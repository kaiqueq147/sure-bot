import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OddsStore } from '../src/core/OddsStore.js';
import { BetbySource, mergeEvent, sportMarkets, winnerOdds, type BetbyEvent } from '../src/sources/betby.js';

const event = (k4: string, k5: string, extra: Partial<BetbyEvent> = {}): BetbyEvent => ({
  desc: {
    scheduled: 1791551700,
    type: 'match',
    slug: 'dewa-united-natus-vincere',
    sport: '109',
    category: 'c1',
    tournament: 't1',
    competitors: [
      { id: '1', name: 'Dewa United' },
      { id: '2', name: 'Natus Vincere' },
    ],
  },
  markets: { '186': { '': { '4': { k: k4 }, '5': { k: k5 } } }, '330': { 'mapnr=1': { '4': { k: '1.5' }, '5': { k: '2.4' } } } },
  state: { status: 0 },
  ...extra,
});

test('lê o mercado Winner (186) e marca bloqueio', () => {
  assert.deepEqual(winnerOdds(event('2.88', '1.33')), { a: 2.88, b: 1.33, suspended: false });
  const blocked = event('14.0', '0.0');
  assert.deepEqual(winnerOdds(blocked), { a: 14, b: null, suspended: true });
  const flagged = event('2.0', '1.8');
  flagged.markets!['186']['']['5'].b = 1;
  assert.equal(winnerOdds(flagged)?.suspended, true);
  assert.equal(winnerOdds({ ...event('2', '2'), markets: {} }), null);
});

test('delta sem desc preserva desc e substitui só os mercados enviados', () => {
  const merged = mergeEvent(event('2.88', '1.33'), { markets: { '186': { '': { '4': { k: '3.1' }, '5': { k: '1.3' } } } } });
  assert.equal(merged.desc?.slug, 'dewa-united-natus-vincere');
  assert.deepEqual(winnerOdds(merged), { a: 3.1, b: 1.3, suspended: false });
  assert.ok(merged.markets?.['330'], 'mercado não enviado no delta continua');
});

test('fonte aplica snapshot e delta, gera link e trata evento nulo', async () => {
  const store = new OddsStore();
  const base = 'https://api.test/api/v4';
  const responses = new Map<string, unknown>();
  const manifest = (version: number) => ({ version, top_events_versions: [version], rest_events_versions: [] });
  responses.set(`${base}/live/brand/b/en/0`, manifest(100));
  responses.set(`${base}/prematch/brand/b/en/0`, manifest(200));
  responses.set(`${base}/live/brand/b/en/100`, { version: 100, events: {} });
  responses.set(`${base}/prematch/brand/b/en/200`, {
    version: 200,
    sports: { '109': { name: 'Counter-Strike', slug: 'counter-strike' } },
    categories: { c1: { name: 'International', slug: 'international' } },
    tournaments: { t1: { name: 'United21', slug: 'united21' } },
    events: { e1: event('2.88', '1.33'), virtual: event('1.5', '2.5', { desc: { ...event('1', '1').desc!, virtual: true } }) },
  });

  const winner = (a: string, b: string) => ({ events: { e1: { markets: { '186': { '': { '4': { k: a }, '5': { k: b } } } } } } });
  let prematchDelta: unknown = winner('3.0', '1.36');
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL) => {
    const url = String(input);
    if (responses.has(url)) return new Response(JSON.stringify(responses.get(url)));
    // delta: version + Date.now()
    const body = url.includes('/prematch/') ? prematchDelta : { events: {} };
    return new Response(JSON.stringify(body));
  }) as typeof fetch;

  try {
    const src = new BetbySource(store, {
      book: 'duel', apiBase: base, brandId: 'b', siteUrl: 'https://duel.com', lang: 'en',
      liveIntervalMs: 20, prematchIntervalMs: 20,
    });
    src.start();
    await new Promise((r) => setTimeout(r, 15));
    const q = store.get('duel:e1');
    assert.ok(q, 'evento de eSports publicado');
    assert.equal(q.oddsA, 3.0);
    assert.equal(q.game, 'cs2');
    assert.equal(q.url, 'https://duel.com/sports?bt-path=/counter-strike/international/united21/dewa-united-natus-vincere-e1');
    assert.equal(store.get('duel:virtual'), undefined, 'eventos virtuais são ignorados');

    prematchDelta = { events: { e1: null } };
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(store.get('duel:e1'), undefined, 'evento nulo no delta sai do store');

    prematchDelta = winner('2.5', '1.5');
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(store.get('duel:e1')?.oddsA, 2.5, 'delta só com mercados restaura o evento');
    src.stop();
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('ciclo sem mudança renova updatedAt sem alterar changedAt', async () => {
  const store = new OddsStore();
  const base = 'https://api.test/api/v4';
  const manifest = (version: number) => ({ version, top_events_versions: [version], rest_events_versions: [] });
  const responses = new Map<string, unknown>([
    [`${base}/live/brand/b/en/0`, manifest(100)],
    [`${base}/prematch/brand/b/en/0`, manifest(200)],
    [`${base}/live/brand/b/en/100`, { version: 100, events: {} }],
    [`${base}/prematch/brand/b/en/200`, { version: 200, events: { e1: event('2.88', '1.33') } }],
  ]);
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL) => {
    const url = String(input);
    // Delta sempre vazio: as odds nunca mudam.
    return new Response(JSON.stringify(responses.get(url) ?? { events: {} }));
  }) as typeof fetch;

  try {
    const src = new BetbySource(store, {
      book: 'duel', apiBase: base, brandId: 'b', siteUrl: 'https://duel.com', lang: 'en',
      liveIntervalMs: 20, prematchIntervalMs: 20,
    });
    src.start();
    await new Promise((r) => setTimeout(r, 15));
    const first = store.get('duel:e1');
    assert.ok(first);
    const { updatedAt, changedAt } = first;
    await new Promise((r) => setTimeout(r, 80));
    src.stop();
    const later = store.get('duel:e1')!;
    assert.ok(later.updatedAt > updatedAt, 'feed confirmou as odds: dado renovado');
    assert.equal(later.changedAt, changedAt, 'preço igual: changedAt não muda');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('esportes tradicionais: 1X2 do futebol com empate e linhas x.5; basquete usa os mercados com prorrogação', () => {
  const desc = (sport: string) => ({ ...event('1', '1').desc!, sport });
  const soccer: BetbyEvent = {
    desc: desc('1'),
    markets: {
      '1': { '': { '1': { k: '2.32' }, '2': { k: '3.4' }, '3': { k: '2.68' } } },
      '16': { 'hcp=-1.5': { '1714': { k: '4.9' }, '1715': { k: '1.12' } }, 'hcp=-1': { '1714': { k: '4.0' }, '1715': { k: '1.18' } } },
      '18': { 'total=2.5': { '12': { k: '2.76' }, '13': { k: '1.37' } }, 'total=3.5': { '12': { k: '5.0' }, '13': { k: '1.12' } } },
    },
  };
  const s = sportMarkets(soccer, 'soccer');
  const w = s.find((m) => m.spec.type === 'winner' && !m.spec.period);
  assert.deepEqual([w?.a, w?.draw, w?.b], [2.32, 3.4, 2.68]);
  assert.deepEqual(s.filter((m) => m.spec.type === 'handicap').map((m) => m.spec.line), [-1.5], 'linha inteira fica de fora');
  assert.deepEqual(s.filter((m) => m.spec.type === 'total').map((m) => m.spec.line), [2.5, 3.5]);

  const nba: BetbyEvent = {
    desc: desc('2'),
    markets: {
      '219': { '': { '4': { k: '1.5' }, '5': { k: '2.6' } } },
      '16': { 'hcp=-5.5': { '1714': { k: '1.9' }, '1715': { k: '1.9' } } },
      '223': { 'hcp=-6.5': { '1714': { k: '1.95' }, '1715': { k: '1.85' } } },
    },
  };
  const b = sportMarkets(nba, 'basketball');
  assert.deepEqual(b.find((m) => m.spec.type === 'winner')?.draw, undefined, 'basquete é 2 vias');
  assert.deepEqual(b.filter((m) => m.spec.type === 'handicap').map((m) => m.spec.line), [-6.5], 'ignora o handicap de tempo regulamentar (16)');
});
