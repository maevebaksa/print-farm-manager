const express = require('express');
const router = express.Router();
const { getDriver } = require('../drivers');
const events = require('../events');
const { hasPermission, canModifyWork, OTHERS_WORK_MESSAGE } = require('../auth');

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

    // Owner: the G-code's uploader, else the part's creator (same fields GET /
    // reports). Someone else's job needs can_manage_others_work.
    const owner = db.prepare(`
      SELECT COALESCE(g.uploaded_by_user_id, p.created_by_user_id) AS owner_id
      FROM (SELECT ? AS gcode_id, ? AS part_id) j
      LEFT JOIN gcodes g ON g.id = j.gcode_id
      LEFT JOIN parts  p ON p.id = j.part_id
    `).get(job.gcode_id, job.part_id).owner_id;
    if (!canModifyWork(req.user, owner)) {
      return res.status(403).json({ error: OTHERS_WORK_MESSAGE });
    }

    // ?reason=failed (default): the print failed or was stopped for a physical
    // reason; the job is cancelled and its part stays open, so the scheduler
    // sends it back through the queue. ?reason=bad_gcode: the G-code itself is
    // bad, so it is also pulled out of dispatch permanently by clearing
    // gcodes.approved (the same flag the scheduler and dispatch-status already
    // honor, no schema change); an operator can approve it again to undo.
    const reason = req.query.reason === undefined ? 'failed' : String(req.query.reason);
    if (reason !== 'failed' && reason !== 'bad_gcode') {
      return res.status(400).json({ error: 'reason must be "failed" or "bad_gcode"' });
    }
    const disableGcode = () => {
      if (reason === 'bad_gcode' && job.gcode_id) {
        db.prepare('UPDATE gcodes SET approved = 0 WHERE id = ?').run(job.gcode_id);
        console.log(`[jobs] G-code ${job.gcode_id} taken out of dispatch (job ${job.id} cancelled as bad G-code)`);
      }
    };

    if (job.status === 'queued') {
      db.transaction(() => {
        db.prepare("UPDATE jobs SET status = 'cancelled' WHERE id = ?").run(job.id);
        disableGcode();
      })();
      return res.json({ success: true, reason });
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
        events.insert(printer.id, 'job_cancelled',
          `Job ${job.id} cancelled by ${req.user?.name ?? 'an operator'}: ` +
          (reason === 'bad_gcode' ? 'bad G-code, taken out of the queue' : 'print failed, part goes back in the queue'));
      }
      db.transaction(() => {
        db.prepare("UPDATE jobs SET status = 'cancelled', finished_at = ? WHERE id = ?").run(Date.now(), job.id);
        disableGcode();
      })();
      return res.json({ success: true, reason });
    }

    return res.status(409).json({
      error: `Cannot cancel a job with status "${job.status}".`,
    });
  });

  return router;
};
