const EventEmitter = require('events');
const { getDriver } = require('./drivers');

const POLL_INTERVAL_MS = 15000;

// Window over which one tick's printer polls are started, evenly spaced, instead of all
// at the same instant. Polling every printer at once opens a burst of new connections
// (two requests per OctoPrint printer), and some routers, access points, and firewalls
// treat a burst of connections to one subnet as a scan and drop it, which shows up as a
// group of printers all timing out together and recovering together. Spreading the
// starts costs at most this much staleness on the last printer's status. This window
// plus the 8 s driver timeout must stay under POLL_INTERVAL_MS so one tick always
// finishes before the next begins (5 s + 8 s = 13 s < 15 s).
const POLL_STAGGER_WINDOW_MS = 5000;

// Event-loop lag monitor. Everything in this server shares one thread, so any long
// synchronous job (decoding a large .bgcode, a big backup restore) delays every poll
// response and can push all printers past their ~8 s request timeouts at once, which
// shows up as every printer going OFFLINE together. A 1 s timer that fires more than
// LAG_WARN_MS late proves the thread was blocked. Must stay well under the 8 s driver
// timeout, so a block that could cause a false OFFLINE is always reported.
const LAG_CHECK_MS = 1000;
const LAG_WARN_MS = 2000;

// Consecutive OFFLINE results required before a printer that was reachable is reported
// as OFFLINE. Printers on shared Wi-Fi or a busy network miss the occasional poll (the
// ~8 s request timeout), and without this one miss flipped the Fleet view to OFFLINE for
// a whole 15 s cycle and, for a printer with a job in progress, held it for operator
// review. Must stay small: a printer that really dropped is shown with its last status
// for up to (OFFLINE_CONFIRM_POLLS - 1) extra poll intervals, so 3 means about 30 s.
const OFFLINE_CONFIRM_POLLS = 3;

class PrinterPoller extends EventEmitter {
  constructor(db) {
    super();
    this.db = db;
    this.timer = null;
    this.lagTimer = null;
    this._lastLagCheck = 0;
    // printer.id -> consecutive OFFLINE results so far (reset by any other result)
    this._offlineMisses = new Map();
    // printer ids that returned a non-OFFLINE status during THIS process lifetime. The
    // debounce only applies to these: right after a restart the stored status says
    // nothing about the printer, and a first OFFLINE (e.g. Bambu MQTT still connecting)
    // must be reported as before, so cold-start behavior is unchanged.
    this._seenOnline = new Set();
  }

  start() {
    console.log(`[poller] Starting poll loop (interval: ${POLL_INTERVAL_MS}ms)`);
    this._tick();
    this.timer = setInterval(() => this._tick(), POLL_INTERVAL_MS);

    this._lastLagCheck = Date.now();
    this.lagTimer = setInterval(() => this._checkLag(Date.now()), LAG_CHECK_MS);
    this.lagTimer.unref();
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.lagTimer) {
      clearInterval(this.lagTimer);
      this.lagTimer = null;
    }
  }

  // Returns the measured lag in ms (0 if on time) and logs when it exceeds LAG_WARN_MS.
  _checkLag(now) {
    const lag = Math.max(0, now - this._lastLagCheck - LAG_CHECK_MS);
    this._lastLagCheck = now;
    if (lag > LAG_WARN_MS) {
      console.warn(`[poller] server was blocked for ~${Math.round(lag / 1000)}s (a long synchronous task); printer polls during this window can time out and read OFFLINE`);
    }
    return lag;
  }

  async _tick() {
    if (process.env.DEMO_MODE === 'true') {
      this.emit('pollComplete');
      return;
    }

    const printers = this.db
      .prepare('SELECT * FROM printers WHERE is_active = 1')
      .all();

    if (printers.length === 0) return;

    const spacingMs = Math.floor(POLL_STAGGER_WINDOW_MS / printers.length);
    const results = await Promise.allSettled(
      printers.map((printer, i) => this._pollAfter(i * spacingMs, printer))
    );

    results.forEach((result, i) => {
      if (result.status === 'rejected') {
        console.error(`[poller] Unexpected error polling ${printers[i].name}:`, result.reason);
      }
    });

    this.emit('pollComplete');
  }

  // Starts one printer's poll after delayMs. The row is re-read at poll time because it
  // may be a few seconds old by then (another path can have changed its status), and a
  // printer decommissioned in the meantime is skipped.
  async _pollAfter(delayMs, printer) {
    if (delayMs <= 0) return this._pollPrinter(printer);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    const fresh = this.db.prepare('SELECT * FROM printers WHERE id = ? AND is_active = 1').get(printer.id);
    if (!fresh) return;
    return this._pollPrinter(fresh);
  }

  async _pollPrinter(printer) {
    const previousStatus = printer.status;
    let newStatus;
    let jobName = null;
    let jobProgress = null;
    let jobTimeRemaining = null;

    let driver;
    try {
      driver = getDriver(printer.type);
    } catch (err) {
      console.error(`[poller] ${printer.name} has unknown type "${printer.type}" — skipping poll: ${err.message}`);
      return;
    }
    const result = await driver.getStatus(printer);
    newStatus = result.status;
    jobProgress = result.progress;
    jobTimeRemaining = result.timeRemaining;

    // Absorb a transient miss: keep the stored status until OFFLINE has been seen
    // OFFLINE_CONFIRM_POLLS times in a row. Returns early so the rest of this handler
    // (status write, job progress, lane sync) never runs on the empty OFFLINE result.
    if (newStatus === 'OFFLINE') {
      if (previousStatus !== 'OFFLINE' && this._seenOnline.has(printer.id)) {
        const misses = (this._offlineMisses.get(printer.id) || 0) + 1;
        if (misses < OFFLINE_CONFIRM_POLLS) {
          this._offlineMisses.set(printer.id, misses);
          return;
        }
      }
    } else {
      this._offlineMisses.delete(printer.id);
      this._seenOnline.add(printer.id);
    }

    if (newStatus !== previousStatus) {
      // Only hold when there is a tracked active job to protect. This gates all three
      // hold triggers — FINISHED, missed-finish (PRINTING→IDLE), and non-safe states
      // (OFFLINE, ERROR, PAUSED, etc.).
      //
      // Without this gate a printer that had its job already confirmed (is_held cleared
      // by Set Ready) can be re-held by a subsequent status transition. The common case
      // is a Prusa printer that stays in FINISHED state until the display is cleared:
      // a network blip causes FINISHED→OFFLINE→FINISHED, the FINISHED re-entry sets
      // is_held=1, and Fleet shows stale confirmation buttons for the already-confirmed job.
      //
      // _handleFinished, _handlePrinterOffline, and _handlePrinterUnavailable in the
      // scheduler also set is_held=1 only when they find an active job — they do their
      // own job lookup before holding, so this gate is not needed there.
      const SAFE_STATES = new Set(['IDLE', 'PRINTING', 'FINISHED', 'READY']);
      const missedFinished = newStatus === 'IDLE' && previousStatus === 'PRINTING';
      const hasActiveJob = !!this.db.prepare(
        "SELECT id FROM jobs WHERE printer_id = ? AND status IN ('uploading', 'printing') LIMIT 1"
      ).get(printer.id);
      const shouldHold = hasActiveJob && (newStatus === 'FINISHED' || missedFinished || !SAFE_STATES.has(newStatus));
      const holdUpdate = shouldHold ? ', is_held = 1' : '';
      // Clear job fields when leaving PRINTING state
      const clearJob = previousStatus === 'PRINTING' && newStatus !== 'PRINTING'
        ? ', job_name = NULL, job_progress = NULL, job_time_remaining = NULL'
        : '';
      this.db
        .prepare(`UPDATE printers SET status = ?${holdUpdate}${clearJob} WHERE id = ?`)
        .run(newStatus, printer.id);

      console.log(`[poller] ${printer.name}: ${previousStatus} → ${newStatus}`);
      this.emit('statusChange', { printer, previousStatus, newStatus });

      if (newStatus === 'IDLE' && previousStatus !== 'IDLE') {
        this.emit('printerIdle', { printer: { ...printer, status: newStatus } });
      }
    }

    // Always persist latest job progress while printing (status may not have changed)
    if (newStatus === 'PRINTING') {
      // Prefer the filename reported directly by the printer (Elegoo SDCP).
      // Fall back to a DB lookup via the jobs table (Prusa Link and others).
      if (result.currentFile) {
        jobName = result.currentFile;
      } else {
        const activeJob = this.db.prepare(`
          SELECT gcodes.filename FROM jobs
          JOIN gcodes ON gcodes.id = jobs.gcode_id
          WHERE jobs.printer_id = ? AND jobs.status = 'printing'
          ORDER BY jobs.started_at DESC LIMIT 1
        `).get(printer.id);
        jobName = activeJob?.filename ?? null;
      }
      this.db
        .prepare('UPDATE printers SET job_name = ?, job_progress = ?, job_time_remaining = ? WHERE id = ?')
        .run(jobName, jobProgress, jobTimeRemaining, printer.id);
    }

    // Per-lane filament state (klipper-filament-sync plugin), for connectors that
    // support it. Optional export: most drivers don't have one, and getDriver()
    // above already resolved a valid driver for this printer.type.
    if (typeof driver.getLaneData === 'function') {
      const lanes = await driver.getLaneData(printer);
      if (lanes) this._syncLanes(printer.id, lanes);
    }
  }

  // Upserts the reported lanes and removes any lane row no longer present in this
  // poll's data (e.g. the printer's toolhead count changed), so printer_lanes always
  // reflects exactly what the plugin last reported, not a superset that accumulates
  // stale rows over time.
  _syncLanes(printerId, lanes) {
    const now = Date.now();
    const upsert = this.db.prepare(`
      INSERT INTO printer_lanes (printer_id, lane_index, material, color, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(printer_id, lane_index) DO UPDATE SET
        material = excluded.material, color = excluded.color, updated_at = excluded.updated_at
    `);
    const sync = this.db.transaction(() => {
      for (const lane of lanes) {
        upsert.run(printerId, lane.index, lane.material, lane.color, now);
      }
      const indexes = lanes.map(l => l.index);
      const placeholders = indexes.map(() => '?').join(',');
      this.db
        .prepare(`DELETE FROM printer_lanes WHERE printer_id = ? AND lane_index NOT IN (${placeholders})`)
        .run(printerId, ...indexes);
    });
    sync();
  }
}

module.exports = PrinterPoller;
