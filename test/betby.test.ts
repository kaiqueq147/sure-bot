import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OddsStore } from '../src/core/OddsStore.js';
import { BetbySource, mergeEvent, winnerOdds, type BetbyEvent } from '../src/sources/betby.js';

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
      book: 'duel', apiBase: base, brandId: 'b', siteUrl: 'https://duel.com', userAgent: 'test-agent', lang: 'en',
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
