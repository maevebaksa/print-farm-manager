// Tests for server/project-eta.js's estimateProjectRemaining, the shared logic
// behind the Dashboard's per-project ETA and GET /api/projects/:id/eta.

const Database = require('better-sqlite3');
const { estimateProjectRemaining } = require('../project-eta');

let db;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL, status TEXT DEFAULT 'active',
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE parts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL, name TEXT NOT NULL,
      target_qty INTEGER NOT NULL, completed_qty INTEGER DEFAULT 0,
      status TEXT DEFAULT 'open',
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE gcodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      part_id INTEGER NOT NULL, printer_model TEXT NOT NULL,
      filename TEXT NOT NULL, filepath TEXT NOT NULL,
      parts_per_plate INTEGER NOT NULL, est_print_secs INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE printers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL, ip TEXT NOT NULL, api_key TEXT NOT NULL,
      model TEXT NOT NULL, status TEXT DEFAULT 'IDLE',
      is_held INTEGER DEFAULT 0, is_active INTEGER DEFAULT 1,
      job_time_remaining INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      part_id INTEGER NOT NULL, printer_id INTEGER NOT NULL, gcode_id INTEGER,
      parts_per_plate INTEGER NOT NULL, status TEXT DEFAULT 'queued',
      started_at INTEGER, finished_at INTEGER, created_at INTEGER NOT NULL
    );
  `);
});

const now = () => Date.now();

function seedProject(name = 'Proj') {
  return db.prepare('INSERT INTO projects (name, status, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run(name, 'active', now(), now()).lastInsertRowid;
}

function seedPart(projectId, { targetQty, completedQty = 0, status = 'open' }) {
  return db.prepare(`
    INSERT INTO parts (project_id, name, target_qty, completed_qty, status, created_at, updated_at)
    VALUES (?, 'Part', ?, ?, ?, ?, ?)
  `).run(projectId, targetQty, completedQty, status, now(), now()).lastInsertRowid;
}

function seedGcode(partId, { model = 'mk4s', partsPerPlate = 1, estPrintSecs = null }) {
  return db.prepare(`
    INSERT INTO gcodes (part_id, printer_model, filename, filepath, parts_per_plate, est_print_secs, created_at)
    VALUES (?, ?, 'f.bgcode', 'f.bgcode', ?, ?, ?)
  `).run(partId, model, partsPerPlate, estPrintSecs, now()).lastInsertRowid;
}

function seedPrinter({ model = 'mk4s', isActive = 1, jobTimeRemaining = null } = {}) {
  return db.prepare(`
    INSERT INTO printers (name, ip, api_key, model, is_active, job_time_remaining, created_at)
    VALUES (?, '1.1.1.1', 'k', ?, ?, ?, ?)
  `).run(`P${Math.random()}`, model, isActive, jobTimeRemaining, now()).lastInsertRowid;
}

function seedJob(partId, printerId, gcodeId, { status = 'printing', partsPerPlate = 1 } = {}) {
  return db.prepare(`
    INSERT INTO jobs (part_id, printer_id, gcode_id, parts_per_plate, status, started_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(partId, printerId, gcodeId, partsPerPlate, status, now(), now()).lastInsertRowid;
}

describe('estimateProjectRemaining', () => {
  test('returns 0 and complete when there is no remaining work', () => {
    const projectId = seedProject();
    seedPart(projectId, { targetQty: 5, completedQty: 5 });

    const eta = estimateProjectRemaining(db, projectId);
    expect(eta.remaining_seconds).toBe(0);
    expect(eta.incomplete).toBe(false);
  });

  test('estimates serial time for remaining plates with no eligible printers (divides by 1)', () => {
    const projectId = seedProject();
    const partId = seedPart(projectId, { targetQty: 4, completedQty: 0 });
    // 2 plates of 2 parts each at 1000s/plate = 2000s total, no printers registered at all.
    seedGcode(partId, { partsPerPlate: 2, estPrintSecs: 1000 });

    const eta = estimateProjectRemaining(db, projectId);
    expect(eta.remaining_seconds).toBe(2000);
    expect(eta.incomplete).toBe(false);
    expect(eta.eligible_printer_count).toBe(0);
  });

  test('divides queued time across every eligible active printer', () => {
    const projectId = seedProject();
    const partId = seedPart(projectId, { targetQty: 4, completedQty: 0 });
    seedGcode(partId, { model: 'mk4s', partsPerPlate: 2, estPrintSecs: 1000 }); // 2000s total
    seedPrinter({ model: 'mk4s' });
    seedPrinter({ model: 'mk4s' });

    const eta = estimateProjectRemaining(db, projectId);
    expect(eta.eligible_printer_count).toBe(2);
    expect(eta.remaining_seconds).toBe(1000); // 2000s / 2 printers
  });

  test('does not count an inactive (decommissioned) printer as eligible', () => {
    const projectId = seedProject();
    const partId = seedPart(projectId, { targetQty: 2, completedQty: 0 });
    seedGcode(partId, { model: 'mk4s', partsPerPlate: 1, estPrintSecs: 500 });
    seedPrinter({ model: 'mk4s', isActive: 0 });

    const eta = estimateProjectRemaining(db, projectId);
    expect(eta.eligible_printer_count).toBe(0);
    expect(eta.remaining_seconds).toBe(1000); // 2 * 500s / max(1, 0)
  });

  test('subtracts completed_qty and active (uploading/printing) qty before estimating', () => {
    const projectId = seedProject();
    const partId = seedPart(projectId, { targetQty: 10, completedQty: 6 });
    seedGcode(partId, { partsPerPlate: 1, estPrintSecs: 100 });
    const printerId = seedPrinter({ model: 'mk4s' });
    const gcodeId = db.prepare('SELECT id FROM gcodes WHERE part_id = ?').get(partId).id;
    seedJob(partId, printerId, gcodeId, { status: 'uploading', partsPerPlate: 2 });

    // remaining = 10 - 6 - 2 (in flight) = 2 plates of 1 part each at 100s = 200s,
    // divided by the 1 eligible printer.
    const eta = estimateProjectRemaining(db, projectId);
    expect(eta.remaining_seconds).toBe(200);
  });

  test('ignores closed parts entirely', () => {
    const projectId = seedProject();
    const closedId = seedPart(projectId, { targetQty: 5, completedQty: 0, status: 'closed' });
    seedGcode(closedId, { partsPerPlate: 1, estPrintSecs: 999999 });

    const eta = estimateProjectRemaining(db, projectId);
    expect(eta.remaining_seconds).toBe(0);
    expect(eta.incomplete).toBe(false);
  });

  test('flags incomplete and excludes a part with no est_print_secs on any gcode', () => {
    const projectId = seedProject();
    const knownPart = seedPart(projectId, { targetQty: 1, completedQty: 0 });
    seedGcode(knownPart, { partsPerPlate: 1, estPrintSecs: 500 });
    const unknownPart = seedPart(projectId, { targetQty: 1, completedQty: 0 });
    seedGcode(unknownPart, { partsPerPlate: 1, estPrintSecs: null });

    const eta = estimateProjectRemaining(db, projectId);
    expect(eta.incomplete).toBe(true);
    expect(eta.remaining_seconds).toBe(500); // only the known part counted
  });

  test('returns null (not 0) when there is remaining work but no time estimate exists anywhere', () => {
    const projectId = seedProject();
    const partId = seedPart(projectId, { targetQty: 1, completedQty: 0 });
    seedGcode(partId, { partsPerPlate: 1, estPrintSecs: null });

    const eta = estimateProjectRemaining(db, projectId);
    expect(eta.remaining_seconds).toBeNull();
    expect(eta.incomplete).toBe(true);
  });

  test('averages per-part time across a part with multiple gcodes (different printer models)', () => {
    const projectId = seedProject();
    const partId = seedPart(projectId, { targetQty: 1, completedQty: 0 });
    seedGcode(partId, { model: 'mk4s', partsPerPlate: 1, estPrintSecs: 100 });
    seedGcode(partId, { model: 'xl',   partsPerPlate: 1, estPrintSecs: 300 });

    const eta = estimateProjectRemaining(db, projectId);
    // average of 100 and 300 = 200s for the one remaining part, no eligible printers -> /1
    expect(eta.remaining_seconds).toBe(200);
  });

  test('adds real job_time_remaining telemetry for a currently-printing job on top of queued time', () => {
    const projectId = seedProject();
    const printingPart = seedPart(projectId, { targetQty: 1, completedQty: 0 });
    const gcodeId = seedGcode(printingPart, { partsPerPlate: 1, estPrintSecs: 100 });
    const printerId = seedPrinter({ model: 'mk4s', jobTimeRemaining: 42 });
    seedJob(printingPart, printerId, gcodeId, { status: 'printing', partsPerPlate: 1 });

    const queuedPart = seedPart(projectId, { targetQty: 1, completedQty: 0 });
    seedGcode(queuedPart, { partsPerPlate: 1, estPrintSecs: 1000 });
    seedPrinter({ model: 'mk4s' }); // a second eligible printer for the queued work

    const eta = estimateProjectRemaining(db, projectId);
    // printingPart's own plate is already in flight (active_qty covers it, contributes
    // 0 to queued time); its real 42s remaining is added on top of the queued part's
    // 1000s split across the 2 eligible printers (500s).
    expect(eta.remaining_seconds).toBe(42 + 500);
  });

  test('a project with only other projects\' printers/parts is unaffected by them', () => {
    const projectId = seedProject('This one');
    const otherProjectId = seedProject('Other');
    const partId = seedPart(projectId, { targetQty: 1, completedQty: 0 });
    seedGcode(partId, { model: 'mk4s', partsPerPlate: 1, estPrintSecs: 100 });

    const otherPartId = seedPart(otherProjectId, { targetQty: 1, completedQty: 0 });
    seedGcode(otherPartId, { model: 'xl', partsPerPlate: 1, estPrintSecs: 999999 });
    seedPrinter({ model: 'xl' });

    const eta = estimateProjectRemaining(db, projectId);
    expect(eta.remaining_seconds).toBe(100); // not diluted by the other project's huge estimate
    expect(eta.eligible_printer_count).toBe(0); // the xl printer doesn't match this project's mk4s gcode
  });
});
