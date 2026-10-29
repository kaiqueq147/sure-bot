import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OddsStore } from '../src/core/OddsStore.js';
import { PolymarketSelfArb, pairedFill } from '../src/engine/PolymarketSelfArb.js';
import type { Quote } from '../src/types.js';

const quote = (priceA: number, priceB: number, extra: Partial<Quote> = {}): Quote => ({
  key: 'polymarket:m1',
  eventKey: 'polymarket:e1',
  market: { type: 'winner' },
  book: 'polymarket',
  marketId: 'm1',
  game: 'cs2',
  eventName: 'NAVI vs FaZe',
  teamA: 'NAVI',
  teamB: 'FaZe',
  oddsA: 1 / priceA,
  oddsB: 1 / priceB,
  depthA: [[priceA, 100]],
  depthB: [[priceB, 100]],
  url: 'https://polymarket.com/event/x',
  updatedAt: Date.now(),
  ...extra,
});

test('pairedFill para no primeiro par de níveis sem lucro', () => {
  // 0.45 + 0.50 = 0.95 nos primeiros 50 pares; depois 0.45 + 0.56 = 1.01 já não paga.
  const fill = pairedFill([[0.45, 200]], [[0.5, 50], [0.56, 100]]);
  assert.equal(fill.shares, 50);
  assert.ok(Math.abs(fill.costA - 22.5) < 1e-9);
  assert.ok(Math.abs(fill.costB - 25) < 1e-9);
  assert.ok(Math.abs(fill.profit - 2.5) < 1e-9);
});

test('detecta par abaixo de $1, confirma com o tempo e fecha quando some', () => {
  const store = new OddsStore();
  const arb = new PolymarketSelfArb(store, { minProfitPct: 0, commissionPct: {}, confirmMs: 1_000 });
  const events: string[] = [];
  arb.on('opportunity', (o) => events.push(`open:${o.status}`));
  arb.on('closed', (_id, reason) => events.push(`closed:${reason}`));

  const t0 = Date.now();
  store.upsert(quote(0.45, 0.5, { updatedAt: t0 }));
  arb.evaluate(t0);
  const [opp] = arb.list();
  assert.ok(opp, 'oportunidade criada');
  assert.equal(opp.status, 'pending');
  assert.deepEqual(opp.legs.map((l) => [l.book, l.side]), [['polymarket', 'A'], ['polymarket', 'B']]);
  assert.ok(Math.abs(opp.profitPct - (1 / 0.95 - 1) * 100) < 1e-9);
  assert.ok(Math.abs(opp.legs[0].maxStake! - 45) < 1e-9, 'perna A lucrativa até 100 shares × 0.45');

  arb.evaluate(t0 + 1_500);
  assert.equal(arb.list()[0].status, 'confirmed');

  store.upsert(quote(0.5, 0.52, { updatedAt: t0 + 2_000 }));
  arb.evaluate(t0 + 2_000);
  assert.equal(arb.list().length, 0);
  assert.deepEqual(events, ['open:pending', 'open:confirmed', 'closed:odds_moved']);
});

test('a taxa de taker pode eliminar a margem', () => {
  const store = new OddsStore();
  const arb = new PolymarketSelfArb(store, { minProfitPct: 0, commissionPct: {} });
  // 0.49 + 0.50 = 0.99 sem taxa; com taxa de 10% sobre p(1-p) o par passa de $1.
  store.upsert(quote(0.49, 0.5, { takerFeeRate: 0.1 }));
  arb.evaluate();
  assert.equal(arb.list().length, 0);

  store.upsert(quote(0.49, 0.5));
  arb.evaluate();
  assert.equal(arb.list().length, 1);
});

test('ignora mercado suspenso e de outras casas', () => {
  const store = new OddsStore();
  const arb = new PolymarketSelfArb(store, { minProfitPct: 0, commissionPct: {} });
  store.upsert(quote(0.4, 0.4, { suspended: true }));
  store.upsert(quote(0.4, 0.4, { key: 'duel:x', book: 'duel' }));
  arb.evaluate();
  assert.equal(arb.list().length, 0);
});
