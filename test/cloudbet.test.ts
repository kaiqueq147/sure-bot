import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CloudbetSource, cloudbetMarkets, cloudbetSportMarkets } from '../src/sources/cloudbet.js';
import { OddsStore } from '../src/core/OddsStore.js';

const sel = (outcome: string, params: string, price: number, status = 'SELECTION_ENABLED') => ({ outcome, params, price, status, maxStake: 100 });
const sub = (selections: ReturnType<typeof sel>[]) => ({ submarkets: { 'period=default': { selections } } });

const event = {
  id: 1,
  home: { name: 'FORZE Reload' },
  away: { name: 'Butterfly' },
  status: 'TRADING',
  markets: {
    'counter_strike.winner': sub([sel('home', '', 1.32), sel('away', '', 3.1)]),
    'counter_strike.map_handicap': sub([
      sel('home', 'handicap=-1.5', 2.08),
      sel('away', 'handicap=-1.5', 1.67),
      sel('home', 'handicap=1.5', 1.11),
      sel('away', 'handicap=1.5', 5.6, 'SELECTION_SUSPENDED'),
      sel('home', 'handicap=-1', 1.5),
      sel('away', 'handicap=-1', 2.5),
    ]),
    'counter_strike.total_maps': sub([sel('over', 'total=2.5', 2.15), sel('under', 'total=2.5', 1.63)]),
    'counter_strike.map_winner': {
      submarkets: {
        'period=map1': { selections: [sel('home', 'map=1', 1.44), sel('away', 'map=1', 2.55)] },
        'period=map2': { selections: [sel('home', 'map=2', 1.45), sel('away', 'map=2', 2.5)] },
      },
    },
  },
};

test('lê vencedor, handicaps x.5, total e vencedor do mapa', () => {
  const markets = cloudbetMarkets('counter-strike', event);
  const by = (type: string, line?: number) => markets.find((m) => m.spec.type === type && m.spec.line === line);
  assert.deepEqual([by('winner')?.a, by('winner')?.b], [1.32, 3.1]);
  assert.deepEqual([by('handicap', -1.5)?.a, by('handicap', -1.5)?.b], [2.08, 1.67]);
  assert.equal(by('handicap', 1.5)?.suspended, true, 'seleção suspensa suspende o par');
  assert.equal(by('handicap', -1), undefined, 'linha inteira (com devolução) fica de fora');
  assert.deepEqual([by('total', 2.5)?.a, by('total', 2.5)?.b], [2.15, 1.63]);
  assert.deepEqual([by('map', 2)?.a, by('map', 2)?.b], [1.45, 2.5]);
  assert.equal(by('winner')?.maxA, 100);
});

test('vencedor com empate não é mercado de 2 vias', () => {
  const draw = {
    ...event,
    markets: { 'counter_strike.winner': sub([sel('home', '', 2), sel('draw', '', 5), sel('away', '', 3)]) },
  };
  assert.equal(cloudbetMarkets('counter-strike', draw).length, 0);
});

test('futebol: 1X2 com empate, handicap asiático e gols só em linhas x.5', () => {
  const soccer = {
    id: 2,
    home: { name: 'Flamengo' },
    away: { name: 'Palmeiras' },
    status: 'TRADING',
    markets: {
      'soccer.match_odds': sub([sel('home', '', 2.1), sel('draw', '', 3.3), sel('away', '', 3.6)]),
      'soccer.asian_handicap': sub([
        sel('home', 'handicap=-0.5', 2.05),
        sel('away', 'handicap=-0.5', 1.8),
        sel('home', 'handicap=-0.25', 2.4),
        sel('away', 'handicap=-0.25', 1.6),
      ]),
      'soccer.total_goals': sub([sel('over', 'total=2.5', 1.95), sel('under', 'total=2.5', 1.9), sel('over', 'total=3.5', 3.2), sel('under', 'total=3.5', 1.35)]),
    },
  };
  const markets = cloudbetSportMarkets('soccer', soccer);
  const winner = markets.find((m) => m.spec.type === 'winner' && !m.spec.period);
  assert.deepEqual([winner?.a, winner?.draw, winner?.b], [2.1, 3.3, 3.6]);
  assert.equal(winner?.suspended, false);
  assert.deepEqual(
    markets.filter((m) => m.spec.type === 'handicap').map((m) => m.spec.line),
    [-0.5],
    'linha de quarto (-0.25) fica de fora',
  );
  assert.deepEqual(markets.filter((m) => m.spec.type === 'total').map((m) => m.spec.line), [2.5, 3.5], 'linhas alternativas entram');
});

test('empate suspenso suspende o 1X2; moneyline com empate é ignorada', () => {
  const soccer = {
    id: 3,
    home: { name: 'A' },
    away: { name: 'B' },
    status: 'TRADING',
    markets: { 'soccer.match_odds': sub([sel('home', '', 2), sel('draw', '', 3, 'SELECTION_SUSPENDED'), sel('away', '', 4)]) },
  };
  assert.equal(cloudbetSportMarkets('soccer', soccer).find((m) => m.spec.type === 'winner')?.suspended, true);
  const nba = {
    ...soccer,
    markets: { 'basketball.moneyline': sub([sel('home', '', 1.5), sel('draw', '', 15), sel('away', '', 2.8)]) },
  };
  assert.equal(cloudbetSportMarkets('basketball', nba).length, 0, 'moneyline de tempo regulamentar não é 2 vias');
});

test('busca de eSports não apaga os eventos de esportes tradicionais (e vice-versa)', () => {
  const store = new OddsStore();
  const src = new CloudbetSource(store, {
    apiBase: 'https://x', siteUrl: 'https://www.cloudbet.com', lang: 'en', sports: ['counter-strike'],
    liveIntervalMs: 1000, allIntervalMs: 15000, traditionalSports: ['soccer'],
  }) as unknown as { ingest(body: unknown, live: boolean, scope: string): void };
  const soccer = {
    id: 9, home: { name: 'Flamengo' }, away: { name: 'Palmeiras' }, status: 'TRADING',
    markets: { 'soccer.match_odds': sub([sel('home', '', 2.1), sel('draw', '', 3.3), sel('away', '', 3.6)]) },
  };
  src.ingest({ sports: [{ key: 'soccer', competitions: [{ key: 'soccer-brazil', name: 'Brasileirão', events: [soccer] }] }] }, false, 'sports');
  src.ingest({ sports: [{ key: 'counter-strike', competitions: [{ key: 'cs-x', name: 'X', events: [event] }] }] }, false, 'esports');
  const q = store.get('cloudbet:9');
  assert.ok(q, 'evento de futebol continua após a busca de eSports');
  assert.equal(q.oddsDraw, 3.3);
  assert.equal(q.game, 'soccer');
  assert.equal(q.url, 'https://www.cloudbet.com/en/sports/soccer/brazil/9');
  assert.ok(store.get('cloudbet:1'), 'evento de CS2 publicado');
  src.ingest({ sports: [] }, false, 'sports');
  assert.equal(store.get('cloudbet:9'), undefined, 'a busca de esportes poda os seus próprios eventos');
  assert.ok(store.get('cloudbet:1'), 'e não mexe nos eSports');
});
