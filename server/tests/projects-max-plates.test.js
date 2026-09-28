// Tests for PUT /api/projects/:id's max_concurrent_plates field: the
// user-defined, per-project cap on how many printers a project's own work may
// occupy at once (see server/scheduler.js's _atPrinterCap). Replaces the
// earlier admin-only max_printers_per_part/max_printers_per_project settings.

const request  = require('supertest');
const express  = require('express');
const Database = require('better-sqlite3');

let db, app, projectId;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      status TEXT DEFAULT 'draft',
      max_concurrent_plates INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  const now = Date.now();
  const r = db.prepare("INSERT INTO projects (name, status, created_at, updated_at) VALUES ('P', 'active', ?, ?)").run(now, now);
  projectId = r.lastInsertRowid;

  app = express();
  app.use(express.json());
  app.use('/api/projects', require('../routes/projects')(db, null));
});

describe('PUT /api/projects/:id max_concurrent_plates', () => {
  test('sets a cap', async () => {
    const res = await request(app).put(`/api/projects/${projectId}`).send({ max_concurrent_plates: 2 });
    expect(res.status).toBe(200);
    expect(res.body.max_concurrent_plates).toBe(2);
  });

  test('null clears it back to unlimited', async () => {
    await request(app).put(`/api/projects/${projectId}`).send({ max_concurrent_plates: 3 });
    const res = await request(app).put(`/api/projects/${projectId}`).send({ max_concurrent_plates: null });
    expect(res.status).toBe(200);
    expect(res.body.max_concurrent_plates).toBeNull();
  });

  test('0 also clears it back to unlimited', async () => {
    await request(app).put(`/api/projects/${projectId}`).send({ max_concurrent_plates: 3 });
    const res = await request(app).put(`/api/projects/${projectId}`).send({ max_concurrent_plates: 0 });
    expect(res.status).toBe(200);
    expect(res.body.max_concurrent_plates).toBeNull();
  });

  test('omitting it entirely leaves the existing cap unchanged', async () => {
    await request(app).put(`/api/projects/${projectId}`).send({ max_concurrent_plates: 5 });
    const res = await request(app).put(`/api/projects/${projectId}`).send({ description: 'note' });
    expect(res.status).toBe(200);
    expect(res.body.max_concurrent_plates).toBe(5);
  });

  test('rejects a negative or non-integer value', async () => {
    expect((await request(app).put(`/api/projects/${projectId}`).send({ max_concurrent_plates: -1 })).status).toBe(400);
    expect((await request(app).put(`/api/projects/${projectId}`).send({ max_concurrent_plates: 1.5 })).status).toBe(400);
  });

  test('404 for an unknown project', async () => {
    const res = await request(app).put('/api/projects/99999').send({ max_concurrent_plates: 2 });
    expect(res.status).toBe(404);
  });
});
