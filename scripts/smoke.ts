/**
 * Teste de fumaça das casas reais: liga cada fonte com a config do .env por alguns
 * segundos e mostra estado, odds recebidas e latência. Sai com código 1 se alguma falhar.
 *
 *   npm run smoke                 # todas menos Thunderpick (abre navegador)
 *   npm run smoke -- --all        # inclui Thunderpick
 *   npm run smoke -- stake duel   # só as casas citadas
 *   SMOKE_SECONDS=20 npm run smoke
 */
import { config } from '../src/config.js';
import { OddsStore } from '../src/core/OddsStore.js';
import { BetbySource } from '../src/sources/betby.js';
import { CloudbetSource } from '../src/sources/cloudbet.js';
import { PolymarketSource } from '../src/sources/polymarket.js';
import { StakeSource } from '../src/sources/stake.js';
import { ThunderpickSource } from '../src/sources/thunderpick.js';
import type { BookId, Source } from '../src/types.js';

const args = process.argv.slice(2);
const seconds = Number(process.env.SMOKE_SECONDS) || 12;
const picked = args.filter((a) => !a.startsWith('--'));
const want = (book: BookId, byDefault = true) =>
  picked.length ? picked.includes(book) : byDefault || args.includes('--all');

const store = new OddsStore();
const factories: Array<[BookId, () => Source]> = [
  ['polymarket', () => new PolymarketSource(store, config.polymarket)],
  ['thunderpick', () => new ThunderpickSource(store, config.thunderpick)],
  ['duel', () => new BetbySource(store, config.duel)],
  ['cloudbet', () => new CloudbetSource(store, config.cloudbet)],
  ['stake', () => new StakeSource(store, config.stake)],
];
const sources = factories
  .filter(([book]) => want(book, book !== 'thunderpick'))
  .map(([, make]) => make());

const updates = new Map<string, number>();
store.on('update', (q) => updates.set(q.book, (updates.get(q.book) ?? 0) + 1));

console.log(`testando ${sources.map((s) => s.name).join(', ')} por ${seconds}s…`);
await Promise.all(sources.map((s) => s.start()));
await new Promise((r) => setTimeout(r, seconds * 1000));

let failed = 0;
const rows = sources.map((s) => {
  const st = s.status();
  const ok = st.state === 'connected' && st.quotes > 0;
  if (!ok) failed++;
  return {
    casa: st.book,
    ok: ok ? 'OK' : 'FALHOU',
    estado: st.state,
    odds: st.quotes,
    'updates/s': ((updates.get(st.book) ?? 0) / seconds).toFixed(1),
    'latência': st.latencyMs === undefined ? '—' : `${Math.round(st.latencyMs)}ms`,
    detalhe: st.detail ?? '',
  };
});
console.table(rows);
await Promise.allSettled(sources.map((s) => s.stop()));
process.exit(failed ? 1 : 0);
