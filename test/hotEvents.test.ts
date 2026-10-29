import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hotEvents } from '../src/core/hotEvents.js';
import { retryAfterSecs } from '../src/sources/cloudbet.js';
import { buildHotQuery } from '../src/sources/stake.js';

test('hotEvents guarda o conjunto atual e separa os ids por casa', () => {
  hotEvents.set(['stake:a', 'cloudbet:1', 'stake:b']);
  assert.equal(hotEvents.size, 3);
  assert.ok(hotEvents.has('cloudbet:1'));
  assert.deepEqual(hotEvents.idsFor('stake'), ['a', 'b']);
  hotEvents.set([]);
  assert.equal(hotEvents.size, 0);
  assert.deepEqual(hotEvents.idsFor('stake'), []);
});

test('query quente da Stake tem um alias por fixture', () => {
  const q = buildHotQuery(['f1', 'f2']);
  assert.match(q, /h0: sportFixture\(fixtureId: "f1"\)/);
  assert.match(q, /h1: sportFixture\(fixtureId: "f2"\)/);
  assert.doesNotMatch(q, /fixtureList/);
});

test('429 da Cloudbet: pausa vem do header, do JSON da Cloudflare ou 60s', async () => {
  assert.equal(await retryAfterSecs(new Response('', { status: 429, headers: { 'retry-after': '12' } })), 12);
  assert.equal(await retryAfterSecs(new Response(JSON.stringify({ retry_after: 45 }), { status: 429 })), 45);
  assert.equal(await retryAfterSecs(new Response('<html>', { status: 429 })), 60);
  // A Cloudflare chega a pedir ~50 min: respeitado inteiro, com teto de 1h.
  assert.equal(await retryAfterSecs(new Response('', { status: 429, headers: { 'retry-after': '3035' } })), 3035);
  assert.equal(await retryAfterSecs(new Response('', { status: 429, headers: { 'retry-after': '9999' } })), 3600);
});
