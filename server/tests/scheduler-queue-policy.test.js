// Tests for the queue policy (scheduler.js _queuePolicy / _atPrinterCap):
//   queue_order = 'priority' (default, admin setting) | 'fifo' (by G-code upload time)
//   user_groups.max_concurrent_plates: a work-conserving cap set per user
//   group (admin-only, Users page), capping how many printers one member's
//   own work may occupy at once, across every project/part they own.
// The driver is mocked, so no real network I/O occurs.

const path = require('path');
const fs   = require('fs');
const Database = require('better-sqlite3');

const mockDriver = { uploadAndPrint: jest.fn(), checkIfPrinting: jest.fn() };
jest.mock('../drivers', () => ({ getDriver: jest.fn(() => mockDriver) }));
jest.mock('../notifications', () => ({ add: jest.fn() }));

const JobScheduler = require('../scheduler');
const GCODE_DIR = path.join(__dirname, '..', 'gcode');

let gcodeFilename;
beforeAll(() => {
  if (!fs.existsSync(GCODE_DIR)) fs.mkdirSync(GCODE_DIR, { recursive: true });
  gcodeFilename = `queue_policy_test_${Date.now()}.gcode`;
  fs.writeFileSync(path.join(GCODE_DIR, gcodeFilename), 'G28');
});
afterAll(() => { try { fs.unlinkSync(path.join(GCODE_DIR, gcodeFilename)); } catch (_) {} });
beforeEach(() => {
  jest.clearAllMocks();
  mockDriver.uploadAndPrint.mockResolvedValue(undefined);
  mockDriver.checkIfPrinting.mockResolvedValue(false);
});

// Project "Early" (priority 0, created first) has part E whose G-code was
// uploaded LATE by user 10 (its own user_group 1); project "Late" (priority 1)
// has part L whose G-code was uploaded EARLY by user 20 (its own user_group
// 2), so each part's uploader can be capped independently. Priority order
// picks E, FIFO picks L.
// caps: { <user_group id> (1 = E's uploader, 2 = L's uploader): max_concurrent_plates }.
// Omitted or 0/null means no cap.
function makeDb(settings = {}, caps = {}) {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE printers (id INTEGER PRIMARY KEY, name TEXT NOT NULL, ip TEXT NOT NULL, api_key TEXT NOT NULL,
      model TEXT NOT NULL, type TEXT DEFAULT 'prusa', group_name TEXT, loaded_material TEXT, loaded_color TEXT,
      status TEXT DEFAULT 'IDLE', is_held INTEGER DEFAULT 0, is_active INTEGER DEFAULT 1, created_at INTEGER NOT NULL);
    CREATE TABLE printer_lanes (id INTEGER PRIMARY KEY, printer_id INTEGER NOT NULL, lane_index INTEGER NOT NULL,
      material TEXT, color TEXT, updated_at INTEGER NOT NULL);
    CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT NOT NULL, status TEXT DEFAULT 'active',
      priority INTEGER DEFAULT 0, required_material TEXT, required_color TEXT, allowed_groups TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, priority_override INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE parts (id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL, name TEXT NOT NULL,
      target_qty INTEGER NOT NULL, completed_qty INTEGER DEFAULT 0, status TEXT DEFAULT 'open',
      sort_order INTEGER DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, priority_override INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE users (id INTEGER PRIMARY KEY, role TEXT, user_group_id INTEGER);
    CREATE TABLE user_groups (id INTEGER PRIMARY KEY, max_concurrent_plates INTEGER, allowed_printer_ids TEXT, allowed_printer_groups TEXT);
    CREATE TABLE gcodes (id INTEGER PRIMARY KEY, part_id INTEGER NOT NULL, printer_model TEXT NOT NULL,
      filename TEXT NOT NULL, filepath TEXT NOT NULL, parts_per_plate INTEGER NOT NULL, ams_slot INTEGER,
      allowed_groups TEXT, required_material TEXT, required_color TEXT, approved INTEGER NOT NULL DEFAULT 1, target_printer_id INTEGER, uploaded_by_user_id INTEGER,
      created_at INTEGER NOT NULL);
    CREATE TABLE jobs (id INTEGER PRIMARY KEY, part_id INTEGER NOT NULL, printer_id INTEGER NOT NULL,
      gcode_id INTEGER, parts_per_plate INTEGER NOT NULL, status TEXT DEFAULT 'queued',
      started_at INTEGER, finished_at INTEGER, created_at INTEGER NOT NULL, upload_first_failed_at INTEGER);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE filament_colors (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, hex_color TEXT);
  `);
  for (const [k, v] of Object.entries(settings)) db.prepare('INSERT INTO settings VALUES (?, ?)').run(k, String(v));

  db.prepare("INSERT INTO printers (id, name, ip, api_key, model, created_at) VALUES (1, 'P1', '10.0.0.1', 'k', 'mk4s', 1)").run();
  db.prepare("INSERT INTO projects (id, name, priority, created_at, updated_at) VALUES (1, 'Early', 0, 100, 100)").run();
  db.prepare("INSERT INTO projects (id, name, priority, created_at, updated_at) VALUES (2, 'Late', 1, 200, 200)").run();
  db.prepare("INSERT INTO parts (id, project_id, name, target_qty, created_at, updated_at) VALUES (1, 1, 'E', 100, 100, 100)").run();
  db.prepare("INSERT INTO parts (id, project_id, name, target_qty, created_at, updated_at) VALUES (2, 2, 'L', 100, 200, 200)").run();
  db.prepare("INSERT INTO user_groups (id) VALUES (1), (2)").run();
  db.prepare("INSERT INTO users (id, role, user_group_id) VALUES (10, 'uploader', 1), (20, 'uploader', 2)").run();
  const gc = db.prepare("INSERT INTO gcodes (id, part_id, printer_model, filename, filepath, parts_per_plate, uploaded_by_user_id, created_at) VALUES (?, ?, 'mk4s', ?, ?, 1, ?, ?)");
  gc.run(1, 1, gcodeFilename, gcodeFilename, 10, 5000); // E uploaded late, by user 10
  gc.run(2, 2, gcodeFilename, gcodeFilename, 20, 1000); // L uploaded early, by user 20
  for (const [groupId, cap] of Object.entries(caps)) {
    db.prepare('UPDATE user_groups SET max_concurrent_plates = ? WHERE id = ?').run(cap || null, groupId);
  }
  return db;
}

const printer = { id: 1, name: 'P1', ip: '10.0.0.1', api_key: 'k', model: 'mk4s', type: 'prusa', status: 'IDLE', is_held: 0, is_active: 1 };

async function dispatchedPartId(db) {
  const scheduler = new JobScheduler(db, { on: () => {} });
  const jobId = await scheduler._dispatchToPrinter(printer);
  return jobId ? db.prepare('SELECT part_id FROM jobs WHERE id = ?').get(jobId).part_id : null;
}

function addActiveJob(db, partId, printerId = 99) {
  db.prepare("INSERT INTO jobs (part_id, printer_id, gcode_id, parts_per_plate, status, created_at) VALUES (?, ?, ?, 1, 'printing', 1)")
    .run(partId, printerId, partId);
}

describe('queue_order', () => {
  test('default (unset) keeps project priority order', async () => {
    expect(await dispatchedPartId(makeDb())).toBe(1);
  });

  test("'priority' keeps project priority order", async () => {
    expect(await dispatchedPartId(makeDb({ queue_order: 'priority' }))).toBe(1);
  });

  test("'fifo' dispatches the earliest-uploaded G-code first, ignoring project priority", async () => {
    expect(await dispatchedPartId(makeDb({ queue_order: 'fifo' }))).toBe(2);
  });

  test("'fifo' ignores part sort_order within a project too", async () => {
    const db = makeDb({ queue_order: 'fifo' });
    db.prepare("INSERT INTO parts (id, project_id, name, target_qty, sort_order, created_at, updated_at) VALUES (3, 1, 'E2', 100, -5, 300, 300)").run();
    db.prepare("INSERT INTO gcodes (id, part_id, printer_model, filename, filepath, parts_per_plate, created_at) VALUES (3, 3, 'mk4s', ?, ?, 1, 500)").run(gcodeFilename, gcodeFilename);
    expect(await dispatchedPartId(db)).toBe(3); // uploaded at 500, before L (1000) and E (5000)
  });
});

describe('per-uploader plate cap (user_groups.max_concurrent_plates)', () => {
  test("an uploader at their cap yields to other waiting work", async () => {
    const db = makeDb({ queue_order: 'fifo' }, { 2: 1 }); // L's uploader (group 2) capped at 1
    addActiveJob(db, 2); // L (first in FIFO) already on one printer
    expect(await dispatchedPartId(db)).toBe(1);
  });

  test('caps are work-conserving: a capped uploader still gets an otherwise idle printer', async () => {
    const db = makeDb({ queue_order: 'fifo' }, { 2: 1 });
    addActiveJob(db, 2);
    db.prepare("UPDATE projects SET status = 'paused' WHERE id = 1").run(); // nothing else waiting
    expect(await dispatchedPartId(db)).toBe(2);
  });

  test('an uploader at their cap yields, even for a different part of theirs', async () => {
    const db = makeDb({}, { 1: 1 }); // E's uploader (group 1) capped at 1; priority order: Early first
    db.prepare("INSERT INTO parts (id, project_id, name, target_qty, created_at, updated_at) VALUES (3, 1, 'E2', 100, 300, 300)").run();
    // Same uploader (user 10) as part E's gcode, just a different part in the same project.
    db.prepare("INSERT INTO gcodes (id, part_id, printer_model, filename, filepath, parts_per_plate, uploaded_by_user_id, created_at) VALUES (3, 3, 'mk4s', ?, ?, 10, 300)").run(gcodeFilename, gcodeFilename);
    addActiveJob(db, 1); // E is printing: its uploader (user 10) is at their cap
    expect(await dispatchedPartId(db)).toBe(2); // L's part, not the same uploader's E2
  });

  test('no cap set (null) means unlimited', async () => {
    const db = makeDb({ queue_order: 'fifo' });
    addActiveJob(db, 2);
    expect(await dispatchedPartId(db)).toBe(2);
  });

  test('a cap of 0 also means unlimited', async () => {
    const db = makeDb({ queue_order: 'fifo' }, { 2: 0 });
    addActiveJob(db, 2);
    expect(await dispatchedPartId(db)).toBe(2);
  });

  test('a capped uploader is skipped before any dispatch lock is taken (no stray job rows)', async () => {
    const db = makeDb({ queue_order: 'fifo' }, { 2: 1 });
    addActiveJob(db, 2);
    await dispatchedPartId(db);
    const rows = db.prepare("SELECT part_id, printer_id FROM jobs WHERE printer_id = 1").all();
    expect(rows).toEqual([{ part_id: 1, printer_id: 1 }]);
  });

  test('an admin uploader is never capped even if their group somehow has one set', async () => {
    const db = makeDb({ queue_order: 'fifo' }, { 2: 1 });
    db.prepare("UPDATE users SET role = 'admin' WHERE id = 20").run(); // L's uploader is an admin
    addActiveJob(db, 2);
    expect(await dispatchedPartId(db)).toBe(2); // still dispatches despite the group cap
  });
});

describe('priority override', () => {
  test('an overridden part jumps FIFO order', async () => {
    const db = makeDb({ queue_order: 'fifo' });
    db.prepare('UPDATE parts SET priority_override = 1 WHERE id = 1').run(); // E, uploaded last
    expect(await dispatchedPartId(db)).toBe(1);
  });

  test('an overridden project jumps project priority order', async () => {
    const db = makeDb();
    db.prepare('UPDATE projects SET priority_override = 1 WHERE id = 2').run(); // Late
    expect(await dispatchedPartId(db)).toBe(2);
  });

  test('overridden work is exempt from the plate cap', async () => {
    const db = makeDb({ queue_order: 'fifo' }, { 2: 1 });
    addActiveJob(db, 2);
    db.prepare('UPDATE parts SET priority_override = 1 WHERE id = 2').run();
    expect(await dispatchedPartId(db)).toBe(2); // not skipped for L despite its uploader being at their cap
  });
});
