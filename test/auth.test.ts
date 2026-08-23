import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

// Both must be set before config.ts is loaded.
const dir = mkdtempSync(join(tmpdir(), 'mtg-auth-'));
process.env['DB_PATH'] = join(dir, 'test.db');
process.env['REFRESH_TOKEN'] = 's3cret-token';

const { createApp } = await import('../src/app.js');
const { getDb, closeDb } = await import('../src/db/index.js');

let server: Server;
let base: string;
let started = 0;

before(() => {
  getDb();
  server = createApp({
    startRefresh: () => { started++; },
    isRefreshRunning: () => false,
    getRefreshStatus: () => ({ running: false, phase: 'idle' }),
  }).listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => { server.close(); closeDb(); rmSync(dir, { recursive: true, force: true }); });

const withToken = (t: string) => ({ headers: { 'x-refresh-token': t } });

test('the update endpoint rejects a missing or wrong token', async () => {
  for (const init of [{}, withToken('wrong')]) {
    const res = await fetch(base + '/api/refresh', { method: 'POST', ...init });
    assert.equal(res.status, 401);
  }
  assert.equal(started, 0, 'a rejected request must not start a refresh');
});

test('the update endpoint accepts the right token, by header or query', async () => {
  const viaHeader = await fetch(base + '/api/refresh', { method: 'POST', ...withToken('s3cret-token') });
  assert.equal(viaHeader.status, 202);

  const viaQuery = await fetch(base + '/api/refresh?token=s3cret-token', { method: 'POST' });
  assert.equal(viaQuery.status, 202);
  assert.equal(started, 2);
});

test('the metrics endpoint is gated by the same token', async () => {
  assert.equal((await fetch(base + '/api/metrics')).status, 401);
  assert.equal((await fetch(base + '/api/metrics', withToken('wrong'))).status, 401);
  assert.equal((await fetch(base + '/api/metrics', withToken('s3cret-token'))).status, 200);
});

test('public endpoints stay open', async () => {
  // Search, stats-lite and health must not require a token, or the app is
  // unusable for the people it is for.
  for (const p of ['/api/search?q=sol', '/api/suggest?q=sol', '/api/stats', '/api/decks', '/healthz', '/']) {
    assert.equal((await fetch(base + p)).status, 200, p);
  }
});

test('stats advertises that a token is required', async () => {
  const body = (await fetch(base + '/api/stats').then((r) => r.json())) as any;
  assert.equal(body.refreshRequiresToken, true);
});
