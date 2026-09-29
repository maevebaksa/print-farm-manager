// Tests for server/project-eta.js: the farm simulation behind the Dashboard's
// per-project ETA and GET /api/projects/:id/eta. Each test fixes "now" so
// operator-hours cases are deterministic (server local time).

const Database = require('better-sqlite3');
const { estimateProjectRemaining, simulateFarm, nextOperatorTime, readOperatorHours } = require('../project-eta');

let db;
// Monday 2026-09-28 10:00 local time.
const MON_10 = new Date(2026, 8, 28, 10, 0, 0).getTime();
const H = 3600 * 1000;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT NOT NULL, status TEXT DEFAULT 'active',
      priority INTEGER DEFAULT 0, allowed_groups TEXT, required_material TEXT, required_color TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, priority_override INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE parts (id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL, name TEXT NOT NULL,
      target_qty INTEGER NOT NULL, completed_qty INTEGER DEFAULT 0, status TEXT DEFAULT 'open', sort_order INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, priority_override INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE gcodes (id INTEGER PRIMARY KEY, part_id INTEGER NOT NULL, printer_model TEXT NOT NULL,
      filename TEXT NOT NULL, filepath TEXT NOT NULL, parts_per_plate INTEGER NOT NULL, est_print_secs INTEGER,
      allowed_groups TEXT, required_material TEXT, required_color TEXT, approved INTEGER NOT NULL DEFAULT 1,
      uploaded_by_user_id INTEGER, created_at INTEGER NOT NULL);
    CREATE TABLE users (id INTEGER PRIMARY KEY, role TEXT NOT NULL DEFAULT 'uploader', user_group_id INTEGER);
    CREATE TABLE user_groups (id INTEGER PRIMARY KEY, max_concurrent_plates INTEGER, allowed_printer_ids TEXT, allowed_printer_groups TEXT);
    CREATE TABLE printers (id INTEGER PRIMARY KEY, name TEXT NOT NULL, model TEXT NOT NULL, status TEXT DEFAULT 'IDLE',
      is_held INTEGER DEFAULT 0, is_active INTEGER DEFAULT 1, job_time_remaining INTEGER, group_name TEXT,
      loaded_material TEXT, loaded_color TEXT, auto_advance INTEGER DEFAULT 0);
    CREATE TABLE printer_lanes (id INTEGER PRIMARY KEY, printer_id INTEGER, lane_index INTEGER, material TEXT, color TEXT);
    CREATE TABLE jobs (id INTEGER PRIMARY KEY, part_id INTEGER NOT NULL, printer_id INTEGER NOT NULL, gcode_id INTEGER,
      parts_per_plate INTEGER NOT NULL, status TEXT DEFAULT 'queued', started_at INTEGER, created_at INTEGER NOT NULL);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
});

const set = (k, v) => db.prepare('INSERT OR REPLACE INTO settings VALUES (?, ?)').run(k, String(v));

function project({ priority = 0, created = 1, override = 0 } = {}) {
  return db.prepare('INSERT INTO projects (name, priority, created_at, updated_at, priority_override) VALUES (?, ?, ?, ?, ?)')
    .run('P', priority, created, created, override).lastInsertRowid;
}
function part(projectId, { target, completed = 0, status = 'open' }) {
  return db.prepare('INSERT INTO parts (project_id, name, target_qty, completed_qty, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, 1)')
    .run(projectId, 'Part', target, completed, status).lastInsertRowid;
}
function gcode(partId, { model = 'mk4s', ppp = 1, secs = 3600, uploaded = 1, uploaderId = null } = {}) {
  return db.prepare('INSERT INTO gcodes (part_id, printer_model, filename, filepath, parts_per_plate, est_print_secs, uploaded_by_user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(partId, model, 'f.gcode', 'f.gcode', ppp, secs, uploaderId, uploaded).lastInsertRowid;
}
// A user in a fresh user_group with the given plate cap (null = no cap).
function user(maxConcurrentPlates = null) {
  const groupId = db.prepare('INSERT INTO user_groups (max_concurrent_plates) VALUES (?)').run(maxConcurrentPlates).lastInsertRowid;
  return db.prepare("INSERT INTO users (role, user_group_id) VALUES ('uploader', ?)").run(groupId).lastInsertRowid;
}
function printer({ model = 'mk4s', status = 'IDLE', held = 0, remaining = null, active = 1, autoAdvance = 0 } = {}) {
  return db.prepare('INSERT INTO printers (name, model, status, is_held, is_active, job_time_remaining, auto_advance) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('X', model, status, held, active, remaining, autoAdvance).lastInsertRowid;
}
function eta(projectId, now = MON_10) {
  return estimateProjectRemaining(db, projectId, simulateFarm(db, now), now);
}

describe('basics', () => {
  test('no remaining work: 0, not incomplete', () => {
    const p = project();
    gcode(part(p, { target: 2, completed: 2, status: 'closed' }));
    expect(eta(p)).toMatchObject({ remaining_seconds: 0, incomplete: false });
  });

  test('one printer prints the plates back to back', () => {
    const p = project(); gcode(part(p, { target: 3 }));
    printer();
    expect(eta(p)).toMatchObject({ remaining_seconds: 3 * 3600, incomplete: false, completion_at: MON_10 + 3 * H });
  });

  test('two printers run plates in parallel', () => {
    const p = project(); gcode(part(p, { target: 4 }));
    printer(); printer();
    expect(eta(p).remaining_seconds).toBe(2 * 3600);
  });

  test('counts whole plates, not parts: 10 parts at 4 per plate is 3 plates', () => {
    const p = project(); gcode(part(p, { target: 10 }), { ppp: 4 });
    printer();
    expect(eta(p).remaining_seconds).toBe(3 * 3600);
  });

  test('subtracts completed and in-flight quantity', () => {
    const p = project(); const pt = part(p, { target: 5, completed: 2 }); const g = gcode(pt);
    const busy = printer({ status: 'PRINTING', remaining: 600 });
    db.prepare("INSERT INTO jobs (part_id, printer_id, gcode_id, parts_per_plate, status, created_at) VALUES (?, ?, ?, 1, 'printing', 1)").run(pt, busy, g);
    printer();
    // 5 - 2 completed - 1 printing = 2 plates left. The idle printer takes one
    // now (0 to 1h); the busy one is free at 10 min and takes the other (to 1h10m).
    expect(eta(p).remaining_seconds).toBe(600 + 3600);
  });

  test('in-flight prints on several printers take the latest end, not the sum', () => {
    const p = project(); const pt = part(p, { target: 2 }); const g = gcode(pt);
    for (const secs of [500, 300]) {
      const pr = printer({ status: 'PRINTING', remaining: secs });
      db.prepare("INSERT INTO jobs (part_id, printer_id, gcode_id, parts_per_plate, status, created_at) VALUES (?, ?, ?, 1, 'printing', 1)").run(pt, pr, g);
    }
    expect(eta(p).remaining_seconds).toBe(500);
  });

  test('offline, errored, and decommissioned printers take no work', () => {
    const p = project(); gcode(part(p, { target: 1 }));
    printer({ status: 'OFFLINE' }); printer({ status: 'ERROR' }); printer({ active: 0 });
    expect(eta(p)).toMatchObject({ remaining_seconds: null, incomplete: true });
  });

  test('a printer of another model cannot take the part', () => {
    const p = project(); gcode(part(p, { target: 1 }), { model: 'xl' });
    printer({ model: 'mk4s' });
    expect(eta(p)).toMatchObject({ remaining_seconds: null, incomplete: true });
  });

  test('a G-code with no print time makes the estimate a lower bound', () => {
    const p = project();
    gcode(part(p, { target: 1 }));
    gcode(part(p, { target: 1 }), { secs: null });
    printer();
    expect(eta(p)).toMatchObject({ remaining_seconds: 3600, incomplete: true });
  });
});

describe('queue ahead of the project', () => {
  test('priority order: a higher-priority project goes first', () => {
    const a = project({ priority: 0 }); gcode(part(a, { target: 2 }));
    const b = project({ priority: 1 }); gcode(part(b, { target: 1 }));
    printer();
    expect(eta(a).remaining_seconds).toBe(2 * 3600);
    expect(eta(b).remaining_seconds).toBe(3 * 3600);
  });

  test('FIFO: the earlier upload goes first regardless of project priority', () => {
    set('queue_order', 'fifo');
    const a = project({ priority: 0 }); gcode(part(a, { target: 2 }), { uploaded: 200 });
    const b = project({ priority: 1 }); gcode(part(b, { target: 1 }), { uploaded: 100 });
    printer();
    expect(eta(b).remaining_seconds).toBe(3600);
    expect(eta(a).remaining_seconds).toBe(3 * 3600);
  });

  test('a priority override goes first', () => {
    const a = project({ priority: 0 }); gcode(part(a, { target: 2 }));
    const b = project({ priority: 1, override: 1 }); gcode(part(b, { target: 1 }));
    printer();
    expect(eta(b).remaining_seconds).toBe(3600);
  });

  test("an uploader's plate cap spreads printers across their projects", () => {
    const capped = user(1);
    const a = project({ priority: 0 }); gcode(part(a, { target: 2 }), { uploaderId: capped });
    const b = project({ priority: 1 }); gcode(part(b, { target: 2 }));
    printer(); printer();
    expect(eta(a).remaining_seconds).toBe(2 * 3600);
    expect(eta(b).remaining_seconds).toBe(2 * 3600);
  });
});

describe('operator hours', () => {
  beforeEach(() => { set('operator_hours_start', '08:00'); set('operator_hours_end', '17:00'); });

  test('a printer that finishes after hours waits for the next shift before its next plate', () => {
    const at16 = new Date(2026, 8, 28, 16, 0).getTime();
    const p = project(); gcode(part(p, { target: 2 }));
    printer();
    // Plate 1: 16:00 to 17:00. Nobody to reset it until 08:00 Tuesday. Plate 2: 08:00 to 09:00.
    expect(eta(p, at16).completion_at).toBe(new Date(2026, 8, 29, 9, 0).getTime());
  });

  test('an idle, unheld printer starts right away even outside hours (dispatch is automatic)', () => {
    const at20 = new Date(2026, 8, 28, 20, 0).getTime();
    const p = project(); gcode(part(p, { target: 1 }));
    printer();
    expect(eta(p, at20).remaining_seconds).toBe(3600);
  });

  test('a held printer waits for the shift to start', () => {
    const at6 = new Date(2026, 8, 28, 6, 0).getTime();
    const p = project(); gcode(part(p, { target: 1 }));
    printer({ status: 'FINISHED', held: 1 });
    expect(eta(p, at6).completion_at).toBe(new Date(2026, 8, 28, 9, 0).getTime());
  });

  test('weekdays only: a Friday evening finish resumes Monday morning', () => {
    set('operator_days', '1,2,3,4,5');
    const fri16 = new Date(2026, 9, 2, 16, 0).getTime(); // Friday 2026-10-02
    const p = project(); gcode(part(p, { target: 2 }));
    printer();
    expect(eta(p, fri16).completion_at).toBe(new Date(2026, 9, 5, 9, 0).getTime());
  });

  test('auto-advance (belt) printers do not wait for an operator', () => {
    const at16 = new Date(2026, 8, 28, 16, 0).getTime();
    const p = project(); gcode(part(p, { target: 2 }));
    printer({ autoAdvance: 1 });
    expect(eta(p, at16).completion_at).toBe(new Date(2026, 8, 28, 18, 0).getTime());
  });
});

describe('nextOperatorTime', () => {
  test('unset hours: always staffed', () => {
    expect(nextOperatorTime(MON_10, readOperatorHours(db))).toBe(MON_10);
  });

  test('an overnight shift (22:00 to 06:00) covers the early morning', () => {
    set('operator_hours_start', '22:00'); set('operator_hours_end', '06:00');
    const hours = readOperatorHours(db);
    const at3 = new Date(2026, 8, 29, 3, 0).getTime();
    expect(nextOperatorTime(at3, hours)).toBe(at3);
    expect(nextOperatorTime(new Date(2026, 8, 29, 12, 0).getTime(), hours)).toBe(new Date(2026, 8, 29, 22, 0).getTime());
  });
});
