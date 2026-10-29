import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OddsStore } from '../src/core/OddsStore.js';
import { buildGroups, ValueScanner } from '../src/engine/ValueScanner.js';
import type { MatchPair } from '../src/matching/matcher.js';
import type { BookId, Quote, ValueBet } from '../src/types.js';

const quote = (book: BookId, teamA: string, teamB: string, oddsA: number, oddsB: number): Quote => ({
  key: `${book}:1`,
  eventKey: `${book}:1`,
  market: { type: 'winner' },
  book,
  marketId: '1',
  game: 'cs2',
  eventName: `${teamA} vs ${teamB}`,
  teamA,
  teamB,
  startTime: Date.now() + 3600_000,
  oddsA,
  oddsB,
  url: `https://${book}.test/1`,
  updatedAt: Date.now(),
});

const pair = (l: string, r: string, swapped = false): MatchPair => ({ id: `${l}|${r}`, leftKey: l, rightKey: r, swapped, score: 1 });
const bookOf = (k: string) => k.split(':')[0] as BookId;

test('buildGroups orienta os times de todas as casas para o mesmo lado', () => {
  const groups = buildGroups(
    [pair('polymarket:1', 'thunderpick:1', true), pair('polymarket:1', 'duel:1'), pair('thunderpick:1', 'duel:1', true)],
    bookOf,
  );
  assert.equal(groups.length, 1);
  const flips = Object.fromEntries(groups[0].members.map((m) => [m.key, m.flip]));
  assert.deepEqual(flips, { 'duel:1': false, 'polymarket:1': false, 'thunderpick:1': true });
});

test('buildGroups descarta orientação contraditória e casa repetida', () => {
  assert.equal(buildGroups([pair('polymarket:1', 'thunderpick:1'), pair('polymarket:1', 'duel:1'), pair('thunderpick:1', 'duel:1', true)], bookOf).length, 0);
  assert.equal(buildGroups([pair('polymarket:1', 'duel:1'), pair('polymarket:1', 'duel:2')], bookOf).length, 0);
});

test('scanner aponta a odd acima do consenso das outras casas', () => {
  const store = new OddsStore();
  // Consenso ~50/50; Duel paga 2.30 em NAVI (lado A) e a Thunderpick tem os times invertidos.
  store.upsert(quote('polymarket', 'NAVI', 'FaZe', 2.0, 2.0));
  store.upsert(quote('thunderpick', 'FaZe', 'NAVI', 1.9, 1.9));
  store.upsert(quote('duel', 'NAVI', 'FaZe', 2.3, 1.6));
  const pairs = [pair('polymarket:1', 'thunderpick:1', true), pair('polymarket:1', 'duel:1'), pair('thunderpick:1', 'duel:1', true)];
  const scanner = new ValueScanner(store, () => pairs, { minEvPct: 2, warnEvPct: 20, maxOverroundPct: 12, commissionPct: {} });
  let emitted: ValueBet[] = [];
  scanner.on('changed', (items) => (emitted = items));
  scanner.scan();

  // A discordância da Duel também deixa FaZe @ 2.0 na Polymarket acima do consenso (EV menor).
  assert.deepEqual(emitted.map((b) => `${b.selection}@${b.bestBook}`), ['NAVI@duel', 'FaZe@polymarket']);
  const bet = emitted[0];
  assert.equal(bet.selection, 'NAVI');
  assert.equal(bet.bestBook, 'duel');
  assert.ok(Math.abs(bet.fairProb - 0.5) < 1e-9);
  assert.ok(Math.abs(bet.evPct - 15) < 1e-9, `EV ${bet.evPct}`);
  assert.ok(Math.abs(bet.disparityPct - (2.3 / 1.9 - 1) * 100) < 1e-9);
  assert.ok(Math.abs(bet.oddsDiff - 0.4) < 1e-9);
  assert.deepEqual(bet.books.map((b) => b.book), ['duel', 'polymarket', 'thunderpick']);
  assert.equal(bet.books[0].openingOdds, 2.3);

  // A odd cai: o EV some e a abertura continua registrada.
  store.upsert(quote('duel', 'NAVI', 'FaZe', 1.95, 1.95));
  scanner.scan();
  assert.equal(emitted.length, 0);
});

test('livro com spread largo não entra no consenso', () => {
  const store = new OddsStore();
  // Polymarket fina: asks de 0.92 e 0.87 (margem de 79%) não dizem nada sobre a probabilidade real.
  store.upsert(quote('polymarket', 'Team Rey', 'RRQ Tora', 1.087, 1.149));
  store.upsert(quote('duel', 'Team Rey', 'RRQ Tora', 1.16, 4.0));
  const pairs = [pair('polymarket:1', 'duel:1')];
  const scanner = new ValueScanner(store, () => pairs, { minEvPct: 2, warnEvPct: 20, maxOverroundPct: 12, commissionPct: {} });
  let emitted: ValueBet[] = [];
  scanner.on('changed', (items) => (emitted = items));
  scanner.scan();
  assert.deepEqual(emitted, []);
});

test('EV exige o mínimo de casas no consenso (padrão 2)', () => {
  const store = new OddsStore();
  store.upsert(quote('polymarket', 'NAVI', 'FaZe', 2.0, 2.0));
  store.upsert(quote('duel', 'NAVI', 'FaZe', 2.3, 1.6));
  const pairs = [pair('polymarket:1', 'duel:1')];
  const opts = { minEvPct: 2, warnEvPct: 20, maxOverroundPct: 12, commissionPct: {} };

  // Só uma outra casa para a odd justa: sem EV por padrão.
  const strict = new ValueScanner(store, () => pairs, opts);
  strict.scan();
  assert.equal(strict.list().length, 0);

  const loose = new ValueScanner(store, () => pairs, { ...opts, minConsensusBooks: 1 });
  loose.scan();
  const bet = loose.list().find((b) => b.bestBook === 'duel');
  assert.ok(bet, 'com 1 casa de consenso o EV aparece');
  assert.ok(bet.warnings.some((w) => w.includes('única casa')));
});

test('EV avisa odd congelada ao vivo quando as outras casas se mexeram', () => {
  const store = new OddsStore();
  const now = Date.now();
  const live = (q: Quote, changedAt: number): Quote => ({ ...q, startTime: now - 600_000, changedAt, updatedAt: now });
  store.upsert(live(quote('polymarket', 'NAVI', 'FaZe', 2.0, 2.0), now - 2_000));
  store.upsert(live(quote('thunderpick', 'NAVI', 'FaZe', 1.95, 1.95), now - 3_000));
  store.upsert(live(quote('duel', 'NAVI', 'FaZe', 2.3, 1.6), now - 60_000));
  // OddsStore recalcula changedAt no upsert; força o cenário de preço parado.
  store.get('duel:1')!.changedAt = now - 60_000;
  store.get('polymarket:1')!.changedAt = now - 2_000;
  store.get('thunderpick:1')!.changedAt = now - 3_000;
  const pairs = [pair('polymarket:1', 'duel:1'), pair('thunderpick:1', 'duel:1'), pair('polymarket:1', 'thunderpick:1')];
  const scanner = new ValueScanner(store, () => pairs, { minEvPct: 2, warnEvPct: 20, maxOverroundPct: 12, commissionPct: {} });
  scanner.scan(now);
  const bet = scanner.list().find((b) => b.bestBook === 'duel');
  assert.ok(bet, 'EV continua aparecendo (só é sinalizado)');
  assert.ok(bet.books[0].frozenMs! >= 60_000);
  assert.ok(bet.warnings.some((w) => w.includes('congelada')));

  // Pré-jogo parado é normal: sem aviso.
  for (const k of ['polymarket:1', 'thunderpick:1', 'duel:1']) store.get(k)!.startTime = now + 3600_000;
  scanner.scan(now);
  const pre = scanner.list().find((b) => b.bestBook === 'duel')!;
  assert.equal(pre.books[0].frozenMs, undefined);
  assert.ok(!pre.warnings.some((w) => w.includes('congelada')));
});
