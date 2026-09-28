// Unit tests for server/drivers/octoprint.js
// All network calls are mocked — no real printers needed.

jest.mock('axios');
const axios = require('axios');

const path = require('path');
const fs = require('fs');
const octoprint = require('../drivers/octoprint');
const { buildBgcode, buildZip } = require('./support/gcode-fixtures');

const GCODE_DIR = path.join(__dirname, '..', 'gcode');

const fakePrinter = { id: 1, name: 'OctoPi_01', ip: '192.168.1.240:5000', model: 'mk3s', type: 'octoprint', api_key: 'test-key' };

const filesToClean = [];

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
    expect(Buffer.isBuffer(fileCall[1])).toBe(true);
    expect(fileCall[1].toString()).toContain('G28\nG1 X1\n');
    expect(fileCall[2].filename).toBe(filename.replace(/\.bgcode$/, '.gcode'));
    appendSpy.mockRestore();
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
    expect(fileCall[1].toString()).toBe('G28\n');
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
