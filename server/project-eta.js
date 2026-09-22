// Rough estimated-completion-time for a project's remaining queue, shared by the
// Dashboard's Active Projects panel and GET /api/projects/:id/eta.
//
// This is deliberately a rough estimate, not a scheduling simulation: it does not
// model which specific printer will pick up which part, material/color/group
// eligibility, or dispatch order. Two components, added together:
//
//   1. in_progress_remaining_secs: real telemetry (printers.job_time_remaining) for
//      whatever is printing right now on this project. The most accurate part of
//      the estimate, since it comes from the printer itself.
//   2. queued_remaining_secs / eligible_printer_count: everything not yet started
//      or in flight, estimated from each part's gcode(s) est_print_secs, spread
//      across every active printer whose model matches at least one of this
//      project's gcodes (regardless of whether that printer happens to be busy
//      right now): a coarse capacity figure, not a real-time schedule.
//
// If any remaining part has no est_print_secs on any of its gcodes, that part's
// time is simply unknown and excluded from the sum; `incomplete: true` flags this
// so the estimate is understood as a lower bound, not a silently wrong total.

function estimateProjectRemaining(db, projectId) {
  const openParts = db.prepare(`
    SELECT parts.id, parts.target_qty, parts.completed_qty,
      COALESCE((
        SELECT SUM(j.parts_per_plate) FROM jobs j
        WHERE j.part_id = parts.id AND j.status IN ('uploading', 'printing')
      ), 0) AS active_qty
    FROM parts
    WHERE parts.project_id = ? AND parts.status = 'open'
  `).all(projectId);

  const gcodeSecsStmt = db.prepare(`
    SELECT est_print_secs, parts_per_plate FROM gcodes
    WHERE part_id = ? AND est_print_secs IS NOT NULL AND parts_per_plate > 0
  `);

  let queuedRemainingSecs = 0;
  let incomplete = false;

  for (const part of openParts) {
    const remainingQty = Math.max(0, part.target_qty - part.completed_qty - part.active_qty);
    if (remainingQty === 0) continue;

    const gcodeOptions = gcodeSecsStmt.all(part.id);
    if (gcodeOptions.length === 0) {
      incomplete = true;
      continue;
    }

    // Average per-part-unit time across this part's gcodes (one per printer
    // model), since we don't know in advance which model's printer will pick it up.
    const perPartSecs = gcodeOptions.reduce((sum, g) => sum + g.est_print_secs / g.parts_per_plate, 0)
      / gcodeOptions.length;
    queuedRemainingSecs += remainingQty * perPartSecs;
  }

  const inProgressRemainingSecs = db.prepare(`
    SELECT COALESCE(SUM(p.job_time_remaining), 0) AS secs
    FROM jobs j
    JOIN printers p ON p.id = j.printer_id
    JOIN parts pt ON pt.id = j.part_id
    WHERE pt.project_id = ? AND j.status = 'printing' AND p.job_time_remaining IS NOT NULL
  `).get(projectId).secs;

  const eligiblePrinterCount = db.prepare(`
    SELECT COUNT(DISTINCT p.id) AS n
    FROM printers p
    WHERE p.is_active = 1 AND p.model IN (
      SELECT DISTINCT g.printer_model FROM gcodes g
      JOIN parts pt ON pt.id = g.part_id
      WHERE pt.project_id = ?
    )
  `).get(projectId).n;

  if (queuedRemainingSecs === 0 && inProgressRemainingSecs === 0) {
    return { remaining_seconds: incomplete ? null : 0, incomplete, eligible_printer_count: eligiblePrinterCount };
  }

  const remainingSeconds = Math.round(
    inProgressRemainingSecs + queuedRemainingSecs / Math.max(1, eligiblePrinterCount)
  );

  return { remaining_seconds: remainingSeconds, incomplete, eligible_printer_count: eligiblePrinterCount };
}

module.exports = { estimateProjectRemaining };
