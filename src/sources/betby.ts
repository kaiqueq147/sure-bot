import type { OddsStore } from '../core/OddsStore.js';
import { backoffDelay, createLogger, sleep } from '../core/logger.js';
import { detectGame } from '../matching/normalize.js';
import { Ewma } from '../core/Health.js';
import { derivedQuoteFields, isHalfLine, isMapNumber, WINNER } from '../core/markets.js';
import { NetStats } from './netStats.js';
import type { BookId, Game, MarketSpec, Quote, Source, SourceStatus } from '../types.js';

/**
 * Casas que usam o sportsbook white-label da Betby (ex: Duel.com).
 *
 * O widget consome um feed JSON público e versionado:
 *  - `GET {api}/{live|prematch}/brand/{brand}/{lang}/0` -> manifesto com `version` e os blocos do snapshot
 *  - `GET .../{versãoDoBloco}` -> bloco do snapshot (sports, categories, tournaments, events)
 *  - `GET .../{version + Date.now()}` -> delta com os eventos alterados desde o último tick
 * O snapshot é regenerado a cada ~30s (live) / ~60s (pré-jogo); entre eles o widget busca
 * deltas a cada ~2s (aqui 1s, com manifesto e delta em paralelo). O WebSocket `ws_new` da Betby não envia odds para visitantes anônimos,
 * então este é o canal mais rápido disponível — o mesmo que o site usa.
 *
 * Mercados seguem os IDs do Sportradar: 186 = "Winner" (2 vias), outcomes 4 = casa, 5 = fora.
 */

interface BetbyOutcome {
  k: string;
  b?: number;
}

type BetbyMarkets = Record<string, Record<string, Record<string, BetbyOutcome>>>;

export interface BetbyEvent {
  desc?: {
    scheduled: number;
    type: string;
    virtual?: boolean;
    slug: string;
    sport: string;
    category: string;
    tournament: string;
    competitors: Array<{ id: string; name: string }>;
  };
  markets?: BetbyMarkets;
  state?: { status: number; match_status?: number };
}

interface Named {
  name: string;
  slug: string;
  sport_id?: string;
  category_id?: string;
}

interface Chunk {
  version: number;
  sports?: Record<string, Named>;
  categories?: Record<string, Named>;
  tournaments?: Record<string, Named>;
  events?: Record<string, BetbyEvent | null>;
}

interface Manifest {
  version: number;
  top_events_versions: number[];
  rest_events_versions: number[];
}

interface Feed {
  name: 'live' | 'prematch';
  intervalMs: number;
  version?: number;
  events: Map<string, BetbyEvent>;
}

export interface BetbyOptions {
  book: BookId;
  apiBase: string;
  brandId: string;
  siteUrl: string;
  lang: string;
  liveIntervalMs: number;
  prematchIntervalMs: number;
}

/** sport_id da Betby -> modalidade */
export const BETBY_SPORT_IDS: Record<string, Game> = {
  '109': 'cs2',
  '110': 'lol',
  '111': 'dota2',
  '121': 'overwatch',
  '125': 'r6',
  '134': 'hok',
  '194': 'valorant',
  '201': 'mlbb',
};

/** Cadência do feed ao vivo quando ele não tem nenhum evento. */
const IDLE_LIVE_INTERVAL_MS = 5_000;
const WINNER_MARKET = '186';
/** Handicap de mapas: specifier `hcp=<linha da casa>`, outcomes 1714 = casa, 1715 = fora */
const MAP_HANDICAP_MARKET = '327';
/** Total de mapas: specifier `total=<linha>`, outcomes 12 = mais, 13 = menos */
const TOTAL_MAPS_MARKET = '328';
/** Vencedor do mapa: specifier `mapnr=<n>`, outcomes 4 = casa, 5 = fora */
const MAP_WINNER_MARKET = '330';
/** Handicap de rounds do mapa (CS2/Valorant): `mapnr=<n>|hcp=<linha da casa>`, outcomes 1714/1715 */
const MAP_ROUNDS_HANDICAP_MARKET = '331';
/** Total de rounds do mapa (CS2/Valorant): `mapnr=<n>|total=<linha>`, outcomes 12 = mais, 13 = menos */
const MAP_ROUNDS_TOTAL_MARKET = '332';
/** Handicap de kills do mapa (LoL/Dota): `mapnr=<n>|hcp=<linha da casa>`, outcomes 1714/1715 */
const MAP_KILLS_HANDICAP_MARKET = '555';

type TwoWayOdds = { a: number | null; b: number | null; suspended: boolean };

/** Outcome bloqueado (`b: 1`) ou odd <= 1 = suspenso. */
function pairOdds(x?: BetbyOutcome, y?: BetbyOutcome): TwoWayOdds | null {
  if (!x || !y) return null;
  const parse = (o: BetbyOutcome) => {
    const k = Number(o.k);
    return Number.isFinite(k) && k > 1 ? k : null;
  };
  const a = parse(x);
  const b = parse(y);
  return { a, b, suspended: x.b === 1 || y.b === 1 || a === null || b === null };
}

/** Odds do mercado "Winner" (186). */
export function winnerOdds(ev: BetbyEvent): TwoWayOdds | null {
  const variants = ev.markets?.[WINNER_MARKET];
  const m = variants?.[''] ?? (variants ? Object.values(variants)[0] : undefined);
  return m ? pairOdds(m['4'], m['5']) : null;
}

/** Handicaps e totais de mapas da série com linha x.5 e vencedor de cada mapa. */
export function lineMarkets(ev: BetbyEvent): Array<TwoWayOdds & { spec: MarketSpec }> {
  const out: Array<TwoWayOdds & { spec: MarketSpec }> = [];
  const read = (
    marketId: string,
    param: string,
    type: MarketSpec['type'],
    outA: string,
    outB: string,
    valid: (line: number) => boolean,
  ) => {
    for (const [specifier, outcomes] of Object.entries(ev.markets?.[marketId] ?? {})) {
      const line = Number(new RegExp(`(?:^|\\|)${param}=(-?[\\d.]+)`).exec(specifier)?.[1]);
      if (!valid(line)) continue;
      const odds = pairOdds(outcomes[outA], outcomes[outB]);
      if (odds) out.push({ ...odds, spec: { type, line } });
    }
  };
  read(MAP_HANDICAP_MARKET, 'hcp', 'handicap', '1714', '1715', isHalfLine);
  read(TOTAL_MAPS_MARKET, 'total', 'total', '12', '13', isHalfLine);
  read(MAP_WINNER_MARKET, 'mapnr', 'map', '4', '5', isMapNumber);

  // Mercados de um mapa: specifier `mapnr=<n>|hcp=<linha da casa>` ou `mapnr=<n>|total=<linha>`.
  const readMap = (marketId: string, param: string, type: MarketSpec['type'], outA: string, outB: string) => {
    for (const [specifier, outcomes] of Object.entries(ev.markets?.[marketId] ?? {})) {
      const map = Number(/(?:^|\|)mapnr=(\d+)/.exec(specifier)?.[1]);
      const line = Number(new RegExp(`(?:^|\\|)${param}=(-?[\\d.]+)`).exec(specifier)?.[1]);
      if (!isMapNumber(map) || !isHalfLine(line)) continue;
      const odds = pairOdds(outcomes[outA], outcomes[outB]);
      if (odds) out.push({ ...odds, spec: { type, line, map } });
    }
  };
  readMap(MAP_ROUNDS_HANDICAP_MARKET, 'hcp', 'map_rounds_hcp', '1714', '1715');
  readMap(MAP_ROUNDS_TOTAL_MARKET, 'total', 'map_rounds_total', '12', '13');
  readMap(MAP_KILLS_HANDICAP_MARKET, 'hcp', 'map_kills_hcp', '1714', '1715');
  return out;
}

/** Deltas trazem só os campos alterados; mercados presentes substituem os anteriores. */
export function mergeEvent(prev: BetbyEvent | undefined, delta: BetbyEvent): BetbyEvent {
  if (!prev) return delta;
  return {
    ...prev,
    ...delta,
    desc: delta.desc ?? prev.desc,
    markets: delta.markets ? { ...prev.markets, ...delta.markets } : prev.markets,
  };
}

export class BetbySource implements Source {
  readonly name: string;
  private stopped = true;
  private readonly feeds: Feed[];
  private readonly sports = new Map<string, Named>();
  private readonly categories = new Map<string, Named>();
  private readonly tournaments = new Map<string, Named>();
  /** chave do quote -> assinatura das odds publicadas (evita updates redundantes) */
  private readonly published = new Map<string, string>();
  /** Ida e volta da requisição de delta */
  private readonly latency = new Ewma();
  private readonly net = new NetStats();
  /** id do evento -> chaves publicadas (vencedor + handicaps/totais) */
  private readonly eventKeys = new Map<string, Set<string>>();
  private lastOkAt?: number;
  private state: SourceStatus['state'] = 'idle';
  private detail?: string;
  private readonly log;

  constructor(
    private readonly store: OddsStore,
    private readonly opts: BetbyOptions,
  ) {
    this.name = opts.book;
    this.log = createLogger(opts.book);
    this.feeds = [
      { name: 'live', intervalMs: opts.liveIntervalMs, events: new Map() },
      { name: 'prematch', intervalMs: opts.prematchIntervalMs, events: new Map() },
    ];
  }

  start(): void {
    this.stopped = false;
    this.state = 'connecting';
    for (const feed of this.feeds) void this.runFeed(feed);
  }

  stop(): void {
    this.stopped = true;
  }

  status(): SourceStatus {
    return {
      book: this.opts.book,
      state: this.state,
      quotes: this.store.count(this.opts.book),
      lastMessageAt: this.lastOkAt,
      detail: this.detail,
      latencyMs: this.latency.value,
      ...this.net.fields(),
    };
  }

  private url(feed: Feed, id: number | string): string {
    return `${this.opts.apiBase}/${feed.name}/brand/${this.opts.brandId}/${this.opts.lang}/${id}`;
  }

  private async get<T>(url: string): Promise<T> {
    const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
    this.net.record(res.status);
    if (!res.ok) throw new Error(`HTTP ${res.status} em ${url}`);
    return (await res.json()) as T;
  }

  private async runFeed(feed: Feed): Promise<void> {
    let failures = 0;
    while (!this.stopped) {
      const startedAt = Date.now();
      try {
        // Manifesto e delta saem juntos (uma ida e volta por ciclo em vez de duas).
        const known = feed.version;
        let [manifest, delta] = await Promise.all([
          this.get<Manifest>(this.url(feed, 0)),
          known === undefined ? undefined : this.get<Chunk>(this.url(feed, known + startedAt)),
        ]);
        this.latency.add(Date.now() - startedAt);
        if (manifest.version !== feed.version) await this.loadSnapshot(feed, manifest);
        // Primeiro ciclo (ou após falha): ainda não havia versão para pedir o delta junto.
        delta ??= await this.get<Chunk>(this.url(feed, manifest.version + Date.now()));
        // Com snapshot novo o delta pedido sobre a versão antiga ainda vale para os eventos que ele traz.
        if (delta) this.applyDelta(feed, delta);
        this.touch(feed);

        failures = 0;
        this.lastOkAt = Date.now();
        if (this.state !== 'connected') {
          this.state = 'connected';
          this.store.setAvailable(this.opts.book, true);
        }
        this.detail = `${this.feeds.map((f) => `${f.name}: ${f.events.size} eventos`).join(' · ')}`;
        // Cadência fixa: o tempo das requisições é descontado da espera.
        // Feed ao vivo vazio: desacelera até aparecer jogo (o manifesto passa a trazê-lo).
        const idle = feed.name === 'live' && feed.events.size === 0;
        const wait = idle ? Math.max(feed.intervalMs, IDLE_LIVE_INTERVAL_MS) : feed.intervalMs;
        await sleep(Math.max(0, wait - (Date.now() - startedAt)));
      } catch (err) {
        failures++;
        this.log.warn(`feed ${feed.name} falhou (${failures}x)`, err);
        if (failures >= 3) {
          this.state = 'error';
          this.detail = (err as Error).message;
          // Sem o feed não dá para garantir que as odds em memória estão atuais.
          this.store.setAvailable(this.opts.book, false);
          feed.version = undefined;
        }
        await sleep(backoffDelay(failures - 1, feed.intervalMs, 30_000));
      }
    }
  }

  /**
   * O delta só traz eventos alterados: um ciclo bem-sucedido confirma que as odds dos demais
   * continuam valendo. Renova `updatedAt` sem emitir update (o preço não mudou).
   */
  private touch(feed: Feed): void {
    const now = Date.now();
    for (const id of feed.events.keys()) {
      for (const key of this.eventKeys.get(id) ?? []) {
        const q = this.store.get(key);
        if (q) q.updatedAt = now;
      }
    }
  }

  private mergeDictionaries(chunk: Chunk): void {
    for (const [id, s] of Object.entries(chunk.sports ?? {})) this.sports.set(id, s);
    for (const [id, c] of Object.entries(chunk.categories ?? {})) this.categories.set(id, c);
    for (const [id, t] of Object.entries(chunk.tournaments ?? {})) this.tournaments.set(id, t);
  }

  private async loadSnapshot(feed: Feed, manifest: Manifest): Promise<void> {
    const versions = [...manifest.top_events_versions, ...manifest.rest_events_versions];
    const chunks = await Promise.all(versions.map((v) => this.get<Chunk>(this.url(feed, v))));
    const before = new Set(feed.events.keys());
    feed.events = new Map();
    for (const chunk of chunks) {
      this.mergeDictionaries(chunk);
      for (const [id, ev] of Object.entries(chunk.events ?? {})) {
        if (ev) feed.events.set(id, mergeEvent(feed.events.get(id), ev));
      }
    }
    feed.version = manifest.version;
    for (const id of new Set([...before, ...feed.events.keys()])) this.sync(id);
    this.log.info(`snapshot ${feed.name}: ${feed.events.size} eventos`);
  }

  private applyDelta(feed: Feed, delta: Chunk): void {
    this.mergeDictionaries(delta);
    for (const [id, ev] of Object.entries(delta.events ?? {})) {
      // `null` no delta = mercados recolhidos momentaneamente (voltam em segundos só com `markets`).
      // A descrição é mantida para aceitar esse retorno; eventos encerrados saem no próximo snapshot.
      if (ev === null) {
        const prev = feed.events.get(id);
        if (prev) feed.events.set(id, { ...prev, markets: undefined });
      } else {
        const merged = mergeEvent(feed.events.get(id), ev);
        if (!merged.desc) continue;
        feed.events.set(id, merged);
      }
      this.sync(id);
    }
  }

  private gameOf(ev: BetbyEvent): Game | null {
    if (!ev.desc || ev.desc.virtual || ev.desc.type !== 'match' || ev.desc.competitors?.length !== 2) return null;
    const byId = BETBY_SPORT_IDS[ev.desc.sport];
    if (byId) return byId;
    const g = detectGame(this.sports.get(ev.desc.sport)?.slug);
    return g === 'other' ? null : g;
  }

  /** O mesmo evento pode estar no feed live e no pré-jogo; o live tem prioridade. */
  private sync(id: string): void {
    const eventKey = `${this.opts.book}:${id}`;
    const ev = this.feeds[0].events.get(id) ?? this.feeds[1].events.get(id);
    const game = ev ? this.gameOf(ev) : null;
    const markets: Array<TwoWayOdds & { spec: MarketSpec }> = [];
    if (ev && game) {
      const winner = winnerOdds(ev);
      if (winner) markets.push({ ...winner, spec: WINNER });
      markets.push(...lineMarkets(ev));
    }

    const keys = new Set<string>();
    const desc = ev?.desc;
    for (const odds of markets) {
      const [home, away] = desc!.competitors;
      const fields = derivedQuoteFields(eventKey, odds.spec, home.name, away.name);
      keys.add(fields.key);
      const sig = `${odds.a}|${odds.b}|${odds.suspended}`;
      if (this.published.get(fields.key) === sig) continue;
      this.published.set(fields.key, sig);
      this.store.upsert({ ...this.baseQuote(id, ev!, game!), ...fields, oddsA: odds.a, oddsB: odds.b, suspended: odds.suspended });
    }
    for (const key of this.eventKeys.get(id) ?? []) {
      if (keys.has(key)) continue;
      this.published.delete(key);
      this.store.remove(key);
    }
    if (keys.size) this.eventKeys.set(id, keys);
    else this.eventKeys.delete(id);
  }

  private baseQuote(id: string, ev: BetbyEvent, game: Game): Omit<Quote, 'key' | 'eventKey' | 'market' | 'oddsA' | 'oddsB'> {
    const desc = ev.desc!;
    const tournament = this.tournaments.get(desc.tournament);
    const category = this.categories.get(desc.category);
    const sport = this.sports.get(desc.sport);
    const [home, away] = desc.competitors;
    // A rota do widget só funciona via `bt-path`; o caminho direto (/soccer/...) dá 404 ao abrir a página.
    const url =
      sport && category && tournament
        ? `${this.opts.siteUrl}/sports?bt-path=/${sport.slug}/${category.slug}/${tournament.slug}/${desc.slug}-${id}`
        : `${this.opts.siteUrl}/sports`;
    return {
      book: this.opts.book,
      marketId: id,
      game,
      league: tournament?.name,
      eventName: tournament ? `${home.name} vs ${away.name} - ${tournament.name}` : `${home.name} vs ${away.name}`,
      teamA: home.name,
      teamB: away.name,
      startTime: desc.scheduled * 1000,
      url,
      updatedAt: Date.now(),
    };
  }
}
