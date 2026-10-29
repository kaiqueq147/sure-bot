import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildStakeQuery, stakeMarkets, type StakeFixture, type StakeMarket } from '../src/sources/stake.js';

const out = (name: string, odds: number, active = true) => ({ name, odds, active });
const mkt = (specifiers: string, outcomes: ReturnType<typeof out>[], status = 'active'): StakeMarket => ({ id: specifiers, status, specifiers, outcomes });

// Recorte de uma resposta real de `fixtureList` (CS2, provedor Oddin).
const fixture: StakeFixture = {
  id: '04c02eb1-10b7-4adb-b2c4-2a835096c7c4',
  slug: '1793260800000-fut-esports-nemiga-gaming',
  status: 'active',
  data: { startTime: 'Thu, 29 Oct 2026 08:00:00 GMT', competitors: [{ name: 'FUT Esports' }, { name: 'Nemiga Gaming' }] },
  tournament: { name: 'PGL Masters Bucharest 2026', slug: 'pgl-masters-bucharest-2026-t2', category: { slug: 'international-3' } },
  main: [
    {
      name: 'handicap',
      templates: [
        {
          extId: '2',
          markets: [
            mkt('handicap=-1.5', [out('FUT Esports (-1.5)', 2.1), out('Nemiga Gaming (1.5)', 1.65)]),
            mkt('handicap=1.5', [out('FUT Esports (1.5)', 1.1), out('Nemiga Gaming (-1.5)', 5.8, false)]),
          ],
        },
      ],
    },
    { name: 'total', templates: [{ extId: '3', markets: [mkt('threshold=2.5', [out('Under 2.5', 1.65), out('Over 2.5', 2.1)])] }] },
    {
      name: 'winner',
      templates: [{ extId: '1', markets: [mkt('variant=way:two|way=two', [out('Nemiga Gaming', 3.1), out('FUT Esports', 1.32)])] }],
    },
  ],
  maps: [
    {
      name: 'maps',
      templates: [
        {
          extId: '6',
          markets: [
            mkt('map=1|variant=way:three|way=three', [out('FUT Esports', 1.72), out('Draw', 6.3), out('Nemiga Gaming', 2.7)]),
            mkt('map=1|variant=way:two|way=two', [out('FUT Esports', 1.52), out('Nemiga Gaming', 2.35)]),
            mkt('map=2|variant=way:two|way=two', [], 'suspended'),
          ],
        },
      ],
    },
  ],
};

test('lê vencedor, handicaps, total e vencedor do mapa', () => {
  const markets = stakeMarkets(fixture);
  const by = (type: string, line?: number) => markets.find((m) => m.spec.type === type && m.spec.line === line);
  assert.deepEqual([by('winner')?.a, by('winner')?.b], [1.32, 3.1], 'casa/fora pelo nome, não pela ordem');
  assert.deepEqual([by('handicap', -1.5)?.a, by('handicap', -1.5)?.b], [2.1, 1.65]);
  assert.equal(by('handicap', 1.5)?.suspended, true, 'outcome inativo suspende o par');
  assert.deepEqual([by('total', 2.5)?.a, by('total', 2.5)?.b], [2.1, 1.65], 'lado A = mais de');
  assert.deepEqual([by('map', 1)?.a, by('map', 1)?.b], [1.52, 2.35], 'só o mercado de 2 vias');
  assert.deepEqual(by('map', 2), { a: null, b: null, suspended: true, spec: { type: 'map', line: 2 } });
  assert.equal(markets.length, 6);
});

test('ignora linhas inteiras e templates de outros mercados', () => {
  const fx: StakeFixture = {
    ...fixture,
    main: [
      { name: 'handicap', templates: [{ extId: '2', markets: [mkt('handicap=-1', [out('FUT Esports (-1)', 1.5), out('Nemiga Gaming (1)', 2.5)])] }] },
      { name: 'total', templates: [{ extId: '124', markets: [mkt('map=1|threshold=26.5', [out('Under 26.5', 1.8), out('Over 26.5', 1.9)])] }] },
    ],
    maps: [],
  };
  assert.equal(stakeMarkets(fx).length, 0);
});

test('query tem um alias por esporte com ao vivo e pré-jogo', () => {
  const q = buildStakeQuery(['counter-strike', 'dota-2']);
  assert.match(q, /s0: slugSport\(sport: "counter-strike"\)/);
  assert.match(q, /s1: slugSport\(sport: "dota-2"\)/);
  assert.equal(q.match(/fixtureList\(type: live/g)?.length, 2);
  assert.equal(q.match(/fixtureList\(type: upcoming/g)?.length, 2);
});

test('query só ao vivo omite o pré-jogo', () => {
  const q = buildStakeQuery(['counter-strike', 'dota-2'], false);
  assert.equal(q.match(/fixtureList\(type: live/g)?.length, 2);
  assert.doesNotMatch(q, /upcoming/);
});
