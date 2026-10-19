import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Persistence } from '../src/core/Persistence.js';

const taken = {
  oppId: 'polymarket:1|duel:2',
  game: 'cs2' as const,
  eventName: 'NAVI vs FaZe',
  marketLabel: 'Handicap de mapas -1.5',
  profitPct: 2.1,
  bankroll: 1000,
  stakeA: 420,
  stakeB: 580,
  payout: 1021,
  profit: 21,
  legs: [
    { book: 'polymarket' as const, selection: 'NAVI -1.5', odds: 2.45, effectiveOdds: 2.45, stake: 420, url: 'u' },
    { book: 'duel' as const, selection: 'FaZe +1.5', odds: 1.8, effectiveOdds: 1.8, stake: 580, url: 'u' },
  ],
};

test('banco só grava a arbitragem que você marcar, e não duplica', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'surebot-'));
  try {
    const db = (await Persistence.open({ path: path.join(dir, 'test.db'), retentionDays: 90 }))!;
    assert.ok(db);
    db.start();
    assert.deepEqual(db.takenIds(), []);
    assert.match((db.take({}) as { error: string }).error, /inválido|faltam/);

    const first = db.take(taken);
    assert.deepEqual(first, { ok: true, already: false, oppId: taken.oppId });
    assert.deepEqual(db.take({ ...taken, profit: 99 }), { ok: true, already: true, oppId: taken.oppId });

    const r = db.report(Date.now() - 3_600_000);
    assert.equal(r.count, 1);
    assert.equal(r.totalProfit, 21);
    assert.equal(r.items[0].legs[0].odds, 2.45);
    assert.deepEqual(r.byMarket.map((g) => g.key), ['Handicap de mapas']);
    assert.deepEqual(db.clear(), { ok: true, removed: 1 });
    assert.deepEqual(db.takenIds(), []);
    assert.equal(db.report(Date.now() - 3_600_000).count, 0);
    db.take(taken);
    db.close();

    const db2 = (await Persistence.open({ path: path.join(dir, 'test.db'), retentionDays: 90 }))!;
    assert.deepEqual(db2.takenIds(), [taken.oppId]);
    db2.close();
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows pode manter o WAL aberto por um instante depois do close
    }
  }
});
