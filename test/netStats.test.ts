import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NetStats } from '../src/sources/netStats.js';

test('conta 403/503 como bloqueio e 429 como rate limit', () => {
  const n = new NetStats();
  for (const s of [200, 403, 503, 429, 429, 500]) n.record(s);
  n.markBlocked();
  assert.deepEqual(n.fields(), { blockedPerMin: 3, rateLimitedPerMin: 2 });
});
