// Authentication core: password hashing, session cookies, and API key
// verification. No framework (no express-session, no passport): sessions are
// a random opaque token in an httpOnly cookie, looked up against the sessions
// table on every request, matching this repo's hand-rolled, synchronous,
// better-sqlite3-only conventions.
//
// Two ways a request authenticates, checked in this order by requireAuth:
//   1. Authorization: Bearer <api_key>  : for scripts, OrcaSlicer, automation
//   2. Cookie: pfm_session=<token>      : for the browser client

const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const SESSION_COOKIE = 'pfm_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const BCRYPT_ROUNDS = 12;
const API_KEY_PREFIX = 'pfm_';
const API_KEY_DISPLAY_PREFIX_LEN = 12; // "pfm_" + 8 hex chars, shown in the UI to tell keys apart

// ─── Passwords ──────────────────────────────────────────────────────────────

function hashPassword(password) {
  return bcrypt.hashSync(password, BCRYPT_ROUNDS);
}

function verifyPassword(password, hash) {
  if (!hash) return false; // OIDC-only user has no password_hash
  return bcrypt.compareSync(password, hash);
}

// ─── Sessions ───────────────────────────────────────────────────────────────

function createSession(db, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  db.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(token, userId, now, now + SESSION_TTL_MS);
  return token;
}

function destroySession(db, token) {
  if (!token) return;
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

// Deletes rows past expiry. Called opportunistically on login/session lookup
// rather than on a timer: this app has no background job runner beyond the
// poller, and sessions are looked up on nearly every request anyway.
function pruneExpiredSessions(db) {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
}

function getUserBySession(db, token) {
  if (!token) return null;
  const row = db.prepare(`
    SELECT u.* FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token = ? AND s.expires_at > ?
  `).get(token, Date.now());
  return row || null;
}

// ─── API keys ───────────────────────────────────────────────────────────────

// Returns { plaintext, prefix, hash }: plaintext is shown to the operator
// exactly once (at creation time); only hash is ever persisted.
function generateApiKey() {
  const plaintext = API_KEY_PREFIX + crypto.randomBytes(24).toString('hex');
  return {
    plaintext,
    prefix: plaintext.slice(0, API_KEY_DISPLAY_PREFIX_LEN),
    hash: bcrypt.hashSync(plaintext, BCRYPT_ROUNDS),
  };
}

// API keys act as their owning user (full-access automation keys, not scoped).
// bcrypt has no lookup-by-value, so every non-revoked key sharing this
// plaintext's display prefix is compared in turn: the prefix keeps this list
// short (collisions are unlikely, and impossible without also brute-forcing
// the rest of the key) without ever storing the plaintext key itself.
function getUserByApiKey(db, plaintext) {
  if (!plaintext || !plaintext.startsWith(API_KEY_PREFIX)) return null;
  const prefix = plaintext.slice(0, API_KEY_DISPLAY_PREFIX_LEN);
  const candidates = db.prepare(
    'SELECT * FROM api_keys WHERE key_prefix = ? AND revoked_at IS NULL'
  ).all(prefix);

  for (const key of candidates) {
    if (bcrypt.compareSync(plaintext, key.key_hash)) {
      db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(Date.now(), key.id);
      return db.prepare('SELECT * FROM users WHERE id = ?').get(key.user_id) || null;
    }
  }
  return null;
}

// ─── Cookies ────────────────────────────────────────────────────────────────

// Minimal hand-rolled cookie handling: this app has exactly one cookie, so a
// dependency (cookie-parser) buys nothing but another package to keep patched.
function parseCookies(req) {
  const header = req.headers.cookie;
  if (!header) return {};
  const out = {};
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const val = part.slice(eq + 1).trim();
    if (key) out[key] = decodeURIComponent(val);
  }
  return out;
}

function setSessionCookie(req, res, token) {
  const secure = req.protocol === 'https' ? ' Secure;' : '';
  res.setHeader('Set-Cookie',
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly;${secure} SameSite=Lax; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`
  );
}

function clearSessionCookie(req, res) {
  const secure = req.protocol === 'https' ? ' Secure;' : '';
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly;${secure} SameSite=Lax; Path=/; Max-Age=0`);
}

// ─── Permissions (user groups) ──────────────────────────────────────────────

// What each built-in role may do when the account has no group (or in tests
// that inject a bare req.user). A user group (user_groups table) overrides
// these flags for a non-admin member; admin is always fully open so the farm
// can never lock itself out of management.
const ROLE_PERMISSIONS = {
  admin:    { can_approve: true,  can_set_ready: true,  can_manage_printers: true,  can_quick_print: true, requires_approval: false },
  operator: { can_approve: true,  can_set_ready: true,  can_manage_printers: true,  can_quick_print: true, requires_approval: false },
  uploader: { can_approve: false, can_set_ready: false, can_manage_printers: false, can_quick_print: true, requires_approval: false },
};

function parseJsonArray(text) {
  if (!text) return null;
  try { const v = JSON.parse(text); return Array.isArray(v) ? v : null; } catch (_) { return null; }
}

// Effective permissions for a users row: the group's flags when the user has
// one (and is not an admin), otherwise the role defaults. allowed_printer_ids /
// allowed_printer_groups are both null when unrestricted.
function resolvePermissions(db, user) {
  const base = ROLE_PERMISSIONS[user.role] || ROLE_PERMISSIONS.uploader;
  const open = { ...base, max_plates_per_upload: null, allowed_printer_ids: null, allowed_printer_groups: null, group: null };
  if (user.role === 'admin' || !user.user_group_id) return open;
  const g = db.prepare('SELECT * FROM user_groups WHERE id = ?').get(user.user_group_id);
  if (!g) return open;
  return {
    can_approve: !!g.can_approve,
    can_set_ready: !!g.can_set_ready,
    can_manage_printers: !!g.can_manage_printers,
    can_quick_print: !!g.can_quick_print,
    requires_approval: !!g.requires_approval,
    max_plates_per_upload: g.max_plates_per_upload ?? null,
    allowed_printer_ids: parseJsonArray(g.allowed_printer_ids),
    allowed_printer_groups: parseJsonArray(g.allowed_printer_groups),
    group: { id: g.id, name: g.name },
  };
}

// Reads req.user.permissions when requireAuth attached them, else falls back to
// the role defaults so a bare { role } user (tests, scripts) behaves as before.
function hasPermission(user, perm) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  const perms = user.permissions || ROLE_PERMISSIONS[user.role] || ROLE_PERMISSIONS.uploader;
  return !!perms[perm];
}

function requirePermission(perm, message) {
  return (req, res, next) => {
    if (!hasPermission(req.user, perm)) {
      return res.status(403).json({ error: message || 'Your user group does not allow this' });
    }
    next();
  };
}

// The "block" flavor of requirePermission, matching blockRole: it only rejects a
// signed-in user who lacks the permission, and lets a request with no req.user
// through (the global requireAuth gate in server/index.js guarantees one in
// production; router-level tests mount routes without it). Used for the
// printer-management and Set Ready gates, which were blockRole('uploader').
function blockWithoutPermission(perm, message) {
  return (req, res, next) => {
    if (req.user && !hasPermission(req.user, perm)) {
      return res.status(403).json({ error: message || 'Your user group does not allow this' });
    }
    next();
  };
}

// True when this user's group allows dispatching to the given printer row
// ({ id, group_name }). Unrestricted (no lists) allows everything.
function printerAllowed(permissions, printer) {
  if (!permissions) return true;
  const ids = permissions.allowed_printer_ids;
  const groups = permissions.allowed_printer_groups;
  if (!ids && !groups) return true;
  return (ids || []).includes(printer.id) || (groups || []).includes(printer.group_name);
}

// ─── Middleware ─────────────────────────────────────────────────────────────

function publicUser(user) {
  if (!user) return null;
  const { password_hash, ...rest } = user;
  return { ...rest, has_password: !!password_hash };
}

// Mounted ahead of every /api route except the public ones listed in
// server/index.js (auth status/bootstrap/login, OIDC start/callback, health).
// Resolves req.user from an API key or a session cookie, in that order, and
// responds 401 if neither resolves to a live user.
function requireAuth(db) {
  return (req, res, next) => {
    const authHeader = req.headers.authorization || '';
    const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
    if (bearerMatch) {
      const user = getUserByApiKey(db, bearerMatch[1].trim());
      if (user) {
        req.user = { ...publicUser(user), permissions: resolvePermissions(db, user) };
        req.authMethod = 'api_key';
        return next();
      }
      return res.status(401).json({ error: 'Invalid API key' });
    }

    const token = parseCookies(req)[SESSION_COOKIE];
    const user = getUserBySession(db, token);
    if (user) {
      req.user = { ...publicUser(user), permissions: resolvePermissions(db, user) };
      req.authMethod = 'session';
      return next();
    }
    return res.status(401).json({ error: 'Not authenticated' });
  };
}

function requireRole(role) {
  return (req, res, next) => {
    if (!req.user || req.user.role !== role) {
      return res.status(403).json({ error: `Requires ${role} role` });
    }
    next();
  };
}

// Like requireRole, but accepts any of several roles. Used for the uploader
// approval endpoints (routes/users.js), which an operator can reach even
// though the rest of user management stays admin-only.
function requireAnyRole(roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: `Requires one of: ${roles.join(', ')}` });
    }
    next();
  };
}

// Opposite of requireRole: lets every role through except the given one.
// Used for the uploader role, which has access to everything an operator does
// except a small set of specific actions (currently: releasing a held printer
// back into the dispatch queue) rather than everything a single named role has.
function blockRole(role, message) {
  return (req, res, next) => {
    if (req.user && req.user.role === role) {
      return res.status(403).json({ error: message || `The ${role} role cannot do this` });
    }
    next();
  };
}

// Printer management (adding, importing, editing, decommissioning,
// recommissioning, or deleting printers, plus the printer model registry and
// group registry they are configured against) is operator/admin work. An
// uploader only queues prints. Applied per-route in routes/printers.js,
// routes/models.js, routes/groups.js, routes/backup.js (restore replaces the
// printer table), and server/index.js (recommission).
// Now driven by the can_manage_printers permission (role default: everyone but
// uploader; a user group can grant or revoke it). The name is kept because it is
// applied across many routes.
const blockUploaderPrinterAdmin = blockWithoutPermission(
  'can_manage_printers',
  'Uploaders cannot add, remove, or change printers or printer settings'
);

module.exports = {
  SESSION_COOKIE,
  ROLE_PERMISSIONS,
  resolvePermissions,
  hasPermission,
  requirePermission,
  blockWithoutPermission,
  printerAllowed,
  blockUploaderPrinterAdmin,
  hashPassword,
  verifyPassword,
  createSession,
  destroySession,
  pruneExpiredSessions,
  getUserBySession,
  generateApiKey,
  getUserByApiKey,
  parseCookies,
  setSessionCookie,
  clearSessionCookie,
  publicUser,
  requireAuth,
  requireRole,
  requireAnyRole,
  blockRole,
};
