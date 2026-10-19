// A single missed poll must not flip a reachable printer to OFFLINE (and, with a job in
// progress, hold it for operator review). OFFLINE is reported only after
// OFFLINE_CONFIRM_POLLS consecutive failures, and never debounced on a cold start.
// The driver is mocked so no real network I/O occurs.

jest.mock('../drivers', () => ({ getDriver: jest.fn() }));

const Database = require('better-sqlite3');
const { getDriver } = require('../drivers');
const PrinterPoller = require('../poller');

const OFFLINE = { status: 'OFFLINE', progress: null, timeRemaining: null };
const IDLE = { status: 'IDLE', progress: null, timeRemaining: null };

function makeDb(status = 'IDLE') {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE printers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL, type TEXT DEFAULT 'octoprint',
      status TEXT DEFAULT 'IDLE', is_held INTEGER DEFAULT 0, is_active INTEGER DEFAULT 1,
      job_name TEXT, job_progress REAL, job_time_remaining INTEGER
    );
    CREATE TABLE jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      part_id INTEGER, printer_id INTEGER, gcode_id INTEGER,
      status TEXT DEFAULT 'queued', started_at INTEGER, finished_at INTEGER
    );
  `);
  db.prepare("INSERT INTO printers (id, name, status) VALUES (1, 'mini5', ?)").run(status);
  return db;
}

const stored = (db) => db.prepare('SELECT * FROM printers WHERE id = 1').get();

// One poll tick for printer 1 with the driver returning `result`.
async function poll(poller, db, result) {
  getDriver.mockReturnValue({ getStatus: jest.fn().mockResolvedValue(result) });
  await poller._pollPrinter(stored(db));
}

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => { console.log.mockRestore(); jest.clearAllMocks(); });

describe('PrinterPoller: OFFLINE debounce', () => {
  test('one or two missed polls of a reachable printer keep its status and emit nothing', async () => {
    const db = makeDb('IDLE');
    const poller = new PrinterPoller(db);
    const changes = [];
    poller.on('statusChange', (e) => changes.push(e.newStatus));

    await poll(poller, db, IDLE);     // seen online in this process
    await poll(poller, db, OFFLINE);  // miss 1
    await poll(poller, db, OFFLINE);  // miss 2
    expect(stored(db).status).toBe('IDLE');
    expect(changes).toEqual([]);
  });

  test('the third consecutive miss is reported as OFFLINE', async () => {
    const db = makeDb('IDLE');
    const poller = new PrinterPoller(db);
    const changes = [];
    poller.on('statusChange', (e) => changes.push(e.newStatus));

    await poll(poller, db, IDLE);
    await poll(poller, db, OFFLINE);
    await poll(poller, db, OFFLINE);
    await poll(poller, db, OFFLINE);
    expect(stored(db).status).toBe('OFFLINE');
    expect(changes).toEqual(['OFFLINE']);
  });

  test('a successful poll resets the count, so spread-out blips never accumulate', async () => {
    const db = makeDb('IDLE');
    const poller = new PrinterPoller(db);

    await poll(poller, db, IDLE);
    for (let i = 0; i < 5; i++) {
      await poll(poller, db, OFFLINE);
      await poll(poller, db, OFFLINE);
      await poll(poller, db, IDLE);
    }
    expect(stored(db).status).toBe('IDLE');
  });

  // Regression: a miss on a printer with a job in progress used to hold it ("Went
  // offline with a job in progress") and null out the job's progress.
  test('a blip on a printing printer does not change status, hold it, or wipe progress', async () => {
    const db = makeDb('PRINTING');
    db.prepare("INSERT INTO jobs (printer_id, status, started_at) VALUES (1, 'printing', ?)").run(Date.now());
    const poller = new PrinterPoller(db);
    const changes = [];
    poller.on('statusChange', (e) => changes.push(e.newStatus));

    await poll(poller, db, { status: 'PRINTING', progress: 42, timeRemaining: 600, currentFile: 'a.gcode' });
    await poll(poller, db, OFFLINE);

    const row = stored(db);
    expect(row.status).toBe('PRINTING');
    expect(row.is_held).toBe(0);
    expect(row.job_progress).toBe(42);
    expect(changes).toEqual([]);
  });

  // Cold start: the stored status says nothing about the printer after a restart, and a
  // first OFFLINE (Bambu MQTT still connecting) has always been reported immediately.
  test('a printer not yet seen online in this process is reported OFFLINE on the first miss', async () => {
    const db = makeDb('IDLE');
    const poller = new PrinterPoller(db);
    const changes = [];
    poller.on('statusChange', (e) => changes.push(e.newStatus));

    await poll(poller, db, OFFLINE);
    expect(stored(db).status).toBe('OFFLINE');
    expect(changes).toEqual(['OFFLINE']);
  });

  test('a printer already OFFLINE is not re-debounced when it keeps failing', async () => {
    const db = makeDb('IDLE');
    const poller = new PrinterPoller(db);
    await poll(poller, db, OFFLINE); // cold start: OFFLINE immediately
    await poll(poller, db, OFFLINE);
    expect(stored(db).status).toBe('OFFLINE');
  });
});
