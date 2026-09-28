const express = require('express');
const router = express.Router();

const ALLOWED_KEYS = new Set(['dispatch_batch_size', 'farm_name', 'auto_sso_redirect', 'color_tolerance', 'upload_retry_window_min', 'require_uploader_approval', 'update_repo', 'queue_order', 'max_printers_per_part', 'max_printers_per_project', 'operator_hours_start', 'operator_hours_end', 'operator_days']);
const QUEUE_ORDERS = new Set(['priority', 'fifo']);
const MAX_PRINTER_CAP = 1000;
// RGB Euclidean distance (server/color-distance.js) ranges 0 (identical) to
// ~441.7 (black vs white): anything past ~450 would treat literally any two
// colors as interchangeable, which is never a useful tolerance.
const MAX_COLOR_TOLERANCE = 450;
// Admin-only settings: everything else in ALLOWED_KEYS can be changed by any
// authenticated user, matching this router's existing behavior. This one
// changes what every logged-out visitor sees on the login page, so it is
// scoped to admin the same way /api/users is (see server/index.js).
// The queue policy keys decide whose prints run first on a shared farm (see
// scheduler.js's _queuePolicy), so they are admin-only as well.
// Operator hours only feed the time estimates (server/project-eta.js), but
// they describe staffing, so they sit with the other admin farm policy keys.
const ADMIN_ONLY_KEYS = new Set(['auto_sso_redirect', 'require_uploader_approval', 'update_repo', 'queue_order', 'max_printers_per_part', 'max_printers_per_project', 'operator_hours_start', 'operator_hours_end', 'operator_days']);

module.exports = (db) => {
  // GET /api/settings — returns all settings as { key: value, ... }
  router.get('/', (req, res) => {
    const rows = db.prepare('SELECT key, value FROM settings').all();
    const result = {};
    rows.forEach(r => { result[r.key] = r.value; });
    res.json(result);
  });

  // PUT /api/settings/:key — update a single setting value
  router.put('/:key', (req, res) => {
    const { key } = req.params;
    if (!ALLOWED_KEYS.has(key)) {
      return res.status(400).json({ error: `Unknown setting key: ${key}` });
    }
    if (ADMIN_ONLY_KEYS.has(key) && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Only an admin can change this setting' });
    }
    const { value } = req.body;
    if (value === undefined || value === null || String(value).trim() === '') {
      return res.status(400).json({ error: 'value is required' });
    }

    if (key === 'dispatch_batch_size') {
      const n = parseInt(value, 10);
      if (isNaN(n) || n < 1 || n > 100) {
        return res.status(400).json({ error: 'dispatch_batch_size must be an integer between 1 and 100' });
      }
    }

    if (key === 'farm_name' && String(value).trim().length > 40) {
      return res.status(400).json({ error: 'farm_name must be 40 characters or fewer' });
    }

    if (key === 'auto_sso_redirect' && value !== '0' && value !== '1') {
      return res.status(400).json({ error: 'auto_sso_redirect must be "0" or "1"' });
    }

    if (key === 'color_tolerance') {
      const n = parseInt(value, 10);
      if (isNaN(n) || n < 0 || n > MAX_COLOR_TOLERANCE) {
        return res.status(400).json({ error: `color_tolerance must be an integer between 0 and ${MAX_COLOR_TOLERANCE}` });
      }
    }

    if (key === 'upload_retry_window_min') {
      const n = parseInt(value, 10);
      if (isNaN(n) || n < 1 || n > 180) {
        return res.status(400).json({ error: 'upload_retry_window_min must be an integer between 1 and 180' });
      }
    }

    if (key === 'require_uploader_approval' && value !== '0' && value !== '1') {
      return res.status(400).json({ error: 'require_uploader_approval must be "0" or "1"' });
    }

    if (key === 'update_repo' && !/^[\w.-]+\/[\w.-]+$/.test(String(value).trim())) {
      return res.status(400).json({ error: 'update_repo must look like owner/repo (e.g. maevebaksa/print-farm-manager)' });
    }

    // "" is not accepted by the generic check above, so "always staffed" is
    // expressed as "off" for either end of the shift.
    if ((key === 'operator_hours_start' || key === 'operator_hours_end') &&
        value !== 'off' && !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(value))) {
      return res.status(400).json({ error: `${key} must be HH:MM (24-hour) or "off"` });
    }

    if (key === 'operator_days') {
      const days = String(value).split(',').map(d => d.trim());
      if (days.length === 0 || days.some(d => !/^[0-6]$/.test(d))) {
        return res.status(400).json({ error: 'operator_days must be a comma-separated list of 0-6 (0 = Sunday)' });
      }
    }

    if (key === 'queue_order' && !QUEUE_ORDERS.has(value)) {
      return res.status(400).json({ error: 'queue_order must be "priority" or "fifo"' });
    }

    if (key === 'max_printers_per_part' || key === 'max_printers_per_project') {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 0 || n > MAX_PRINTER_CAP) {
        return res.status(400).json({ error: `${key} must be an integer between 0 (unlimited) and ${MAX_PRINTER_CAP}` });
      }
    }

    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, String(value));
    res.json({ key, value: String(value) });
  });

  return router;
};
