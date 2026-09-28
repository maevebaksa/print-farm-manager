// Tests for GET /api/update/status and POST /api/update/trigger.
// https and child_process are fully mocked: this route never needs a real
// GitHub call or a real spawned process to verify its own logic. fs is only
// spied on for the two specific functions this route calls (existsSync,
// createWriteStream), not mocked wholesale: better-sqlite3 (new Database
// below) uses fs internally to locate its own native binding, and a blanket
// jest.mock('fs') would break that for everyone in this test file's module
// graph, not just this route.

jest.mock('https');
jest.mock('child_process');

const request  = require('supertest');
const express  = require('express');
const Database = require('better-sqlite3');
const EventEmitter = require('events');
const https = require('https');
const fs = require('fs');
const { spawn } = require('child_process');

let db;
let app;
let currentUser;

// Simulates https.get(url, opts, callback) resolving with a JSON body, or
// emitting a request-level error instead when statusCode is null.
function mockGithubResponse({ statusCode = 200, body = '{}' } = {}) {
  https.get.mockImplementation((url, opts, callback) => {
    const req = new EventEmitter();
    req.destroy = jest.fn();
    if (statusCode === null) {
      process.nextTick(() => req.emit('error', new Error('network error')));
      return req;
    }
    const res = new EventEmitter();
    res.statusCode = statusCode;
    res.resume = jest.fn();
    process.nextTick(() => {
      callback(res);
      process.nextTick(() => {
        res.emit('data', Buffer.from(body));
        res.emit('end');
      });
    });
    return req;
  });
}

function setUpdateRepo(repo) {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('update_repo', repo);
}

beforeEach(() => {
  jest.clearAllMocks();
  // Every real deployment starts in this state: neither the Docker socket nor
  // the bind-mounted compose project directory exist until an operator has
  // deliberately opted in (see docs/deployment.md). Individual tests override
  // this to exercise the opted-in path.
  jest.spyOn(fs, 'existsSync').mockReturnValue(false);
  jest.spyOn(fs, 'createWriteStream').mockReturnValue({ write: jest.fn() });
  db = new Database(':memory:');
  db.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  currentUser = { id: 1, email: 'admin@farm.local', role: 'admin' };

  app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = currentUser; next(); });
  app.use('/api/update', require('../routes/update')(db));
});

describe('GET /api/update/status', () => {
  test('403s for a non-admin', async () => {
    currentUser = { id: 2, email: 'op@farm.local', role: 'operator' };
    const res = await request(app).get('/api/update/status');
    expect(res.status).toBe(403);
  });

  test('reports unknown/no update when update_repo is not configured', async () => {
    const res = await request(app).get('/api/update/status');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ repo: null, latestCommit: null, updateAvailable: false });
  });

  test('updateAvailable: false when the running commit matches the latest', async () => {
    process.env.GIT_COMMIT = 'abc1234abc1234abc1234abc1234abc1234abcd';
    setUpdateRepo('maevebaksa/print-farm-manager');
    mockGithubResponse({ body: JSON.stringify({ sha: 'abc1234abc1234abc1234abc1234abc1234abcd' }) });

    const res = await request(app).get('/api/update/status');
    expect(res.body.updateAvailable).toBe(false);
    delete process.env.GIT_COMMIT;
  });

  test('updateAvailable: true when the latest commit differs', async () => {
    process.env.GIT_COMMIT = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    setUpdateRepo('maevebaksa/print-farm-manager');
    mockGithubResponse({ body: JSON.stringify({ sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }) });

    const res = await request(app).get('/api/update/status');
    expect(res.body).toMatchObject({
      currentCommit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      latestCommit: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      updateAvailable: true,
    });
    delete process.env.GIT_COMMIT;
  });

  test('latestCommit is null, not a crash, when GitHub is unreachable', async () => {
    setUpdateRepo('maevebaksa/print-farm-manager');
    mockGithubResponse({ statusCode: null });
    const res = await request(app).get('/api/update/status');
    expect(res.status).toBe(200);
    expect(res.body.latestCommit).toBeNull();
    expect(res.body.updateAvailable).toBe(false);
  });

  test('latestCommit is null when GitHub returns a non-200 (e.g. repo not found)', async () => {
    setUpdateRepo('maevebaksa/does-not-exist');
    mockGithubResponse({ statusCode: 404, body: '{}' });
    const res = await request(app).get('/api/update/status');
    expect(res.body.latestCommit).toBeNull();
  });
});

describe('POST /api/update/trigger', () => {
  test('403s for a non-admin', async () => {
    currentUser = { id: 2, email: 'op@farm.local', role: 'operator' };
    const res = await request(app).post('/api/update/trigger');
    expect(res.status).toBe(403);
  });

  // canTrigger() checks fs.existsSync against the real, hardcoded
  // /var/run/docker.sock and /deploy/docker-compose.yml paths, which do not
  // exist on this (or any CI) machine: this is exactly the "opted out"
  // state every deployment starts in, so no fs mocking is needed to hit it.
  test('409s when the Docker socket / compose project mounts are not present', async () => {
    const res = await request(app).post('/api/update/trigger');
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/docker socket/i);
    expect(spawn).not.toHaveBeenCalled();
  });

  test('spawns docker compose pull && up -d and responds immediately once both mounts are present', async () => {
    fs.existsSync.mockReturnValue(true); // both DOCKER_SOCK and the compose file "exist"
    fs.createWriteStream.mockReturnValue({ write: jest.fn() });
    const fakeChild = { stdout: { pipe: jest.fn() }, stderr: { pipe: jest.fn() }, unref: jest.fn() };
    spawn.mockReturnValue(fakeChild);

    const res = await request(app).post('/api/update/trigger');

    expect(res.status).toBe(200);
    expect(res.body.started).toBe(true);
    expect(spawn).toHaveBeenCalledWith(
      'sh',
      ['-c', 'docker compose pull && docker compose up -d'],
      expect.objectContaining({ cwd: '/deploy', detached: true })
    );
    expect(fakeChild.unref).toHaveBeenCalled();
  });
});
