// Estimated completion time for every active project, shared by the Dashboard's
// Active Projects panel and GET /api/projects/:id/eta.
//
// A small simulation of the farm, not a formula: it replays what the scheduler
// would do from now on, one plate at a time, so a project's estimate accounts
// for the work queued ahead of it.
//
//   Printers   every active printer that can take work. One printing now is
//              free once its print ends (the printer's own job_time_remaining);
//              an idle, unheld one is free now; one held for sign-off is free
//              once an operator is on shift. OFFLINE / ERROR / UNKNOWN printers
//              take no work in the simulation.
//   Queue      open parts of active projects, walked exactly like the scheduler
//              (scheduler.js _reserveCandidate): priority override first, then
//              queue_order ('priority' or 'fifo' by G-code upload time), same
//              model / group / material / color eligibility (exact match; the
//              optional color tolerance is not modeled), same work-conserving
//              per-uploader plate cap (user_groups.max_concurrent_plates).
//   Plates     a printer runs one whole plate of the part's G-code for its own
//              model: parts_per_plate parts in est_print_secs (read from the
//              file header on upload). Remaining plates per part come from
//              target - completed - already printing.
//   Operators  every print finishes held until someone confirms it (Set Ready),
//              so a finished printer only takes its next plate at the next
//              moment an operator is on shift (settings operator_hours_start /
//              operator_hours_end / operator_days, server local time; unset
//              means always staffed). Printers with auto_advance (belt
//              printers) do not wait.
//
// A project's estimate is when its last plate finishes printing. It is flagged
// `incomplete` (a lower bound) when one of its G-codes has no print time, a
// part has no printer that can take it, or the simulation hits its safety
// limit. `remaining_seconds` is null when there is work left but nothing about
// it can be estimated.

const { resolvePermissions } = require('./auth');

const SIM_MAX_PLATES = 20000; // safety cap on simulated dispatches per call
const WORK_STATUSES_NOW = new Set(['IDLE', 'READY', 'FINISHED', 'STOPPED']);

// ─── Settings ────────────────────────────────────────────────────────────────

function hasTable(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

function setting(db, key) {
  return hasTable(db, 'settings') ? db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value : undefined;
}

// ─── Operator hours ──────────────────────────────────────────────────────────

function parseHHMM(s) {
  const m = String(s || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = parseInt(m[1], 10), min = parseInt(m[2], 10);
  return h < 24 && min < 60 ? h * 60 + min : null;
}

// { start, end } minutes after midnight and a Set of weekdays (0 = Sunday), or
// null when operator hours are not configured (always staffed).
function readOperatorHours(db) {
  const get = (k) => setting(db, k);
  const start = parseHHMM(get('operator_hours_start'));
  const end = parseHHMM(get('operator_hours_end'));
  if (start == null || end == null || start === end) return null;
  const daysRaw = get('operator_days');
  const days = new Set(
    (daysRaw ? daysRaw.split(',') : ['0', '1', '2', '3', '4', '5', '6'])
      .map(d => parseInt(d, 10)).filter(d => d >= 0 && d <= 6)
  );
  return days.size ? { start, end, days } : null;
}

// Earliest moment at or after t (ms) when an operator is on shift. A shift
// whose end is before its start runs past midnight (e.g. 22:00 to 06:00) and
// belongs to the weekday it starts on. Server local time throughout.
function nextOperatorTime(t, hours) {
  if (!hours) return t;
  const base = new Date(t);
  for (let offset = -1; offset <= 8; offset++) {
    const day = new Date(base.getFullYear(), base.getMonth(), base.getDate() + offset);
    if (!hours.days.has(day.getDay())) continue;
    const open = day.getTime() + hours.start * 60000;
    const close = day.getTime() + (hours.end > hours.start ? hours.end : hours.end + 1440) * 60000;
    if (t < close) return Math.max(t, open);
  }
  return t; // unreachable with at least one configured day; never block
}

// ─── Simulation ─────────────────────────────────────────────────────────────

function readQueuePolicy(db) {
  return { fifo: setting(db, 'queue_order') === 'fifo' };
}

function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === column);
}

// Simulates the whole farm once. Returns Map(projectId => { completion_at,
// incomplete }) for every active project, plus the inputs' timestamp.
function simulateFarm(db, now = Date.now()) {
  const hours = readOperatorHours(db);
  const policy = readQueuePolicy(db);
  const col = (table, column, fallback) => (hasColumn(db, table, column) ? `${table}.${column}` : fallback);

  const projects = db.prepare(`
    SELECT id, created_at, ${col('projects', 'priority', '0')} AS priority,
           ${col('projects', 'priority_override', '0')} AS priority_override,
           ${col('projects', 'allowed_groups', 'NULL')} AS allowed_groups,
           ${col('projects', 'required_material', 'NULL')} AS required_material,
           ${col('projects', 'required_color', 'NULL')} AS required_color
    FROM projects WHERE status = 'active'
  `).all();

  // Per-uploader plate cap (user_groups.max_concurrent_plates), memoized per
  // simulation call since the same uploader recurs across many gcodes. An
  // admin uploader (or one with no cap set) resolves to null: unlimited.
  const capCache = new Map();
  const capForUploader = (userId) => {
    if (!userId) return null;
    if (!capCache.has(userId)) {
      const user = db.prepare('SELECT id, role, user_group_id FROM users WHERE id = ?').get(userId);
      capCache.set(userId, user ? (resolvePermissions(db, user).max_concurrent_plates || null) : null);
    }
    return capCache.get(userId);
  };
  const projectById = new Map(projects.map(p => [p.id, p]));
  const result = new Map(projects.map(p => [p.id, { completion_at: null, incomplete: false, has_work: false }]));
  const touch = (projectId, end) => {
    const r = result.get(projectId);
    if (r && (r.completion_at == null || end > r.completion_at)) r.completion_at = end;
  };

  // Real jobs in flight: their end times count toward completion and toward
  // the caps while they run.
  const running = []; // { partId, projectId, end }
  const inFlight = db.prepare(`
    SELECT j.part_id, pt.project_id, j.status, p.job_time_remaining, g.est_print_secs,
           ${hasColumn(db, 'gcodes', 'uploaded_by_user_id') ? 'g.uploaded_by_user_id' : 'NULL'} AS uploaded_by_user_id
    FROM jobs j JOIN parts pt ON pt.id = j.part_id JOIN printers p ON p.id = j.printer_id
    LEFT JOIN gcodes g ON g.id = j.gcode_id
    WHERE j.status IN ('uploading', 'printing')
  `).all();
  for (const j of inFlight) {
    if (!result.has(j.project_id)) continue;
    result.get(j.project_id).has_work = true;
    const secs = j.status === 'printing' ? j.job_time_remaining : j.est_print_secs;
    if (secs == null) { result.get(j.project_id).incomplete = true; continue; }
    const end = now + secs * 1000;
    running.push({ partId: j.part_id, projectId: j.project_id, uploaderId: j.uploaded_by_user_id, end });
    touch(j.project_id, end);
  }

  // Parts with plates still to dispatch, and each one's G-codes per model.
  const parts = db.prepare(`
    SELECT parts.id, parts.project_id, parts.target_qty, parts.completed_qty, parts.created_at,
           ${col('parts', 'sort_order', '0')} AS sort_order,
           ${col('parts', 'priority_override', '0')} AS priority_override,
           COALESCE((SELECT SUM(j.parts_per_plate) FROM jobs j
                     WHERE j.part_id = parts.id AND j.status IN ('uploading', 'printing')), 0) AS active_qty
    FROM parts JOIN projects ON projects.id = parts.project_id
    WHERE parts.status = 'open' AND projects.status = 'active'
  `).all();
  const gcodeCols = ['est_print_secs', 'allowed_groups', 'required_material', 'required_color', 'approved', 'uploaded_by_user_id']
    .map(c => (hasColumn(db, 'gcodes', c) ? c : `NULL AS ${c}`)).join(', ');
  const gcodesStmt = db.prepare(`SELECT id, printer_model, parts_per_plate, created_at, ${gcodeCols} FROM gcodes WHERE part_id = ?`);

  const queue = [];
  for (const part of parts) {
    const project = projectById.get(part.project_id);
    const remaining = Math.max(0, part.target_qty - part.completed_qty - part.active_qty);
    if (remaining === 0) continue;
    result.get(part.project_id).has_work = true;
    const gcodes = gcodesStmt.all(part.id).filter(g => g.approved !== 0 && g.parts_per_plate > 0);
    if (gcodes.some(g => g.est_print_secs == null)) result.get(part.project_id).incomplete = true;
    const usable = gcodes.filter(g => g.est_print_secs != null);
    if (usable.length === 0) { result.get(part.project_id).incomplete = true; continue; }
    queue.push({
      part, project, remaining,
      overridden: part.priority_override === 1 || project.priority_override === 1,
      byModel: new Map(usable.map(g => [g.printer_model, {
        ...g,
        groups: JSON.parse(g.allowed_groups || project.allowed_groups || 'null'),
        material: g.required_material || project.required_material || null,
        color: g.required_color || project.required_color || null,
      }])),
    });
  }

  // Printers that can take work, with when each is next free.
  const laneRows = hasTable(db, 'printer_lanes') ? db.prepare('SELECT printer_id, material, color FROM printer_lanes').all() : [];
  const printerCols = ['group_name', 'loaded_material', 'loaded_color', 'auto_advance']
    .map(c => (hasColumn(db, 'printers', c) ? c : `NULL AS ${c}`)).join(', ');
  const printers = [];
  for (const p of db.prepare(`SELECT id, model, status, is_held, job_time_remaining, ${printerCols} FROM printers WHERE is_active = 1`).all()) {
    const lanes = laneRows.filter(l => l.printer_id === p.id);
    const autoAdvance = p.auto_advance === 1;
    let free;
    if (p.status === 'PRINTING' || p.status === 'PAUSED') {
      const end = now + (p.job_time_remaining ?? 0) * 1000;
      free = autoAdvance ? end : nextOperatorTime(end, hours);
    } else if (p.is_held === 1 && WORK_STATUSES_NOW.has(p.status)) {
      free = nextOperatorTime(now, hours);
    } else if (WORK_STATUSES_NOW.has(p.status)) {
      free = now;
    } else {
      continue; // OFFLINE, ERROR, UNKNOWN: takes no work
    }
    printers.push({ ...p, lanes, autoAdvance, free });
  }

  const materialOk = (p, g) => {
    const direct = (!g.material || g.material === p.loaded_material) && (!g.color || g.color === p.loaded_color);
    return direct || p.lanes.some(l => (!g.material || l.material === g.material) && (!g.color || l.color === g.color));
  };
  const eligible = (p, item) => {
    const g = item.byModel.get(p.model);
    if (!g) return null;
    if (g.groups && !g.groups.includes(p.group_name)) return null;
    return materialOk(p, g) ? g : null;
  };
  const orderKey = (item, g) => policy.fifo
    ? [item.overridden ? 0 : 1, g.created_at, g.id]
    : [item.overridden ? 0 : 1, item.project.priority, item.project.created_at, item.part.sort_order, item.part.created_at];
  const cmp = (a, b) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1; return 0; };
  const busyAt = (t, pred) => running.filter(r => r.end > t && pred(r)).length;
  const atCap = (g, t) => {
    const cap = capForUploader(g.uploaded_by_user_id);
    return cap > 0 && busyAt(t, r => r.uploaderId === g.uploaded_by_user_id) >= cap;
  };

  let dispatched = 0;
  while (printers.length > 0) {
    let pi = 0;
    for (let i = 1; i < printers.length; i++) if (printers[i].free < printers[pi].free) pi = i;
    const printer = printers[pi];
    const t = printer.free;
    // The simulation clock (the earliest free printer) never moves backward,
    // so a job already finished at t can never count toward a cap again.
    for (let i = running.length - 1; i >= 0; i--) if (running[i].end <= t) running.splice(i, 1);

    const options = queue
      .filter(item => item.remaining > 0)
      .map(item => ({ item, g: eligible(printer, item) }))
      .filter(o => o.g)
      .sort((a, b) => cmp(orderKey(a.item, a.g), orderKey(b.item, b.g)));
    const pick = options.find(o => o.item.overridden || !atCap(o.g, t)) || options[0];
    if (!pick) { printers.splice(pi, 1); continue; } // nothing it can ever print

    if (++dispatched > SIM_MAX_PLATES) {
      for (const item of queue) if (item.remaining > 0) result.get(item.part.project_id).incomplete = true;
      break;
    }
    const end = t + pick.g.est_print_secs * 1000;
    pick.item.remaining -= pick.g.parts_per_plate;
    running.push({ partId: pick.item.part.id, projectId: pick.item.part.project_id, uploaderId: pick.g.uploaded_by_user_id, end });
    touch(pick.item.part.project_id, end);
    printer.free = printer.autoAdvance ? end : nextOperatorTime(end, hours);
  }

  // Work no printer could take leaves its project's estimate a lower bound.
  for (const item of queue) if (item.remaining > 0) result.get(item.part.project_id).incomplete = true;
  return result;
}

// ─── Per-project view ───────────────────────────────────────────────────────

function eligiblePrinterCount(db, projectId) {
  return db.prepare(`
    SELECT COUNT(DISTINCT p.id) AS n FROM printers p
    WHERE p.is_active = 1 AND p.model IN (
      SELECT DISTINCT g.printer_model FROM gcodes g JOIN parts pt ON pt.id = g.part_id WHERE pt.project_id = ?
    )
  `).get(projectId).n;
}

// { remaining_seconds, completion_at, incomplete, eligible_printer_count }.
// Pass a simulateFarm() result to reuse one simulation across many projects
// (the Dashboard does), otherwise one is run for this call.
function estimateProjectRemaining(db, projectId, sim = null, now = Date.now()) {
  const results = sim || simulateFarm(db, now);
  const r = results.get(Number(projectId));
  const count = eligiblePrinterCount(db, projectId);
  if (!r || !r.has_work) {
    return { remaining_seconds: 0, completion_at: null, incomplete: false, eligible_printer_count: count };
  }
  if (r.completion_at == null) {
    return { remaining_seconds: null, completion_at: null, incomplete: true, eligible_printer_count: count };
  }
  return {
    remaining_seconds: Math.max(0, Math.round((r.completion_at - now) / 1000)),
    completion_at: r.completion_at,
    incomplete: r.incomplete,
    eligible_printer_count: count,
  };
}

module.exports = { estimateProjectRemaining, simulateFarm, nextOperatorTime, readOperatorHours };
