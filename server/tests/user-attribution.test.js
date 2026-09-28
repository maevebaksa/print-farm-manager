// Tests that projects, parts, and duplicated G-codes record who created or
// uploaded them (created_by_* / uploaded_by_*, see db.js's migration comment).
// G-code upload attribution is covered in gcodes.test.js, jobs' joined owner
// fields in jobs-route.test.js.

const request  = require('supertest');
const express  = require('express');
const Database = require('better-sqlite3');

let db;
let app;
let currentUser;

beforeAll(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, description TEXT,
      status TEXT DEFAULT 'draft', priority INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      created_by_user_id INTEGER, created_by_name TEXT, priority_override INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE parts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL REFERENCES projects(id),
      name TEXT NOT NULL, target_qty INTEGER NOT NULL, completed_qty INTEGER DEFAULT 0,
      status TEXT DEFAULT 'open', sort_order INTEGER NOT NULL DEFAULT 0,
      print_time_seconds INTEGER, material_grams REAL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      created_by_user_id INTEGER, created_by_name TEXT, priority_override INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE gcodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT, part_id INTEGER NOT NULL REFERENCES parts(id),
      printer_model TEXT NOT NULL, filename TEXT NOT NULL, filepath TEXT NOT NULL,
      parts_per_plate INTEGER NOT NULL, est_print_secs INTEGER, material_grams REAL,
      ams_slot INTEGER, created_at INTEGER NOT NULL,
      uploaded_by_user_id INTEGER, uploaded_by_name TEXT
    );
    CREATE TABLE jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, part_id INTEGER NOT NULL REFERENCES parts(id),
      printer_id INTEGER NOT NULL, gcode_id INTEGER, parts_per_plate INTEGER NOT NULL,
      status TEXT DEFAULT 'queued', started_at INTEGER, finished_at INTEGER, created_at INTEGER NOT NULL
    );
  `);

  app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = currentUser; next(); });
  app.use('/api/projects', require('../routes/projects')(db, null));
  app.use('/api/parts', require('../routes/parts')(db));
});

beforeEach(() => { currentUser = { id: 1, name: 'Alice', role: 'operator' }; });

describe('created_by attribution', () => {
  test('POST /api/projects records the creating user', async () => {
    const res = await request(app).post('/api/projects').send({ name: 'Brackets' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ created_by_user_id: 1, created_by_name: 'Alice' });
  });

  test('POST /api/parts records the creating user, visible on GET', async () => {
    const project = (await request(app).post('/api/projects').send({ name: 'P' })).body;
    currentUser = { id: 2, name: 'Bob', role: 'uploader' };
    const res = await request(app).post('/api/parts').send({ project_id: project.id, name: 'Clip', target_qty: 4 });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ created_by_user_id: 2, created_by_name: 'Bob' });

    const list = await request(app).get(`/api/parts?project_id=${project.id}`);
    expect(list.body[0].created_by_name).toBe('Bob');
  });

  test('a validation failure still 400s and creates nothing', async () => {
    const res = await request(app).post('/api/parts').send({ name: 'No project' });
    expect(res.status).toBe(400);
  });

  test('the name is a snapshot: renaming the user later does not change it', async () => {
    const res = await request(app).post('/api/projects').send({ name: 'Snapshot' });
    currentUser = { id: 1, name: 'Alice Renamed', role: 'operator' };
    const row = db.prepare('SELECT created_by_name FROM projects WHERE id = ?').get(res.body.id);
    expect(row.created_by_name).toBe('Alice');
  });
});

describe('POST /api/projects/:id/duplicate attribution', () => {
  test('the duplicator owns the new project and parts; copied G-code keeps its uploader', async () => {
    const now = Date.now();
    const projectId = db.prepare(
      "INSERT INTO projects (name, created_at, updated_at, created_by_user_id, created_by_name) VALUES ('Src', ?, ?, 2, 'Bob')"
    ).run(now, now).lastInsertRowid;
    const partId = db.prepare(
      "INSERT INTO parts (project_id, name, target_qty, created_at, updated_at, created_by_user_id, created_by_name) VALUES (?, 'Part', 3, ?, ?, 2, 'Bob')"
    ).run(projectId, now, now).lastInsertRowid;
    db.prepare(
      "INSERT INTO gcodes (part_id, printer_model, filename, filepath, parts_per_plate, created_at, uploaded_by_user_id, uploaded_by_name) VALUES (?, 'mk4s', 'a.gcode', 'missing_on_disk.gcode', 1, ?, 2, 'Bob')"
    ).run(partId, now);

    currentUser = { id: 1, name: 'Alice', role: 'operator' };
    const res = await request(app).post(`/api/projects/${projectId}/duplicate`).send({});
    expect(res.status).toBe(201);
    expect(res.body.project).toMatchObject({ created_by_user_id: 1, created_by_name: 'Alice' });

    const newPart = db.prepare('SELECT * FROM parts WHERE project_id = ?').get(res.body.project.id);
    expect(newPart).toMatchObject({ created_by_user_id: 1, created_by_name: 'Alice' });
    const newGcode = db.prepare('SELECT * FROM gcodes WHERE part_id = ?').get(newPart.id);
    expect(newGcode).toMatchObject({ uploaded_by_user_id: 2, uploaded_by_name: 'Bob' });
  });
});
