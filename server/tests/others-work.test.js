// Deleting or cancelling someone else's work needs can_manage_others_work
// (auth.js's canModifyWork): jobs (owner = G-code uploader, else part creator),
// and the G-code, part, and project deletes that cascade over other people's work.

const request  = require('supertest');
const express  = require('express');
const Database = require('better-sqlite3');

let db;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE printers (id INTEGER PRIMARY KEY, name TEXT, ip TEXT, api_key TEXT DEFAULT '',
      model TEXT, type TEXT, status TEXT DEFAULT 'IDLE', is_held INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1, created_at INTEGER);
    CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT, status TEXT DEFAULT 'active',
      created_at INTEGER, updated_at INTEGER, created_by_user_id INTEGER, created_by_name TEXT,
      priority_override INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE parts (id INTEGER PRIMARY KEY, project_id INTEGER, name TEXT,
      target_qty INTEGER, completed_qty INTEGER DEFAULT 0, status TEXT DEFAULT 'open',
      created_at INTEGER, updated_at INTEGER, created_by_user_id INTEGER, created_by_name TEXT,
      priority_override INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE gcodes (id INTEGER PRIMARY KEY, part_id INTEGER, filename TEXT, filepath TEXT DEFAULT 'x',
      uploaded_by_user_id INTEGER, uploaded_by_name TEXT);
    CREATE TABLE jobs (id INTEGER PRIMARY KEY, part_id INTEGER, printer_id INTEGER,
      gcode_id INTEGER, parts_per_plate INTEGER, status TEXT DEFAULT 'queued',
      started_at INTEGER, finished_at INTEGER, created_at INTEGER);
  `);
  const now = Date.now();
  db.prepare("INSERT INTO projects (id, name, created_at, updated_at, created_by_user_id) VALUES (1, 'P', ?, ?, 5)").run(now, now);
  db.prepare("INSERT INTO parts (id, project_id, name, target_qty, created_at, updated_at, created_by_user_id) VALUES (1, 1, 'Part', 5, ?, ?, 5)").run(now, now);
  db.prepare("INSERT INTO gcodes (id, part_id, filename, uploaded_by_user_id) VALUES (1, 1, 'a.gcode', 5)").run();
  db.prepare("INSERT INTO jobs (id, part_id, gcode_id, parts_per_plate, status, created_at) VALUES (1, 1, 1, 1, 'queued', ?)").run(now);
});

// Some route modules (jobs.js) keep their express.Router at module level, so a
// second factory call would leave the first test's DB bound to the handlers.
// Load a fresh copy of the module for every app so each test sees its own DB.
function appAs(user, modulePath, mount, ...extra) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = user; next(); });
  jest.isolateModules(() => { app.use(mount, require(modulePath)(db, ...extra)); });
  return app;
}
const jobsApp   = (u) => appAs(u, '../routes/jobs', '/api/jobs');
const gcodesApp = (u) => appAs(u, '../routes/gcodes', '/api/gcodes', { on() {}, emit() {} });
const partsApp  = (u) => appAs(u, '../routes/parts', '/api/parts', {});

const OWNER    = { id: 5, role: 'uploader' };
const OTHER    = { id: 9, role: 'uploader' };
const GRANTED  = { id: 9, role: 'uploader', permissions: { can_manage_others_work: true } };
const OPERATOR = { id: 2, role: 'operator' };

describe('DELETE /api/jobs/:id', () => {
  test("another user cannot cancel someone else's queued job", async () => {
    const res = await request(jobsApp(OTHER)).delete('/api/jobs/1');
    expect(res.status).toBe(403);
    expect(db.prepare('SELECT status FROM jobs WHERE id = 1').get().status).toBe('queued');
  });

  test('the owner can cancel their own queued job', async () => {
    expect((await request(jobsApp(OWNER)).delete('/api/jobs/1')).status).toBe(200);
  });

  test('a group with can_manage_others_work, and an operator, can cancel it', async () => {
    expect((await request(jobsApp(GRANTED)).delete('/api/jobs/1')).status).toBe(200);
    db.prepare("UPDATE jobs SET status = 'queued' WHERE id = 1").run();
    expect((await request(jobsApp(OPERATOR)).delete('/api/jobs/1')).status).toBe(200);
  });

  test('a job with no recorded owner counts as someone else\'s', async () => {
    db.prepare('UPDATE gcodes SET uploaded_by_user_id = NULL').run();
    db.prepare('UPDATE parts SET created_by_user_id = NULL').run();
    expect((await request(jobsApp(OWNER)).delete('/api/jobs/1')).status).toBe(403);
  });
});

describe('DELETE /api/gcodes/:id and /api/parts/:id', () => {
  test("another user cannot delete someone else's G-code or part", async () => {
    db.prepare("DELETE FROM jobs").run();
    expect((await request(gcodesApp(OTHER)).delete('/api/gcodes/1')).status).toBe(403);
    expect((await request(partsApp(OTHER)).delete('/api/parts/1')).status).toBe(403);
    expect(db.prepare('SELECT COUNT(*) AS n FROM parts').get().n).toBe(1);
  });

  test('the owner can delete their own part', async () => {
    db.prepare("DELETE FROM jobs").run();
    expect((await request(partsApp(OWNER)).delete('/api/parts/1')).status).toBe(200);
  });

  test("a part is not deletable by its creator if it holds someone else's G-code", async () => {
    db.prepare("DELETE FROM jobs").run();
    db.prepare('UPDATE gcodes SET uploaded_by_user_id = 9').run();
    expect((await request(partsApp(OWNER)).delete('/api/parts/1')).status).toBe(403);
  });
});

describe('DELETE /api/jobs/:id?reason=', () => {
  beforeEach(() => { db.exec('ALTER TABLE gcodes ADD COLUMN approved INTEGER NOT NULL DEFAULT 1'); });

  test('default and reason=failed cancel the job and leave the G-code dispatchable', async () => {
    const res = await request(jobsApp(OPERATOR)).delete('/api/jobs/1?reason=failed');
    expect(res.status).toBe(200);
    expect(db.prepare('SELECT status FROM jobs WHERE id = 1').get().status).toBe('cancelled');
    expect(db.prepare('SELECT approved FROM gcodes WHERE id = 1').get().approved).toBe(1);
  });

  test('reason=bad_gcode cancels the job and takes the G-code out of dispatch', async () => {
    const res = await request(jobsApp(OPERATOR)).delete('/api/jobs/1?reason=bad_gcode');
    expect(res.status).toBe(200);
    expect(db.prepare('SELECT status FROM jobs WHERE id = 1').get().status).toBe('cancelled');
    expect(db.prepare('SELECT approved FROM gcodes WHERE id = 1').get().approved).toBe(0);
  });

  test('an unknown reason is a 400 and changes nothing', async () => {
    const res = await request(jobsApp(OPERATOR)).delete('/api/jobs/1?reason=whatever');
    expect(res.status).toBe(400);
    expect(db.prepare('SELECT status FROM jobs WHERE id = 1').get().status).toBe('queued');
  });
});
