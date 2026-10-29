import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cloudbetMarkets } from '../src/sources/cloudbet.js';

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
