import assert from 'node:assert/strict';
import { test } from 'node:test';
import { matchQuotes, pairKey, setPairBlocklist } from '../src/matching/matcher.js';
import { canonicalTeam, detectGame, teamSimilarity } from '../src/matching/normalize.js';
import type { Quote } from '../src/types.js';

test('aliases e variações de nome convergem', () => {
  const same: Array<[string, string]> = [
    ['Natus Vincere', 'NAVI'],
    ['Ninjas in Pyjamas', 'NIP'],
    ['Gen.G', 'GenG Esports'],
    ['Team Vitality', 'Vitality'],
    ['MOUZ', 'mousesports'],
    ['FaZe Clan', 'FaZe'],
    ['Bilibili Gaming', 'BLG'],
    ['Team Liquid', 'Liquid'],
    ['Fürious Gaming', 'Furious'],
  ];
  for (const [a, b] of same) assert.ok(teamSimilarity(a, b) >= 0.85, `${a} ~ ${b} = ${teamSimilarity(a, b)}`);
});

test('equipes diferentes não colidem', () => {
  assert.ok(teamSimilarity('T1', 'T1 Academy') < 0.7);
  assert.ok(teamSimilarity('G2 Esports', 'Fnatic') < 0.5);
  assert.ok(teamSimilarity('Team Spirit', 'Team Secret') < 0.7);
  assert.equal(canonicalTeam('Natus Vincere'), canonicalTeam('NaVi'));
});

test('detecção de modalidade', () => {
  assert.equal(detectGame('Counter-Strike: Vitality vs FaZe'), 'cs2');
  assert.equal(detectGame('counter-strike-2'), 'cs2');
  assert.equal(detectGame('LoL: T1 vs Gen.G'), 'lol');
  assert.equal(detectGame('Dota 2'), 'dota2');
  assert.equal(detectGame('VALORANT Champions'), 'valorant');
});

const q = (key: string, teamA: string, teamB: string, extra: Partial<Quote> = {}): Quote => ({
  key,
  eventKey: key,
  market: { type: 'winner' },
  book: key.startsWith('polymarket') ? 'polymarket' : 'thunderpick',
  marketId: key,
  game: 'cs2',
  eventName: '',
  teamA,
  teamB,
  oddsA: 2,
  oddsB: 2,
  url: '',
  updatedAt: 0,
  ...extra,
});

test('pareamento detecta orientação invertida e respeita horário', () => {
  const now = Date.now();
  const left = [
    q('polymarket:1', 'Team Vitality', 'MOUZ', { startTime: now }),
    q('polymarket:2', 'G2 Esports', 'FaZe Clan', { startTime: now }),
  ];
  const right = [
    q('thunderpick:a', 'mousesports', 'Vitality', { startTime: now + 600_000 }),
    q('thunderpick:b', 'G2', 'FaZe', { startTime: now + 2 * 86400_000 }),
  ];
  const pairs = matchQuotes(left, right, { threshold: 0.78, maxStartDiffMs: 6 * 3600_000 });
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].leftKey, 'polymarket:1');
  assert.equal(pairs[0].swapped, true);
});

test('modalidades diferentes não pareiam', () => {
  const pairs = matchQuotes([q('polymarket:1', 'Fnatic', 'G2')], [q('thunderpick:1', 'Fnatic', 'G2', { game: 'lol' })], {
    threshold: 0.78,
    maxStartDiffMs: 1,
  });
  assert.equal(pairs.length, 0);
});

test('par bloqueado não é pareado; desbloquear volta a parear', () => {
  const l = [q('stake:1', 'Natus Vincere', 'FaZe', { eventKey: 'stake:1' })];
  const r = [q('duel:9', 'NAVI', 'FaZe Clan', { book: 'duel', eventKey: 'duel:9' })];
  const opts = { threshold: 0.78, maxStartDiffMs: 6 * 3600_000 };
  assert.equal(matchQuotes(l, r, opts).length, 1);
  const blocked = new Set([pairKey('duel:9', 'stake:1')]);
  setPairBlocklist((a, b) => blocked.has(pairKey(a, b)));
  try {
    assert.equal(matchQuotes(l, r, opts).length, 0, 'par marcado como errado');
    blocked.clear();
    assert.equal(matchQuotes(l, r, opts).length, 1);
  } finally {
    setPairBlocklist();
  }
});
