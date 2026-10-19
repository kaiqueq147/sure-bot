import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { HealthMonitor } from './core/Health.js';
import { OddsHistory } from './core/OddsHistory.js';
import { Persistence } from './core/Persistence.js';
import { OddsStore } from './core/OddsStore.js';
import { createLogger } from './core/logger.js';
import { ArbitrageEngine } from './engine/ArbitrageEngine.js';
import { ValueScanner } from './engine/ValueScanner.js';
import { startServer } from './server.js';
import { BetbySource } from './sources/betby.js';
import { PolymarketSource } from './sources/polymarket.js';
import { SimulatorSource } from './sources/simulator.js';
import { ThunderpickSource } from './sources/thunderpick.js';
import type { BookId, Opportunity, Source } from './types.js';

const log = createLogger('main');
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const store = new OddsStore();
store.setTtl('thunderpick', config.thunderpick.staleMs);

const sources: Source[] = [];
const books: BookId[] = [];
if (config.simulator) {
  log.warn('modo SIMULADOR ativo: odds sintéticas, nenhuma casa real é consultada');
  sources.push(new SimulatorSource(store));
  books.push('polymarket', 'thunderpick', 'duel');
} else {
  if (config.polymarket.enabled) {
    sources.push(new PolymarketSource(store, config.polymarket));
    books.push('polymarket');
  }
  if (config.thunderpick.enabled) {
    sources.push(new ThunderpickSource(store, config.thunderpick));
    books.push('thunderpick');
  }
  if (config.duel.enabled) {
    sources.push(new BetbySource(store, config.duel));
    books.push('duel');
  }
}

// Um motor por par de casas: cada oportunidade combina as duas pernas mais favoráveis entre elas.
const engines: ArbitrageEngine[] = [];
for (let i = 0; i < books.length; i++) {
  for (let j = i + 1; j < books.length; j++) {
    engines.push(
      new ArbitrageEngine(
        store,
        {
          ...config.engine,
          commissionPct: {
            polymarket: config.polymarket.commissionPct,
            thunderpick: config.thunderpick.commissionPct,
            duel: config.duel.commissionPct,
          },
        },
        books[i],
        books[j],
      ),
    );
  }
}

const valueScanner = new ValueScanner(store, () => engines.flatMap((e) => e.matchedPairs()), {
  ...config.ev,
  commissionPct: {
    polymarket: config.polymarket.commissionPct,
    thunderpick: config.thunderpick.commissionPct,
    duel: config.duel.commissionPct,
  },
});

const history = new OddsHistory(store);
const db = config.db.enabled ? await Persistence.open(config.db) : null;

const opportunities = (): Opportunity[] => engines.flatMap((e) => e.list()).sort((a, b) => b.profitPct - a.profitPct);
const pairCount = () => engines.reduce((n, e) => n + e.pairCount, 0);
const sourceStatus = () => sources.map((s) => s.status());
const health = new HealthMonitor(store, sourceStatus);

const server = startServer({
  port: config.port,
  host: config.host,
  publicDir: path.join(rootDir, 'public'),
  snapshot: () => ({
    type: 'snapshot',
    opportunities: opportunities(),
    ev: valueScanner.list(),
    sources: sourceStatus(),
    health: health.list(),
    pairs: pairCount(),
    persistence: !!db,
    taken: db?.takenIds() ?? [],
  }),
  api: {
    opportunities,
    ev: () => valueScanner.list(),
    pairs: () => engines.flatMap((e) => e.listPairs()),
    quotes: () => store.all(),
    sources: sourceStatus,
    history: (params) => history.get((params.get('keys') ?? '').split(',').filter(Boolean).slice(0, 100)),
    health: () => health.list(),
    taken: () => db?.takenIds() ?? [],
    report: (params) => {
      if (!db) return { error: 'persistência desativada (DB_ENABLED=false ou Node sem node:sqlite)' };
      const hours = Math.min(24 * 90, Math.max(1, Number(params.get('hours')) || 24));
      return db.report(Date.now() - hours * 3_600_000);
    },
  },
  post: {
    taken: (body) => {
      if (!db) return { error: 'persistência desativada (DB_ENABLED=false ou Node sem node:sqlite)' };
      const result = db.take(body);
      if ('ok' in result && !result.already) server.broadcast({ type: 'taken', id: result.oppId });
      return result;
    },
    clear: () => {
      if (!db) return { error: 'persistência desativada (DB_ENABLED=false ou Node sem node:sqlite)' };
      const result = db.clear();
      server.broadcast({ type: 'taken-cleared' });
      return result;
    },
  },
});

/**
 * Histerese do log: uma oportunidade que oscila (some e volta, lucro sobe e desce) só é
 * registrada na primeira aparição, quando supera o máximo já registrado ou depois de um tempo.
 */
const LOG_STEP_PCT = 0.5;
const LOG_REPEAT_MS = 60_000;
const LOG_FORGET_MS = 10 * 60_000;
const logged = new Map<string, { maxProfit: number; at: number }>();
for (const engine of engines) {
  engine.on('opportunity', (opp: Opportunity) => {
    server.broadcast({ type: 'opportunity', opportunity: opp });
    if (opp.status !== 'confirmed') return;
    const now = Date.now();
    const last = logged.get(opp.id);
    if (last && opp.profitPct < last.maxProfit + LOG_STEP_PCT && now - last.at < LOG_REPEAT_MS) return;
    logged.set(opp.id, { maxProfit: Math.max(opp.profitPct, last?.maxProfit ?? -Infinity), at: now });
    const [a, b] = opp.legs;
    const market = opp.market.type === 'winner' ? '' : ` [${opp.marketLabel}]`;
    log.info(
      `ARB +${opp.profitPct.toFixed(2)}% ${opp.eventName}${market} | ${a.book}: ${a.selection} @ ${a.odds.toFixed(3)} | ${b.book}: ${b.selection} @ ${b.odds.toFixed(3)}`,
    );
  });
  engine.on('closed', (id, reason) => {
    server.broadcast({ type: 'closed', id, reason });
  });
  engine.start();
}
setInterval(() => {
  const min = Date.now() - LOG_FORGET_MS;
  for (const [id, l] of logged) if (l.at < min) logged.delete(id);
}, 60_000);

history.start();
db?.start();
health.start();

valueScanner.on('changed', (items) => {
  server.broadcast({ type: 'ev', items });
});
valueScanner.start();

setInterval(() => server.broadcast({ type: 'sources', sources: sourceStatus(), health: health.list(), pairs: pairCount() }), 2_000);

for (const s of sources) {
  Promise.resolve(s.start()).catch((err) => log.error(`falha ao iniciar ${s.name}`, err));
}

const shutdown = async () => {
  log.info('encerrando...');
  engines.forEach((e) => e.stop());
  valueScanner.stop();
  history.stop();
  health.stop();
  db?.close();
  await Promise.allSettled(sources.map((s) => s.stop()));
  await server.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
