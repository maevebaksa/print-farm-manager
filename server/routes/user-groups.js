// User groups: admin-managed permission bundles (see user_groups in db.js and
// auth.js's resolvePermissions). Every route is admin-only except the plain
// list, which any signed-in user may read (the Users page and Quick Print need
// group names). System groups (Admin, Operator, Uploader) can have their flags
// edited but never renamed, re-roled, or deleted, and Admin stays fully open.
//
// A group's role is the base role its members get. Custom groups may only be
// operator or uploader based: minting admins stays an explicit act on the user.

const express = require('express');
const auth = require('../auth');

const FLAGS = ['can_approve', 'can_set_ready', 'can_manage_printers', 'can_quick_print', 'requires_approval'];
const CUSTOM_ROLES = new Set(['operator', 'uploader']);

function parseList(text) {
  try { const v = JSON.parse(text); return Array.isArray(v) ? v : null; } catch (_) { return null; }
}

function present(row) {
  return {
    ...row,
    allowed_printer_ids: parseList(row.allowed_printer_ids),
    allowed_printer_groups: parseList(row.allowed_printer_groups),
  };
}

// max_concurrent_plates: how many printers one member's own work may occupy
// at once (server/scheduler.js's _atPrinterCap). undefined = leave alone;
// null/0/'' = unlimited. Returns { error } on a bad value.
function parsePlateCap(body) {
  if (!('max_concurrent_plates' in body)) return { skip: true };
  const v = body.max_concurrent_plates;
  if (v === null || v === '' || v === 0) return { value: null };
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) return { error: 'max_concurrent_plates must be a positive integer or null' };
  return { value: n };
}

// Normalizes the two allowed lists from a request body. undefined = leave
// alone; null or an empty array = unrestricted. Returns { error } on bad input.
function normalizeLists(db, body) {
  const out = {};
  if ('allowed_printer_ids' in body) {
    const raw = body.allowed_printer_ids;
    if (raw === null || (Array.isArray(raw) && raw.length === 0)) out.ids = null;
    else if (!Array.isArray(raw)) return { error: 'allowed_printer_ids must be an array of printer ids or null' };
    else {
      const ids = raw.map(Number);
      if (ids.some(n => !Number.isInteger(n))) return { error: 'allowed_printer_ids must be integers' };
      out.ids = JSON.stringify([...new Set(ids)]);
    }
  }
  if ('allowed_printer_groups' in body) {
    const raw = body.allowed_printer_groups;
    if (raw === null || (Array.isArray(raw) && raw.length === 0)) out.groups = null;
    else if (!Array.isArray(raw) || raw.some(g => typeof g !== 'string')) {
      return { error: 'allowed_printer_groups must be an array of group names or null' };
    } else out.groups = JSON.stringify([...new Set(raw)]);
  }
  return out;
}

module.exports = (db) => {
  const router = express.Router();
  const withMembers = `SELECT g.*, (SELECT COUNT(*) FROM users u WHERE u.user_group_id = g.id) AS member_count FROM user_groups g`;

  // GET /api/user-groups
  router.get('/', (req, res) => {
    res.json(db.prepare(`${withMembers} ORDER BY g.is_system DESC, g.id`).all().map(present));
  });

  // POST /api/user-groups
  router.post('/', auth.requireRole('admin'), (req, res) => {
    const body = req.body || {};
    const name = (body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'name is required' });
    const role = body.role || 'uploader';
    if (!CUSTOM_ROLES.has(role)) {
      return res.status(400).json({ error: `role must be one of: ${[...CUSTOM_ROLES].join(', ')}` });
    }
    const lists = normalizeLists(db, body);
    if (lists.error) return res.status(400).json({ error: lists.error });
    const cap = parsePlateCap(body);
    if (cap.error) return res.status(400).json({ error: cap.error });
    if (db.prepare('SELECT 1 FROM user_groups WHERE name = ? COLLATE NOCASE').get(name)) {
      return res.status(409).json({ error: `A user group named "${name}" already exists` });
    }

    const defaults = auth.ROLE_PERMISSIONS[role];
    const flag = (k) => (k in body ? (body[k] ? 1 : 0) : (defaults[k] ? 1 : 0));
    const result = db.prepare(`
      INSERT INTO user_groups (name, role, can_approve, can_set_ready, can_manage_printers, can_quick_print,
                               can_delete_projects, can_cancel_active_jobs, can_manage_settings, can_manage_others_work, can_cancel_own_active_jobs, can_delete_own_projects,
                               requires_approval, max_concurrent_plates, allowed_printer_ids, allowed_printer_groups,
                               is_system, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
    `).run(name, role, flag('can_approve'), flag('can_set_ready'), flag('can_manage_printers'), flag('can_quick_print'),
           flag('can_delete_projects'), flag('can_cancel_active_jobs'), flag('can_manage_settings'), flag('can_manage_others_work'), flag('can_cancel_own_active_jobs'), flag('can_delete_own_projects'),
           flag('requires_approval'), cap.value ?? null, lists.ids ?? null, lists.groups ?? null, Date.now());
    res.status(201).json(present(db.prepare(`${withMembers} WHERE g.id = ?`).get(result.lastInsertRowid)));
  });

  // PUT /api/user-groups/:id: COALESCE-style partial update. The two printer lists
  // use present-in-body semantics because null is a meaningful value (unrestricted).
  router.put('/:id', auth.requireRole('admin'), (req, res) => {
    const group = db.prepare('SELECT * FROM user_groups WHERE id = ?').get(req.params.id);
    if (!group) return res.status(404).json({ error: 'User group not found' });
    const body = req.body || {};

    if (group.role === 'admin') {
      return res.status(409).json({ error: 'The Admin group is always fully open and cannot be edited' });
    }
    let name = group.name;
    if (body.name !== undefined) {
      if (group.is_system) return res.status(409).json({ error: 'System groups cannot be renamed' });
      name = String(body.name).trim();
      if (!name) return res.status(400).json({ error: 'name cannot be empty' });
      const clash = db.prepare('SELECT id FROM user_groups WHERE name = ? COLLATE NOCASE AND id <> ?').get(name, group.id);
      if (clash) return res.status(409).json({ error: `A user group named "${name}" already exists` });
    }
    let role = group.role;
    if (body.role !== undefined) {
      if (group.is_system && body.role !== group.role) return res.status(409).json({ error: 'System groups cannot change role' });
      if (!CUSTOM_ROLES.has(body.role)) return res.status(400).json({ error: `role must be one of: ${[...CUSTOM_ROLES].join(', ')}` });
      role = body.role;
    }
    const lists = normalizeLists(db, body);
    if (lists.error) return res.status(400).json({ error: lists.error });
    const cap = parsePlateCap(body);
    if (cap.error) return res.status(400).json({ error: cap.error });

    const flag = (k) => (k in body ? (body[k] ? 1 : 0) : group[k]);
    db.transaction(() => {
      db.prepare(`
        UPDATE user_groups
        SET name = ?, role = ?, can_approve = ?, can_set_ready = ?, can_manage_printers = ?,
            can_quick_print = ?, can_delete_projects = ?, can_cancel_active_jobs = ?, can_manage_settings = ?, can_manage_others_work = ?, can_cancel_own_active_jobs = ?, can_delete_own_projects = ?,
            requires_approval = ?, max_concurrent_plates = ?,
            allowed_printer_ids = ?, allowed_printer_groups = ?
        WHERE id = ?
      `).run(name, role, flag('can_approve'), flag('can_set_ready'), flag('can_manage_printers'),
             flag('can_quick_print'), flag('can_delete_projects'), flag('can_cancel_active_jobs'), flag('can_manage_settings'), flag('can_manage_others_work'), flag('can_cancel_own_active_jobs'), flag('can_delete_own_projects'),
             flag('requires_approval'),
             cap.skip ? group.max_concurrent_plates : cap.value,
             'ids' in lists ? lists.ids : group.allowed_printer_ids,
             'groups' in lists ? lists.groups : group.allowed_printer_groups,
             group.id);
      // Members' base role follows the group's role. Never touches an admin
      // account, and a role change here can never demote the last admin because
      // only non-admin groups are editable.
      if (role !== group.role) {
        db.prepare("UPDATE users SET role = ? WHERE user_group_id = ? AND role <> 'admin'").run(role, group.id);
      }
    })();
    res.json(present(db.prepare(`${withMembers} WHERE g.id = ?`).get(group.id)));
  });

  // DELETE /api/user-groups/:id: refused while it has members, so nobody is
  // silently dropped onto different permissions.
  router.delete('/:id', auth.requireRole('admin'), (req, res) => {
    const group = db.prepare('SELECT * FROM user_groups WHERE id = ?').get(req.params.id);
    if (!group) return res.status(404).json({ error: 'User group not found' });
    if (group.is_system) return res.status(409).json({ error: 'System groups cannot be deleted' });
    const members = db.prepare('SELECT COUNT(*) AS n FROM users WHERE user_group_id = ?').get(group.id).n;
    if (members > 0) {
      return res.status(409).json({ error: `Move its ${members} member(s) to another group first` });
    }
    db.prepare('DELETE FROM user_groups WHERE id = ?').run(group.id);
    res.json({ success: true });
  });

  return router;
};
