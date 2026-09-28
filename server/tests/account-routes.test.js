// Tests for PUT /api/account/password (self-service, own account only).

const request  = require('supertest');
const express  = require('express');
const Database = require('better-sqlite3');
const auth      = require('../auth');

let db;
let app;
let currentUser;

function insertUser({ email, password }) {
  const now = Date.now();
  const result = db.prepare(
    'INSERT INTO users (email, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(email, 'Name', password ? auth.hashPassword(password) : null, 'operator', now);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid);
}

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      email         TEXT NOT NULL UNIQUE,
      name          TEXT NOT NULL,
      password_hash TEXT,
      role          TEXT NOT NULL DEFAULT 'operator',
      created_at    INTEGER NOT NULL
    );
  `);
  currentUser = insertUser({ email: 'me@farm.local', password: 'correct-password' });

  app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = currentUser; next(); });
  app.use('/api/account', require('../routes/account')(db));
});

describe('PUT /api/account/password', () => {
  test('changes the password when current_password is correct', async () => {
    const res = await request(app)
      .put('/api/account/password')
      .send({ current_password: 'correct-password', new_password: 'new-password-1' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(currentUser.id);
    expect(auth.verifyPassword('new-password-1', row.password_hash)).toBe(true);
    expect(auth.verifyPassword('correct-password', row.password_hash)).toBe(false);
  });

  test('401s when current_password is wrong', async () => {
    const res = await request(app)
      .put('/api/account/password')
      .send({ current_password: 'wrong-password', new_password: 'new-password-1' });
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/incorrect/i);

    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(currentUser.id);
    expect(auth.verifyPassword('correct-password', row.password_hash)).toBe(true);
  });

  test('400s when new_password is shorter than 8 characters', async () => {
    const res = await request(app)
      .put('/api/account/password')
      .send({ current_password: 'correct-password', new_password: 'short' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/8 characters/i);
  });

  test('400s for an SSO-only account with no password to change', async () => {
    currentUser = insertUser({ email: 'sso@farm.local', password: null });
    const res = await request(app)
      .put('/api/account/password')
      .send({ current_password: 'anything', new_password: 'new-password-1' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no password/i);
  });

  test('404s if the signed-in user no longer exists', async () => {
    currentUser = { ...currentUser, id: 999999 };
    const res = await request(app)
      .put('/api/account/password')
      .send({ current_password: 'correct-password', new_password: 'new-password-1' });
    expect(res.status).toBe(404);
  });
});
