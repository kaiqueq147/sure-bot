import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildStakeQuery, buildStakeSportsQuery, stakeMarkets, stakeSportMarkets, type StakeFixture, type StakeMarket } from '../src/sources/stake.js';

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

const smkt = (id: string, specifiers: string, outcomes: Array<[string, number]>, status = 'active'): StakeMarket => ({
  id,
  status,
  specifiers,
  outcomes: outcomes.map(([name, odds]) => ({ name, odds, active: true })),
});
const sportFx = (templates: Array<{ extId: string; markets: StakeMarket[] }>): StakeFixture => ({
  id: 'f1',
  slug: 'home-away',
  status: 'active',
  data: { startTime: '2026-10-30T20:00:00Z', competitors: [{ name: 'Home FC' }, { name: 'Away FC' }] },
  main: [{ name: 'main', templates }],
});

test('futebol: 1X2 com empate, DNB, ambas marcam e linhas x.5', () => {
  const fx = sportFx([
    { extId: '1', markets: [smkt('m1', '', [['Away FC', 3.1], ['Draw', 3.4], ['Home FC', 2.2]])] },
    { extId: '11', markets: [smkt('m2', '', [['Home FC', 1.6], ['Away FC', 2.3]])] },
    { extId: '29', markets: [smkt('m3', '', [['No', 1.9], ['Yes', 1.85]])] },
    { extId: '16', markets: [smkt('m4', 'hcp=-0.5', [['Home FC (-0.5)', 2.2], ['Away FC (0.5)', 1.7]]), smkt('m5', 'hcp=-0.25', [['Home FC (-0.25)', 2], ['Away FC (0.25)', 1.8]])] },
    { extId: '18', markets: [smkt('m6', 'total=2.5', [['Over 2.5', 1.9], ['Under 2.5', 1.9]]), smkt('m7', 'total=2', [['Over 2', 1.6], ['Under 2', 2.2]])] },
  ]);
  const ms = stakeSportMarkets('soccer', fx);
  const winner = ms.find((m) => m.spec.type === 'winner')!;
  assert.deepEqual([winner.a, winner.draw, winner.b], [2.2, 3.4, 3.1], 'casa/empate/fora pelo nome, não pela ordem');
  assert.deepEqual(ms.find((m) => m.spec.type === 'btts') && [ms.find((m) => m.spec.type === 'btts')!.a, ms.find((m) => m.spec.type === 'btts')!.b], [1.85, 1.9]);
  assert.ok(ms.some((m) => m.spec.type === 'dnb' && m.a === 1.6));
  assert.deepEqual(ms.filter((m) => m.spec.type === 'handicap').map((m) => m.spec.line), [-0.5], 'linha de quarto (−0.25) fica de fora');
  assert.deepEqual(ms.filter((m) => m.spec.type === 'total').map((m) => m.spec.line), [2.5], 'linha inteira fica de fora');
});

test('basquete: período do 1º quarto só com quarternr=1; tênis: games e 1º set', () => {
  const bb = stakeSportMarkets('basketball', sportFx([
    { extId: '219', markets: [smkt('w', '', [['Home FC', 1.5], ['Away FC', 2.6]])] },
    { extId: '303', markets: [smkt('q1', 'quarternr=1|hcp=-1.5', [['Home FC (-1.5)', 1.9], ['Away FC (1.5)', 1.9]]), smkt('q2', 'quarternr=2|hcp=-1.5', [['Home FC (-1.5)', 1.9], ['Away FC (1.5)', 1.9]])] },
  ]));
  assert.deepEqual(bb.map((m) => `${m.spec.type}${m.spec.period ? '@' + m.spec.period : ''}`), ['winner', 'handicap@q1']);
  assert.equal(bb[0].draw, undefined, 'basquete não tem empate');
  const tn = stakeSportMarkets('tennis', sportFx([
    { extId: '188', markets: [smkt('s', 'hcp=-1.5', [['Home FC (-1.5)', 2], ['Away FC (1.5)', 1.8]])] },
    { extId: '204', markets: [smkt('t', 'setnr=1|total=9.5', [['Over 9.5', 1.9], ['Under 9.5', 1.9]])] },
  ]));
  assert.deepEqual(tn.map((m) => `${m.spec.type}@${m.spec.period}:${m.spec.line}`), ['total@set1:9.5'], 'handicap de sets (188) não entra');
});

test('query de esportes: alias por esporte, limite 50 e offset', () => {
  const q = buildStakeSportsQuery(['soccer', 'basketball'], 'upcoming', 50);
  assert.match(q, /t0: slugSport\(sport: "soccer"\)/);
  assert.match(q, /t1: slugSport\(sport: "basketball"\)/);
  assert.equal(q.match(/limit: 50, offset: 50/g)?.length, 2);
  assert.match(q, /groups\(groups: \["main","half"\]/);
  assert.match(q, /^query StakeSports/);
});
