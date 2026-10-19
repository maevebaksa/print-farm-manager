// Unit tests for server/drivers/octoprint.js
// All network calls are mocked — no real printers needed.

jest.mock('axios');
const axios = require('axios');
// The offline TCP probe opens a real socket; mocked so no test touches the network.
jest.mock('net');
const net = require('net');
const { EventEmitter } = require('events');

const path = require('path');
const fs = require('fs');
const octoprint = require('../drivers/octoprint');
const { buildBgcode, buildZip } = require('./support/gcode-fixtures');

const GCODE_DIR = path.join(__dirname, '..', 'gcode');

const fakePrinter = { id: 1, name: 'OctoPi_01', ip: '192.168.1.240:5000', model: 'mk3s', type: 'octoprint', api_key: 'test-key' };

const filesToClean = [];

// Drains a Readable (the converted-file upload body) into one Buffer.
async function streamToBuffer(stream) {
  const parts = [];
  for await (const chunk of stream) parts.push(Buffer.from(chunk));
  return Buffer.concat(parts);
}

beforeAll(() => {
  if (!fs.existsSync(GCODE_DIR)) fs.mkdirSync(GCODE_DIR, { recursive: true });
});

afterAll(() => {
  for (const p of filesToClean) {
    try { fs.unlinkSync(p); } catch (_) {}
  }
});

afterEach(() => {
  jest.clearAllMocks();
});

function createTestFile(filename) {
  const filePath = path.join(GCODE_DIR, filename);
  fs.writeFileSync(filePath, '; fake gcode');
  filesToClean.push(filePath);
  return filePath;
}

function printerResponse(flags) {
  return { data: { state: { flags: { operational: true, printing: false, paused: false, pausing: false, cancelling: false, error: false, closedOrError: false, ready: true, ...flags } } } };
}

function jobResponse({ completion = null, printTimeLeft = null, filename = null } = {}) {
  return {
    data: {
      progress: { completion, printTimeLeft },
      job: { file: { name: filename } },
    },
  };
}

function mockPair(printerFlags, jobOpts) {
  axios.get.mockImplementation((url) => {
    if (url.includes('/api/printer')) return Promise.resolve(printerResponse(printerFlags));
    if (url.includes('/api/job')) return Promise.resolve(jobResponse(jobOpts));
    return Promise.reject(new Error(`unexpected url ${url}`));
  });
}

// ─── getStatus ────────────────────────────────────────────────────────────────

describe('getStatus', () => {
  test('returns IDLE when operational with no job loaded', async () => {
    mockPair({}, {});
    const result = await octoprint.getStatus(fakePrinter);
    expect(result.status).toBe('IDLE');
    expect(result.progress).toBeNull();
    expect(result.timeRemaining).toBeNull();
  });

  test('returns PRINTING with progress, time remaining, and current file', async () => {
    mockPair({ printing: true }, { completion: 42, printTimeLeft: 600, filename: 'part.gcode' });
    const result = await octoprint.getStatus(fakePrinter);
    expect(result.status).toBe('PRINTING');
    expect(result.progress).toBe(42);
    expect(result.timeRemaining).toBe(600);
    expect(result.currentFile).toBe('part.gcode');
  });

  test('returns PRINTING while cancelling (transitional state)', async () => {
    mockPair({ cancelling: true }, { completion: 80, filename: 'part.gcode' });
    const result = await octoprint.getStatus(fakePrinter);
    expect(result.status).toBe('PRINTING');
  });

  test('returns PAUSED', async () => {
    mockPair({ paused: true }, { completion: 30, filename: 'part.gcode' });
    const result = await octoprint.getStatus(fakePrinter);
    expect(result.status).toBe('PAUSED');
  });

  test('returns FINISHED when not printing, job file present, completion is 100', async () => {
    mockPair({}, { completion: 100, filename: 'part.gcode' });
    const result = await octoprint.getStatus(fakePrinter);
    expect(result.status).toBe('FINISHED');
    expect(result.progress).toBeNull();
  });

  test('returns IDLE (not FINISHED) when completion is 100 but no job file loaded', async () => {
    mockPair({}, { completion: 100, filename: null });
    const result = await octoprint.getStatus(fakePrinter);
    expect(result.status).toBe('IDLE');
  });

  test('returns ERROR when error flag is set', async () => {
    mockPair({ error: true }, {});
    const result = await octoprint.getStatus(fakePrinter);
    expect(result.status).toBe('ERROR');
  });

  test('returns ERROR when closedOrError flag is set', async () => {
    mockPair({ operational: false, closedOrError: true }, {});
    const result = await octoprint.getStatus(fakePrinter);
    expect(result.status).toBe('ERROR');
  });

  test('returns UNKNOWN when not operational and no error flag', async () => {
    mockPair({ operational: false }, {});
    const result = await octoprint.getStatus(fakePrinter);
    expect(result.status).toBe('UNKNOWN');
  });

  test('returns OFFLINE on network error', async () => {
    axios.get.mockRejectedValue(new Error('ETIMEDOUT'));
    const result = await octoprint.getStatus(fakePrinter);
    expect(result.status).toBe('OFFLINE');
    expect(result.progress).toBeNull();
  });

  describe('offline diagnostics', () => {
    let logSpy;
    const printer = { ...fakePrinter, id: 901, name: 'OctoPi_diag' };
    beforeEach(() => { logSpy = jest.spyOn(console, 'log').mockImplementation(() => {}); });
    afterEach(() => { logSpy.mockRestore(); });
    const logged = () => logSpy.mock.calls.map(c => c[0])
      .filter(l => /OctoPi_diag (OFFLINE|reachable again)/.test(String(l)));

    test('409 from /api/printer is OFFLINE and logs that the serial link is closed', async () => {
      axios.get.mockRejectedValue({ response: { status: 409 } });
      const result = await octoprint.getStatus({ ...printer, id: 902 });
      expect(result.status).toBe('OFFLINE');
      expect(logged().join('\n')).toMatch(/not operational/);
    });

    test('logs once while the cause is unchanged, again when it changes, and on recovery', async () => {
      axios.get.mockRejectedValue({ code: 'ECONNREFUSED' });
      await octoprint.getStatus(printer);
      await octoprint.getStatus(printer);
      expect(logged()).toHaveLength(1);

      axios.get.mockRejectedValue({ response: { status: 409 } });
      await octoprint.getStatus(printer);
      expect(logged()).toHaveLength(2);

      mockPair({}, {});
      await octoprint.getStatus(printer);
      expect(logged()).toHaveLength(3);
      expect(logged()[2]).toMatch(/reachable again/);
    });
  });

  describe('offline TCP probe and slow-answer log', () => {
    let fakeSocket;
    beforeEach(() => {
      jest.spyOn(console, 'log').mockImplementation(() => {});
      fakeSocket = Object.assign(new EventEmitter(), { destroy: jest.fn() });
      net.connect.mockReset().mockReturnValue(fakeSocket);
    });
    afterEach(() => { console.log.mockRestore(); });
    const probeLogs = () => console.log.mock.calls.map(c => c[0]).filter(l => /TCP probe/.test(String(l)));
    const tick = () => new Promise(r => setImmediate(r));

    test('a timeout probes the printer web port and reports a hanging OctoPrint when the connect succeeds', async () => {
      axios.get.mockRejectedValue({ code: 'ECONNABORTED' });
      await octoprint.getStatus({ ...fakePrinter, id: 930, name: 'probe_up', ip: '192.168.1.77:5000' });
      await tick();
      expect(net.connect).toHaveBeenCalledWith(expect.objectContaining({ host: '192.168.1.77', port: 5000 }));

      fakeSocket.emit('connect');
      expect(probeLogs().join('\n')).toMatch(/probe_up TCP probe: connected to 192\.168\.1\.77:5000 .*not answering HTTP/);
      expect(fakeSocket.destroy).toHaveBeenCalled();
    });

    test('reports the host as unreachable when the connect times out', async () => {
      axios.get.mockRejectedValue({ code: 'ECONNABORTED' });
      await octoprint.getStatus({ ...fakePrinter, id: 931, name: 'probe_down', ip: '192.168.1.78' });
      await tick();
      expect(net.connect).toHaveBeenCalledWith(expect.objectContaining({ host: '192.168.1.78', port: 80 }));

      fakeSocket.emit('timeout');
      expect(probeLogs().join('\n')).toMatch(/probe_down TCP probe: no connection .* not reachable from this server/);
    });

    test('probes once per new timeout, and never for other failures', async () => {
      const printer = { ...fakePrinter, id: 932, name: 'probe_once' };
      axios.get.mockRejectedValue({ code: 'ECONNABORTED' });
      await octoprint.getStatus(printer);
      await octoprint.getStatus(printer); // same reason again: no second probe
      await tick();
      expect(net.connect).toHaveBeenCalledTimes(1);

      net.connect.mockClear();
      for (const [id, err] of [[933, { code: 'ECONNREFUSED' }], [934, { response: { status: 403 } }], [935, { response: { status: 409 } }]]) {
        axios.get.mockRejectedValue(err);
        axios.post.mockResolvedValue({});
        await octoprint.getStatus({ ...fakePrinter, id });
      }
      await tick();
      expect(net.connect).not.toHaveBeenCalled();
    });

    test('a probe that cannot start never breaks the poll', async () => {
      net.connect.mockImplementation(() => { throw new Error('boom'); });
      axios.get.mockRejectedValue({ code: 'ECONNABORTED' });
      const result = await octoprint.getStatus({ ...fakePrinter, id: 936, name: 'probe_throw' });
      expect(result.status).toBe('OFFLINE');
    });

    test('logs a successful but slow answer once per minute per printer', async () => {
      let now = 1_000_000;
      const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
      const printer = { ...fakePrinter, id: 937, name: 'slowpoke' };
      axios.get.mockImplementation(async (url) => {
        // OctoPrint takes 6 s to answer; getStatus sends two requests per poll in
        // parallel, so the clock only advances on one of them.
        if (url.includes('/api/printer')) { now += 6000; return printerResponse({}); }
        return jobResponse({});
      });

      await octoprint.getStatus(printer);
      await octoprint.getStatus(printer); // within a minute: not logged again
      const slow = () => console.log.mock.calls.map(c => c[0]).filter(l => /slowpoke slow answer/.test(String(l)));
      expect(slow()).toHaveLength(1);
      expect(slow()[0]).toMatch(/6\.0s \(timeout is 8s\)/);

      now += 61000;
      await octoprint.getStatus(printer);
      expect(slow()).toHaveLength(2);
      nowSpy.mockRestore();
    });

    test('a fast answer is not logged as slow', async () => {
      mockPair({}, {});
      await octoprint.getStatus({ ...fakePrinter, id: 938, name: 'speedy' });
      expect(console.log.mock.calls.map(c => c[0]).filter(l => /speedy slow answer/.test(String(l)))).toHaveLength(0);
    });
  });

  describe('auto-reconnect on 409', () => {
    let nowSpy;
    let now;
    beforeEach(() => {
      jest.spyOn(console, 'log').mockImplementation(() => {});
      jest.spyOn(console, 'warn').mockImplementation(() => {});
      now = 1_000_000_000;
      nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
      axios.post.mockResolvedValue({ status: 204 });
    });
    afterEach(() => { nowSpy.mockRestore(); console.log.mockRestore(); console.warn.mockRestore(); });

    test('sends the connect command (command only) when /api/printer answers 409', async () => {
      axios.get.mockRejectedValue({ response: { status: 409 } });
      const result = await octoprint.getStatus({ ...fakePrinter, id: 910 });
      expect(result.status).toBe('OFFLINE');
      expect(axios.post).toHaveBeenCalledTimes(1);
      expect(axios.post).toHaveBeenCalledWith(
        'http://192.168.1.240:5000/api/connection',
        { command: 'connect' },
        expect.objectContaining({ headers: { 'X-Api-Key': 'test-key' } })
      );
    });

    test('does not send connect for unreachable, timeout, or auth errors', async () => {
      for (const [i, err] of [[911, { code: 'ECONNREFUSED' }], [912, { code: 'ECONNABORTED' }], [913, { response: { status: 403 } }]]) {
        axios.get.mockRejectedValue(err);
        await octoprint.getStatus({ ...fakePrinter, id: i });
      }
      expect(axios.post).not.toHaveBeenCalled();
    });

    test('waits out the cooldown between attempts, then tries again', async () => {
      axios.get.mockRejectedValue({ response: { status: 409 } });
      const printer = { ...fakePrinter, id: 914 };
      await octoprint.getStatus(printer);
      now += 15000;
      await octoprint.getStatus(printer);
      expect(axios.post).toHaveBeenCalledTimes(1);
      now += 60000;
      await octoprint.getStatus(printer);
      expect(axios.post).toHaveBeenCalledTimes(2);
    });

    test('a failing connect command (e.g. 403) is swallowed and the status is still OFFLINE', async () => {
      axios.get.mockRejectedValue({ response: { status: 409 } });
      axios.post.mockRejectedValue({ response: { status: 403 } });
      const result = await octoprint.getStatus({ ...fakePrinter, id: 915 });
      expect(result.status).toBe('OFFLINE');
      expect(console.warn).toHaveBeenCalledWith(expect.stringMatching(/connect command failed \(HTTP 403\)/));
    });
  });

  test('queries /api/printer and /api/job with X-Api-Key header', async () => {
    mockPair({}, {});
    await octoprint.getStatus(fakePrinter);
    expect(axios.get).toHaveBeenCalledWith(
      'http://192.168.1.240:5000/api/printer',
      expect.objectContaining({ headers: { 'X-Api-Key': 'test-key' } })
    );
    expect(axios.get).toHaveBeenCalledWith(
      'http://192.168.1.240:5000/api/job',
      expect.objectContaining({ headers: { 'X-Api-Key': 'test-key' } })
    );
  });
});

// ─── uploadAndPrint ───────────────────────────────────────────────────────────

describe('uploadAndPrint', () => {
  test('POSTs to /api/files/local with select and print form fields', async () => {
    const filename = `octoprint_upload_${Date.now()}.gcode`;
    const fullPath = createTestFile(filename);
    axios.post.mockResolvedValueOnce({});

    const FormData = require('form-data');
    const appendSpy = jest.spyOn(FormData.prototype, 'append');

    await octoprint.uploadAndPrint(fakePrinter, fullPath, filename);

    const [url, , config] = axios.post.mock.calls[0];
    expect(url).toBe('http://192.168.1.240:5000/api/files/local');
    expect(config.headers['X-Api-Key']).toBe('test-key');

    const appendedFields = appendSpy.mock.calls.map(([name, value]) => ({ name, value }));
    expect(appendedFields).toContainEqual({ name: 'select', value: 'true' });
    expect(appendedFields).toContainEqual({ name: 'print', value: 'true' });

    appendSpy.mockRestore();
  });

  test('throws UPLOAD_CONFLICT on 409 response', async () => {
    const filename = `octoprint_conflict_${Date.now()}.gcode`;
    const fullPath = createTestFile(filename);
    axios.post.mockRejectedValueOnce({ response: { status: 409 } });

    await expect(octoprint.uploadAndPrint(fakePrinter, fullPath, filename))
      .rejects.toMatchObject({ code: 'UPLOAD_CONFLICT' });
  });

  test('converts a .bgcode to plain G-code and uploads it under a .gcode name', async () => {
    const filename = `octoprint_bg_${Date.now()}.bgcode`;
    const fullPath = path.join(GCODE_DIR, filename);
    fs.writeFileSync(fullPath, buildBgcode([{ type: 1, data: Buffer.from('G28\nG1 X1\n') }]));
    filesToClean.push(fullPath);
    axios.post.mockResolvedValueOnce({ data: { done: true, effectivePrint: true } });

    const FormData = require('form-data');
    const appendSpy = jest.spyOn(FormData.prototype, 'append');
    await octoprint.uploadAndPrint(fakePrinter, fullPath, filename);

    const fileCall = appendSpy.mock.calls.find(([name]) => name === 'file');
    // A converted file is streamed in small chunks so upload progress follows what the
    // printer accepts; the declared length keeps Content-Length exact.
    const sent = await streamToBuffer(fileCall[1]);
    expect(sent.toString()).toContain('G28\nG1 X1\n');
    expect(fileCall[2].knownLength).toBe(sent.length);
    expect(fileCall[2].filename).toBe(filename.replace(/\.bgcode$/, '.gcode'));
    appendSpy.mockRestore();
  });

  // Regression: the scheduler retries a failed upload (3 attempts per sweep, then again
  // on every later sweep), and each attempt re-read and re-decoded the whole file on the
  // server's single thread, which a 35 MB .bgcode made very expensive.
  test('converts a .bgcode only once across repeated upload attempts, and re-converts if the file changes', async () => {
    const filename = `octoprint_cache_${Date.now()}.bgcode`;
    const fullPath = path.join(GCODE_DIR, filename);
    fs.writeFileSync(fullPath, buildBgcode([{ type: 1, data: Buffer.from('G28\nG1 X1\n') }]));
    filesToClean.push(fullPath);
    axios.post.mockResolvedValue({ data: { done: true, effectivePrint: true } });

    const readSpy = jest.spyOn(fs, 'readFileSync');
    const reads = () => readSpy.mock.calls.filter(([p]) => p === fullPath).length;

    await octoprint.uploadAndPrint(fakePrinter, fullPath, filename);
    await octoprint.uploadAndPrint(fakePrinter, fullPath, filename);
    await octoprint.uploadAndPrint(fakePrinter, fullPath, filename);
    expect(reads()).toBe(1);

    // A re-uploaded file (new content, so new size/mtime) must not be served stale.
    fs.writeFileSync(fullPath, buildBgcode([{ type: 1, data: Buffer.from('G28\nG1 X1 Y1 Z1 E1\n') }]));
    const FormData = require('form-data');
    const appendSpy = jest.spyOn(FormData.prototype, 'append');
    await octoprint.uploadAndPrint(fakePrinter, fullPath, filename);
    expect(reads()).toBe(2);
    const fileCall = appendSpy.mock.calls.find(([name]) => name === 'file');
    expect((await streamToBuffer(fileCall[1])).toString()).toContain('Y1 Z1 E1');

    appendSpy.mockRestore();
    readSpy.mockRestore();
  });

  test('logs the upload size and duration on success and on failure', async () => {
    const filename = `octoprint_stats_${Date.now()}.gcode`;
    const fullPath = createTestFile(filename);
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    axios.post.mockResolvedValueOnce({ data: { effectivePrint: true } });
    await octoprint.uploadAndPrint(fakePrinter, fullPath, filename);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/OctoPi_01: upload finished, \d+\.\d MB in \d+s \(\d+\.\d\d MB\/s\)/));

    axios.post.mockRejectedValueOnce(Object.assign(new Error('timeout of 300000ms exceeded'), { code: 'ECONNABORTED' }));
    await expect(octoprint.uploadAndPrint(fakePrinter, fullPath, filename)).rejects.toThrow(/timeout/);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/OctoPi_01: upload failed after \d+s, \d+\.\d of \d+\.\d MB accepted by the printer/));

    log.mockRestore();
    warn.mockRestore();
  });

  test('extracts the plate G-code from a sliced .3mf and uploads it', async () => {
    const filename = `octoprint_3mf_${Date.now()}.gcode.3mf`;
    const fullPath = path.join(GCODE_DIR, filename);
    fs.writeFileSync(fullPath, buildZip([{ name: 'Metadata/plate_1.gcode', data: Buffer.from('G28\n') }]));
    filesToClean.push(fullPath);
    axios.post.mockResolvedValueOnce({ data: { effectivePrint: true } });

    const FormData = require('form-data');
    const appendSpy = jest.spyOn(FormData.prototype, 'append');
    await octoprint.uploadAndPrint(fakePrinter, fullPath, filename);

    const fileCall = appendSpy.mock.calls.find(([name]) => name === 'file');
    expect((await streamToBuffer(fileCall[1])).toString()).toBe('G28\n');
    expect(fileCall[2].filename).toBe(filename.replace(/\.gcode\.3mf$/, '.gcode'));
    appendSpy.mockRestore();
  });

  test('rejects an unsliced .3mf without contacting OctoPrint', async () => {
    const filename = `octoprint_model_${Date.now()}.3mf`;
    const fullPath = path.join(GCODE_DIR, filename);
    fs.writeFileSync(fullPath, buildZip([{ name: '3D/3dmodel.model', data: Buffer.from('<model/>') }]));
    filesToClean.push(fullPath);

    await expect(octoprint.uploadAndPrint(fakePrinter, fullPath, filename)).rejects.toThrow(/no sliced G-code/);
    expect(axios.post).not.toHaveBeenCalled();
  });

  test('rejects a file type OctoPrint cannot print without contacting it', async () => {
    const filename = `octoprint_model_${Date.now()}.stl`;
    const fullPath = createTestFile(filename);

    await expect(octoprint.uploadAndPrint(fakePrinter, fullPath, filename)).rejects.toThrow(/only accepts/);
    expect(axios.post).not.toHaveBeenCalled();
  });

  test('throws when OctoPrint stores the file but does not start the print (effectivePrint false)', async () => {
    // Real-world: OctoPrint answers 201 but skips print=true when the printer is not
    // connected/ready or the key lacks PRINT; this used to mark the job printing
    // while nothing ran.
    const filename = `octoprint_noprint_${Date.now()}.gcode`;
    const fullPath = createTestFile(filename);
    axios.post.mockResolvedValueOnce({ status: 201, data: { done: true, effectiveSelect: false, effectivePrint: false } });

    await expect(octoprint.uploadAndPrint(fakePrinter, fullPath, filename))
      .rejects.toThrow(/did not start the print/);
  });

  test('includes OctoPrint\'s error text and a permission hint on 403', async () => {
    const filename = `octoprint_403_${Date.now()}.gcode`;
    const fullPath = createTestFile(filename);
    axios.post.mockRejectedValueOnce({ response: { status: 403, data: { error: 'File already exists, cannot overwrite due to a lack of permissions' } } });

    const err = await octoprint.uploadAndPrint(fakePrinter, fullPath, filename).catch(e => e);
    expect(err.message).toMatch(/HTTP 403: File already exists/);
    expect(err.message).toMatch(/FILES_DELETE/);
    expect(err.code).toBeUndefined();
  });

  test('rethrows non-409 errors unchanged', async () => {
    const filename = `octoprint_fail_${Date.now()}.gcode`;
    const fullPath = createTestFile(filename);
    axios.post.mockRejectedValueOnce(new Error('Request failed with status code 500'));

    await expect(octoprint.uploadAndPrint(fakePrinter, fullPath, filename))
      .rejects.toThrow('500');
  });
});

// ─── cancelJob ─────────────────────────────────────────────────────────────────

describe('cancelJob', () => {
  test('POSTs cancel command to /api/job', async () => {
    axios.post.mockResolvedValueOnce({});
    await octoprint.cancelJob(fakePrinter);
    expect(axios.post).toHaveBeenCalledWith(
      'http://192.168.1.240:5000/api/job',
      { command: 'cancel' },
      expect.objectContaining({ headers: { 'X-Api-Key': 'test-key' } })
    );
  });

  test('swallows errors', async () => {
    axios.post.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(octoprint.cancelJob(fakePrinter)).resolves.toBeUndefined();
  });
});

// ─── checkIfPrinting ─────────────────────────────────────────────────────────

describe('checkIfPrinting', () => {
  test('returns true when printing', async () => {
    axios.get.mockResolvedValueOnce(printerResponse({ printing: true }));
    expect(await octoprint.checkIfPrinting(fakePrinter)).toBe(true);
  });

  test('returns true when paused', async () => {
    axios.get.mockResolvedValueOnce(printerResponse({ paused: true }));
    expect(await octoprint.checkIfPrinting(fakePrinter)).toBe(true);
  });

  test('returns false when idle', async () => {
    axios.get.mockResolvedValueOnce(printerResponse({}));
    expect(await octoprint.checkIfPrinting(fakePrinter)).toBe(false);
  });

  test('returns false when printer is unreachable', async () => {
    axios.get.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    expect(await octoprint.checkIfPrinting(fakePrinter)).toBe(false);
  });
});

// ─── getCameraUrl ──────────────────────────────────────────────────────────────

describe('getCameraUrl', () => {
  test('returns resolved stream/snapshot URLs from settings.webcam', async () => {
    axios.get.mockResolvedValueOnce({
      data: { webcam: { streamUrl: '/webcam/?action=stream', snapshotUrl: '/webcam/?action=snapshot' } },
    });
    const result = await octoprint.getCameraUrl(fakePrinter);
    expect(result).toEqual({
      streamUrl: 'http://192.168.1.240:5000/webcam/?action=stream',
      snapshotUrl: 'http://192.168.1.240:5000/webcam/?action=snapshot',
    });
  });

  test('passes through an already-absolute stream URL unchanged', async () => {
    axios.get.mockResolvedValueOnce({
      data: { webcam: { streamUrl: 'http://otherhost:8080/stream', snapshotUrl: null } },
    });
    const result = await octoprint.getCameraUrl(fakePrinter);
    expect(result.streamUrl).toBe('http://otherhost:8080/stream');
    expect(result.snapshotUrl).toBeNull();
  });

  // A webcam not set up through OctoPrint's recommended HAProxy passthrough
  // reports an absolute http://127.0.0.1:<port>/... (or localhost): mjpg-
  // streamer's own loopback address, not reachable from outside the Pi at all
  // (confirmed live: the printer's real IP on that same port also refused the
  // connection). The only externally-reachable path is OctoPi's own /webcam/
  // HAProxy passthrough on the printer's normal address, confirmed live
  // against a real printer (http://<ip>/webcam/?action=snapshot worked).
  // fakePrinter.ip already carries its own :5000 for OctoPrint's own API,
  // which must not appear in the rebuilt URL: the passthrough lives on the
  // printer's normal (non-loopback) address, not OctoPrint's own API port.
  test('rebuilds an absolute 127.0.0.1 stream/snapshot URL through the /webcam/ passthrough', async () => {
    axios.get.mockResolvedValueOnce({
      data: { webcam: { streamUrl: 'http://127.0.0.1:8080/?action=stream', snapshotUrl: 'http://127.0.0.1:8080/?action=snapshot' } },
    });
    const result = await octoprint.getCameraUrl(fakePrinter);
    expect(result).toEqual({
      streamUrl: 'http://192.168.1.240/webcam/?action=stream',
      snapshotUrl: 'http://192.168.1.240/webcam/?action=snapshot',
    });
  });

  test('rebuilds an absolute localhost URL (no port) through the /webcam/ passthrough too', async () => {
    axios.get.mockResolvedValueOnce({
      data: { webcam: { streamUrl: 'http://localhost/?action=stream', snapshotUrl: null } },
    });
    const result = await octoprint.getCameraUrl(fakePrinter);
    expect(result.streamUrl).toBe('http://192.168.1.240/webcam/?action=stream');
  });

  test('returns null when no webcam is configured', async () => {
    axios.get.mockResolvedValueOnce({ data: { webcam: {} } });
    expect(await octoprint.getCameraUrl(fakePrinter)).toBeNull();
  });

  test('returns null on network error', async () => {
    axios.get.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    expect(await octoprint.getCameraUrl(fakePrinter)).toBeNull();
  });

  test('queries /api/settings with X-Api-Key header', async () => {
    axios.get.mockResolvedValueOnce({ data: { webcam: {} } });
    await octoprint.getCameraUrl(fakePrinter);
    expect(axios.get).toHaveBeenCalledWith(
      'http://192.168.1.240:5000/api/settings',
      expect.objectContaining({ headers: { 'X-Api-Key': 'test-key' } })
    );
  });
});

// ─── Test connection ──────────────────────────────────────────────────────────

describe('testConnection', () => {
  test('reports ok on a successful request', async () => {
    axios.get.mockResolvedValue({ data: {} });
    const result = await octoprint.testConnection(fakePrinter);
    expect(result).toEqual({ ok: true, message: 'Connected' });
  });

  test('reports the connection refused reason', async () => {
    axios.get.mockRejectedValue(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));
    const result = await octoprint.testConnection(fakePrinter);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/refused/i);
  });

  test('reports a bad API key as a rejection, not a generic failure', async () => {
    axios.get.mockRejectedValue({ response: { status: 401 } });
    const result = await octoprint.testConnection(fakePrinter);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/API key/i);
  });
});

// ─── Driver registry ──────────────────────────────────────────────────────────

describe('driver registry', () => {
  const { getDriver } = require('../drivers');

  test('getDriver("octoprint") returns the octoprint driver', () => {
    const driver = getDriver('octoprint');
    expect(typeof driver.getStatus).toBe('function');
    expect(typeof driver.uploadAndPrint).toBe('function');
    expect(typeof driver.cancelJob).toBe('function');
    expect(typeof driver.checkIfPrinting).toBe('function');
    expect(typeof driver.getCameraUrl).toBe('function');
    expect(typeof driver.testConnection).toBe('function');
  });
});
