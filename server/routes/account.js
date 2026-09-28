// Self-service actions for the signed-in user's own account, distinct from
// server/routes/users.js (admin managing everyone). Currently just changing
// your own password.

const express = require('express');
const auth = require('../auth');

module.exports = (db) => {
  // A fresh router per factory call, not one at module level: a shared
  // module-level router accumulates one handler per call, and the first one
  // (bound to the first db it was given) answers every request after it.
  // Harmless with one production call, wrong in tests that build a new app
  // and database per test (and the reason this route's tests failed in CI).
  const router = express.Router();
  // PUT /api/account/password { current_password, new_password }: requires
  // proving you still know the current one, same reasoning bank/email account
  // settings use it for, before letting a live session silently take over the
  // account for good. Does not touch other sessions or API keys (same as an
  // admin resetting someone's password via PUT /api/users/:id).
  router.put('/password', (req, res) => {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const { current_password, new_password } = req.body || {};
    if (!user.password_hash) {
      return res.status(400).json({ error: 'This account has no password (signs in via SSO); there is nothing to change.' });
    }
    if (!current_password || !auth.verifyPassword(current_password, user.password_hash)) {
      return res.status(401).json({ error: 'Current password is incorrect.' });
    }
    if (!new_password || new_password.length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters.' });
    }

    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(auth.hashPassword(new_password), user.id);
    res.json({ success: true });
  });

  return router;
};
