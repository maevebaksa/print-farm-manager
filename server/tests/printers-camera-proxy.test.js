// Tests for:
//   GET /api/printers/:id/camera
//   GET /api/printers/:id/camera/snapshot
//   GET /api/printers/:id/camera/stream
//
// The driver registry is mocked (getCameraUrl's own connector-specific logic is
// covered by each driver's own test file, e.g. klipper-driver.test.js). axios is
// also mocked, since the two proxy routes make their own upstream HTTP call
// directly (not through a driver) to fetch and pipe the actual image/stream bytes.

jest.mock('../drivers', () => ({
  getDriver: jest.fn(),
}));
jest.mock('axios');

const request   = require('supertest');
const express   = require('express');
const Database  = require('better-sqlite3');
const { Readable } = require('stream');
const { getDriver } = require('../drivers');
const axios = require('axios');

let db;
let app;

beforeEach(() => {
  jest.clearAllMocks();
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE printers (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      name              TEXT NOT NULL,
      ip                TEXT NOT NULL,
      type              TEXT DEFAULT 'prusa',
      model             TEXT NOT NULL,
      camera_rotation   INTEGER DEFAULT 0,
      camera_flip_h     INTEGER DEFAULT 0,
      camera_flip_v     INTEGER DEFAULT 0,
      created_at        INTEGER NOT NULL
    );
    CREATE TABLE printer_groups (name TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
  `);
  db.prepare(
    `INSERT INTO printers (id, name, ip, type, model, camera_rotation, camera_flip_h, camera_flip_v, created_at)
     VALUES (1, 'Voron', '192.168.1.50', 'klipper', 'voron-24', 180, 1, 0, ?)`
  ).run(Date.now());

  app = express();
  app.use(express.json());
  app.use('/api/printers', require('../routes/printers')(db));
});

describe('GET /api/printers/:id/camera', () => {
  test('404s for a missing printer', async () => {
    const res = await request(app).get('/api/printers/999/camera');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  test('available: false when the connector has no getCameraUrl support', async () => {
    getDriver.mockReturnValue({ getStatus: jest.fn() });
    const res = await request(app).get('/api/printers/1/camera');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ available: false });
  });

  test('available: false when the driver reports no camera', async () => {
    getDriver.mockReturnValue({ getCameraUrl: jest.fn().mockResolvedValue(null) });
    const res = await request(app).get('/api/printers/1/camera');
    expect(res.body).toEqual({ available: false });
  });

  test('returns this server\'s own proxy paths, not the driver\'s raw LAN URLs', async () => {
    getDriver.mockReturnValue({
      getCameraUrl: jest.fn().mockResolvedValue({
        streamUrl: 'http://192.168.1.50/webcam/?action=stream',
        snapshotUrl: 'http://192.168.1.50/webcam/?action=snapshot',
      }),
    });
    const res = await request(app).get('/api/printers/1/camera');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      available: true,
      streamUrl: '/api/printers/1/camera/stream',
      snapshotUrl: '/api/printers/1/camera/snapshot',
      rotation: 180,
      flipH: true,
      flipV: false,
    });
  });

  test('snapshotUrl is null when the driver has a stream but no snapshot', async () => {
    getDriver.mockReturnValue({
      getCameraUrl: jest.fn().mockResolvedValue({
        streamUrl: 'http://192.168.1.50/webcam/?action=stream',
        snapshotUrl: null,
      }),
    });
    const res = await request(app).get('/api/printers/1/camera');
    expect(res.body.streamUrl).toBe('/api/printers/1/camera/stream');
    expect(res.body.snapshotUrl).toBeNull();
  });
});

// Shared across both proxy routes below.
function fakeUpstream(contentType, body) {
  const stream = Readable.from([Buffer.from(body)]);
  return { headers: { 'content-type': contentType }, data: stream };
}

// superagent (supertest's client) picks a body parser from the response's own
// Content-Type: 'image/jpeg' has none registered, so res.text/res.body come back
// empty, and 'multipart/x-mixed-replace' matches its multipart parser, which then
// chokes trying to read our plain fake bytes as real multipart-boundary data. Ask
// for the raw bytes directly instead, regardless of what Content-Type the proxy
// route sets, exactly as the proxy itself claims to not care what it's forwarding.
function rawBufferParser(res, callback) {
  const chunks = [];
  res.on('data', (chunk) => chunks.push(chunk));
  res.on('end', () => callback(null, Buffer.concat(chunks)));
}

describe('GET /api/printers/:id/camera/snapshot', () => {
  test('404s for a missing printer', async () => {
    const res = await request(app).get('/api/printers/999/camera/snapshot');
    expect(res.status).toBe(404);
  });

  test('404s when the connector has no camera support', async () => {
    getDriver.mockReturnValue({ getStatus: jest.fn() });
    const res = await request(app).get('/api/printers/1/camera/snapshot');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/camera not available/i);
  });

  test('404s when the driver reports no snapshot URL', async () => {
    getDriver.mockReturnValue({
      getCameraUrl: jest.fn().mockResolvedValue({ streamUrl: 'http://192.168.1.50/stream', snapshotUrl: null }),
    });
    const res = await request(app).get('/api/printers/1/camera/snapshot');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/snapshot/i);
  });

  test('pipes the upstream image through with its content type, fetched from the LAN URL', async () => {
    getDriver.mockReturnValue({
      getCameraUrl: jest.fn().mockResolvedValue({
        streamUrl: 'http://192.168.1.50/webcam/?action=stream',
        snapshotUrl: 'http://192.168.1.50/webcam/?action=snapshot',
      }),
    });
    axios.get.mockResolvedValue(fakeUpstream('image/jpeg', 'fake-jpeg-bytes'));

    const res = await request(app).get('/api/printers/1/camera/snapshot').buffer(true).parse(rawBufferParser);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/jpeg');
    expect(res.body.toString()).toBe('fake-jpeg-bytes');
    expect(axios.get).toHaveBeenCalledWith(
      'http://192.168.1.50/webcam/?action=snapshot',
      expect.objectContaining({ responseType: 'stream' })
    );
  });

  test('502s when the upstream camera request fails', async () => {
    getDriver.mockReturnValue({
      getCameraUrl: jest.fn().mockResolvedValue({
        streamUrl: 'http://192.168.1.50/stream', snapshotUrl: 'http://192.168.1.50/snapshot',
      }),
    });
    axios.get.mockRejectedValue(new Error('connect ECONNREFUSED'));

    const res = await request(app).get('/api/printers/1/camera/snapshot');
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/could not reach camera/i);
  });
});

describe('GET /api/printers/:id/camera/stream', () => {
  test('404s when the driver reports no stream URL', async () => {
    getDriver.mockReturnValue({
      getCameraUrl: jest.fn().mockResolvedValue({ streamUrl: null, snapshotUrl: 'http://192.168.1.50/snapshot' }),
    });
    const res = await request(app).get('/api/printers/1/camera/stream');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/stream/i);
  });

  test('pipes the upstream MJPEG stream through with its content type, fetched from the LAN URL', async () => {
    getDriver.mockReturnValue({
      getCameraUrl: jest.fn().mockResolvedValue({
        streamUrl: 'http://192.168.1.50/webcam/?action=stream',
        snapshotUrl: 'http://192.168.1.50/webcam/?action=snapshot',
      }),
    });
    axios.get.mockResolvedValue(fakeUpstream('multipart/x-mixed-replace; boundary=frame', 'fake-mjpeg-bytes'));

    const res = await request(app).get('/api/printers/1/camera/stream').buffer(true).parse(rawBufferParser);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('multipart/x-mixed-replace; boundary=frame');
    expect(res.body.toString()).toBe('fake-mjpeg-bytes');
    expect(axios.get).toHaveBeenCalledWith(
      'http://192.168.1.50/webcam/?action=stream',
      expect.objectContaining({ responseType: 'stream' })
    );
  });
});
