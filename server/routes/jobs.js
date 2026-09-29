const express = require('express');
const router = express.Router();
const { getDriver } = require('../drivers');
const events = require('../events');
const { hasPermission } = require('../auth');

module.exports = (db) => {
  // GET /api/jobs: list with optional filters, joined with part/project/printer names.
  // Owner fields come from the job's part (created_by) and G-code (uploaded_by):
  // the scheduler creates job rows, so a job has no owner column of its own.
  router.get('/', (req, res) => {
    const { printer_id, part_id, project_id, status } = req.query;

    let query = `
      SELECT
        jobs.*,
        parts.name        AS part_name,
        projects.id       AS project_id,
        projects.name     AS project_name,
        printers.name     AS printer_name,
        printers.model    AS printer_model,
        printers.is_held  AS printer_is_held,
        printers.status   AS printer_status,
        parts.created_by_user_id AS part_owner_user_id,
        parts.created_by_name    AS part_owner_name,
        gcodes.uploaded_by_user_id AS gcode_uploaded_by_user_id,
        gcodes.uploaded_by_name    AS gcode_uploaded_by_name
      FROM jobs
      JOIN parts    ON parts.id    = jobs.part_id
      JOIN projects ON projects.id = parts.project_id
      JOIN printers ON printers.id = jobs.printer_id
      LEFT JOIN gcodes ON gcodes.id = jobs.gcode_id
      WHERE 1=1
    `;
    const params = [];

    if (printer_id) { query += ' AND jobs.printer_id = ?';   params.push(printer_id); }
    if (part_id)    { query += ' AND jobs.part_id = ?';      params.push(part_id); }
    if (project_id) { query += ' AND projects.id = ?';       params.push(project_id); }
    if (status)     { query += ' AND jobs.status = ?';       params.push(status); }

    query += ' ORDER BY jobs.created_at DESC';

    res.json(db.prepare(query).all(...params));
  });

  // GET /api/jobs/:id
  router.get('/:id', (req, res) => {
    const job = db.prepare(`
      SELECT jobs.*,
        parts.name        AS part_name,
        projects.id       AS project_id,
        projects.name     AS project_name,
        printers.name     AS printer_name,
        printers.model    AS printer_model,
        printers.is_held  AS printer_is_held,
        printers.status   AS printer_status,
        parts.created_by_user_id AS part_owner_user_id,
        parts.created_by_name    AS part_owner_name,
        gcodes.uploaded_by_user_id AS gcode_uploaded_by_user_id,
        gcodes.uploaded_by_name    AS gcode_uploaded_by_name
      FROM jobs
      JOIN parts    ON parts.id    = jobs.part_id
      JOIN projects ON projects.id = parts.project_id
      JOIN printers ON printers.id = jobs.printer_id
      LEFT JOIN gcodes ON gcodes.id = jobs.gcode_id
      WHERE jobs.id = ?
    `).get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json(job);
  });

  // DELETE /api/jobs/:id: cancel a job. A queued job is a plain DB row
  // flip: it never reached a printer. An uploading/printing job is a live
  // print: gated behind can_cancel_active_jobs (operator/admin always have
  // it; an uploader only if their group grants it, see auth.js's
  // ROLE_PERMISSIONS and resolvePermissions), since pulling back a job
  // already running on shared hardware is a bigger deal than dropping one
  // that hadn't started. Any other status (finished/failed/cancelled) is a
  // finished fact, not cancellable.
  router.delete('/:id', async (req, res) => {
    const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    if (job.status === 'queued') {
      db.prepare("UPDATE jobs SET status = 'cancelled' WHERE id = ?").run(job.id);
      return res.json({ success: true });
    }

    if (job.status === 'uploading' || job.status === 'printing') {
      if (!hasPermission(req.user, 'can_cancel_active_jobs')) {
        return res.status(403).json({ error: 'Your user group cannot cancel a job that is already uploading or printing.' });
      }
      const printer = db.prepare('SELECT * FROM printers WHERE id = ?').get(job.printer_id);
      if (printer) {
        try {
          const driver = getDriver(printer.type);
          await driver.cancelJob(printer);
        } catch (err) {
          // cancelJob's own contract is "log a warning, never throw", but a
          // completely unknown printer.type (getDriver itself) still can:
          // the job is cancelled in our own records either way; the operator
          // may need to stop the physical print by hand if the driver
          // couldn't reach it.
          console.warn(`[jobs] cancelJob failed for printer ${printer.id} (${printer.name}): ${err.message}`);
        }
        // Hold for operator sign-off, same as any other STOPPED printer:
        // the plate needs a physical look before the next job dispatches.
        db.prepare('UPDATE printers SET is_held = 1 WHERE id = ?').run(printer.id);
        events.insert(printer.id, 'job_cancelled', `Job ${job.id} cancelled by ${req.user?.name ?? 'an operator'}`);
      }
      db.prepare("UPDATE jobs SET status = 'cancelled', finished_at = ? WHERE id = ?").run(Date.now(), job.id);
      return res.json({ success: true });
    }

    return res.status(409).json({
      error: `Cannot cancel a job with status "${job.status}".`,
    });
  });

  return router;
};
