import assert from 'node:assert/strict';
import { test } from 'node:test';
import { derivedQuoteFields, marketLabel, WINNER } from '../src/core/markets.js';
import { OddsHistory } from '../src/core/OddsHistory.js';
import { OddsStore } from '../src/core/OddsStore.js';
import { ArbitrageEngine } from '../src/engine/ArbitrageEngine.js';
import { depthOdds } from '../src/engine/math.js';
import { lineMarkets, type BetbyEvent } from '../src/sources/betby.js';
import { pickLineMarkets } from '../src/sources/polymarket.js';
import { extractThunderpick, readLineMarket } from '../src/sources/thunderpickExtract.js';
import { HealthMonitor } from '../src/core/Health.js';
import type { MarketSpec, Opportunity, Quote, SourceStatus } from '../src/types.js';

const quote = (
  base: Pick<Quote, 'book' | 'teamA' | 'teamB'> & { id: string },
  spec: MarketSpec,
  oddsA: number,
  oddsB: number,
): Quote => ({
  ...derivedQuoteFields(`${base.book}:${base.id}`, spec, base.teamA, base.teamB),
  book: base.book,
  teamA: base.teamA,
  teamB: base.teamB,
  marketId: base.id,
  game: 'cs2',
  eventName: `${base.teamA} vs ${base.teamB}`,
  oddsA,
  oddsB,
  url: 'https://example.com',
  updatedAt: Date.now(),
});

const flush = () => new Promise((r) => setTimeout(r, 600));

test('handicap com times invertidos entre as casas é pareado pela linha negada', async () => {
  const store = new OddsStore();
  const engine = new ArbitrageEngine(store, {
    minProfitPct: 0, maxProfitPct: 15, confirmMs: 0, matchThreshold: 0.78, maxStartDiffMs: 6 * 3600_000,
    commissionPct: { polymarket: 0, thunderpick: 0 },
  });
  const found: Opportunity[] = [];
  engine.on('opportunity', (o) => found.push(o));

  const pm = { book: 'polymarket' as const, id: '1', teamA: 'Natus Vincere', teamB: 'FaZe Clan' };
  const tp = { book: 'thunderpick' as const, id: '9', teamA: 'FaZe', teamB: 'NAVI' };
  store.upsert(quote(pm, WINNER, 2, 2));
  store.upsert(quote(tp, WINNER, 2, 2));
  // NAVI -1.5 na Polymarket; FaZe +1.5 na Thunderpick é a mesma linha vista do outro time.
  store.upsert(quote(pm, { type: 'handicap', line: -1.5 }, 3, 1.4));
  store.upsert(quote(tp, { type: 'handicap', line: 1.5 }, 1.6, 2.2));
  // FaZe -1.5 é outro mercado e não pode ser pareado com NAVI -1.5.
  store.upsert(quote(tp, { type: 'handicap', line: -1.5 }, 9, 9));
  await flush();

  assert.equal(found.length, 1);
  const [opp] = found;
  assert.equal(opp.marketLabel, marketLabel({ type: 'handicap', line: -1.5 }));
  assert.deepEqual(opp.legs.map((l) => l.selection), ['Natus Vincere -1.5', 'FaZe +1.5']);
  assert.ok(Math.abs(opp.margin - (1 / 3 + 1 / 1.6)) < 1e-9);
  engine.stop();
});

test('totais pareiam pela mesma linha e nunca trocam mais/menos', async () => {
  const store = new OddsStore();
  const engine = new ArbitrageEngine(store, {
    minProfitPct: 0, maxProfitPct: 15, confirmMs: 0, matchThreshold: 0.78, maxStartDiffMs: 6 * 3600_000,
    commissionPct: { polymarket: 0, thunderpick: 0 },
  });
  const found: Opportunity[] = [];
  engine.on('opportunity', (o) => found.push(o));
  const pm = { book: 'polymarket' as const, id: '1', teamA: 'Natus Vincere', teamB: 'FaZe Clan' };
  const tp = { book: 'thunderpick' as const, id: '9', teamA: 'FaZe', teamB: 'NAVI' };
  store.upsert(quote(pm, WINNER, 2, 2));
  store.upsert(quote(tp, WINNER, 2, 2));
  store.upsert(quote(pm, { type: 'total', line: 2.5 }, 2.3, 1.6));
  store.upsert(quote(tp, { type: 'total', line: 2.5 }, 1.7, 1.9));
  await flush();

  assert.equal(found.length, 1);
  assert.deepEqual(found[0].legs.map((l) => l.selection), ['Mais de 2.5 mapas', 'Menos de 2.5 mapas']);
  engine.stop();
});

test('depthOdds percorre o livro e para quando acaba a liquidez', () => {
  const depth: Array<[number, number]> = [[0.4, 10], [0.5, 100]];
  // $4 compram 10 shares a 0.40; os outros $6 compram 12 shares a 0.50
  const r = depthOdds(depth, 10)!;
  assert.equal(r.filled, 10);
  assert.ok(Math.abs(r.odds - 22 / 10) < 1e-9);
  assert.ok(Math.abs(depthOdds(depth, 2)!.odds - 2.5) < 1e-9);
  assert.ok(Math.abs(depthOdds(depth, 1_000)!.filled - 54) < 1e-9);
});

test('Duel: handicap 327 e total 328 com linha x.5', () => {
  const ev = {
    desc: { competitors: [{ name: 'A' }, { name: 'B' }] },
    markets: {
      '327': { 'hcp=-1.5': { '1714': { k: '2.6' }, '1715': { k: '1.45' } }, 'hcp=-1': { '1714': { k: '2' }, '1715': { k: '1.8' } } },
      '328': { 'total=2.5': { '12': { k: '1.9' }, '13': { k: '1.85', b: 1 } } },
    },
  } as unknown as BetbyEvent;
  const out = lineMarkets(ev);
  assert.deepEqual(out, [
    { a: 2.6, b: 1.45, suspended: false, spec: { type: 'handicap', line: -1.5 } },
    { a: 1.9, b: 1.85, suspended: true, spec: { type: 'total', line: 2.5 } },
  ]);
});

test('Polymarket: handicap orientado pelo teamA do vencedor e total over/under', () => {
  const ev = {
    markets: [
      { id: 2, sportsMarketType: 'map_handicap', line: -1.5, outcomes: '["FaZe Clan","Natus Vincere"]', clobTokenIds: '["f","n"]' },
      { id: 3, sportsMarketType: 'totals', line: 2.5, outcomes: '["Over","Under"]', clobTokenIds: '["o","u"]' },
      { id: 4, sportsMarketType: 'map_handicap', line: -1.5, outcomes: '["Outro","Time"]', clobTokenIds: '["x","y"]' },
      { id: 5, sportsMarketType: 'totals', line: 2, outcomes: '["Over","Under"]', clobTokenIds: '["o2","u2"]' },
    ],
  };
  const out = pickLineMarkets(ev as never, 'Natus Vincere', 'FaZe Clan');
  assert.deepEqual(
    out.map((x) => [x.spec, x.tokenA, x.tokenB]),
    [
      [{ type: 'handicap', line: 1.5 }, 'n', 'f'],
      [{ type: 'total', line: 2.5 }, 'o', 'u'],
    ],
  );
});

test('Thunderpick: Match Handicap e Total Maps no REST e no delta', () => {
  const handicap = {
    id: 77, name: 'Match Handicap', category: 2, period: null, handicap: -1.5,
    selections: [
      { name: 'Team A', odds: 1.55, handicap: 1.5, type: 'home', status: 1 },
      { name: 'Team B', odds: 2.4, handicap: -1.5, type: 'away', status: 1 },
    ],
  };
  const total = {
    id: 78, name: 'Total Maps Played Over/Under', nickName: 'Total Maps', category: 5, baseLine: '2.5',
    selections: [
      { name: 'Over', odds: 2.1, total: '2.5', type: 'other', status: 1 },
      { name: 'Under', odds: 1.7, total: '2.5', type: 'other', status: 1 },
    ],
  };
  assert.deepEqual(readLineMarket(handicap)?.spec, { type: 'handicap', line: 1.5 });
  assert.deepEqual(readLineMarket({ ...handicap, period: 1 }), undefined);

  const { matches } = extractThunderpick({
    data: {
      upcoming: [{
        id: 5, gameId: 6, teams: { home: { name: 'Team A' }, away: { name: 'Team B' } },
        preferredMarkets: [
          { id: 76, name: 'Match Winner', selections: [{ type: 'home', odds: 1.8, status: 1 }, { type: 'away', odds: 2, status: 1 }] },
          handicap, total,
        ],
      }],
    },
  });
  assert.equal(matches.length, 1);
  assert.equal(matches[0].oddsA, 1.8);
  assert.deepEqual(matches[0].lines?.map((l) => [l.marketId, l.spec.line, l.oddsA, l.oddsB]), [['77', 1.5, 1.55, 2.4], ['78', 2.5, 2.1, 1.7]]);

  const { linePatches, patches } = extractThunderpick({ eventId: 5, ...handicap, selections: handicap.selections.map((s) => ({ ...s, odds: s.odds + 0.1 })) });
  assert.equal(patches.length, 0);
  assert.equal(linePatches[0].id, '5');
  assert.ok(Math.abs(linePatches[0].oddsA! - 1.65) < 1e-9);
});

test('vencedor do mapa com times invertidos troca o lado sem mexer no número do mapa', async () => {
  const store = new OddsStore();
  const engine = new ArbitrageEngine(store, {
    minProfitPct: 0, maxProfitPct: 15, confirmMs: 0, matchThreshold: 0.78, maxStartDiffMs: 6 * 3600_000,
    commissionPct: { polymarket: 0, duel: 0 },
  }, 'polymarket', 'duel');
  const found: Opportunity[] = [];
  engine.on('opportunity', (o) => found.push(o));
  const pm = { book: 'polymarket' as const, id: '1', teamA: 'Natus Vincere', teamB: 'FaZe Clan' };
  const du = { book: 'duel' as const, id: '7', teamA: 'FaZe', teamB: 'NAVI' };
  store.upsert(quote(pm, WINNER, 2, 2));
  store.upsert(quote(du, WINNER, 2, 2));
  store.upsert(quote(pm, { type: 'map', line: 2 }, 2.4, 1.6));
  store.upsert(quote(du, { type: 'map', line: 2 }, 1.9, 1.5));
  // Mapa 1 com odds altas não pode ser cruzado com o mapa 2.
  store.upsert(quote(du, { type: 'map', line: 1 }, 9, 9));
  await flush();

  assert.equal(found.length, 1);
  assert.equal(found[0].marketLabel, 'Vencedor do mapa 2');
  // NAVI no mapa 2 @ 2.4 (Polymarket) + FaZe no mapa 2 @ 1.9 (Duel, lado A)
  assert.deepEqual(found[0].legs.map((l) => l.selection), ['Natus Vincere (mapa 2)', 'FaZe (mapa 2)']);
  engine.stop();
});

test('vencedor do mapa nas três casas', () => {
  const ev = {
    desc: { competitors: [{ name: 'A' }, { name: 'B' }] },
    markets: { '330': { 'mapnr=1': { '4': { k: '1.41' }, '5': { k: '2.56' } }, 'mapnr=9': { '4': { k: '2' }, '5': { k: '2' } } } },
  } as unknown as BetbyEvent;
  assert.deepEqual(lineMarkets(ev), [{ a: 1.41, b: 2.56, suspended: false, spec: { type: 'map', line: 1 } }]);

  const pm = pickLineMarkets({
    markets: [
      { id: 9, sportsMarketType: 'child_moneyline', groupItemTitle: 'Game 2 Winner', outcomes: '["FaZe Clan","Natus Vincere"]', clobTokenIds: '["f","n"]' },
    ],
  } as never, 'Natus Vincere', 'FaZe Clan');
  assert.deepEqual(pm.map((x) => [x.spec, x.tokenA, x.tokenB]), [[{ type: 'map', line: 2 }, 'n', 'f']]);

  const sels = [
    { name: 'Team A', odds: 1.7, type: 'home', status: 1 },
    { name: 'Team B', odds: 2.1, type: 'away', status: 1 },
  ];
  assert.deepEqual(readLineMarket({ id: 1, name: 'Map Winner', period: { type: 'map', number: 3 }, selections: sels })?.spec, { type: 'map', line: 3 });
  assert.deepEqual(readLineMarket({ id: 2, name: 'Winner - Map 2', period: null, selections: sels })?.spec, { type: 'map', line: 2 });
  assert.equal(readLineMarket({ id: 3, name: 'Round Handicap - Map 1', period: { type: 'map', number: 1 }, selections: sels }), undefined);

  // "Map Winner" com período de mapa nunca pode virar o vencedor da série.
  const { matches } = extractThunderpick({
    data: {
      upcoming: [{
        id: 5, gameId: 6, teams: { home: { name: 'Team A' }, away: { name: 'Team B' } },
        preferredMarkets: [
          { id: 80, name: 'Map Winner', period: { type: 'map', number: 1 }, selections: sels },
          { id: 76, name: 'Match Winner', period: null, selections: [{ type: 'home', odds: 1.8, status: 1 }, { type: 'away', odds: 2, status: 1 }] },
        ],
      }],
    },
  });
  assert.equal(matches[0].oddsA, 1.8);
  assert.deepEqual(matches[0].lines?.map((l) => [l.marketId, l.spec]), [['80', { type: 'map', line: 1 }]]);
});

test('saúde conta quedas e uptime só depois da primeira conexão', () => {
  const store = new OddsStore();
  let state: SourceStatus['state'] = 'connecting';
  const h = new HealthMonitor(store, () => [{ book: 'duel', state, quotes: 3 }]);
  h.sample(0);
  h.sample(10_000);
  state = 'connected';
  h.sample(20_000);
  h.sample(80_000);
  state = 'error';
  h.sample(90_000);
  h.sample(100_000);
  state = 'connected';
  h.sample(110_000);
  h.countUpdate('duel', 110_000);
  h.countUpdate('duel', 110_500);
  const [d] = h.list(111_000);
  assert.equal(d.disconnects, 1);
  assert.equal(d.lastDisconnectAt, 90_000);
  // conectada 20s→90s (70s), fora 90s→110s (20s)
  assert.ok(Math.abs(d.uptimePct - (70 / 90) * 100) < 1e-9);
  assert.equal(d.updatesPerMin, 2);
  assert.equal(h.list(200_000)[0].updatesPerMin, 0);
});

test('histórico agrega mudanças rápidas e preserva o ponto anterior', () => {
  const h = new OddsHistory(new OddsStore(), { windowMs: 60_000, resolutionMs: 5_000, maxSamples: 10 });
  h.record('k', 2, 2, 0);
  h.record('k', 2.1, 2, 10_000);
  h.record('k', 2.2, 2, 11_000);
  h.record('k', 2.2, 2, 12_000);
  h.record('k', 2.3, 2, 13_000);
  assert.deepEqual(h.get(['k']).k, [[0, 2, 2], [10_000, 2.1, 2], [13_000, 2.3, 2]]);
});
