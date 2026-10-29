import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pickSoccer1x2, pickSportLineMarkets, sportOf, type GammaEvent } from '../src/sources/polymarket.js';

const yesNo = (id: string, extra: Record<string, unknown>) => ({
  id,
  outcomes: '["Yes", "No"]',
  clobTokenIds: `["${id}-yes", "${id}-no"]`,
  active: true,
  closed: false,
  enableOrderBook: true,
  acceptingOrders: true,
  ...extra,
});

test('futebol: 1X2 a partir dos três Sim/Não, mandante pelo título', () => {
  const ev: GammaEvent = {
    id: 1,
    slug: 'lal-vil-esp-2026-10-30',
    title: 'Villarreal CF vs. RCD Espanyol de Barcelona',
    tags: [{ slug: 'soccer' }, { slug: 'la-liga' }],
    markets: [
      yesNo('away', { sportsMarketType: 'moneyline', groupItemTitle: 'RCD Espanyol de Barcelona' }),
      yesNo('draw', { sportsMarketType: 'moneyline', groupItemTitle: 'Draw (Villarreal CF vs. RCD Espanyol de Barcelona)' }),
      yesNo('home', { sportsMarketType: 'moneyline', groupItemTitle: 'Villarreal CF' }),
    ],
  };
  assert.equal(sportOf(ev), 'soccer');
  const x = pickSoccer1x2(ev)!;
  assert.equal(x.teamA, 'Villarreal CF');
  assert.equal(x.teamB, 'RCD Espanyol de Barcelona');
  assert.deepEqual([x.entry.tokenA, x.entry.tokenDraw, x.entry.tokenB], ['home-yes', 'draw-yes', 'away-yes']);
});

test('linhas: spread orientado pelo primeiro outcome, totais, ambas marcam e 1º tempo', () => {
  const more: GammaEvent = {
    id: 2,
    slug: 'lal-vil-esp-2026-10-30-more-markets',
    title: 'Villarreal CF vs. RCD Espanyol de Barcelona - More Markets',
    markets: [
      { id: 's', sportsMarketType: 'spreads', line: -1.5, outcomes: '["RCD Espanyol de Barcelona", "Villarreal CF"]', clobTokenIds: '["e", "v"]' },
      { id: 't', sportsMarketType: 'totals', line: 2.5, outcomes: '["Under", "Over"]', clobTokenIds: '["u", "o"]' },
      { id: 'tint', sportsMarketType: 'totals', line: 2, outcomes: '["Over", "Under"]', clobTokenIds: '["o2", "u2"]' },
      { id: 'b', sportsMarketType: 'both_teams_to_score', outcomes: '["Yes", "No"]', clobTokenIds: '["y", "n"]' },
      { id: 'h', sportsMarketType: 'first_half_totals', line: 0.5, outcomes: '["Over", "Under"]', clobTokenIds: '["ho", "hu"]' },
      { id: 'team', sportsMarketType: 'soccer_team_totals', line: 0.5, outcomes: '["Over", "Under"]', clobTokenIds: '["x", "y2"]' },
    ],
  };
  const got = pickSportLineMarkets([more], 'Villarreal CF', 'RCD Espanyol de Barcelona').map(
    (e) => `${e.spec.type}${e.spec.period ? '@' + e.spec.period : ''}:${e.spec.line ?? ''}:${e.tokenA}/${e.tokenB}`,
  );
  assert.deepEqual(got, ['handicap:1.5:v/e', 'total:2.5:o/u', 'btts::y/n', 'total@h1:0.5:ho/hu']);
});

test('tênis: total de games e vencedor do 1º set; NBA vira basquete', () => {
  const ev: GammaEvent = {
    id: 3,
    slug: 'atp-a-b',
    title: 'ATP Basel: Player A vs Player B',
    tags: [{ slug: 'tennis' }],
    markets: [
      { id: 'm', sportsMarketType: 'tennis_match_totals', line: 21.5, outcomes: '["Over", "Under"]', clobTokenIds: '["o", "u"]' },
      { id: 's1', sportsMarketType: 'tennis_first_set_winner', outcomes: '["Player B", "Player A"]', clobTokenIds: '["b", "a"]' },
      { id: 'sh', sportsMarketType: 'tennis_set_handicap', line: -1.5, outcomes: '["Player A", "Player B"]', clobTokenIds: '["x", "y"]' },
    ],
  };
  assert.equal(sportOf(ev), 'tennis');
  const got = pickSportLineMarkets([ev], 'Player A', 'Player B').map((e) => `${e.spec.type}@${e.spec.period ?? ''}:${e.tokenA}`);
  assert.deepEqual(got, ['total@:o', 'winner@set1:a']);
  assert.equal(sportOf({ id: 4, slug: 'x', title: 'Cavaliers vs. Hawks', tags: [{ slug: 'nba' }] }), 'basketball');
});
