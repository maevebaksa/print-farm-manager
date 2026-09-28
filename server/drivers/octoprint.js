// OctoPrint driver — OctoPrint REST API (HTTP polling)
// Implements the shared driver interface: getStatus, uploadAndPrint, cancelJob, checkIfPrinting
//
// All functions are async and take a `printer` DB row as the first argument.
// uploadAndPrint receives a resolved absolute path to the G-code file on disk.
//
// Reference: https://docs.octoprint.org/en/main/api/index.html
// printer.ip may include a port (e.g. "octopi.local:5000") — OctoPrint commonly
// runs behind its bundled server on :5000 rather than :80, so no port is assumed.

const axios = require('axios');
const fs = require('fs');
const FormData = require('form-data');
const { resolveHost } = require('../mdns-resolve');
const { describeConnectionError } = require('../connection-test-helpers');
const { toPlainGcode } = require('../gcode-convert');

function headers(printer) {
  return { 'X-Api-Key': printer.api_key };
}

// ─── Status ─────────────────────────────────────────────────────────────────

// Returns { status, progress, timeRemaining, currentFile }
// status is a canonical string: IDLE | PRINTING | FINISHED | PAUSED | ERROR | OFFLINE | UNKNOWN
//
// OctoPrint has no persistent "just finished" state like PrusaLink/Moonraker — after a
// print completes it reports the same `operational` flags as a printer that never printed.
// We detect completion by combining the flags with /api/job's leftover progress: not
// printing/paused, a job file is still loaded, and completion sits at 100%. This condition
// naturally stops being true once the operator (or scheduler) starts the next print, and
// poller.js only reacts to it once since the DB status only changes on the transition.
async function getStatus(printer) {
  try {
    const ip = await resolveHost(printer.ip);
    const [printerRes, jobRes] = await Promise.all([
      axios.get(`http://${ip}/api/printer`, { headers: headers(printer), timeout: 8000 }),
      axios.get(`http://${ip}/api/job`, { headers: headers(printer), timeout: 8000 }),
    ]);

    const flags = printerRes.data?.state?.flags || {};
    const job = jobRes.data || {};
    const completion = job.progress?.completion ?? null;
    const hasJobFile = !!job.job?.file?.name;

    let status;
    if (flags.error || flags.closedOrError) {
      status = 'ERROR';
    } else if (flags.printing || flags.pausing || flags.cancelling) {
      status = 'PRINTING';
    } else if (flags.paused) {
      status = 'PAUSED';
    } else if (flags.operational && hasJobFile && completion === 100) {
      status = 'FINISHED';
    } else if (flags.operational) {
      status = 'IDLE';
    } else {
      status = 'UNKNOWN';
    }

    const progress = (status === 'PRINTING') ? completion : null;
    const timeRemaining = (status === 'PRINTING') ? (job.progress?.printTimeLeft ?? null) : null;
    const currentFile = (status === 'PRINTING' && hasJobFile) ? job.job.file.name : null;

    return { status, progress, timeRemaining, currentFile };
  } catch (_) {
    return { status: 'OFFLINE', progress: null, timeRemaining: null, currentFile: null };
  }
}

// ─── Upload & Print ──────────────────────────────────────────────────────────

// Uploads the G-code file to OctoPrint's "local" file location and starts the print in
// one call (OctoPrint supports select+print as multipart form fields, unlike PrusaLink
// which needs a header on the upload and Moonraker which needs a separate print field).
// Reference: https://docs.octoprint.org/en/main/api/files.html#upload-file-or-create-folder
//
// OctoPrint only accepts plain G-code (.gcode/.gco/.g per octoprint/filemanager's
// type mapping) and answers anything else with an error. A .bgcode or a sliced
// .3mf is converted to plain G-code here first (see gcode-convert.js) and
// uploaded under a .gcode name; plain G-code streams straight from disk.
//
// A 201 does not mean the print started: OctoPrint still stores the file but
// silently skips select/print when the printer is not operational/ready or the
// API key's user lacks the PRINT permission, reporting it only as
// effectivePrint: false in the response body. That is treated as a failed
// dispatch (the scheduler retries, then holds), not a running print.
// Throws UPLOAD_CONFLICT if OctoPrint refuses because the same file is mid-print.
const PLAIN_GCODE_EXTENSIONS = ['.gcode', '.gco', '.g'];

async function uploadAndPrint(printer, gcodeFullPath, filename) {
  const ip = await resolveHost(printer.ip);
  const lower = filename.toLowerCase();

  let upload;
  if (PLAIN_GCODE_EXTENSIONS.some(ext => lower.endsWith(ext))) {
    upload = { body: fs.createReadStream(gcodeFullPath), filename };
  } else {
    let converted;
    try {
      converted = toPlainGcode(filename, fs.readFileSync(gcodeFullPath));
    } catch (err) {
      throw new Error(`Cannot print "${filename}" on ${printer.name}: ${err.message}`);
    }
    if (!converted) {
      throw new Error(`Cannot print "${filename}" on ${printer.name}: OctoPrint only accepts .gcode, .bgcode (converted) or sliced .3mf (converted)`);
    }
    console.log(`[octoprint] ${printer.name}: converted "${filename}" to plain G-code "${converted.filename}" (${(converted.buffer.length / 1048576).toFixed(1)} MB)`);
    upload = { body: converted.buffer, filename: converted.filename };
  }

  const form = new FormData();
  form.append('file', upload.body, { filename: upload.filename, contentType: 'application/octet-stream' });
  form.append('select', 'true');
  form.append('print', 'true');

  let res;
  try {
    res = await axios.post(
      `http://${ip}/api/files/local`,
      form,
      {
        headers: { ...headers(printer), ...form.getHeaders() },
        timeout: 300000, // 5 minutes — large files on slow networks
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
      }
    );
  } catch (err) {
    const status = err.response?.status;
    if (status === 409) {
      throw Object.assign(
        new Error(`409 Conflict on upload — file likely mid-print on ${printer.name}`),
        { code: 'UPLOAD_CONFLICT' }
      );
    }
    if (!status) throw err;
    // OctoPrint's API errors carry a JSON body { "error": "<description>" }.
    const detail = typeof err.response.data?.error === 'string' ? `: ${err.response.data.error}` : '';
    const hint = status === 403
      ? ' (check the API key: its user needs the FILES_UPLOAD and PRINT permissions, plus FILES_DELETE to re-upload a file name that already exists)'
      : '';
    throw new Error(`OctoPrint rejected the upload to ${printer.name} (HTTP ${status}${detail})${hint}`, { cause: err });
  }

  if (res?.data?.effectivePrint === false) {
    throw new Error(
      `OctoPrint stored "${upload.filename}" on ${printer.name} but did not start the print ` +
      '(printer not connected/ready in OctoPrint, or the API key lacks the PRINT permission)'
    );
  }
}

// ─── Cancel ──────────────────────────────────────────────────────────────────

async function cancelJob(printer) {
  try {
    const ip = await resolveHost(printer.ip);
    await axios.post(
      `http://${ip}/api/job`,
      { command: 'cancel' },
      { headers: headers(printer), timeout: 10000 }
    );
  } catch (err) {
    console.warn(`[octoprint] Cancel failed for ${printer.name}: ${err.message}`);
  }
}

// ─── Check if printing ────────────────────────────────────────────────────────

// Returns true if the printer is currently PRINTING or PAUSED.
// Used by the scheduler after an upload failure to detect the case where our
// request timed out but the printer received the file and started printing anyway.
async function checkIfPrinting(printer) {
  try {
    const ip = await resolveHost(printer.ip);
    const response = await axios.get(`http://${ip}/api/printer`, {
      headers: headers(printer),
      timeout: 8000,
    });
    const flags = response.data?.state?.flags || {};
    return !!(flags.printing || flags.paused || flags.pausing || flags.cancelling);
  } catch (_) {
    return false;
  }
}

// ─── Camera ─────────────────────────────────────────────────────────────────

// Returns { streamUrl, snapshotUrl } from OctoPrint's configured webcam, or null
// if no webcam is configured, the printer is unreachable, or the API key lacks
// SETTINGS_READ permission. Never throws.
// Reference: https://docs.octoprint.org/en/main/api/settings.html
async function getCameraUrl(printer) {
  try {
    const ip = await resolveHost(printer.ip);
    const res = await axios.get(`http://${ip}/api/settings`, {
      headers: headers(printer),
      timeout: 8000,
    });
    const webcam = res.data?.webcam || {};
    if (!webcam.streamUrl) return null;

    // streamUrl/snapshotUrl are commonly relative (e.g. "/webcam/?action=stream"),
    // proxied through the same host OctoPrint itself is served on. When the
    // webcam isn't set up through OctoPrint's recommended HAProxy passthrough,
    // OctoPrint instead reports an absolute http://127.0.0.1:<port>/... (or
    // localhost): mjpg-streamer's own loopback address from the Pi's point of
    // view. That port is not reachable from outside the Pi at all (confirmed
    // live: connecting to the printer's real IP on that same port still
    // refused, mjpg-streamer there is bound to 127.0.0.1 only): the only
    // externally-reachable path to it is OctoPi's own HAProxy passthrough,
    // which proxies /webcam/<path> on the printer's normal (non-loopback,
    // no special port) address through to that same loopback instance
    // internally. Rebuilding through that passthrough instead of hitting the
    // reported port directly is what a live test against a real printer
    // confirmed actually works (http://<ip>/webcam/?action=snapshot). A
    // genuinely different absolute URL (an actual external webcam server) is
    // left untouched.
    const hostOnly = ip.replace(/:\d+$/, '');
    const resolve = (u) => {
      if (!/^https?:\/\//i.test(u)) return `http://${ip}${u}`;
      const loopback = /^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?(\/.*)?$/i.exec(u);
      if (!loopback) return u;
      return `http://${hostOnly}/webcam${loopback[1] || '/'}`;
    };
    return {
      streamUrl: resolve(webcam.streamUrl),
      snapshotUrl: webcam.snapshotUrl ? resolve(webcam.snapshotUrl) : null,
    };
  } catch (_) {
    return null;
  }
}

// ─── Test connection ─────────────────────────────────────────────────────────

// One-off reachability check for the "Test Connection" button. Does not create or
// touch any cached connection state (OctoPrint has none). Never throws.
async function testConnection(printer) {
  try {
    const ip = await resolveHost(printer.ip);
    await axios.get(`http://${ip}/api/printer`, { headers: headers(printer), timeout: 8000 });
    return { ok: true, message: ip !== printer.ip ? `Connected (resolved to ${ip})` : 'Connected' };
  } catch (err) {
    return { ok: false, message: describeConnectionError(err) };
  }
}

module.exports = { getStatus, uploadAndPrint, cancelJob, checkIfPrinting, getCameraUrl, testConnection };
