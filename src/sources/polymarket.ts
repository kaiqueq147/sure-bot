import type { OddsStore } from '../core/OddsStore.js';
import { ReconnectingWebSocket } from '../core/ReconnectingWebSocket.js';
import { createLogger } from '../core/logger.js';
import { Ewma } from '../core/Health.js';
import { derivedQuoteFields, isHalfLine, isMapNumber, WINNER } from '../core/markets.js';
import { depthOdds } from '../engine/math.js';
import { detectGame } from '../matching/normalize.js';
import type { DepthLevel, Game, MarketSpec, Quote, Source, SourceStatus } from '../types.js';

interface GammaMarket {
  id: string | number;
  question?: string;
  /** Ex.: "Game 1 Winner" nos mercados `child_moneyline` */
  groupItemTitle?: string;
  slug?: string;
  outcomes?: string | string[];
  clobTokenIds?: string | string[];
  active?: boolean;
  closed?: boolean;
  archived?: boolean;
  enableOrderBook?: boolean;
  acceptingOrders?: boolean;
  sportsMarketType?: string;
  /** Linha do handicap (vale para o primeiro outcome) ou do total */
  line?: number | string;
  gameStartTime?: string;
  eventStartTime?: string;
  volumeNum?: number;
  feesEnabled?: boolean;
  feeSchedule?: { rate?: number; takerOnly?: boolean };
}

interface GammaEvent {
  id: string | number;
  slug: string;
  title: string;
  startTime?: string;
  closed?: boolean;
  tags?: Array<{ slug?: string; label?: string }>;
  series?: Array<{ title?: string }>;
  markets?: GammaMarket[];
}

interface TrackedMarket {
  marketId: string;
  key: string;
  eventKey: string;
  market: MarketSpec;
  selA: string;
  selB: string;
  /** tokenA = seleção A do quote (teamA, teamA com a linha, ou "mais de") */
  tokenA: string;
  tokenB: string;
  eventName: string;
  teamA: string;
  teamB: string;
  game: Game;
  league?: string;
  startTime?: number;
  takerFeeRate?: number;
  url: string;
}

interface Book {
  asks: Map<string, number>;
}

interface SideBook {
  odds: number;
  depth: DepthLevel[];
  liquidity: number;
}

export interface PolymarketOptions {
  gammaUrl: string;
  wsUrl: string;
  tagSlugs: string[];
  discoveryIntervalMs: number;
  minFillUsd: number;
  depthLevels: number;
}

const log = createLogger('polymarket');
const PAGE = 100;
const NON_MATCH_WINNER = /\b(game|map)\s*\d|handicap|spread|total|o\/u|over|under|kills|first blood|exact|correct score/i;

const parseList = (v: unknown): string[] => {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
};

const toEpoch = (s?: string): number | undefined => {
  if (!s) return undefined;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : undefined;
};

/** Seleciona o mercado "vencedor da partida" (2 vias com nomes dos times) dentro de um evento. */
export function pickMatchWinner(event: GammaEvent): GammaMarket | undefined {
  const candidates = (event.markets ?? []).filter((m) => {
    if (m.closed || m.archived || m.active === false || m.enableOrderBook === false || m.acceptingOrders === false) return false;
    // child_moneyline = vencedor de mapa/jogo individual, não da série
    if (m.sportsMarketType && m.sportsMarketType !== 'moneyline') return false;
    const outcomes = parseList(m.outcomes);
    if (outcomes.length !== 2 || parseList(m.clobTokenIds).length !== 2) return false;
    const lower = outcomes.map((o) => o.toLowerCase());
    return !(lower.includes('yes') && lower.includes('no')) && !lower.some((o) => /^(over|under)\b/.test(o));
  });
  const score = (m: GammaMarket) =>
    (m.sportsMarketType === 'moneyline' ? 10 : 0) +
    (NON_MATCH_WINNER.test(m.question ?? '') ? -5 : 0) +
    ((m.question ?? '').trim() === event.title.trim() ? 2 : 0);
  return candidates.sort((a, b) => score(b) - score(a) || (b.volumeNum ?? 0) - (a.volumeNum ?? 0))[0];
}

const norm = (s: string) => s.trim().toLowerCase();

/** Uma assinatura com centenas de tokens numa mensagem só não recebe nenhum `book` (testado com 864). */
const SUBSCRIBE_CHUNK = 100;
function chunks<T>(list: T[], size = SUBSCRIBE_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/**
 * Handicap e total de mapas da série, orientados pelo vencedor: no handicap a linha da
 * Polymarket vale para o primeiro outcome (que nem sempre é o teamA do vencedor).
 */
export function pickLineMarkets(
  event: GammaEvent,
  teamA: string,
  teamB: string,
): Array<{ market: GammaMarket; spec: MarketSpec; tokenA: string; tokenB: string }> {
  const out: Array<{ market: GammaMarket; spec: MarketSpec; tokenA: string; tokenB: string }> = [];
  for (const m of event.markets ?? []) {
    if (m.closed || m.archived || m.active === false || m.enableOrderBook === false || m.acceptingOrders === false) continue;
    const outcomes = parseList(m.outcomes);
    const tokens = parseList(m.clobTokenIds);
    if (outcomes.length !== 2 || tokens.length !== 2) continue;
    const [o0, o1] = outcomes.map(norm);

    if (m.sportsMarketType === 'child_moneyline') {
      const n = Number(/game\s*(\d+)\s*winner/i.exec(`${m.groupItemTitle ?? ''} ${m.question ?? ''}`)?.[1]);
      if (!isMapNumber(n)) continue;
      const spec: MarketSpec = { type: 'map', line: n };
      if (o0 === norm(teamA) && o1 === norm(teamB)) out.push({ market: m, spec, tokenA: tokens[0], tokenB: tokens[1] });
      else if (o0 === norm(teamB) && o1 === norm(teamA)) out.push({ market: m, spec, tokenA: tokens[1], tokenB: tokens[0] });
      continue;
    }

    const line = Number(m.line);
    if (!isHalfLine(line)) continue;
    if (m.sportsMarketType === 'map_handicap') {
      if (o0 === norm(teamA) && o1 === norm(teamB)) out.push({ market: m, spec: { type: 'handicap', line }, tokenA: tokens[0], tokenB: tokens[1] });
      else if (o0 === norm(teamB) && o1 === norm(teamA)) out.push({ market: m, spec: { type: 'handicap', line: -line }, tokenA: tokens[1], tokenB: tokens[0] });
    } else if (m.sportsMarketType === 'totals') {
      if (o0 === 'over' && o1 === 'under') out.push({ market: m, spec: { type: 'total', line }, tokenA: tokens[0], tokenB: tokens[1] });
      else if (o0 === 'under' && o1 === 'over') out.push({ market: m, spec: { type: 'total', line }, tokenA: tokens[1], tokenB: tokens[0] });
    }
  }
  return out;
}

export class PolymarketSource implements Source {
  readonly name = 'polymarket';
  private readonly ws: ReconnectingWebSocket;
  private readonly markets = new Map<string, TrackedMarket>();
  private readonly tokenIndex = new Map<string, { marketId: string; side: 'A' | 'B' }>();
  private readonly books = new Map<string, Book>();
  private discoveryTimer?: NodeJS.Timeout;
  private lastMessageAt?: number;
  /** Chegada da mensagem − carimbo `timestamp` do servidor (inclui diferença de relógio) */
  private readonly latency = new Ewma(0.05);
  private state: SourceStatus['state'] = 'idle';
  private detail?: string;

  constructor(
    private readonly store: OddsStore,
    private readonly opts: PolymarketOptions,
  ) {
    this.ws = new ReconnectingWebSocket(opts.wsUrl, {
      name: 'polymarket',
      pingPayload: 'PING',
      pingIntervalMs: 10_000,
      // O canal de mercado só envia em mudanças; o PONG mantém o watchdog vivo.
      idleTimeoutMs: 35_000,
    });
    this.ws.on('open', () => this.onOpen());
    this.ws.on('message', (m: string) => this.onMessage(m));
    this.ws.on('close', () => this.onClose());
  }

  async start(): Promise<void> {
    this.state = 'connecting';
    await this.discover();
    this.ws.start();
    this.discoveryTimer = setInterval(() => void this.discover(), this.opts.discoveryIntervalMs);
  }

  stop(): void {
    clearInterval(this.discoveryTimer);
    this.ws.stop();
  }

  status(): SourceStatus {
    return {
      book: 'polymarket',
      state: this.state,
      quotes: this.store.count('polymarket'),
      lastMessageAt: this.lastMessageAt,
      detail: this.detail,
      latencyMs: this.latency.value,
    };
  }

  // ---------------------------------------------------------------- descoberta

  private async fetchEvents(tag: string): Promise<GammaEvent[]> {
    const all: GammaEvent[] = [];
    for (let offset = 0; offset < 2_000; offset += PAGE) {
      const url = new URL('/events', this.opts.gammaUrl);
      url.searchParams.set('tag_slug', tag);
      url.searchParams.set('active', 'true');
      url.searchParams.set('closed', 'false');
      // Eventos já jogados continuam "active" até a resolução, com book vazio.
      url.searchParams.set('end_date_min', new Date().toISOString());
      url.searchParams.set('limit', String(PAGE));
      url.searchParams.set('offset', String(offset));
      const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`Gamma ${res.status} ${res.statusText}`);
      const page = (await res.json()) as GammaEvent[];
      all.push(...page);
      if (page.length < PAGE) break;
    }
    return all;
  }

  private async discover(): Promise<void> {
    try {
      const events = new Map<string, GammaEvent>();
      for (const tag of this.opts.tagSlugs) {
        for (const ev of await this.fetchEvents(tag)) events.set(String(ev.id), ev);
      }

      const seen = new Set<string>();
      const newTokens: string[] = [];
      for (const ev of events.values()) {
        if (ev.closed) continue;
        const m = pickMatchWinner(ev);
        if (!m) continue;
        const winnerId = String(m.id);
        const [teamA, teamB] = parseList(m.outcomes);
        const [tokenA, tokenB] = parseList(m.clobTokenIds);
        const eventKey = `polymarket:${winnerId}`;
        const base = {
          teamA,
          teamB,
          eventName: ev.title,
          game: detectGame(...(ev.tags ?? []).flatMap((t) => [t.slug, t.label]), ev.title),
          league: ev.series?.[0]?.title,
          startTime: toEpoch(m.eventStartTime) ?? toEpoch(m.gameStartTime) ?? toEpoch(ev.startTime),
          url: `https://polymarket.com/event/${ev.slug}`,
        };
        const entries = [
          { market: m, spec: WINNER, tokenA, tokenB },
          ...pickLineMarkets(ev, teamA, teamB),
        ];
        for (const e of entries) {
          const marketId = String(e.market.id);
          seen.add(marketId);
          if (this.markets.has(marketId)) continue;
          const tracked: TrackedMarket = {
            ...base,
            ...derivedQuoteFields(eventKey, e.spec, teamA, teamB),
            marketId,
            tokenA: e.tokenA,
            tokenB: e.tokenB,
            takerFeeRate: e.market.feesEnabled === false ? 0 : (e.market.feeSchedule?.rate ?? 0),
          };
          this.markets.set(marketId, tracked);
          this.tokenIndex.set(e.tokenA, { marketId, side: 'A' });
          this.tokenIndex.set(e.tokenB, { marketId, side: 'B' });
          newTokens.push(e.tokenA, e.tokenB);
          this.store.upsert(this.toQuote(tracked, null, null));
        }
      }

      for (const [marketId, t] of this.markets) {
        if (seen.has(marketId)) continue;
        this.markets.delete(marketId);
        for (const token of [t.tokenA, t.tokenB]) {
          this.tokenIndex.delete(token);
          this.books.delete(token);
        }
        this.store.remove(t.key);
      }

      if (newTokens.length && this.ws.isOpen) {
        for (const chunk of chunks(newTokens)) this.ws.send({ assets_ids: chunk, operation: 'subscribe' });
      }
      const winners = [...this.markets.values()].filter((t) => t.market.type === 'winner').length;
      this.detail = `${winners} jogos · ${this.markets.size - winners} handicaps/totais`;
      log.info(`descoberta: ${events.size} eventos, ${winners} jogos + ${this.markets.size - winners} handicaps/totais (${newTokens.length / 2} mercados novos)`);
    } catch (err) {
      this.detail = `falha na descoberta: ${(err as Error).message}`;
      log.error('falha na descoberta de mercados', err);
    }
  }

  // ---------------------------------------------------------------- websocket

  private onOpen(): void {
    this.state = 'connected';
    const tokens = [...this.tokenIndex.keys()];
    // Ao (re)assinar, o servidor reenvia um snapshot `book` de cada ativo.
    const [first = [], ...rest] = chunks(tokens);
    this.ws.send({ assets_ids: first, type: 'market' });
    for (const chunk of rest) this.ws.send({ assets_ids: chunk, operation: 'subscribe' });
    this.store.setAvailable('polymarket', true);
    log.info(`assinando ${tokens.length} tokens`);
  }

  private onClose(): void {
    this.state = 'disconnected';
    this.books.clear();
    // Sem conexão não há garantia de que o book local reflete o real: suspende a casa inteira.
    this.store.setAvailable('polymarket', false);
  }

  private onMessage(raw: string): void {
    this.lastMessageAt = Date.now();
    if (raw === 'PONG' || (!raw.startsWith('{') && !raw.startsWith('['))) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    const msgs = (Array.isArray(parsed) ? parsed : [parsed]) as Array<Record<string, any>>;
    const touched = new Set<string>();

    const now = Date.now();
    for (const msg of msgs) {
      // Snapshots `book` repetem o carimbo do último trade; só deltas medem o atraso real.
      const ts = Number(msg.timestamp);
      if (msg.event_type === 'price_change' && ts > 1e12) this.latency.add(Math.max(0, now - ts));
      switch (msg.event_type) {
        case 'book': {
          const asks = new Map<string, number>();
          for (const lvl of msg.asks ?? msg.sells ?? []) asks.set(String(lvl.price), Number(lvl.size));
          this.books.set(msg.asset_id, { asks });
          touched.add(msg.asset_id);
          break;
        }
        case 'price_change': {
          const changes: Array<Record<string, any>> = msg.price_changes ?? (msg.changes ?? []).map((c: any) => ({ ...c, asset_id: msg.asset_id }));
          for (const c of changes) {
            if (String(c.side).toUpperCase() !== 'SELL') continue;
            const book = this.books.get(c.asset_id);
            if (!book) continue;
            const size = Number(c.size);
            if (size > 0) book.asks.set(String(c.price), size);
            else book.asks.delete(String(c.price));
            touched.add(c.asset_id);
          }
          break;
        }
        default:
          break;
      }
    }

    const markets = new Set<string>();
    for (const token of touched) {
      const idx = this.tokenIndex.get(token);
      if (idx) markets.add(idx.marketId);
    }
    for (const marketId of markets) this.refreshQuote(marketId);
  }

  /**
   * Para apostar numa seleção compramos shares nos asks, do menor preço para o maior.
   * A odd publicada é a média para comprar `minFillUsd`: uma ordem de centavos no topo do
   * livro não vira "odd" (era o que fazia arbitragens piscarem várias vezes por segundo).
   */
  private side(token: string): SideBook | null {
    const book = this.books.get(token);
    if (!book) return null;
    const levels: DepthLevel[] = [...book.asks]
      .map(([p, size]) => [Number(p), size] as DepthLevel)
      .filter(([p, size]) => size > 0 && p > 0 && p < 1)
      .sort((x, y) => x[0] - y[0])
      .slice(0, this.opts.depthLevels);
    const fill = depthOdds(levels, this.opts.minFillUsd);
    if (!fill || fill.filled < this.opts.minFillUsd - 1e-9) return null;
    return { odds: fill.odds, depth: levels, liquidity: levels.reduce((s, [p, size]) => s + p * size, 0) };
  }

  private refreshQuote(marketId: string): void {
    const t = this.markets.get(marketId);
    if (!t) return;
    this.store.upsert(this.toQuote(t, this.side(t.tokenA), this.side(t.tokenB)));
  }

  private toQuote(t: TrackedMarket, a: SideBook | null, b: SideBook | null): Quote {
    return {
      key: t.key,
      eventKey: t.eventKey,
      market: t.market,
      selA: t.selA,
      selB: t.selB,
      book: 'polymarket',
      marketId: t.marketId,
      game: t.game,
      league: t.league,
      eventName: t.eventName,
      teamA: t.teamA,
      teamB: t.teamB,
      startTime: t.startTime,
      oddsA: a?.odds ?? null,
      oddsB: b?.odds ?? null,
      maxStakeA: a?.liquidity,
      maxStakeB: b?.liquidity,
      depthA: a?.depth,
      depthB: b?.depth,
      takerFeeRate: t.takerFeeRate,
      url: t.url,
      updatedAt: Date.now(),
    };
  }
}
