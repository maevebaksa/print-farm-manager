// Tests for server/routes/user-groups.js and the permission helpers in
// server/auth.js (resolvePermissions, hasPermission, printerAllowed).

const request  = require('supertest');
const express  = require('express');
const Database = require('better-sqlite3');
const auth     = require('../auth');

let db, app, currentUser;
const ADMIN = { id: 1, role: 'admin' };

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT, name TEXT, role TEXT NOT NULL DEFAULT 'uploader', user_group_id INTEGER);
    CREATE TABLE user_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, role TEXT NOT NULL DEFAULT 'uploader',
      can_approve INTEGER NOT NULL DEFAULT 0, can_set_ready INTEGER NOT NULL DEFAULT 0,
      can_manage_printers INTEGER NOT NULL DEFAULT 0, can_quick_print INTEGER NOT NULL DEFAULT 1,
      can_delete_projects INTEGER NOT NULL DEFAULT 0, can_cancel_active_jobs INTEGER NOT NULL DEFAULT 0,
      requires_approval INTEGER NOT NULL DEFAULT 0, max_plates_per_upload INTEGER, max_concurrent_plates INTEGER,
      allowed_printer_ids TEXT, allowed_printer_groups TEXT, is_system INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
    );
    INSERT INTO user_groups (name, role, can_approve, can_set_ready, can_manage_printers, is_system, created_at)
      VALUES ('Admin', 'admin', 1, 1, 1, 1, 1), ('Operator', 'operator', 1, 1, 1, 1, 1), ('Uploader', 'uploader', 0, 0, 0, 1, 1);
  `);
  currentUser = ADMIN;
  app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = currentUser; next(); });
  app.use('/api/user-groups', require('../routes/user-groups')(db));
});

describe('user group routes', () => {
  test('lists the three seeded system groups with member counts', async () => {
    const res = await request(app).get('/api/user-groups');
    expect(res.status).toBe(200);
    expect(res.body.map(g => g.name)).toEqual(['Admin', 'Operator', 'Uploader']);
    expect(res.body[0].member_count).toBe(0);
  });

  test('creates a custom group with printer limits and flags', async () => {
    const res = await request(app).post('/api/user-groups').send({
      name: 'Students', role: 'uploader', allowed_printer_ids: [1, '2'], allowed_printer_groups: ['Rack A'],
      requires_approval: true, can_quick_print: false,
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ name: 'Students', is_system: 0, requires_approval: 1, can_quick_print: 0 });
    expect(res.body.allowed_printer_ids).toEqual([1, 2]);
    expect(res.body.allowed_printer_groups).toEqual(['Rack A']);
  });

  test('validation: missing name 400, admin role 400, duplicate 409, bad ids 400', async () => {
    expect((await request(app).post('/api/user-groups').send({})).status).toBe(400);
    expect((await request(app).post('/api/user-groups').send({ name: 'X', role: 'admin' })).status).toBe(400);
    expect((await request(app).post('/api/user-groups').send({ name: 'uploader' })).status).toBe(409);
    expect((await request(app).post('/api/user-groups').send({ name: 'Y', allowed_printer_ids: ['abc'] })).status).toBe(400);
  });

  test('non-admins cannot create, edit, or delete; anyone can list', async () => {
    currentUser = { id: 2, role: 'operator' };
    expect((await request(app).get('/api/user-groups')).status).toBe(200);
    expect((await request(app).post('/api/user-groups').send({ name: 'Z' })).status).toBe(403);
    expect((await request(app).put('/api/user-groups/3').send({ can_set_ready: true })).status).toBe(403);
    expect((await request(app).delete('/api/user-groups/3')).status).toBe(403);
  });

  test('PUT edits flags on a system group but refuses rename, Admin edits, and 404s', async () => {
    expect((await request(app).put('/api/user-groups/3').send({ can_set_ready: true })).body.can_set_ready).toBe(1);
    expect((await request(app).put('/api/user-groups/3').send({ name: 'Nope' })).status).toBe(409);
    expect((await request(app).put('/api/user-groups/1').send({ can_set_ready: false })).status).toBe(409);
    expect((await request(app).put('/api/user-groups/99').send({})).status).toBe(404);
  });

  test('PUT with null clears printer limits', async () => {
    const g = (await request(app).post('/api/user-groups').send({ name: 'G', allowed_printer_ids: [1] })).body;
    const res = await request(app).put(`/api/user-groups/${g.id}`).send({ allowed_printer_ids: null });
    expect(res.body.allowed_printer_ids).toBeNull();
  });

  test('changing a custom group role updates its non-admin members', async () => {
    const g = (await request(app).post('/api/user-groups').send({ name: 'G' })).body;
    db.prepare("INSERT INTO users (id, email, name, role, user_group_id) VALUES (5, 'a', 'A', 'uploader', ?)").run(g.id);
    await request(app).put(`/api/user-groups/${g.id}`).send({ role: 'operator' });
    expect(db.prepare('SELECT role FROM users WHERE id = 5').get().role).toBe('operator');
  });

  test('delete: system group 409, group with members 409, empty custom group 200, unknown 404', async () => {
    expect((await request(app).delete('/api/user-groups/3')).status).toBe(409);
    const g = (await request(app).post('/api/user-groups').send({ name: 'G' })).body;
    db.prepare("INSERT INTO users (id, email, name, role, user_group_id) VALUES (5, 'a', 'A', 'uploader', ?)").run(g.id);
    expect((await request(app).delete(`/api/user-groups/${g.id}`)).status).toBe(409);
    db.prepare('DELETE FROM users WHERE id = 5').run();
    expect((await request(app).delete(`/api/user-groups/${g.id}`)).status).toBe(200);
    expect((await request(app).delete('/api/user-groups/99')).status).toBe(404);
  });
});

describe('permission helpers', () => {
  test('role defaults apply with no group: uploader cannot set ready, operator can', () => {
    expect(auth.hasPermission({ role: 'uploader' }, 'can_set_ready')).toBe(false);
    expect(auth.hasPermission({ role: 'operator' }, 'can_set_ready')).toBe(true);
    expect(auth.hasPermission({ role: 'uploader' }, 'can_quick_print')).toBe(true);
  });

  test('a group overrides role defaults for a non-admin, and admin ignores groups', () => {
    db.prepare("INSERT INTO user_groups (name, role, can_set_ready, can_quick_print, allowed_printer_ids, created_at) VALUES ('Lead', 'uploader', 1, 0, '[4]', 1)").run();
    const gid = db.prepare("SELECT id FROM user_groups WHERE name = 'Lead'").get().id;
    const p = auth.resolvePermissions(db, { role: 'uploader', user_group_id: gid });
    expect(p.can_set_ready).toBe(true);
    expect(p.can_quick_print).toBe(false);
    expect(p.group.name).toBe('Lead');
    expect(auth.printerAllowed(p, { id: 4, group_name: null })).toBe(true);
    expect(auth.printerAllowed(p, { id: 5, group_name: null })).toBe(false);
    const admin = auth.resolvePermissions(db, { role: 'admin', user_group_id: gid });
    expect(admin.allowed_printer_ids).toBeNull();
    expect(auth.hasPermission({ role: 'admin', permissions: p }, 'can_quick_print')).toBe(true);
  });

  test('requirePermission 403s when the flag is off', () => {
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();
    auth.requirePermission('can_set_ready', 'no')({ user: { role: 'uploader' } }, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });
});
