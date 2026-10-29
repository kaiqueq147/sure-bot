import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { HealthMonitor } from './core/Health.js';
import { OddsHistory } from './core/OddsHistory.js';
import { Persistence, type BlockedPair } from './core/Persistence.js';
import { hotEvents } from './core/hotEvents.js';
import { OddsStore } from './core/OddsStore.js';
import { createLogger } from './core/logger.js';
import { ArbitrageEngine } from './engine/ArbitrageEngine.js';
import { PolymarketSelfArb } from './engine/PolymarketSelfArb.js';
import { ThreeWayEngine } from './engine/ThreeWayEngine.js';
import { ValueScanner } from './engine/ValueScanner.js';
import { pairKey, setPairBlocklist } from './matching/matcher.js';
import { startServer } from './server.js';
import { BetbySource } from './sources/betby.js';
import { CloudbetSource } from './sources/cloudbet.js';
import { PolymarketSource } from './sources/polymarket.js';
import { SimulatorSource } from './sources/simulator.js';
import { StakeSource } from './sources/stake.js';
import { ThunderpickSource } from './sources/thunderpick.js';
import type { BookId, Opportunity, Source, ValueBet } from './types.js';

const log = createLogger('main');
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const store = new OddsStore();
store.setTtl('thunderpick', config.thunderpick.staleMs);
store.setTtl('cloudbet', config.cloudbet.staleMs);
store.setTtl('stake', config.stake.staleMs);

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
  if (config.cloudbet.enabled) {
    sources.push(new CloudbetSource(store, config.cloudbet));
    books.push('cloudbet');
  }
  if (config.stake.enabled) {
    sources.push(new StakeSource(store, config.stake));
    books.push('stake');
  }
}

const commissionPct: Record<BookId, number> = {
  polymarket: config.polymarket.commissionPct,
  thunderpick: config.thunderpick.commissionPct,
  duel: config.duel.commissionPct,
  cloudbet: config.cloudbet.commissionPct,
  stake: config.stake.commissionPct,
};

// Um motor por par de casas: cada oportunidade combina as duas pernas mais favoráveis entre elas.
const engines: ArbitrageEngine[] = [];
for (let i = 0; i < books.length; i++) {
  for (let j = i + 1; j < books.length; j++) {
    engines.push(
      new ArbitrageEngine(
        store,
        { ...config.engine, commissionPct },
        books[i],
        books[j],
      ),
    );
  }
}

// SIM + NÃO do mesmo mercado da Polymarket custando menos de $1 (não precisa de outra casa).
const selfArb = books.includes('polymarket')
  ? new PolymarketSelfArb(store, { minProfitPct: config.engine.minProfitPct, commissionPct, confirmMs: config.engine.confirmMs })
  : null;
// 1X2 do futebol: melhor casa/empate/fora entre todas as casas pareadas (3 pernas).
const threeWay = new ThreeWayEngine(store, () => engines.flatMap((e) => e.matchedPairs()), {
  minProfitPct: config.engine.minProfitPct,
  maxProfitPct: config.engine.maxProfitPct,
  confirmMs: config.engine.confirmMs,
  frozenMs: config.engine.frozenMs,
  commissionPct,
});
/** Tudo que produz oportunidades de arbitragem (mesmos eventos `opportunity`/`closed`). */
const arbSources: Array<ArbitrageEngine | PolymarketSelfArb | ThreeWayEngine> = [...engines, threeWay];
if (selfArb) arbSources.push(selfArb);

const valueScanner = new ValueScanner(store, () => engines.flatMap((e) => e.matchedPairs()), {
  ...config.ev,
  commissionPct,
});

const history = new OddsHistory(store);
const db = config.db.enabled ? await Persistence.open(config.db) : null;

/**
 * Pares marcados como "par errado" no painel: o matcher deixa de parear esses dois eventos.
 * Sem banco, a lista vale só até reiniciar.
 */
const blocked = new Map<string, BlockedPair>((db?.blockedPairs() ?? []).map((p) => [pairKey(p.a, p.b), p]));
setPairBlocklist((a, b) => blocked.has(pairKey(a, b)));
/** Os motores só repareiam quando o conjunto de mercados muda: força um rematch. */
const rematchAll = () => store.emit('keys');

/** `eventKey` de uma chave de quote (vencedor = o próprio evento; demais = `<evento>:<mercado>`). */
const eventKeyOf = (key: string) => store.get(key)?.eventKey ?? key.split(':').slice(0, 2).join(':');

/** Completa cada perna com a hora real do último preço visto/alterado (o motor só copia na emissão). */
/**
 * Os dois eventos pareados ("par errado" bloqueia exatamente esse par). No 1X2 de 3 pernas duas
 * podem estar na mesma casa; com 3 eventos distintos não há um par único e o botão some.
 */
const pairEventsOf = (opp: Opportunity): [string, string] | undefined => {
  const events = [...new Set(opp.legs.map((l) => eventKeyOf(l.key)))];
  return events.length === 2 ? [events[0], events[1]] : undefined;
};

const withAges = (opp: Opportunity): Opportunity => ({
  ...opp,
  pairEvents: pairEventsOf(opp),
  legs: opp.legs.map((l) => {
    const q = store.get(l.key);
    return q ? { ...l, updatedAt: Math.max(l.updatedAt, q.updatedAt), changedAt: q.changedAt ?? q.updatedAt } : l;
  }) as Opportunity['legs'],
});

/** Cada linha de EV ganha o evento da casa e o score do pareamento direto com a melhor odd. */
const withPairing = (bets: ValueBet[]): ValueBet[] => {
  const scores = new Map<string, number>();
  for (const p of engines.flatMap((e) => e.matchedPairs())) scores.set(pairKey(p.leftKey, p.rightKey), p.score);
  return bets.map((bet) => {
    const best = bet.books[0];
    return {
      ...bet,
      books: bet.books.map((b) => ({
        ...b,
        eventKey: eventKeyOf(b.key),
        matchScore: b === best ? undefined : scores.get(pairKey(best.key, b.key)),
      })),
    };
  });
};
const evList = () => withPairing(valueScanner.list());

/** Eventos com oportunidade aberta: as fontes consultam esses mais rápido. */
const refreshHotEvents = () => {
  const keys = new Set<string>();
  for (const a of arbSources) for (const o of a.list()) for (const l of o.legs) keys.add(eventKeyOf(l.key));
  hotEvents.set(keys);
};

const opportunities = (): Opportunity[] =>
  arbSources
    .flatMap((e) => e.list())
    .sort((a, b) => b.profitPct - a.profitPct)
    .map(withAges);
/**
 * Idade das odds: chave do quote → [visto em, preço mudou em]. Com `keys` (as chaves que o
 * painel tem na tela) só essas; sem, todas as pernas abertas e linhas de EV. Com os esportes
 * tradicionais são milhares de chaves: mandar tudo a cada 2s pesaria megabytes por minuto.
 */
const legAges = (keys?: Iterable<string>): Record<string, [number, number]> => {
  const out: Record<string, [number, number]> = {};
  const add = (key: string) => {
    const q = store.get(key);
    if (q) out[key] = [q.updatedAt, q.changedAt ?? q.updatedAt];
  };
  if (keys) {
    for (const k of keys) add(k);
    return out;
  }
  for (const e of arbSources) for (const o of e.list()) for (const l of o.legs) add(l.key);
  for (const bet of valueScanner.list()) for (const b of bet.books) add(b.key);
  return out;
};
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
    ev: evList(),
    sources: sourceStatus(),
    health: health.list(),
    pairs: pairCount(),
    persistence: !!db,
    blocked: [...blocked.values()],
    taken: db?.takenIds() ?? [],
  }),
  api: {
    opportunities,
    ev: evList,
    pairs: () => engines.flatMap((e) => e.listPairs()),
    quotes: () => store.all(),
    sources: sourceStatus,
    history: (params) => history.get((params.get('keys') ?? '').split(',').filter(Boolean).slice(0, 100)),
    health: () => health.list(),
    taken: () => db?.takenIds() ?? [],
    blocked: () => [...blocked.values()].sort((x, y) => y.blockedAt - x.blockedAt),
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
    block: (body) => {
      const { a, b, label } = (body ?? {}) as { a?: unknown; b?: unknown; label?: unknown };
      if (typeof a !== 'string' || typeof b !== 'string' || !a || !b || a === b) return { error: 'informe os dois eventos (a, b)' };
      const [x, y] = a < b ? [a, b] : [b, a];
      const entry: BlockedPair = { a: x, b: y, label: typeof label === 'string' ? label.slice(0, 300) : `${x} × ${y}`, blockedAt: Date.now() };
      blocked.set(pairKey(x, y), entry);
      db?.blockPair(entry);
      log.info(`par bloqueado: ${entry.label}`);
      rematchAll();
      server.broadcast({ type: 'blocked', items: [...blocked.values()] });
      return { ok: true, persisted: !!db };
    },
    unblock: (body) => {
      const { a, b } = (body ?? {}) as { a?: unknown; b?: unknown };
      if (typeof a !== 'string' || typeof b !== 'string') return { error: 'informe os dois eventos (a, b)' };
      const key = pairKey(a, b);
      if (!blocked.delete(key)) return { ok: true, removed: false };
      const [x, y] = a < b ? [a, b] : [b, a];
      db?.unblockPair(x, y);
      rematchAll();
      server.broadcast({ type: 'blocked', items: [...blocked.values()] });
      return { ok: true, removed: true };
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
for (const engine of arbSources) {
  engine.on('opportunity', (opp: Opportunity) => {
    server.broadcast({ type: 'opportunity', opportunity: withAges(opp) });
    refreshHotEvents();
    if (opp.status !== 'confirmed') return;
    db?.recordDetected({
      id: opp.id,
      firstSeen: opp.firstSeen,
      game: opp.game,
      books: opp.legs.map((l) => l.book).sort().join('×'),
      market: opp.marketLabel.replace(/ [+-]?\d+(\.\d+)?$/, ''),
      profitPct: opp.profitPct,
    });
    const now = Date.now();
    const last = logged.get(opp.id);
    if (last && opp.profitPct < last.maxProfit + LOG_STEP_PCT && now - last.at < LOG_REPEAT_MS) return;
    logged.set(opp.id, { maxProfit: Math.max(opp.profitPct, last?.maxProfit ?? -Infinity), at: now });
    const market = opp.market.type === 'winner' && opp.legs.length === 2 ? '' : ` [${opp.marketLabel}]`;
    const legs = opp.legs.map((l) => `${l.book}: ${l.selection} @ ${l.odds.toFixed(3)}`).join(' | ');
    log.info(`ARB +${opp.profitPct.toFixed(2)}% ${opp.eventName}${market} | ${legs}`);
  });
  engine.on('closed', (id: string, reason: string) => {
    server.broadcast({ type: 'closed', id, reason });
    refreshHotEvents();
    db?.closeDetected(id, reason);
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

/**
 * A lista de EV inteira (~130 KB) mudava quase a cada segundo. Agora só seguem as apostas
 * alteradas e os ids que sumiram; quem conecta recebe a lista completa no snapshot.
 * `updatedAt` e o tempo de odd parada crescem a cada varredura e não contam como alteração
 * (o painel conta os segundos parados sozinho).
 */
const evSent = new Map<string, string>();
const evSignature = (bet: ValueBet) =>
  JSON.stringify(bet, (k, v) => {
    if (k === 'updatedAt') return undefined;
    if (k === 'frozenMs') return v === undefined ? undefined : true;
    if (k === 'warnings') return (v as string[]).map((w) => w.replace(/há \d+s/, 'há'));
    return v;
  });
valueScanner.on('changed', (raw: ValueBet[]) => {
  const items = withPairing(raw);
  const upsert: ValueBet[] = [];
  const ids = new Set<string>();
  for (const bet of items) {
    ids.add(bet.id);
    const sig = evSignature(bet);
    if (evSent.get(bet.id) === sig) continue;
    evSent.set(bet.id, sig);
    upsert.push(bet);
  }
  const remove = [...evSent.keys()].filter((id) => !ids.has(id));
  for (const id of remove) evSent.delete(id);
  if (upsert.length || remove.length) server.broadcast({ type: 'ev-delta', upsert, remove });
});
valueScanner.start();

setInterval(() => {
  const base = { type: 'sources', sources: sourceStatus(), health: health.list(), pairs: pairCount() };
  let all: Record<string, [number, number]> | undefined;
  server.broadcastEach((client) => ({ ...base, ages: client.watch ? legAges(client.watch) : (all ??= legAges()) }));
}, 2_000);

for (const s of sources) {
  Promise.resolve(s.start()).catch((err) => log.error(`falha ao iniciar ${s.name}`, err));
}

const shutdown = async () => {
  log.info('encerrando...');
  arbSources.forEach((e) => e.stop());
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
