import assert from 'node:assert/strict';
import { test } from 'node:test';
import { derivedQuoteFields, marketKey, marketLabel, sameMarket, selectionLabels } from '../src/core/markets.js';
import { OddsStore } from '../src/core/OddsStore.js';
import { ArbitrageEngine, derivedPairs } from '../src/engine/ArbitrageEngine.js';
import { ThreeWayEngine } from '../src/engine/ThreeWayEngine.js';
import { ValueScanner } from '../src/engine/ValueScanner.js';
import { matchQuotes } from '../src/matching/matcher.js';
import { parsePlayer, teamSimilarity } from '../src/matching/normalize.js';
import type { Opportunity, Quote, ValueBet } from '../src/types.js';

const quote = (over: Partial<Quote> & Pick<Quote, 'key' | 'book' | 'teamA' | 'teamB'>): Quote => ({
  eventKey: over.key,
  market: { type: 'winner' },
  marketId: over.key.split(':')[1],
  game: 'soccer',
  eventName: `${over.teamA} vs ${over.teamB}`,
  oddsA: 2,
  oddsB: 2,
  url: 'https://example.com',
  startTime: Date.parse('2026-11-01T18:00:00Z'),
  updatedAt: Date.now(),
  ...over,
});

const flush = () => new Promise((r) => setTimeout(r, 600));
const engineOpts = {
  minProfitPct: 0, maxProfitPct: 15, confirmMs: 0, matchThreshold: 0.78, maxStartDiffMs: 6 * 3600_000,
  commissionPct: {},
};

test('período entra na chave, no pareamento e nos rótulos; unidade por esporte', () => {
  assert.equal(marketKey({ type: 'total', line: 2.5 }), 'tot:2.5');
  assert.equal(marketKey({ type: 'total', line: 2.5, period: 'h1' }), 'tot:2.5@h1');
  assert.ok(!sameMarket({ type: 'total', line: 2.5 }, { type: 'total', line: 2.5, period: 'h1' }));
  assert.equal(marketLabel({ type: 'total', line: 2.5 }, 'soccer'), 'Total de gols 2.5');
  assert.equal(marketLabel({ type: 'handicap', line: -5.5, period: 'q1' }, 'basketball'), '1º quarto: Handicap de pontos -5.5');
  assert.equal(marketLabel({ type: 'total', line: 2.5 }), 'Total de mapas 2.5', 'eSports sem jogo: rótulo antigo');
  assert.deepEqual(selectionLabels({ type: 'total', line: 8.5 }, 'Yankees', 'Red Sox', 'baseball'), ['Mais de 8.5 runs', 'Menos de 8.5 runs']);
  assert.deepEqual(selectionLabels({ type: 'btts' }, 'A', 'B', 'soccer'), ['Ambas marcam: sim', 'Ambas marcam: não']);
  // O vencedor de um período é derivado: só o do jogo inteiro é a âncora do pareamento.
  assert.equal(derivedQuoteFields('stake:1', { type: 'winner' }, 'A', 'B').key, 'stake:1');
  assert.equal(derivedQuoteFields('stake:1', { type: 'winner', period: 'h1' }, 'A', 'B').key, 'stake:1:win@h1');
});

test('nomes de esportes tradicionais: siglas de clube, abreviações e tenistas', () => {
  const same: Array<[string, string, Quote['game']]> = [
    ['Manchester United', 'Man Utd', 'soccer'],
    ['FC Barcelona', 'Barcelona', 'soccer'],
    ['Bayern München', 'FC Bayern Munich', 'soccer'],
    ['Paris Saint-Germain', 'PSG', 'soccer'],
    ['Los Angeles Lakers', 'LA Lakers', 'basketball'],
    ['Sinner J.', 'Jannik Sinner', 'tennis'],
    ['Sinner, Jannik', 'J. Sinner', 'tennis'],
    ['De Minaur A.', 'Alex de Minaur', 'tennis'],
    ['Krawczyk D. / Salisbury J.', 'Joe Salisbury / Desirae Krawczyk', 'tennis'],
  ];
  for (const [a, b, g] of same) assert.ok(teamSimilarity(a, b, g) >= 0.85, `${a} ~ ${b} = ${teamSimilarity(a, b, g)}`);

  const different: Array<[string, string, Quote['game']]> = [
    ['Chelsea', 'Chelsea W', 'soccer'],
    ['Real Madrid', 'Real Madrid Castilla', 'soccer'],
    ['Brazil', 'Brazil U21', 'soccer'],
    ['Manchester United', 'Manchester City', 'soccer'],
    ['Zverev A.', 'Mischa Zverev', 'tennis'],
  ];
  for (const [a, b, g] of different) assert.ok(teamSimilarity(a, b, g) < 0.7, `${a} != ${b} = ${teamSimilarity(a, b, g)}`);

  assert.deepEqual(parsePlayer('Sinner J.'), { surname: 'sinner', initial: 'j' });
  // eSports sem `game` seguem as regras antigas.
  assert.ok(teamSimilarity('T1', 'T1 Academy') < 0.7);
});

test('1X2 é âncora do pareamento mas não vira arbitragem de 2 vias', async () => {
  const store = new OddsStore();
  const engine = new ArbitrageEngine(store, engineOpts, 'stake', 'duel');
  const found: Opportunity[] = [];
  engine.on('opportunity', (o) => found.push(o));

  // Odds de 2 vias absurdas no 1X2: sem o empate isso seria "arbitragem".
  store.upsert(quote({ key: 'stake:1', book: 'stake', teamA: 'Arsenal FC', teamB: 'Chelsea', oddsA: 3, oddsB: 3, oddsDraw: 3.4 }));
  store.upsert(quote({ key: 'duel:9', book: 'duel', teamA: 'Chelsea FC', teamB: 'Arsenal', oddsA: 3, oddsB: 3, oddsDraw: 3.3 }));
  // Handicap asiático derivado do mesmo jogo (times invertidos na Duel): continua pareando.
  store.upsert(quote({ key: 'stake:1:hcp:-0.5', eventKey: 'stake:1', book: 'stake', teamA: 'Arsenal FC', teamB: 'Chelsea', market: { type: 'handicap', line: -0.5 }, oddsA: 2.2, oddsB: 1.7 }));
  store.upsert(quote({ key: 'duel:9:hcp:0.5', eventKey: 'duel:9', book: 'duel', teamA: 'Chelsea FC', teamB: 'Arsenal', market: { type: 'handicap', line: 0.5 }, oddsA: 2.15, oddsB: 1.75 }));
  await flush();

  assert.equal(engine.pairCount, 1, 'o 1X2 pareia os jogos');
  assert.ok(engine.matchedPairs().some((p) => p.leftKey === 'stake:1:hcp:-0.5' && p.rightKey === 'duel:9:hcp:0.5'));
  assert.ok(found.every((o) => o.market.type !== 'winner'), 'nenhuma oportunidade de 2 vias no 1X2');
  // Arsenal -0.5 @ 2.2 na Stake + Chelsea +0.5 @ 2.15 na Duel => margem < 1
  assert.equal(found.length, 1);
  assert.equal(found[0].market.type, 'handicap');
  engine.stop();
});

test('arbitragem de 3 vias: melhor casa/empate/fora entre casas, com times invertidos', async () => {
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

  store.upsert(quote({ key: 'stake:1', book: books[0], teamA: 'Arsenal', teamB: 'Chelsea', oddsA: 2.9, oddsB: 2.6, oddsDraw: 3.2 }));
  // Duel lista Chelsea primeiro: oddsA = Chelsea.
  store.upsert(quote({ key: 'duel:9', book: books[1], teamA: 'Chelsea', teamB: 'Arsenal FC', oddsA: 3.1, oddsB: 2.5, oddsDraw: 3.3 }));
  store.upsert(quote({ key: 'cloudbet:5', book: books[2], teamA: 'Arsenal', teamB: 'Chelsea FC', oddsA: 2.5, oddsB: 2.7, oddsDraw: 3.9 }));
  await flush();
  three.evaluate();

  // Melhor Arsenal 2.9 (Stake) + empate 3.9 (Cloudbet) + Chelsea 3.1 (Duel): 1/2.9+1/3.9+1/3.1 = 0.9238
  assert.equal(found.length, 1);
  const [opp] = found;
  assert.equal(opp.legs.length, 3);
  assert.deepEqual(opp.legs.map((l) => `${l.book}:${l.side}:${l.selection}@${l.odds}`), [
    'stake:A:Arsenal@2.9',
    'cloudbet:D:Empate@3.9',
    'duel:A:Chelsea@3.1',
  ]);
  assert.ok(Math.abs(opp.margin - (1 / 2.9 + 1 / 3.9 + 1 / 3.1)) < 1e-9);
  assert.equal(opp.marketLabel, 'Resultado final (1X2)');

  const closed: string[] = [];
  three.on('closed', (id, reason) => closed.push(`${id}:${reason}`));
  // Arsenal cai na Stake: melhor casa vira 2.5 => 1/2.5 + 1/3.9 + 1/3.1 = 0.98; com o empate
  // da Cloudbet a 3.0 o melhor empate é 3.3 (Duel) => 1.026, sem arbitragem.
  store.patch('stake:1', { oddsA: 2.0, updatedAt: Date.now() });
  store.patch('cloudbet:5', { oddsDraw: 3.0, updatedAt: Date.now() });
  three.evaluate();
  assert.equal(closed.length, 1);
  assert.match(closed[0], /odds_moved$/);
  for (const e of engines) e.stop();
  three.stop();
});

test('EV no 1X2: probabilidade justa das outras casas sem a margem das 3 seleções', () => {
  const store = new OddsStore();
  const q = [
    quote({ key: 'stake:1', book: 'stake', teamA: 'Arsenal', teamB: 'Chelsea', oddsA: 2.0, oddsB: 4.0, oddsDraw: 3.5 }),
    quote({ key: 'duel:9', book: 'duel', teamA: 'Arsenal', teamB: 'Chelsea', oddsA: 2.0, oddsB: 4.0, oddsDraw: 3.5 }),
    // Cloudbet paga bem mais pelo empate.
    quote({ key: 'cloudbet:5', book: 'cloudbet', teamA: 'Chelsea', teamB: 'Arsenal', oddsA: 4.0, oddsB: 2.0, oddsDraw: 4.6 }),
  ];
  for (const x of q) store.upsert(x);
  const pairs = [
    { id: 'a', leftKey: 'stake:1', rightKey: 'duel:9', swapped: false, score: 1 },
    { id: 'b', leftKey: 'stake:1', rightKey: 'cloudbet:5', swapped: true, score: 1 },
  ];
  const scanner = new ValueScanner(store, () => pairs, { minEvPct: 2, warnEvPct: 30, maxOverroundPct: 12, commissionPct: {} });
  let emitted: ValueBet[] = [];
  scanner.on('changed', (items) => (emitted = items));
  scanner.scan();

  const draw = emitted.find((b) => b.selection === 'Empate');
  assert.ok(draw, 'EV no empate');
  assert.equal(draw.bestBook, 'cloudbet');
  assert.equal(draw.books[0].side, 'D');
  const sum = 1 / 2 + 1 / 4 + 1 / 3.5;
  assert.ok(Math.abs(draw.fairProb - 1 / 3.5 / sum) < 1e-9);
  assert.ok(Math.abs(draw.evPct - (4.6 * (1 / 3.5 / sum) - 1) * 100) < 1e-9);
  // Nenhuma seleção de 2 vias sai de um 1X2.
  assert.ok(emitted.every((b) => /#(A|B|D)$/.test(b.id)));
});

test('rematch com milhares de jogos de futebol usa a janela de horário', () => {
  const base = Date.parse('2026-11-01T00:00:00Z');
  const mk = (book: 'stake' | 'duel', i: number, swap: boolean): Quote =>
    quote({
      key: `${book}:${i}`,
      book,
      teamA: swap ? `Club ${i} B` : `FC Team ${i} A`,
      teamB: swap ? `Team ${i} A` : `Club ${i} B FC`,
      // 5 mil jogos ao longo de ~7 dias
      startTime: base + i * 120_000,
    });
  const left = Array.from({ length: 5000 }, (_, i) => mk('stake', i, false));
  const right = Array.from({ length: 5000 }, (_, i) => mk('duel', i, true));
  const t = performance.now();
  const pairs = matchQuotes(left, right, { threshold: 0.78, maxStartDiffMs: 6 * 3600_000 });
  const ms = performance.now() - t;
  assert.ok(pairs.length >= 4900, `pares: ${pairs.length}`);
  assert.ok(pairs.filter((p) => p.leftKey.split(':')[1] === p.rightKey.split(':')[1]).length >= 4900);
  assert.ok(derivedPairs(pairs, left, right).length === 0);
  console.log(`matchQuotes 5000x5000 futebol: ${ms.toFixed(0)}ms`);
});
