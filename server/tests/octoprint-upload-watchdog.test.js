// OctoPrint upload watchdog, tested against REAL loopback sockets (127.0.0.1 only, no
// printer, nothing leaves the machine). It cannot be tested with a mocked axios: what it
// watches is how many bytes the connection has accepted, which only a real socket
// reports. The scenarios are the failure modes seen on a real farm, where a large
// converted file could not be uploaded to one printer:
//   - a flat 5 minute limit killed a healthy but slow upload
//   - a printer that stopped accepting data had to be waited out
//   - axios's own onUploadProgress reports 100% instantly, so it cannot tell them apart

const http = require('http');
const fs = require('fs');
const path = require('path');

const octoprint = require('../drivers/octoprint');

const MB = 1024 * 1024;
const GCODE_DIR = path.join(__dirname, '..', 'gcode');
const filesToClean = [];
const servers = [];

const defaults = { ...octoprint._uploadLimits };

beforeAll(() => {
  if (!fs.existsSync(GCODE_DIR)) fs.mkdirSync(GCODE_DIR, { recursive: true });
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  Object.assign(octoprint._uploadLimits, defaults);
  while (servers.length) {
    const s = servers.pop();
    s.closeAllConnections && s.closeAllConnections();
    s.close();
  }
});

afterAll(() => {
  for (const p of filesToClean) { try { fs.unlinkSync(p); } catch (_) {} }
  console.log.mockRestore();
  console.warn.mockRestore();
});

// A fake OctoPrint. mode:
//   normal  - reads fast, answers
//   slow    - drains at ratePerSec the whole time, then answers (slow but healthy)
//   stall   - stops reading after stallAfter bytes and never resumes
//   noreply - reads everything, never answers
function fakeOctoPrint(mode, { ratePerSec = 4 * MB, stallAfter = 2 * MB } = {}) {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      let n = 0;
      req.on('data', (c) => {
        n += c.length;
        if (mode === 'slow') { req.pause(); setTimeout(() => req.resume(), (c.length / ratePerSec) * 1000); }
        if (mode === 'stall' && n > stallAfter) req.pause();
      });
      req.on('end', () => {
        if (mode === 'noreply') return;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ done: true, effectivePrint: true }));
      });
    });
    servers.push(s);
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}

function gcodeFile(bytes) {
  const name = `watchdog_${bytes}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.gcode`;
  const full = path.join(GCODE_DIR, name);
  fs.writeFileSync(full, Buffer.alloc(bytes, 'G1 X1 Y1\n'));
  filesToClean.push(full);
  return { full, name };
}

const printerFor = (server) => ({
  id: 1, name: 'P_watchdog', ip: `127.0.0.1:${server.address().port}`, api_key: 'k',
});

describe('OctoPrint upload watchdog', () => {
  test('a normal upload completes', async () => {
    const server = await fakeOctoPrint('normal');
    const { full, name } = gcodeFile(4 * MB);
    await expect(octoprint.uploadAndPrint(printerFor(server), full, name)).resolves.toBeUndefined();
  });

  // The case a flat timeout (or a progress signal that jumps to 100%) gets wrong: the
  // upload takes far longer than the stall limit but never stops moving.
  test('a slow but steadily progressing upload is NOT failed, even though it outlasts the stall limit', async () => {
    Object.assign(octoprint._uploadLimits, { stallMs: 1000, replyWaitMs: 1000 });
    const server = await fakeOctoPrint('slow', { ratePerSec: 3 * MB });
    const { full, name } = gcodeFile(14 * MB); // ~2+ s after the kernel buffers fill
    const start = Date.now();
    await expect(octoprint.uploadAndPrint(printerFor(server), full, name)).resolves.toBeUndefined();
    expect(Date.now() - start).toBeGreaterThan(1000);
  }, 30000);

  test('an upload the printer stops accepting fails as stalled, and says how far it got', async () => {
    Object.assign(octoprint._uploadLimits, { stallMs: 1000, replyWaitMs: 5000 });
    const server = await fakeOctoPrint('stall', { stallAfter: 1 * MB });
    const { full, name } = gcodeFile(30 * MB); // far more than the loopback buffers hold
    const start = Date.now();
    await expect(octoprint.uploadAndPrint(printerFor(server), full, name))
      .rejects.toThrow(/stalled: no data accepted for 1s, \d+\.\d of 30\.0 MB accepted by the printer/);
    expect(Date.now() - start).toBeLessThan(8000); // fails fast, not after a long limit
  }, 30000);

  test('a printer that takes the whole file but never replies fails as no-reply', async () => {
    Object.assign(octoprint._uploadLimits, { stallMs: 5000, replyWaitMs: 1000 });
    const server = await fakeOctoPrint('noreply');
    const { full, name } = gcodeFile(2 * MB);
    await expect(octoprint.uploadAndPrint(printerFor(server), full, name))
      .rejects.toThrow(/sent the whole file but OctoPrint did not reply within 1s/);
  }, 30000);

  test('the hard cap still ends an upload that keeps trickling forever', async () => {
    Object.assign(octoprint._uploadLimits, { stallMs: 60000, replyWaitMs: 60000, maxTotalMs: 1500 });
    const server = await fakeOctoPrint('slow', { ratePerSec: 1 * MB });
    const { full, name } = gcodeFile(40 * MB);
    await expect(octoprint.uploadAndPrint(printerFor(server), full, name)).rejects.toThrow(/timeout of 1500ms/);
  }, 30000);
});
