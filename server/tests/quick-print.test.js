// Tests for server/routes/quick-print.js: one-off upload that queues a single
// plate, optionally pinned to a printer, honoring the uploader's user group.

const request  = require('supertest');
const express  = require('express');
const Database = require('better-sqlite3');
const path     = require('path');
const fs       = require('fs');

const GCODE_DIR = path.join(__dirname, '..', 'gcode');
let db, app, currentUser;
const sweep = jest.fn();
const created = [];

const perms = (over = {}) => ({
  can_quick_print: true, requires_approval: false,
  allowed_printer_ids: null, allowed_printer_groups: null, ...over,
});
const USER = (over) => ({ id: 2, name: 'Bob', role: 'uploader', permissions: perms(over) });
const OPERATOR = (over) => ({ id: 3, name: 'Op', role: 'operator', permissions: perms(over) });

beforeAll(() => {
  if (!fs.existsSync(GCODE_DIR)) fs.mkdirSync(GCODE_DIR, { recursive: true });
});
afterAll(() => { for (const f of created) { try { fs.unlinkSync(path.join(GCODE_DIR, f)); } catch (_) {} } });

beforeEach(() => {
  sweep.mockClear();
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE printer_models (model_id TEXT PRIMARY KEY, label TEXT NOT NULL, connector TEXT NOT NULL);
    CREATE TABLE printers (id INTEGER PRIMARY KEY, name TEXT, model TEXT, group_name TEXT, is_active INTEGER DEFAULT 1);
    CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT NOT NULL, description TEXT, status TEXT DEFAULT 'draft',
      priority INTEGER DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, created_by_user_id INTEGER, created_by_name TEXT);
    CREATE TABLE parts (id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL, name TEXT NOT NULL, target_qty INTEGER NOT NULL,
      completed_qty INTEGER DEFAULT 0, status TEXT DEFAULT 'open', sort_order INTEGER NOT NULL DEFAULT 0,
      priority_override INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, created_by_user_id INTEGER, created_by_name TEXT);
    CREATE TABLE gcodes (id INTEGER PRIMARY KEY, part_id INTEGER NOT NULL, printer_model TEXT NOT NULL, filename TEXT NOT NULL,
      filepath TEXT NOT NULL, parts_per_plate INTEGER NOT NULL, est_print_secs INTEGER, material_grams REAL, material_type TEXT,
      approved INTEGER NOT NULL DEFAULT 1, target_printer_id INTEGER, uploaded_by_user_id INTEGER, uploaded_by_name TEXT, created_at INTEGER NOT NULL);
    INSERT INTO printer_models VALUES ('mk4s', 'MK4S', 'prusa'), ('c1', 'Core One', 'prusa');
    INSERT INTO printers (id, name, model, group_name) VALUES (1, 'a1', 'mk4s', 'Rack A'), (2, 'a2', 'mk4s', 'Rack B');
  `);
  currentUser = USER();
  app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = currentUser; next(); });
  app.use('/api/quick-print', require('../routes/quick-print')(db, { sweepIdlePrinters: sweep }));
});

async function send(fields = {}, name = 'plate.gcode') {
  let r = request(app).post('/api/quick-print').attach('file', Buffer.from('; PrusaSlicer\nG28\n'), name);
  for (const [k, v] of Object.entries(fields)) r = r.field(k, v);
  const res = await r;
  if (res.body && res.body.gcode_id) created.push(db.prepare('SELECT filepath FROM gcodes WHERE id = ?').get(res.body.gcode_id).filepath);
  return res;
}

describe('POST /api/quick-print', () => {
  test('queues one plate in the uploader Uploads project, no printer pinned, and sweeps', async () => {
    const res = await send();
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ printer_model: 'mk4s', target_printer_id: null, pending_approval: false });
    expect(db.prepare('SELECT name FROM projects').get().name).toBe('Uploads: Bob');
    expect(db.prepare('SELECT * FROM parts').get()).toMatchObject({ name: 'plate', target_qty: 1, completed_qty: 0 });
    expect(sweep).toHaveBeenCalled();
  });

  test('pins the gcode to the chosen printer and uses its model (operator/admin only)', async () => {
    currentUser = OPERATOR();
    const res = await send({ printer_id: '2' });
    expect(res.status).toBe(201);
    expect(db.prepare('SELECT target_printer_id FROM gcodes').get().target_printer_id).toBe(2);
  });

  test('403 for a plain uploader targeting a specific printer', async () => {
    expect((await send({ printer_id: '2' })).status).toBe(403);
  });

  test('printer_model narrows to a type, open to every role, no pin', async () => {
    const res = await send({ printer_model: 'mk4s' });
    expect(res.status).toBe(201);
    expect(res.body.printer_model).toBe('mk4s');
    expect(db.prepare('SELECT target_printer_id FROM gcodes').get().target_printer_id).toBeNull();
  });

  test('400 when printer_model has no active printers on the farm', async () => {
    expect((await send({ printer_model: 'c1' })).status).toBe(400);
  });

  test('priority is operator/admin only and sets priority_override', async () => {
    expect((await send({ priority: 'true' })).status).toBe(403);
    currentUser = OPERATOR();
    const res = await send({ priority: 'true' });
    expect(res.status).toBe(201);
    expect(res.body.priority).toBe(true);
    expect(db.prepare('SELECT priority_override FROM parts').get().priority_override).toBe(1);
  });

  test('a second quick print reuses the same project', async () => {
    await send();
    await send();
    expect(db.prepare('SELECT COUNT(*) AS n FROM projects').get().n).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM parts').get().n).toBe(2);
  });

  test('403 when the group disallows Quick Print', async () => {
    currentUser = USER({ can_quick_print: false });
    expect((await send()).status).toBe(403);
  });

  test('403 for a printer outside the group allowed printers, 201 for one inside', async () => {
    currentUser = OPERATOR({ allowed_printer_ids: [1] });
    expect((await send({ printer_id: '2' })).status).toBe(403);
    expect((await send({ printer_id: '1' })).status).toBe(201);
  });

  test('allowed printer groups work, and a restricted group with no usable printer is refused', async () => {
    currentUser = OPERATOR({ allowed_printer_groups: ['Rack B'] });
    expect((await send({ printer_id: '2' })).status).toBe(201);
    expect((await send({ printer_id: '1' })).status).toBe(403);
    currentUser = USER({ allowed_printer_ids: [999] });
    expect((await send()).status).toBe(403);
  });

  test('requires_approval queues it unapproved and does not sweep', async () => {
    currentUser = USER({ requires_approval: true });
    const res = await send();
    expect(res.body.pending_approval).toBe(true);
    expect(db.prepare('SELECT approved FROM gcodes').get().approved).toBe(0);
    expect(sweep).not.toHaveBeenCalled();
  });

  test('validation: bad extension 415, unknown printer 404, decommissioned 409, bad count 400, no file 400', async () => {
    currentUser = OPERATOR();
    expect((await send({}, 'notes.txt')).status).toBe(415);
    expect((await send({ printer_id: '77' })).status).toBe(404);
    db.prepare('UPDATE printers SET is_active = 0 WHERE id = 1').run();
    expect((await send({ printer_id: '1' })).status).toBe(409);
    expect((await send({ parts_per_plate: '0' })).status).toBe(400);
    expect((await request(app).post('/api/quick-print')).status).toBe(400);
  });

  test('ambiguous model with no printer chosen is a 400', async () => {
    db.prepare("INSERT INTO printers (id, name, model) VALUES (3, 'c', 'c1')").run();
    expect((await send()).status).toBe(400);
  });
});
