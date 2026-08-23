import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

// A deliberately empty database: this file exercises the state a freshly
// deployed container is in before anyone has pressed "Update now".
const dir = mkdtempSync(join(tmpdir(), 'mtg-empty-'));
process.env['DB_PATH'] = join(dir, 'empty.db');

const { createApp } = await import('../src/app.js');
const { getDb, closeDb } = await import('../src/db/index.js');

let server: Server;
let base: string;

before(() => {
  getDb();
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => { server.close(); closeDb(); rmSync(dir, { recursive: true, force: true }); });

test('liveness passes on an empty index', async () => {
  // If /healthz failed here, a hosting platform would restart-loop the
  // container before anyone could populate it.
  const res = await fetch(base + '/healthz');
  assert.equal(res.status, 200);
  const body = (await res.json()) as any;
  assert.equal(body.ok, true);
  assert.equal(body.hasData, false);
});

test('readiness reports the empty index', async () => {
  const res = await fetch(base + '/readyz');
  assert.equal(res.status, 503);
  assert.equal(((await res.json()) as any).ready, false);
});

test('the UI still loads with no data', async () => {
  assert.equal((await fetch(base + '/')).status, 200);

  const search = await fetch(base + '/api/search?q=sol%20ring');
  assert.equal(search.status, 200, 'search must answer, not error, on an empty index');
  assert.deepEqual(((await search.json()) as any).decks, []);
});
