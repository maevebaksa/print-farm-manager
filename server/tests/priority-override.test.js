// PUT /api/parts/:id/priority-override and PUT /api/projects/:id/priority-override:
// operator/admin only; the general PUT /:id routes never change the flag.

const request  = require('supertest');
const express  = require('express');
const Database = require('better-sqlite3');

let db, app, currentUser;
const sweep = jest.fn();

beforeAll(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT NOT NULL, description TEXT, status TEXT DEFAULT 'active',
      priority INTEGER DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      created_by_user_id INTEGER, created_by_name TEXT, priority_override INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE parts (id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL, name TEXT NOT NULL, target_qty INTEGER NOT NULL,
      completed_qty INTEGER DEFAULT 0, status TEXT DEFAULT 'open', sort_order INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, created_by_user_id INTEGER, created_by_name TEXT,
      priority_override INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE jobs (id INTEGER PRIMARY KEY, part_id INTEGER NOT NULL, printer_id INTEGER, gcode_id INTEGER,
      parts_per_plate INTEGER NOT NULL, status TEXT, created_at INTEGER);
    INSERT INTO projects (id, name, created_at, updated_at) VALUES (1, 'P', 1, 1);
    INSERT INTO parts (id, project_id, name, target_qty, created_at, updated_at) VALUES (1, 1, 'A', 5, 1, 1);
  `);
  app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = currentUser; next(); });
  app.use('/api/parts', require('../routes/parts')(db, { sweepIdlePrinters: sweep }));
  app.use('/api/projects', require('../routes/projects')(db, { sweepIdlePrinters: sweep }));
});

beforeEach(() => {
  currentUser = { id: 1, name: 'Olga', role: 'operator' };
  sweep.mockClear();
  db.prepare('UPDATE parts SET priority_override = 0').run();
  db.prepare('UPDATE projects SET priority_override = 0').run();
});

describe.each([['parts', 'Part'], ['projects', 'Project']])('PUT /api/%s/:id/priority-override', (resource, noun) => {
  test('an operator can set and clear it; setting it sweeps', async () => {
    let res = await request(app).put(`/api/${resource}/1/priority-override`).send({ enabled: true });
    expect(res.status).toBe(200);
    expect(res.body.priority_override).toBe(1);
    expect(sweep).toHaveBeenCalledTimes(1);
    res = await request(app).put(`/api/${resource}/1/priority-override`).send({ enabled: false });
    expect(res.body.priority_override).toBe(0);
  });

  test('an admin can set it', async () => {
    currentUser = { id: 2, name: 'Ada', role: 'admin' };
    expect((await request(app).put(`/api/${resource}/1/priority-override`).send({ enabled: true })).status).toBe(200);
  });

  test('an uploader gets 403 and nothing changes', async () => {
    currentUser = { id: 3, name: 'Uma', role: 'uploader' };
    expect((await request(app).put(`/api/${resource}/1/priority-override`).send({ enabled: true })).status).toBe(403);
    expect(db.prepare(`SELECT priority_override FROM ${resource} WHERE id = 1`).get().priority_override).toBe(0);
  });

  test('400 without a boolean, 404 for an unknown id', async () => {
    expect((await request(app).put(`/api/${resource}/1/priority-override`).send({ enabled: 'yes' })).status).toBe(400);
    const res = await request(app).put(`/api/${resource}/999/priority-override`).send({ enabled: true });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe(`${noun} not found`);
  });

  test('the general PUT /:id cannot set it, even as an operator', async () => {
    await request(app).put(`/api/${resource}/1`).send({ name: 'Renamed', priority_override: 1 });
    expect(db.prepare(`SELECT priority_override FROM ${resource} WHERE id = 1`).get().priority_override).toBe(0);
  });
});
