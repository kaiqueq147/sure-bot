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

test('estatísticas das detectadas: duração, pares de casas e reaparição', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'surebot-'));
  try {
    const db = (await Persistence.open({ path: path.join(dir, 'test.db'), retentionDays: 90 }))!;
    const t0 = Date.now() - 60_000;
    const base = { id: 'x', game: 'cs2' as const, books: 'duel×stake', market: 'Vencedor', profitPct: 1 };
    db.recordDetected({ ...base, firstSeen: t0 }, t0);
    db.recordDetected({ ...base, firstSeen: t0, profitPct: 3 }, t0 + 1_000);
    db.closeDetected('x', 'odds_moved', t0 + 2_000);
    // a mesma surebet reaparece: nova linha, ainda aberta
    db.recordDetected({ ...base, firstSeen: t0 + 40_000, profitPct: 2 }, t0 + 40_000);
    db.recordDetected({ id: 'y', game: 'lol', books: 'cloudbet×polymarket', market: 'Vencedor', profitPct: 4, firstSeen: t0 }, t0);
    db.closeDetected('y', 'stale', t0 + 50_000);

    const d = db.report(t0 - 1_000).detected;
    assert.equal(d.count, 3);
    assert.equal(d.closed, 2);
    assert.equal(d.avgProfitPct, 3);
    assert.deepEqual(d.durationBuckets, [1, 0, 1, 0, 0]);
    assert.equal(d.byBooks[0].key, 'duel×stake');
    assert.equal(d.byBooks[0].count, 2);
    assert.equal(d.byBooks[0].maxProfit, 3);
    assert.equal(d.byBooks[0].avgDurationMs, 2_000);
    assert.deepEqual(d.byReason.map((r) => r.key).sort(), ['odds_moved', 'stale']);
    db.close();
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows pode manter o WAL aberto por um instante depois do close
    }
  }
});

test('detectada reaberta com o mesmo firstSeen volta a ficar aberta', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'surebot-'));
  try {
    const db = (await Persistence.open({ path: path.join(dir, 'test.db'), retentionDays: 90 }))!;
    const t0 = Date.now() - 60_000;
    const d = { id: 'x', firstSeen: t0, game: 'cs2' as const, books: 'duel×stake', market: 'Vencedor', profitPct: 1 };
    db.recordDetected(d, t0);
    db.closeDetected('x', 'odds_moved', t0 + 1_000);
    db.recordDetected(d, t0 + 2_000);
    assert.equal(db.report(t0 - 1).detected.closed, 0);
    db.closeDetected('x', 'stale', t0 + 9_000);
    assert.equal(db.report(t0 - 1).detected.medianDurationMs, 9_000);
    db.close();
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows pode manter o WAL aberto por um instante depois do close
    }
  }
});

test('pares bloqueados persistem e podem ser desfeitos', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'surebot-'));
  try {
    const file = path.join(dir, 'test.db');
    const db = (await Persistence.open({ path: file, retentionDays: 90 }))!;
    db.blockPair({ a: 'duel:9', b: 'stake:1', label: 'NAVI × FaZe', blockedAt: 1 });
    db.blockPair({ a: 'duel:9', b: 'stake:1', label: 'NAVI × FaZe', blockedAt: 2 });
    db.close();
    const db2 = (await Persistence.open({ path: file, retentionDays: 90 }))!;
    assert.deepEqual(db2.blockedPairs(), [{ a: 'duel:9', b: 'stake:1', label: 'NAVI × FaZe', blockedAt: 2 }]);
    db2.unblockPair('duel:9', 'stake:1');
    assert.equal(db2.blockedPairs().length, 0);
    db2.close();
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows pode manter o WAL aberto por um instante depois do close
    }
  }
});
