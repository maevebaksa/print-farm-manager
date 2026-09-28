const request  = require('supertest');
const express  = require('express');
const Database = require('better-sqlite3');

let db;
let app;
// mutated per test to simulate "who is making this request": auto_sso_redirect
// is admin-only, the rest of this router isn't (see server/routes/settings.js)
let currentUser = { id: 1, role: 'admin' };

beforeAll(() => {
  db = new Database(':memory:');
  db.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  db.prepare("INSERT INTO settings (key, value) VALUES ('dispatch_batch_size', '10')").run();

  app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = currentUser; next(); });
  app.use('/api/settings', require('../routes/settings')(db));
});

describe('GET /api/settings', () => {
  test('returns all settings as a key/value object', async () => {
    const res = await request(app).get('/api/settings');
    expect(res.status).toBe(200);
    expect(res.body.dispatch_batch_size).toBe('10');
  });
});

describe('PUT /api/settings/dispatch_batch_size', () => {
  test('saves a valid value and returns it', async () => {
    const res = await request(app)
      .put('/api/settings/dispatch_batch_size')
      .send({ value: 5 });
    expect(res.status).toBe(200);
    expect(res.body.key).toBe('dispatch_batch_size');
    expect(res.body.value).toBe('5');
    // Persisted in DB
    expect(db.prepare("SELECT value FROM settings WHERE key = 'dispatch_batch_size'").get().value).toBe('5');
  });

  test('rejects a value below 1', async () => {
    const res = await request(app)
      .put('/api/settings/dispatch_batch_size')
      .send({ value: 0 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/between 1 and 100/i);
  });

  test('rejects a value above 100', async () => {
    const res = await request(app)
      .put('/api/settings/dispatch_batch_size')
      .send({ value: 101 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/between 1 and 100/i);
  });

  test('rejects a non-numeric value', async () => {
    const res = await request(app)
      .put('/api/settings/dispatch_batch_size')
      .send({ value: 'banana' });
    expect(res.status).toBe(400);
  });

  test('rejects an empty value', async () => {
    const res = await request(app)
      .put('/api/settings/dispatch_batch_size')
      .send({ value: '' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/value is required/i);
  });

  test('rejects an unknown settings key', async () => {
    const res = await request(app)
      .put('/api/settings/unknown_key')
      .send({ value: '5' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/unknown setting key/i);
  });
});

describe('PUT /api/settings/auto_sso_redirect', () => {
  afterEach(() => { currentUser = { id: 1, role: 'admin' }; });

  test('admin can enable it', async () => {
    const res = await request(app)
      .put('/api/settings/auto_sso_redirect')
      .send({ value: '1' });
    expect(res.status).toBe(200);
    expect(res.body.value).toBe('1');
    expect(db.prepare("SELECT value FROM settings WHERE key = 'auto_sso_redirect'").get().value).toBe('1');
  });

  test('rejects a value other than 0 or 1', async () => {
    const res = await request(app)
      .put('/api/settings/auto_sso_redirect')
      .send({ value: 'yes' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/must be "0" or "1"/i);
  });

  test('an operator cannot change it', async () => {
    currentUser = { id: 2, role: 'operator' };
    const res = await request(app)
      .put('/api/settings/auto_sso_redirect')
      .send({ value: '0' });
    expect(res.status).toBe(403);
  });
});

describe('PUT /api/settings/color_tolerance', () => {
  afterEach(() => { currentUser = { id: 1, role: 'admin' }; });

  test('any authenticated user can set it (not admin-only)', async () => {
    currentUser = { id: 2, role: 'operator' };
    const res = await request(app)
      .put('/api/settings/color_tolerance')
      .send({ value: '40' });
    expect(res.status).toBe(200);
    expect(res.body.value).toBe('40');
  });

  test('accepts 0 (tolerance off)', async () => {
    const res = await request(app)
      .put('/api/settings/color_tolerance')
      .send({ value: '0' });
    expect(res.status).toBe(200);
    expect(res.body.value).toBe('0');
  });

  test('rejects a negative value', async () => {
    const res = await request(app)
      .put('/api/settings/color_tolerance')
      .send({ value: '-1' });
    expect(res.status).toBe(400);
  });

  test('rejects a value above the maximum', async () => {
    const res = await request(app)
      .put('/api/settings/color_tolerance')
      .send({ value: '9999' });
    expect(res.status).toBe(400);
  });

  test('rejects a non-numeric value', async () => {
    const res = await request(app)
      .put('/api/settings/color_tolerance')
      .send({ value: 'loose' });
    expect(res.status).toBe(400);
  });
});

describe('PUT /api/settings/upload_retry_window_min', () => {
  test('saves a valid value and returns it', async () => {
    const res = await request(app)
      .put('/api/settings/upload_retry_window_min')
      .send({ value: '30' });
    expect(res.status).toBe(200);
    expect(res.body.value).toBe('30');
    expect(db.prepare("SELECT value FROM settings WHERE key = 'upload_retry_window_min'").get().value).toBe('30');
  });

  test('rejects a value below 1', async () => {
    const res = await request(app)
      .put('/api/settings/upload_retry_window_min')
      .send({ value: '0' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/between 1 and 180/i);
  });

  test('rejects a value above 180', async () => {
    const res = await request(app)
      .put('/api/settings/upload_retry_window_min')
      .send({ value: '181' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/between 1 and 180/i);
  });

  test('rejects a non-numeric value', async () => {
    const res = await request(app)
      .put('/api/settings/upload_retry_window_min')
      .send({ value: 'a while' });
    expect(res.status).toBe(400);
  });
});

describe('PUT /api/settings/require_uploader_approval', () => {
  afterEach(() => { currentUser = { id: 1, role: 'admin' }; });

  test('admin can enable it', async () => {
    const res = await request(app)
      .put('/api/settings/require_uploader_approval')
      .send({ value: '1' });
    expect(res.status).toBe(200);
    expect(res.body.value).toBe('1');
    expect(db.prepare("SELECT value FROM settings WHERE key = 'require_uploader_approval'").get().value).toBe('1');
  });

  test('rejects a value other than 0 or 1', async () => {
    const res = await request(app)
      .put('/api/settings/require_uploader_approval')
      .send({ value: 'yes' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/must be "0" or "1"/i);
  });

  test('an operator cannot change it', async () => {
    currentUser = { id: 2, role: 'operator' };
    const res = await request(app)
      .put('/api/settings/require_uploader_approval')
      .send({ value: '1' });
    expect(res.status).toBe(403);
  });
});

describe('queue policy settings (queue_order, max_printers_per_part/project)', () => {
  afterEach(() => { currentUser = { id: 1, role: 'admin' }; });

  test('admin can switch queue_order to fifo', async () => {
    const res = await request(app).put('/api/settings/queue_order').send({ value: 'fifo' });
    expect(res.status).toBe(200);
    expect(db.prepare("SELECT value FROM settings WHERE key = 'queue_order'").get().value).toBe('fifo');
  });

  test('rejects an unknown queue_order', async () => {
    const res = await request(app).put('/api/settings/queue_order').send({ value: 'random' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/"priority" or "fifo"/);
  });

  test('admin can set printer caps, 0 meaning unlimited', async () => {
    expect((await request(app).put('/api/settings/max_printers_per_part').send({ value: '2' })).status).toBe(200);
    expect((await request(app).put('/api/settings/max_printers_per_project').send({ value: '0' })).status).toBe(200);
  });

  test('rejects a negative or non-integer cap', async () => {
    expect((await request(app).put('/api/settings/max_printers_per_part').send({ value: '-1' })).status).toBe(400);
    expect((await request(app).put('/api/settings/max_printers_per_project').send({ value: '1.5' })).status).toBe(400);
  });

  test.each(['queue_order', 'max_printers_per_part', 'max_printers_per_project'])('an operator cannot change %s', async (key) => {
    currentUser = { id: 2, role: 'operator' };
    const res = await request(app).put(`/api/settings/${key}`).send({ value: key === 'queue_order' ? 'fifo' : '1' });
    expect(res.status).toBe(403);
  });
});

describe('operator hours settings (used by the time estimates)', () => {
  afterEach(() => { currentUser = { id: 1, role: 'admin' }; });

  test('admin can set start, end, and days; "off" clears a shift end', async () => {
    expect((await request(app).put('/api/settings/operator_hours_start').send({ value: '08:00' })).status).toBe(200);
    expect((await request(app).put('/api/settings/operator_hours_end').send({ value: '17:30' })).status).toBe(200);
    expect((await request(app).put('/api/settings/operator_days').send({ value: '1,2,3,4,5' })).status).toBe(200);
    expect((await request(app).put('/api/settings/operator_hours_end').send({ value: 'off' })).status).toBe(200);
  });

  test('rejects malformed times and days', async () => {
    expect((await request(app).put('/api/settings/operator_hours_start').send({ value: '8am' })).status).toBe(400);
    expect((await request(app).put('/api/settings/operator_hours_end').send({ value: '24:00' })).status).toBe(400);
    expect((await request(app).put('/api/settings/operator_days').send({ value: '1,7' })).status).toBe(400);
  });

  test('an operator cannot change them', async () => {
    currentUser = { id: 2, role: 'operator' };
    expect((await request(app).put('/api/settings/operator_hours_start').send({ value: '08:00' })).status).toBe(403);
  });
});
