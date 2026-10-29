import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OddsStore } from '../src/core/OddsStore.js';
import { ArbitrageEngine } from '../src/engine/ArbitrageEngine.js';
import { applyCommission, arbMargin, polymarketTakerOdds, profitPct, splitStakes } from '../src/engine/math.js';
import type { Opportunity, Quote } from '../src/types.js';

test('margem e lucro seguem a fórmula 1/o1 + 1/o2', () => {
  const m = arbMargin(2.1, 2.05);
  assert.ok(Math.abs(m - (1 / 2.1 + 1 / 2.05)) < 1e-12);
  assert.ok(m < 1);
  assert.ok(Math.abs(profitPct(m) - (1 / m - 1) * 100) < 1e-12);
  assert.ok(arbMargin(1.9, 1.9) > 1);
});

test('stakes igualam o retorno nas duas pernas', () => {
  const { stake1, stake2, payout, profit } = splitStakes(1000, 2.1, 2.05);
  assert.ok(Math.abs(stake1 + stake2 - 1000) < 1e-9);
  assert.ok(Math.abs(stake1 * 2.1 - payout) < 1e-9);
  assert.ok(Math.abs(stake2 * 2.05 - payout) < 1e-9);
  assert.ok(profit > 0);
});

test('taxa de taker da Polymarket bate com a tabela oficial', () => {
  // 100 shares a $0.50 com feeRate 0.05 => taxa de $1.25 => custo total $51.25 para receber $100
  assert.ok(Math.abs(polymarketTakerOdds(0.5, 0.05) - 100 / 51.25) < 1e-12);
  // 100 shares a $0.30 => taxa $1.05
  assert.ok(Math.abs(polymarketTakerOdds(0.3, 0.05) - 100 / 31.05) < 1e-12);
  assert.equal(polymarketTakerOdds(0.4, 0), 1 / 0.4);
});

test('comissão incide só sobre o lucro', () => {
  assert.equal(applyCommission(2, 0), 2);
  assert.ok(Math.abs(applyCommission(2, 2) - 1.98) < 1e-12);
});

const quote = (over: Partial<Quote> & Pick<Quote, 'key' | 'book' | 'teamA' | 'teamB'>): Quote => ({
  eventKey: over.key,
  market: { type: 'winner' },
  marketId: over.key.split(':')[1],
  game: 'cs2',
  eventName: `${over.teamA} vs ${over.teamB}`,
  oddsA: 2,
  oddsB: 2,
  url: 'https://example.com',
  updatedAt: Date.now(),
  ...over,
});

const flush = () => new Promise((r) => setTimeout(r, 600));

test('motor detecta arbitragem com times invertidos e nomes diferentes', async () => {
  const store = new OddsStore();
  const engine = new ArbitrageEngine(store, {
    minProfitPct: 0, maxProfitPct: 15, confirmMs: 0, matchThreshold: 0.78, maxStartDiffMs: 6 * 3600_000,
    commissionPct: { polymarket: 0, thunderpick: 0 },
  });
  const found: Opportunity[] = [];
  engine.on('opportunity', (o) => found.push(o));

  store.upsert(quote({ key: 'polymarket:1', book: 'polymarket', teamA: 'Natus Vincere', teamB: 'FaZe Clan', oddsA: 1 / 0.45, oddsB: 1 / 0.56 }));
  store.upsert(quote({ key: 'thunderpick:9', book: 'thunderpick', teamA: 'FaZe', teamB: 'NAVI', oddsA: 2.2, oddsB: 1.8 }));
  await flush();

  // NAVI na Polymarket @ 2.222 + FaZe na Thunderpick @ 2.2 => margem 0.9045
  assert.equal(found.length, 1);
  const [opp] = found;
  assert.equal(opp.legs[0].selection, 'Natus Vincere');
  assert.equal(opp.legs[1].selection, 'FaZe');
  assert.ok(Math.abs(opp.margin - (0.45 + 1 / 2.2)) < 1e-9);

  const closed: string[] = [];
  engine.on('closed', (id, reason) => closed.push(`${id}:${reason}`));
  store.patch('thunderpick:9', { oddsA: 1.7, updatedAt: Date.now() });
  await flush();
  assert.equal(closed.length, 1);
  assert.match(closed[0], /odds_moved$/);
  engine.stop();
});

test('odds de casa indisponível ou vencidas não geram oportunidade', async () => {
  const store = new OddsStore();
  store.setTtl('thunderpick', 1_000);
  const engine = new ArbitrageEngine(store, {
    minProfitPct: 0, maxProfitPct: 15, confirmMs: 0, matchThreshold: 0.78, maxStartDiffMs: 6 * 3600_000,
    commissionPct: { polymarket: 0, thunderpick: 0 },
  });
  const found: Opportunity[] = [];
  engine.on('opportunity', (o) => found.push(o));

  store.upsert(quote({ key: 'polymarket:1', book: 'polymarket', teamA: 'T1', teamB: 'Gen.G', oddsA: 2.5, oddsB: 1.6 }));
  store.upsert(quote({ key: 'thunderpick:1', book: 'thunderpick', teamA: 'T1', teamB: 'GenG', oddsA: 1.5, oddsB: 2.4, updatedAt: Date.now() - 5_000 }));
  await flush();
  assert.equal(found.length, 0, 'odd stale da Thunderpick deve ser ignorada');

  store.patch('thunderpick:1', { updatedAt: Date.now() });
  store.setAvailable('polymarket', false);
  await flush();
  assert.equal(found.length, 0, 'Polymarket desconectada deve ser ignorada');

  store.setAvailable('polymarket', true);
  await flush();
  assert.equal(found.length, 1);
  engine.stop();
});

test('motor sinaliza perna congelada ao vivo sem esconder a oportunidade', async () => {
  const store = new OddsStore();
  const engine = new ArbitrageEngine(store, {
    minProfitPct: 0, maxProfitPct: 50, confirmMs: 0, matchThreshold: 0.78, maxStartDiffMs: 6 * 3600_000,
    commissionPct: {}, frozenMs: 30_000,
  });
  const found: Opportunity[] = [];
  engine.on('opportunity', (o) => found.push(o));
  const now = Date.now();
  const startTime = now - 600_000;
  store.upsert(quote({ key: 'polymarket:1', book: 'polymarket', teamA: 'NAVI', teamB: 'FaZe', oddsA: 2.3, oddsB: 1.6, startTime }));
  store.upsert(quote({ key: 'thunderpick:1', book: 'thunderpick', teamA: 'NAVI', teamB: 'FaZe', oddsA: 1.6, oddsB: 2.3, startTime }));
  store.get('polymarket:1')!.changedAt = now - 90_000;
  store.get('thunderpick:1')!.changedAt = now - 1_000;
  await flush();

  const opp = found.at(-1);
  assert.ok(opp, 'oportunidade continua aparecendo');
  assert.ok(opp.legs[0].frozenMs! >= 90_000, 'perna da Polymarket marcada');
  assert.equal(opp.legs[1].frozenMs, undefined);
  assert.ok(opp.warnings.some((w) => w.includes('polymarket') && w.includes('congelada')));
  engine.stop();
});
