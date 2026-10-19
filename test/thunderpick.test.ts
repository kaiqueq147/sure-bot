import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pickMatchWinner } from '../src/sources/polymarket.js';
import { extractThunderpick, parseWsFrame } from '../src/sources/thunderpickExtract.js';

test('extrai partida com teams.home/away e market.home/away', () => {
  const payload = {
    data: {
      matches: [
        {
          id: 123,
          slug: 'navi-vs-faze',
          startTime: '2026-10-09T18:00:00Z',
          game: { name: 'Counter-Strike 2' },
          tournament: { name: 'IEM Cologne' },
          teams: { home: { name: 'NAVI' }, away: { name: 'FaZe' } },
          market: { home: { odds: 1.85 }, away: { odds: 2.05 }, isLocked: false },
        },
      ],
    },
  };
  const { matches } = extractThunderpick(payload);
  assert.equal(matches.length, 1);
  const [m] = matches;
  assert.equal(m.id, '123');
  assert.equal(m.teamA, 'NAVI');
  assert.equal(m.oddsA, 1.85);
  assert.equal(m.oddsB, 2.05);
  assert.equal(m.game, 'cs2');
  assert.equal(m.league, 'IEM Cologne');
  assert.equal(m.suspended, false);
});

test('extrai formato com competitors[] + markets[].selections[] e ignora 3 vias', () => {
  const payload = [
    {
      eventId: 'e1',
      competitors: [{ name: 'T1' }, { name: 'Gen.G' }],
      markets: [
        { name: 'Map 1 Winner', selections: [{ name: 'T1', price: 1.5 }, { name: 'Gen.G', price: 2.5 }] },
        { name: 'Match Winner', selections: [{ name: 'Gen.G', price: '2.10' }, { name: 'T1', price: '1.72' }] },
      ],
    },
    {
      id: 'soccer',
      homeTeam: 'A',
      awayTeam: 'B',
      market: { home: 2.5, draw: 3.1, away: 2.9 },
    },
  ];
  const { matches } = extractThunderpick(payload, { defaultGame: 'lol' });
  assert.equal(matches.length, 1);
  assert.equal(matches[0].teamA, 'T1');
  assert.equal(matches[0].oddsA, 1.72, 'seleções reordenadas pelo nome do time');
  assert.equal(matches[0].oddsB, 2.1);
  assert.equal(matches[0].game, 'lol');
});

test('mercado travado vira suspended e deltas sem times viram patch', () => {
  const { matches, patches } = extractThunderpick({
    updates: [
      { id: 7, teams: ['Spirit', 'Liquid'], market: { home: { odds: 1.4 }, away: { odds: 3.0 }, status: 'SUSPENDED' } },
      { id: 8, market: { home: { odds: 1.9 }, away: { odds: 1.9 } } },
    ],
  });
  assert.equal(matches[0].suspended, true);
  assert.deepEqual(patches, [{ id: '8', marketId: undefined, oddsA: 1.9, oddsB: 1.9, suspended: false }]);
});

test('formato real de /api/matches: gameId, competition e 1X2 ignorado', () => {
  const payload = {
    statusCode: 200,
    ok: true,
    data: {
      upcoming: [
        {
          id: 2786925,
          gameId: 6,
          startTime: '2026-10-09T15:00:00+00:00',
          name: 'Vitality vs PARIVISION',
          teams: { home: { id: 1, name: 'Vitality', shortName: 'VIT' }, away: { id: 2, name: 'PARIVISION', shortName: 'PARI' } },
          competition: { id: 10968, name: 'ESL Pro League Season 24' },
          market: {
            id: 208620549, name: 'Match Winner', type: 0, status: 1,
            home: { id: 1, name: 'Vitality', odds: 1.05, status: 1 },
            draw: null,
            away: { id: 2, name: 'PARIVISION', odds: 9.5, status: 1 },
          },
          preferredMarkets: [],
        },
        {
          id: 2795108,
          gameId: 37,
          teams: { home: { name: 'Boston Celtics' }, away: { name: 'Los Angeles Lakers' } },
          market: { id: 1, name: '1X2', status: 1, home: { odds: 1.48 }, draw: { odds: 9.8 }, away: { odds: 2.81 } },
          preferredMarkets: [
            { name: 'Match Winner inc. overtime', eventId: 2795108, id: 2, status: 1, selections: [{ type: 'home', odds: 1.41, status: 1 }, { type: 'away', odds: 2.69, status: 1 }] },
          ],
        },
      ],
      live: [],
    },
  };
  const { matches } = extractThunderpick(payload);
  assert.equal(matches.length, 1);
  const [m] = matches;
  assert.equal(m.id, '2786925');
  assert.equal(m.marketId, '208620549');
  assert.equal(m.game, 'cs2');
  assert.equal(m.league, 'ESL Pro League Season 24');
  assert.equal(m.competitionId, '10968');
  assert.equal(m.oddsA, 1.05);
  assert.equal(m.oddsB, 9.5);
  assert.equal(m.suspended, false);
});

test('frames SignalR: delta de mercado vira patch por eventId e marketsHidden suspende', () => {
  const frame =
    JSON.stringify({
      type: 1,
      target: 'PublicEvent',
      arguments: [{ data: { list: [{
        eventId: 2786925, id: 208620549, name: 'Match Winner', status: 1,
        selections: [{ name: 'PARIVISION', type: 'away', odds: 8.0, status: 1 }, { name: 'Vitality', type: 'home', odds: 1.07, status: 1 }],
      }, {
        eventId: 2786925, id: 999, name: 'Map 1 Winner', status: 1,
        selections: [{ type: 'home', odds: 1.2, status: 1 }, { type: 'away', odds: 4, status: 1 }],
      }] } }],
    }) +
    '\x1e' +
    JSON.stringify({ type: 1, target: 'FilteredEvent', arguments: [{ data: { list: [{ id: 208620549, eventId: 2786925 }] }, type: 'marketsHidden' }] }) +
    '\x1e';

  const results = parseWsFrame(frame).map((j) => extractThunderpick(j));
  assert.deepEqual(results[0].patches, [{ id: '2786925', marketId: '208620549', oddsA: 1.07, oddsB: 8, suspended: false }]);
  assert.deepEqual(results[1].hidden, [{ id: '2786925', marketId: '208620549' }]);
});

test('decodifica frames socket.io e SignalR', () => {
  assert.deepEqual(parseWsFrame('42["odds",{"id":1}]'), [['odds', { id: 1 }]]);
  assert.deepEqual(parseWsFrame('{"a":1}\x1e{"b":2}\x1e'), [{ a: 1 }, { b: 2 }]);
  assert.deepEqual(parseWsFrame('3'), []);
});

test('Polymarket: escolhe o mercado de vencedor da partida', () => {
  const m = pickMatchWinner({
    id: 1,
    slug: 'cs2-navi-faze',
    title: 'Counter-Strike: NAVI vs FaZe (BO3)',
    markets: [
      { id: 'map1', question: 'NAVI vs FaZe - Map 1 Winner', outcomes: '["NAVI","FaZe"]', clobTokenIds: '["1","2"]' },
      { id: 'ou', question: 'Total maps O/U 2.5', outcomes: '["Over","Under"]', clobTokenIds: '["3","4"]' },
      { id: 'yes', question: 'Will NAVI win?', outcomes: '["Yes","No"]', clobTokenIds: '["5","6"]' },
      { id: 'ml', question: 'Counter-Strike: NAVI vs FaZe (BO3)', outcomes: '["NAVI","FaZe"]', clobTokenIds: '["7","8"]' },
    ],
  });
  assert.equal(m?.id, 'ml');
});
