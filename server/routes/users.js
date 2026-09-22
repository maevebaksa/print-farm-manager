// User management. Mounted behind the global requireAuth gate (see
// server/index.js) but NOT a blanket role gate: most routes here are
// admin-only (full account management: create, edit, delete, change role),
// applied per-route with auth.requireRole('admin'). The two pending-approval
// routes (GET /pending, POST /:id/approve) use auth.requireAnyRole(['admin',
// 'operator']) instead, since approving a new uploader account is meant to be
// an everyday operator action, not something that needs an admin specifically
// (see docs/auth.md's Roles section and the require_uploader_approval setting).

const express = require('express');
const router = express.Router();
const auth = require('../auth');

const VALID_ROLES = new Set(['admin', 'operator', 'uploader']);
const USER_FIELDS = 'id, email, name, role, approved, oidc_subject, created_at, last_login_at';

function countAdmins(db) {
  return db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin'").get().count;
}

module.exports = (db) => {
  // GET /api/users/pending: admin-or-operator. This endpoint exists so an
  // operator can review and approve without reaching GET / and the rest of
  // the full admin-only user management surface. Must be declared before any
  // GET /:id-shaped route, if one is ever added.
  router.get('/pending', auth.requireAnyRole(['admin', 'operator']), (req, res) => {
    const pending = db.prepare(
      `SELECT id, email, name, role, created_at FROM users WHERE approved = 0 ORDER BY created_at`
    ).all();
    res.json(pending);
  });

  // POST /api/users/:id/approve: admin-or-operator. The only write this
  // router allows a non-admin to make: flips approved 0 -> 1, nothing else
  // about the account. Idempotent (approving an already-approved account is
  // a no-op, not an error) so a double-click or a stale pending list doesn't
  // need special handling client-side.
  router.post('/:id/approve', auth.requireAnyRole(['admin', 'operator']), (req, res) => {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    db.prepare('UPDATE users SET approved = 1 WHERE id = ?').run(user.id);
    console.log(`[users] ${user.email} approved by ${req.user.email} (${req.user.role})`);
    res.json(db.prepare(`SELECT ${USER_FIELDS} FROM users WHERE id = ?`).get(user.id));
  });

  // GET /api/users
  router.get('/', auth.requireRole('admin'), (req, res) => {
    const users = db.prepare(`SELECT ${USER_FIELDS} FROM users ORDER BY created_at`).all();
    res.json(users);
  });

  // POST /api/users: admin creates an account for someone else. password is
  // optional: omit it for an OIDC-only account (they sign in via SSO, never
  // set a local password) and the admin communicates the OIDC provider's
  // enrollment out of band. Always created approved: an admin creating the
  // account directly has already made the call the approval workflow exists
  // to gate (see require_uploader_approval, which only applies to an account
  // that appears on its own via OIDC auto-provisioning).
  router.post('/', auth.requireRole('admin'), (req, res) => {
    const { email, name, password, role } = req.body || {};
    if (!email || !name) {
      return res.status(400).json({ error: 'email and name are required' });
    }
    const resolvedRole = role || 'uploader';
    if (!VALID_ROLES.has(resolvedRole)) {
      return res.status(400).json({ error: `role must be one of: ${[...VALID_ROLES].join(', ')}` });
    }
    if (password && password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }
    try {
      const now = Date.now();
      const result = db.prepare(`
        INSERT INTO users (email, name, password_hash, role, approved, created_at)
        VALUES (?, ?, ?, ?, 1, ?)
      `).run(email.trim().toLowerCase(), name.trim(), password ? auth.hashPassword(password) : null, resolvedRole, now);
      res.status(201).json(db.prepare(
        `SELECT ${USER_FIELDS} FROM users WHERE id = ?`
      ).get(result.lastInsertRowid));
    } catch (err) {
      if (err.message.includes('UNIQUE')) {
        return res.status(409).json({ error: `A user with email "${email}" already exists` });
      }
      throw err;
    }
  });

  // PUT /api/users/:id: update name, role, or reset password. COALESCE
  // keeps omitted fields unchanged, matching every other route in this app.
  router.put('/:id', auth.requireRole('admin'), (req, res) => {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const { name, role, password, approved } = req.body || {};
    if (role !== undefined && !VALID_ROLES.has(role)) {
      return res.status(400).json({ error: `role must be one of: ${[...VALID_ROLES].join(', ')}` });
    }
    // Guard against locking the farm out of its own admin panel: refuse to
    // demote the last remaining admin, including demoting yourself. Checked
    // against "not admin" rather than naming 'operator' specifically, so this
    // still catches a demotion to any other role (uploader included).
    if (role !== undefined && role !== 'admin' && user.role === 'admin' && countAdmins(db) <= 1) {
      return res.status(409).json({ error: 'Cannot demote the last admin account' });
    }
    if (password && password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    db.prepare(`
      UPDATE users
      SET name = COALESCE(?, name),
          role = COALESCE(?, role),
          approved = COALESCE(?, approved),
          password_hash = COALESCE(?, password_hash)
      WHERE id = ?
    `).run(name ?? null, role ?? null, approved === undefined ? null : (approved ? 1 : 0), password ? auth.hashPassword(password) : null, req.params.id);

    res.json(db.prepare(`SELECT ${USER_FIELDS} FROM users WHERE id = ?`).get(req.params.id));
  });

  // DELETE /api/users/:id
  router.delete('/:id', auth.requireRole('admin'), (req, res) => {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (String(req.user.id) === String(req.params.id)) {
      return res.status(409).json({ error: 'Cannot delete your own account while signed in as it' });
    }
    if (user.role === 'admin' && countAdmins(db) <= 1) {
      return res.status(409).json({ error: 'Cannot delete the last admin account' });
    }
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
    db.prepare('DELETE FROM api_keys WHERE user_id = ?').run(user.id);
    db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
    res.json({ success: true });
  });

  return router;
};
