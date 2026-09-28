// Uploaders queue prints; they must not add, remove, or reconfigure printers
// (auth.blockUploaderPrinterAdmin). Every gated route 403s for an uploader
// before touching the DB, while operators and admins keep full access, and
// read-only routes stay open to everyone.

const request  = require('supertest');
const express  = require('express');
const Database = require('better-sqlite3');
const auth     = require('../auth');

let db;
let app;
let currentUser;

const UPLOADER = { id: 3, name: 'Uma', role: 'uploader' };
const OPERATOR = { id: 2, name: 'Otto', role: 'operator' };

beforeAll(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE printer_models (model_id TEXT PRIMARY KEY, label TEXT NOT NULL, connector TEXT NOT NULL);
    CREATE TABLE printer_groups (name TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
    CREATE TABLE printers (id INTEGER PRIMARY KEY, name TEXT, model TEXT, group_name TEXT, is_active INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE gcodes (id INTEGER PRIMARY KEY, allowed_groups TEXT);
    CREATE TABLE projects (id INTEGER PRIMARY KEY, allowed_groups TEXT);
  `);
  db.prepare("INSERT INTO printer_models VALUES ('mk4s', 'MK4S', 'prusa')").run();
  db.prepare("INSERT INTO printer_groups VALUES ('Rack A', 1)").run();
  db.prepare("INSERT INTO printers (id, name, model) VALUES (1, 'mini1', 'mk4s')").run();

  app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = currentUser; next(); });
  app.use('/api/printers', require('../routes/printers')(db));
  app.use('/api/models',   require('../routes/models')(db));
  app.use('/api/groups',   require('../routes/groups')(db));
  app.use('/api/backup',   require('../routes/backup')(db));
  // server/index.js mounts recommission inline (it needs the scheduler); the
  // same middleware guards it there. Mirrored here with a stub handler.
  app.post('/api/printers/:id/recommission', auth.blockUploaderPrinterAdmin, (req, res) => res.json({ ok: true }));
});

beforeEach(() => { currentUser = UPLOADER; });

const GATED = [
  ['post',   '/api/printers',                               { name: 'x', ip: '1.2.3.4', model: 'mk4s', type: 'prusa' }],
  ['post',   '/api/printers/import',                        {}],
  ['put',    '/api/printers/1',                             { group_name: 'Rack A' }],
  ['delete', '/api/printers/1',                             null],
  ['post',   '/api/printers/1/decommission',                {}],
  ['post',   '/api/printers/1/complete-and-decommission',   {}],
  ['post',   '/api/printers/1/recommission',                {}],
  ['post',   '/api/printers/test-connection',               { ip: '127.0.0.1', type: 'prusa' }],
  ['post',   '/api/printers/list-cameras',                  { ip: '127.0.0.1', type: 'klipper' }],
  ['post',   '/api/models',                                 { model_id: 'xl', label: 'XL', connector: 'prusa' }],
  ['delete', '/api/models/mk4s',                            null],
  ['post',   '/api/groups',                                 { name: 'Rack B' }],
  ['delete', '/api/groups/Rack%20A',                        null],
  ['post',   '/api/backup/restore',                         {}],
];

describe('uploader is blocked from printer management', () => {
  test.each(GATED)('%s %s returns 403', async (method, url, body) => {
    let req = request(app)[method](url);
    if (body) req = req.send(body);
    const res = await req;
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/Uploaders cannot/);
  });

  test('nothing was changed by the blocked requests', () => {
    expect(db.prepare('SELECT COUNT(*) AS n FROM printer_models').get().n).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM printer_groups').get().n).toBe(1);
    expect(db.prepare('SELECT * FROM printers WHERE id = 1').get()).toMatchObject({ name: 'mini1', group_name: null, is_active: 1 });
  });

  test('read-only routes stay open to an uploader', async () => {
    expect((await request(app).get('/api/models')).status).toBe(200);
    expect((await request(app).get('/api/groups')).status).toBe(200);
  });
});

describe('operators keep printer management', () => {
  beforeEach(() => { currentUser = OPERATOR; });

  test('an operator can add and delete a printer model', async () => {
    expect((await request(app).post('/api/models').send({ model_id: 'xl', label: 'XL', connector: 'prusa' })).status).toBe(201);
    expect((await request(app).delete('/api/models/xl')).status).toBe(200);
  });

  test('an operator can add a group', async () => {
    const res = await request(app).post('/api/groups').send({ name: 'Rack B' });
    expect(res.status).toBe(201);
  });

  test('an operator passes the gate on recommission', async () => {
    expect((await request(app).post('/api/printers/1/recommission').send({})).status).toBe(200);
  });
});
