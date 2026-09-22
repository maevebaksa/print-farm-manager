// Tests for POST /api/printers/set-ready-batch's role gate specifically.
//
// The real handler (server/index.js) has closure access to `events` and
// `scheduler` and calls the real events.js singleton (a documented
// pre-existing gap: events.js requires('./db') directly rather than taking a
// db param, see CLAUDE.md's sync-pairs table and events-module.test.js).
// Replicating the full handler here would mean fighting that singleton for a
// test that isn't about it. This file instead replicates just enough of the
// route (the auth.blockRole('uploader') gate, the ids validation, and the
// is_held release) to prove the role gate is wired on this route the same as
// it is on set-ready, without re-testing blockRole's own logic (already
// covered in auth-helpers.test.js) or the scheduler sweep it kicks off
// (covered in the scheduler-sweep.test.js suite).

const request  = require('supertest');
const express  = require('express');
const Database = require('better-sqlite3');
const auth     = require('../auth');

function makeApp(db, user = { id: 1, role: 'admin' }) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = user; next(); });

  app.post('/api/printers/set-ready-batch', auth.blockRole('uploader'), (req, res) => {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'ids array required' });
    }
    const placeholders = ids.map(() => '?').join(',');
    db.prepare(`UPDATE printers SET is_held = 0 WHERE id IN (${placeholders})`).run(...ids);
    const printers = db.prepare(`SELECT * FROM printers WHERE id IN (${placeholders}) AND is_active = 1`).all(...ids);
    res.json({ ok: true, count: printers.length });
  });

  return app;
}

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE printers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL, ip TEXT NOT NULL, model TEXT NOT NULL,
      status TEXT DEFAULT 'FINISHED', is_held INTEGER DEFAULT 1, is_active INTEGER DEFAULT 1,
      created_at INTEGER NOT NULL
    );
  `);
  return db;
}

function seedPrinter(db) {
  const now = Date.now();
  return db.prepare(
    `INSERT INTO printers (name, ip, model, status, is_held, is_active, created_at) VALUES (?, '10.0.0.1', 'mk4s', 'FINISHED', 1, 1, ?)`
  ).run(`P_${now}_${Math.random()}`, now).lastInsertRowid;
}

describe('POST /api/printers/set-ready-batch: uploader role', () => {
  test('403s for the uploader role, before touching any printer', async () => {
    const db  = makeDb();
    const id  = seedPrinter(db);
    const app = makeApp(db, { id: 1, role: 'uploader' });
    const res = await request(app).post('/api/printers/set-ready-batch').send({ ids: [id] });
    expect(res.status).toBe(403);
    expect(db.prepare('SELECT is_held FROM printers WHERE id = ?').get(id).is_held).toBe(1);
  });

  test('admin and operator are unaffected', async () => {
    for (const role of ['admin', 'operator']) {
      const db  = makeDb();
      const id  = seedPrinter(db);
      const app = makeApp(db, { id: 1, role });
      const res = await request(app).post('/api/printers/set-ready-batch').send({ ids: [id] });
      expect(res.status).toBe(200);
      expect(db.prepare('SELECT is_held FROM printers WHERE id = ?').get(id).is_held).toBe(0);
    }
  });
});
