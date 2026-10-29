import assert from 'node:assert/strict';
import { test } from 'node:test';
import { derivedQuoteFields, drawLabel, marketKey, marketLabel, sameMarket } from '../src/core/markets.js';
import { OddsStore } from '../src/core/OddsStore.js';
import { ArbitrageEngine, derivedPairs } from '../src/engine/ArbitrageEngine.js';
import { PolymarketSelfArb } from '../src/engine/PolymarketSelfArb.js';
import { ThreeWayEngine } from '../src/engine/ThreeWayEngine.js';
import { ValueScanner } from '../src/engine/ValueScanner.js';
import type { BookId, Game, MarketSpec, Opportunity, Quote } from '../src/types.js';

const START = Date.parse('2026-11-01T18:00:00Z');

/** Âncora (vencedor) do evento `${book}:${id}`. */
const anchor = (book: BookId, id: string, teamA: string, teamB: string, game: Game, over: Partial<Quote> = {}): Quote => ({
  key: `${book}:${id}`,
  eventKey: `${book}:${id}`,
  market: { type: 'winner' },
  book,
  marketId: id,
  game,
  eventName: `${teamA} vs ${teamB}`,
  teamA,
  teamB,
  oddsA: 1.9,
  oddsB: 1.9,
  url: 'https://example.com',
  startTime: START,
  updatedAt: Date.now(),
  ...over,
});

/** Mercado derivado do evento, com chave e rótulos de `derivedQuoteFields`. */
const derived = (a: Quote, spec: MarketSpec, odds: Partial<Quote>): Quote => ({
  ...a,
  ...derivedQuoteFields(a.eventKey, spec, a.teamA, a.teamB, a.game),
  ...odds,
});

const flush = () => new Promise((r) => setTimeout(r, 600));
const engineOpts = {
  minProfitPct: 0, maxProfitPct: 15, confirmMs: 0, matchThreshold: 0.78, maxStartDiffMs: 6 * 3600_000,
  commissionPct: {},
};

test('result3: chave por período, rótulos de 1X2 e de tempo regulamentar', () => {
  assert.equal(marketKey({ type: 'result3' }), 'r3');
  assert.equal(marketKey({ type: 'result3', period: 'h1' }), 'r3@h1');
  assert.ok(!sameMarket({ type: 'result3' }, { type: 'result3', period: 'h1' }));
  assert.ok(!sameMarket({ type: 'result3', period: 'h1' }, { type: 'winner', period: 'h1' }), '1X2 do 1º tempo ≠ vencedor 2 vias');

  assert.equal(marketLabel({ type: 'result3', period: 'h1' }, 'soccer'), '1º tempo: Resultado (1X2)');
  assert.equal(marketLabel({ type: 'result3' }, 'basketball'), 'Resultado no tempo regulamentar (1X2)');
  assert.equal(marketLabel({ type: 'result3' }, 'american_football'), 'Resultado no tempo regulamentar (1X2)');
  assert.equal(drawLabel({ type: 'result3', period: 'h1' }, 'soccer'), 'Empate (1º tempo)');
  assert.equal(drawLabel({ type: 'result3' }, 'basketball'), 'Empate (tempo regulamentar)');
  assert.equal(drawLabel({ type: 'winner' }, 'soccer'), 'Empate');

  const f = derivedQuoteFields('stake:1', { type: 'result3' }, 'Lakers', 'Celtics', 'basketball');
  assert.equal(f.key, 'stake:1:r3', 'nunca é a âncora');
  assert.deepEqual([f.selA, f.selB], ['Lakers (tempo regulamentar)', 'Celtics (tempo regulamentar)']);
  const h1 = derivedQuoteFields('stake:2', { type: 'result3', period: 'h1' }, 'Arsenal', 'Chelsea', 'soccer');
  assert.deepEqual([h1.selA, h1.selB], ['Arsenal (1º tempo)', 'Chelsea (1º tempo)']);
});

test('result3 pareia com times invertidos trocando casa/fora (sem negar linha); empate fica', () => {
  const l = anchor('stake', '1', 'Arsenal', 'Chelsea', 'soccer', { oddsDraw: 3.3 });
  const r = anchor('duel', '9', 'Chelsea', 'Arsenal', 'soccer', { oddsDraw: 3.4 });
  const lr = derived(l, { type: 'result3', period: 'h1' }, { oddsA: 3.4, oddsB: 4.1, oddsDraw: 2.1 });
  const rr = derived(r, { type: 'result3', period: 'h1' }, { oddsA: 4.0, oddsB: 3.5, oddsDraw: 2.05 });
  const winners = [{ id: `${l.key}|${r.key}`, leftKey: l.key, rightKey: r.key, swapped: true, score: 1 }];
  const pairs = derivedPairs(winners, [l, lr], [r, rr]);
  assert.deepEqual(pairs.map((p) => [p.leftKey, p.rightKey, p.swapped]), [[lr.key, rr.key, true]]);
});

test('motores de 2 vias e PolymarketSelfArb ignoram result3, mesmo com o empate suspenso', async () => {
  const store = new OddsStore();
  const engine = new ArbitrageEngine(store, engineOpts, 'stake', 'duel');
  const self = new PolymarketSelfArb(store, { minProfitPct: 0, commissionPct: {} });
  const found: Opportunity[] = [];
  engine.on('opportunity', (o) => found.push(o));
  self.on('opportunity', (o) => found.push(o));

  const s = anchor('stake', '1', 'Lakers', 'Celtics', 'basketball');
  const d = anchor('duel', '9', 'Lakers', 'Celtics', 'basketball', { oddsA: 1.85, oddsB: 1.95 });
  const p = anchor('polymarket', '3', 'Lakers', 'Celtics', 'basketball');
  store.upsert(s);
  store.upsert(d);
  store.upsert(p);
  // Casa/fora "baratos" sem o empate: em 2 vias seria arbitragem (1/3 + 1/3 < 1).
  store.upsert(derived(s, { type: 'result3' }, { oddsA: 3, oddsB: 3, oddsDraw: 12 }));
  store.upsert(derived(d, { type: 'result3' }, { oddsA: 3, oddsB: 3, oddsDraw: null }));
  store.upsert(derived(p, { type: 'result3' }, { oddsA: 3, oddsB: 3, oddsDraw: null }));
  await flush();
  self.evaluate();

  assert.ok(engine.matchedPairs().some((x) => x.leftKey === 'stake:1:r3'), 'result3 pareia pela âncora de 2 vias');
  assert.deepEqual(found.filter((o) => o.market.type === 'result3'), []);
  engine.stop();
  self.stop();
});

test('3 vias acha arbitragem no 1X2 do 1º tempo entre 3 casas e nunca mistura períodos', async () => {
  const store = new OddsStore();
  const books = ['stake', 'duel', 'cloudbet'] as const;
  const engines = [
    new ArbitrageEngine(store, engineOpts, 'stake', 'duel'),
    new ArbitrageEngine(store, engineOpts, 'stake', 'cloudbet'),
    new ArbitrageEngine(store, engineOpts, 'duel', 'cloudbet'),
  ];
  const three = new ThreeWayEngine(store, () => engines.flatMap((e) => e.matchedPairs()), engineOpts);
  const found: Opportunity[] = [];
  three.on('opportunity', (o) => found.push(o));

  // 1X2 do jogo inteiro sem arbitragem (âncoras).
  const s = anchor(books[0], '1', 'Arsenal', 'Chelsea', 'soccer', { oddsA: 2.4, oddsB: 3.0, oddsDraw: 3.3 });
  const d = anchor(books[1], '9', 'Chelsea', 'Arsenal', 'soccer', { oddsA: 2.9, oddsB: 2.45, oddsDraw: 3.25 });
  const c = anchor(books[2], '5', 'Arsenal', 'Chelsea', 'soccer', { oddsA: 2.38, oddsB: 3.05, oddsDraw: 3.35 });
  for (const q of [s, d, c]) store.upsert(q);
  // 1X2 do 1º tempo: Arsenal 3.6 (Stake) + empate 2.4 (Cloudbet) + Chelsea 4.6 (Duel, invertida)
  // = 1/3.6 + 1/2.4 + 1/4.6 = 0.9118 => arbitragem.
  store.upsert(derived(s, { type: 'result3', period: 'h1' }, { oddsA: 3.6, oddsB: 4.0, oddsDraw: 2.05 }));
  store.upsert(derived(d, { type: 'result3', period: 'h1' }, { oddsA: 4.6, oddsB: 3.2, oddsDraw: 2.1 }));
  store.upsert(derived(c, { type: 'result3', period: 'h1' }, { oddsA: 3.3, oddsB: 4.1, oddsDraw: 2.4 }));
  // Empate enorme num "1X2" de outro período (q1): só combinaria com o h1 se os períodos se misturassem.
  store.upsert(derived(c, { type: 'result3', period: 'q1' }, { oddsA: 1.5, oddsB: 1.5, oddsDraw: 50 }));
  await flush();
  three.evaluate();

  const h1 = found.filter((o) => o.market.type === 'result3' && o.market.period === 'h1');
  assert.equal(h1.length, 1);
  const [opp] = h1;
  assert.deepEqual(opp.legs.map((l) => `${l.book}:${l.side}:${l.selection}@${l.odds}`), [
    'stake:A:Arsenal (1º tempo)@3.6',
    'cloudbet:D:Empate (1º tempo)@2.4',
    'duel:A:Chelsea (1º tempo)@4.6',
  ]);
  assert.equal(opp.marketLabel, '1º tempo: Resultado (1X2)');
  assert.ok(Math.abs(opp.margin - (1 / 3.6 + 1 / 2.4 + 1 / 4.6)) < 1e-9);
  assert.ok(opp.id.startsWith('3w:') && opp.id.includes('r3@h1'));

  // Nenhuma oportunidade mistura mercados: todas as pernas são do mesmo período.
  for (const o of found) {
    const suffixes = new Set(o.legs.map((l) => l.key.split(':').slice(2).join(':')));
    assert.equal(suffixes.size, 1, `${o.id} mistura ${[...suffixes].join(', ')}`);
  }
  assert.ok(found.every((o) => !o.legs.some((l) => l.key.endsWith('r3@q1'))), 'q1 só existe numa casa');
  assert.ok(found.every((o) => o.market.type !== 'winner'), '1X2 do jogo inteiro sem arbitragem');
  for (const e of engines) e.stop();
  three.stop();
});

test('EV de 3 vias também vale para o resultado no tempo regulamentar', async () => {
  const store = new OddsStore();
  const books = ['stake', 'duel', 'cloudbet'] as const;
  const engines = [
    new ArbitrageEngine(store, engineOpts, 'stake', 'duel'),
    new ArbitrageEngine(store, engineOpts, 'stake', 'cloudbet'),
    new ArbitrageEngine(store, engineOpts, 'duel', 'cloudbet'),
  ];
  const scanner = new ValueScanner(store, () => engines.flatMap((e) => e.matchedPairs()), {
    minEvPct: 0, warnEvPct: 50, maxOverroundPct: 12, commissionPct: {}, minConsensusBooks: 2,
  });

  const qs = books.map((b, i) => anchor(b, String(i + 1), 'Lakers', 'Celtics', 'basketball'));
  for (const q of qs) store.upsert(q);
  // Empate no tempo regulamentar: Stake paga 18, as outras ~13 (justo ≈ 1/14).
  store.upsert(derived(qs[0], { type: 'result3' }, { oddsA: 1.95, oddsB: 2.0, oddsDraw: 18 }));
  store.upsert(derived(qs[1], { type: 'result3' }, { oddsA: 1.9, oddsB: 2.0, oddsDraw: 13 }));
  store.upsert(derived(qs[2], { type: 'result3' }, { oddsA: 1.92, oddsB: 1.98, oddsDraw: 13.5 }));
  await flush();
  scanner.scan();

  const draw = scanner.list().find((b) => b.market.type === 'result3' && b.id.endsWith('#D'));
  assert.ok(draw, 'EV no empate do tempo regulamentar');
  assert.equal(draw.bestBook, 'stake');
  assert.equal(draw.selection, 'Empate (tempo regulamentar)');
  assert.equal(draw.marketLabel, 'Resultado no tempo regulamentar (1X2)');
  assert.ok(scanner.list().every((b) => b.market.type !== 'result3' || /#[ABD]$/.test(b.id)));
  for (const e of engines) e.stop();
});
