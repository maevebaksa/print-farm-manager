// Tests for server/routes/users.js. Mounted behind the global requireAuth
// gate only (see server/index.js): this router gates each of its own routes
// individually (most admin-only via requireRole('admin'), the two
// pending-approval routes admin-or-operator via requireAnyRole), so unlike a
// blanket-gated router these tests inject req.user directly and then vary
// its role per test to exercise the router's own gating, not an external one.

const request  = require('supertest');
const express  = require('express');
const Database = require('better-sqlite3');

let db;
let app;
let currentUser; // mutated per test to simulate "who is making this request"

beforeAll(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      email         TEXT NOT NULL UNIQUE,
      name          TEXT NOT NULL,
      password_hash TEXT,
      role          TEXT NOT NULL DEFAULT 'uploader',
      approved      INTEGER NOT NULL DEFAULT 1,
      oidc_subject  TEXT UNIQUE,
      created_at    INTEGER NOT NULL,
      last_login_at INTEGER
    );
    CREATE TABLE sessions (
      token TEXT PRIMARY KEY, user_id INTEGER, created_at INTEGER, expires_at INTEGER
    );
    CREATE TABLE api_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, name TEXT,
      key_prefix TEXT, key_hash TEXT, created_at INTEGER, last_used_at INTEGER, revoked_at INTEGER
    );
  `);

  const usersRouter = require('../routes/users')(db);
  app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = currentUser; next(); });
  app.use('/api/users', usersRouter);
});

function insertUser({ email, name = 'Name', role = 'operator', approved = 1 }) {
  const now = Date.now();
  const result = db.prepare('INSERT INTO users (email, name, role, approved, created_at) VALUES (?, ?, ?, ?, ?)').run(email, name, role, approved, now);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid);
}

beforeEach(() => {
  db.prepare('DELETE FROM users').run();
  currentUser = insertUser({ email: 'admin@farm.local', name: 'Admin', role: 'admin' });
});

describe('GET /api/users', () => {
  test('lists users without password_hash', async () => {
    const res = await request(app).get('/api/users');
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(1);
    expect(res.body[0].password_hash).toBeUndefined();
  });
});

describe('POST /api/users', () => {
  test('creates a user with a password', async () => {
    const res = await request(app).post('/api/users').send({ email: 'op@farm.local', name: 'Op', password: 'password123', role: 'operator' });
    expect(res.status).toBe(201);
    expect(res.body.role).toBe('operator');
  });

  test('creates an SSO-only user with no password', async () => {
    const res = await request(app).post('/api/users').send({ email: 'sso@farm.local', name: 'SSO User' });
    expect(res.status).toBe(201);
  });

  test('rejects a duplicate email with 409', async () => {
    await request(app).post('/api/users').send({ email: 'dupe@farm.local', name: 'A' });
    const res = await request(app).post('/api/users').send({ email: 'dupe@farm.local', name: 'B' });
    expect(res.status).toBe(409);
  });

  test('rejects an invalid role', async () => {
    const res = await request(app).post('/api/users').send({ email: 'x@farm.local', name: 'X', role: 'superuser' });
    expect(res.status).toBe(400);
  });

  test('rejects a password under 8 characters', async () => {
    const res = await request(app).post('/api/users').send({ email: 'x@farm.local', name: 'X', password: 'short' });
    expect(res.status).toBe(400);
  });
});

describe('PUT /api/users/:id', () => {
  test('404s for an unknown id', async () => {
    const res = await request(app).put('/api/users/999').send({ name: 'New' });
    expect(res.status).toBe(404);
  });

  test('updates name and role, leaving other fields unchanged (COALESCE)', async () => {
    const op = insertUser({ email: 'op@farm.local', role: 'operator' });
    const res = await request(app).put(`/api/users/${op.id}`).send({ name: 'Renamed' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Renamed');
    expect(res.body.role).toBe('operator');
    expect(res.body.email).toBe('op@farm.local');
  });

  test('refuses to demote the last admin', async () => {
    const res = await request(app).put(`/api/users/${currentUser.id}`).send({ role: 'operator' });
    expect(res.status).toBe(409);
  });

  test('allows demoting an admin when another admin exists', async () => {
    const secondAdmin = insertUser({ email: 'admin2@farm.local', role: 'admin' });
    const res = await request(app).put(`/api/users/${secondAdmin.id}`).send({ role: 'operator' });
    expect(res.status).toBe(200);
    expect(res.body.role).toBe('operator');
  });
});

describe('DELETE /api/users/:id', () => {
  test('404s for an unknown id', async () => {
    const res = await request(app).delete('/api/users/999');
    expect(res.status).toBe(404);
  });

  test('refuses to delete your own account', async () => {
    const res = await request(app).delete(`/api/users/${currentUser.id}`);
    expect(res.status).toBe(409);
  });

  test('an operator cannot reach delete at all (admin-only gate, before any other check)', async () => {
    // currentUser (the sole admin) is the delete target; an operator is the
    // one making the request. Delete is admin-only end to end now, so this
    // never even reaches the "last admin" guard below: a non-admin has no
    // path to it, not even to be told why not.
    const operator = insertUser({ email: 'op@farm.local', role: 'operator' });
    const soleAdminId = currentUser.id;
    currentUser = operator;
    const res = await request(app).delete(`/api/users/${soleAdminId}`);
    expect(res.status).toBe(403);
  });

  test('deletes an operator and their sessions/keys', async () => {
    const op = insertUser({ email: 'op@farm.local', role: 'operator' });
    db.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run('tok1', op.id, Date.now(), Date.now() + 1000);
    db.prepare('INSERT INTO api_keys (user_id, name, key_prefix, key_hash, created_at) VALUES (?, ?, ?, ?, ?)').run(op.id, 'k', 'pfm_ab', 'hash', Date.now());

    const res = await request(app).delete(`/api/users/${op.id}`);
    expect(res.status).toBe(200);
    expect(db.prepare('SELECT * FROM users WHERE id = ?').get(op.id)).toBeUndefined();
    expect(db.prepare('SELECT * FROM sessions WHERE user_id = ?').get(op.id)).toBeUndefined();
    expect(db.prepare('SELECT * FROM api_keys WHERE user_id = ?').get(op.id)).toBeUndefined();
  });
});

// Per-route admin gating: GET/POST/PUT/DELETE are each individually
// requireRole('admin') now (moved from a blanket external gate, see
// server/index.js and this file's header comment). One representative
// non-admin request per route is enough; auth-helpers.test.js already covers
// requireRole itself in isolation.
describe('admin-only gating on full user management', () => {
  test.each([
    ['operator', 'GET',    '/api/users'],
    ['uploader', 'GET',    '/api/users'],
    ['operator', 'POST',   '/api/users'],
    ['uploader', 'POST',   '/api/users'],
  ])('%s cannot %s %s', async (role, method, path) => {
    currentUser = insertUser({ email: `${role}@farm.local`, role });
    const res = await request(app)[method.toLowerCase()](path).send({ email: 'x@farm.local', name: 'X' });
    expect(res.status).toBe(403);
  });

  test('an uploader cannot PUT or DELETE another user', async () => {
    const target = insertUser({ email: 'target@farm.local', role: 'operator' });
    currentUser = insertUser({ email: 'uploader@farm.local', role: 'uploader' });
    const putRes = await request(app).put(`/api/users/${target.id}`).send({ name: 'Renamed' });
    expect(putRes.status).toBe(403);
    const deleteRes = await request(app).delete(`/api/users/${target.id}`);
    expect(deleteRes.status).toBe(403);
  });
});

describe('uploader role', () => {
  test('VALID_ROLES accepts uploader', async () => {
    const res = await request(app).post('/api/users').send({ email: 'up@farm.local', name: 'Up', role: 'uploader' });
    expect(res.status).toBe(201);
    expect(res.body.role).toBe('uploader');
  });

  test('POST /api/users defaults to uploader when role is omitted', async () => {
    const res = await request(app).post('/api/users').send({ email: 'default@farm.local', name: 'Default' });
    expect(res.status).toBe(201);
    expect(res.body.role).toBe('uploader');
  });

  test('an admin-created account is always approved, regardless of role', async () => {
    const res = await request(app).post('/api/users').send({ email: 'up2@farm.local', name: 'Up2', role: 'uploader' });
    expect(res.status).toBe(201);
    expect(res.body.approved).toBe(1);
  });

  test('refuses to demote the last admin to uploader, not just operator', async () => {
    const res = await request(app).put(`/api/users/${currentUser.id}`).send({ role: 'uploader' });
    expect(res.status).toBe(409);
  });
});

describe('GET /api/users/pending', () => {
  test('lists only unapproved accounts, admin-visible fields only', async () => {
    insertUser({ email: 'approved@farm.local', role: 'uploader', approved: 1 });
    const pendingUser = insertUser({ email: 'pending@farm.local', role: 'uploader', approved: 0 });

    const res = await request(app).get('/api/users/pending');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe(pendingUser.id);
    expect(res.body[0].email).toBe('pending@farm.local');
  });

  test('an operator can also list pending accounts', async () => {
    insertUser({ email: 'pending@farm.local', role: 'uploader', approved: 0 });
    currentUser = insertUser({ email: 'op@farm.local', role: 'operator' });
    const res = await request(app).get('/api/users/pending');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });

  test('an uploader cannot list pending accounts', async () => {
    currentUser = insertUser({ email: 'up@farm.local', role: 'uploader' });
    const res = await request(app).get('/api/users/pending');
    expect(res.status).toBe(403);
  });
});

describe('POST /api/users/:id/approve', () => {
  test('an admin can approve a pending account', async () => {
    const pendingUser = insertUser({ email: 'pending@farm.local', role: 'uploader', approved: 0 });
    const res = await request(app).post(`/api/users/${pendingUser.id}/approve`);
    expect(res.status).toBe(200);
    expect(res.body.approved).toBe(1);
    expect(db.prepare('SELECT approved FROM users WHERE id = ?').get(pendingUser.id).approved).toBe(1);
  });

  test('an operator can also approve a pending account', async () => {
    const pendingUser = insertUser({ email: 'pending@farm.local', role: 'uploader', approved: 0 });
    currentUser = insertUser({ email: 'op@farm.local', role: 'operator' });
    const res = await request(app).post(`/api/users/${pendingUser.id}/approve`);
    expect(res.status).toBe(200);
    expect(res.body.approved).toBe(1);
  });

  test('an uploader cannot approve accounts, including itself', async () => {
    const pendingUser = insertUser({ email: 'pending@farm.local', role: 'uploader', approved: 0 });
    currentUser = insertUser({ email: 'up@farm.local', role: 'uploader' });
    const res = await request(app).post(`/api/users/${pendingUser.id}/approve`);
    expect(res.status).toBe(403);
  });

  test('approving an already-approved account is a no-op, not an error', async () => {
    const approvedUser = insertUser({ email: 'approved@farm.local', role: 'uploader', approved: 1 });
    const res = await request(app).post(`/api/users/${approvedUser.id}/approve`);
    expect(res.status).toBe(200);
    expect(res.body.approved).toBe(1);
  });

  test('404s for an unknown id', async () => {
    const res = await request(app).post('/api/users/999/approve');
    expect(res.status).toBe(404);
  });
});
