import type { OddsStore } from '../core/OddsStore.js';
import { ReconnectingWebSocket } from '../core/ReconnectingWebSocket.js';
import { createLogger } from '../core/logger.js';
import { Ewma } from '../core/Health.js';
import { derivedQuoteFields, isHalfLine, isHandicapType, isMapNumber, marketKey, WINNER } from '../core/markets.js';
import { depthOdds } from '../engine/math.js';
import { detectGame } from '../matching/normalize.js';
import { NetStats } from './netStats.js';
import { hasDraw, isSport } from '../core/sports.js';
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

export interface GammaEvent {
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
  /** Só no 1X2 do futebol: o "Sim" do mercado de empate */
  tokenDraw?: string;
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
  /** Tags com jogos de esportes tradicionais; vazio desliga */
  sportTagSlugs?: string[];
  sportsHorizonH?: number;
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
 * Tipo de um mercado de linha pelo `sportsMarketType`. Mercados de um mapa trazem o número no
 * sufixo (`round_handicap_game_2`) ou, nas kills, na pergunta ("... in Game 2?").
 */
export function lineMarketKind(m: GammaMarket): { type: MarketSpec['type']; map?: number } | null {
  const t = m.sportsMarketType ?? '';
  if (t === 'map_handicap') return { type: 'handicap' };
  if (t === 'totals') return { type: 'total' };
  const perMap: Array<[RegExp, MarketSpec['type']]> = [
    [/^round_handicap_game_(\d+)$/, 'map_rounds_hcp'],
    [/^round_over_under_game_(\d+)$/, 'map_rounds_total'],
  ];
  for (const [re, type] of perMap) {
    const n = Number(re.exec(t)?.[1]);
    if (re.test(t)) return isMapNumber(n) ? { type, map: n } : null;
  }
  if (t === 'kill_over_under_game') {
    const n = Number(/\bgame\s*(\d+)/i.exec(`${m.question ?? ''} ${m.groupItemTitle ?? ''}`)?.[1]);
    return isMapNumber(n) ? { type: 'map_kills_total', map: n } : null;
  }
  return null;
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
    const kind = lineMarketKind(m);
    if (!kind) continue;
    const spec = (l: number): MarketSpec => (kind.map ? { type: kind.type, line: l, map: kind.map } : { type: kind.type, line: l });
    if (isHandicapType(kind.type)) {
      if (o0 === norm(teamA) && o1 === norm(teamB)) out.push({ market: m, spec: spec(line), tokenA: tokens[0], tokenB: tokens[1] });
      else if (o0 === norm(teamB) && o1 === norm(teamA)) out.push({ market: m, spec: spec(-line), tokenA: tokens[1], tokenB: tokens[0] });
    } else {
      if (o0 === 'over' && o1 === 'under') out.push({ market: m, spec: spec(line), tokenA: tokens[0], tokenB: tokens[1] });
      else if (o0 === 'under' && o1 === 'over') out.push({ market: m, spec: spec(line), tokenA: tokens[1], tokenB: tokens[0] });
    }
  }
  return out;
}

/** Tags do Gamma -> esporte tradicional. Um evento de NBA traz "nba" e "basketball". */
const SPORT_TAGS: Array<[Game, string[]]> = [
  ['soccer', ['soccer']],
  ['basketball', ['basketball', 'nba', 'wnba', 'ncaab']],
  ['baseball', ['baseball', 'mlb', 'kbo', 'npb']],
  ['tennis', ['tennis', 'atp', 'wta']],
  ['american_football', ['nfl', 'ncaaf', 'american-football']],
];

export function sportOf(ev: GammaEvent): Game | null {
  const tags = new Set((ev.tags ?? []).map((t) => (t.slug ?? '').toLowerCase()));
  return SPORT_TAGS.find(([, slugs]) => slugs.some((s) => tags.has(s)))?.[0] ?? null;
}

type Period = NonNullable<MarketSpec['period']>;

/** sportsMarketType -> mercado do contrato (só 2 vias; o resto fica de fora). */
const SPORT_LINE_TYPES: Record<string, { type: MarketSpec['type']; period?: Period; sel: 'teams' | 'ou' | 'yesno' }> = {
  spreads: { type: 'handicap', sel: 'teams' },
  totals: { type: 'total', sel: 'ou' },
  first_half_spreads: { type: 'handicap', period: 'h1', sel: 'teams' },
  first_half_totals: { type: 'total', period: 'h1', sel: 'ou' },
  both_teams_to_score: { type: 'btts', sel: 'yesno' },
  both_teams_to_score_first_half: { type: 'btts', period: 'h1', sel: 'yesno' },
  // Tênis: total de games da partida e do 1º set, vencedor do 1º set (o handicap da Polymarket é de sets)
  tennis_match_totals: { type: 'total', sel: 'ou' },
  tennis_first_set_totals: { type: 'total', period: 'set1', sel: 'ou' },
  tennis_first_set_winner: { type: 'winner', period: 'set1', sel: 'teams' },
};

const tradable = (m: GammaMarket) =>
  !(m.closed || m.archived || m.active === false || m.enableOrderBook === false || m.acceptingOrders === false);

type Entry = { market: GammaMarket; spec: MarketSpec; tokenA: string; tokenB: string; tokenDraw?: string };

/**
 * Mercados de linha de um jogo de esporte tradicional, nos eventos do jogo (o principal e os
 * "- More Markets" do futebol). Handicap: a linha vale para o primeiro outcome.
 */
export function pickSportLineMarkets(events: GammaEvent[], teamA: string, teamB: string): Entry[] {
  const out: Entry[] = [];
  for (const m of events.flatMap((e) => e.markets ?? [])) {
    const kind = SPORT_LINE_TYPES[m.sportsMarketType ?? ''];
    if (!kind || !tradable(m)) continue;
    const outcomes = parseList(m.outcomes).map(norm);
    const tokens = parseList(m.clobTokenIds);
    if (outcomes.length !== 2 || tokens.length !== 2) continue;
    const [o0, o1] = outcomes;
    const spec = (line?: number): MarketSpec => ({
      type: kind.type,
      ...(line !== undefined ? { line } : {}),
      ...(kind.period ? { period: kind.period } : {}),
    });
    const straight = o0 === norm(teamA) && o1 === norm(teamB);
    const crossed = o0 === norm(teamB) && o1 === norm(teamA);
    if (kind.sel === 'yesno') {
      if (o0 === 'yes' && o1 === 'no') out.push({ market: m, spec: spec(), tokenA: tokens[0], tokenB: tokens[1] });
      else if (o0 === 'no' && o1 === 'yes') out.push({ market: m, spec: spec(), tokenA: tokens[1], tokenB: tokens[0] });
      continue;
    }
    if (kind.sel === 'teams' && kind.type !== 'handicap') {
      if (straight) out.push({ market: m, spec: spec(), tokenA: tokens[0], tokenB: tokens[1] });
      else if (crossed) out.push({ market: m, spec: spec(), tokenA: tokens[1], tokenB: tokens[0] });
      continue;
    }
    const line = Number(m.line);
    if (!isHalfLine(line)) continue;
    if (kind.sel === 'teams') {
      if (straight) out.push({ market: m, spec: spec(line), tokenA: tokens[0], tokenB: tokens[1] });
      else if (crossed) out.push({ market: m, spec: spec(-line), tokenA: tokens[1], tokenB: tokens[0] });
    } else if (o0.startsWith('over') && o1.startsWith('under')) {
      out.push({ market: m, spec: spec(line), tokenA: tokens[0], tokenB: tokens[1] });
    } else if (o0.startsWith('under') && o1.startsWith('over')) {
      out.push({ market: m, spec: spec(line), tokenA: tokens[1], tokenB: tokens[0] });
    }
  }
  return out;
}

/**
 * 1X2 do futebol: a Polymarket publica três mercados Sim/Não ("X vence?", "empate?", "Y vence?").
 * Apostar numa seleção = comprar o "Sim" dela, então A/empate/B são os tokens "Sim" de cada um.
 * Mandante = primeiro nome do título ("Villarreal CF vs. RCD Espanyol de Barcelona").
 */
export function pickSoccer1x2(ev: GammaEvent): { teamA: string; teamB: string; entry: Entry } | null {
  const [home, away] = ev.title.split(/\s+vs\.?\s+/i).map((t) => t.trim());
  if (!home || !away) return null;
  const yes = (m: GammaMarket) => {
    const outcomes = parseList(m.outcomes).map(norm);
    const tokens = parseList(m.clobTokenIds);
    const i = outcomes.indexOf('yes');
    return outcomes.length === 2 && tokens.length === 2 && i >= 0 ? tokens[i] : undefined;
  };
  const ml = (ev.markets ?? []).filter((m) => m.sportsMarketType === 'moneyline' && tradable(m));
  if (ml.length !== 3) return null;
  const draw = ml.find((m) => /^draw\b/i.test(m.groupItemTitle ?? '') || /\bdraw\?/i.test(m.question ?? ''));
  const team = (name: string) => ml.find((m) => m !== draw && norm(m.groupItemTitle ?? '') === norm(name));
  const mh = team(home);
  const ma = team(away);
  if (!draw || !mh || !ma) return null;
  const [tokenA, tokenB, tokenDraw] = [yes(mh), yes(ma), yes(draw)];
  if (!tokenA || !tokenB || !tokenDraw) return null;
  return { teamA: home, teamB: away, entry: { market: mh, spec: WINNER, tokenA, tokenB, tokenDraw } };
}

/** Mesmo critério de `stake.ts`: tipo/período que `markets.ts` ainda não distingue fica de fora. */
function marketKeySupported(spec: MarketSpec): boolean {
  const k = marketKey(spec);
  if (spec.type !== 'winner' && k === 'win') return false;
  if (spec.period && !k.includes(spec.period)) return false;
  return true;
}

export class PolymarketSource implements Source {
  readonly name = 'polymarket';
  private readonly ws: ReconnectingWebSocket;
  private readonly markets = new Map<string, TrackedMarket>();
  private readonly tokenIndex = new Map<string, { marketId: string; side: 'A' | 'B' | 'D' }>();
  private readonly books = new Map<string, Book>();
  private discoveryTimer?: NodeJS.Timeout;
  private lastMessageAt?: number;
  /** Chegada da mensagem − carimbo `timestamp` do servidor (inclui diferença de relógio) */
  private readonly net = new NetStats();
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
      ...this.net.fields(),
    };
  }

  // ---------------------------------------------------------------- descoberta

  private async fetchEvents(tag: string, endMax?: Date): Promise<GammaEvent[]> {
    const all: GammaEvent[] = [];
    for (let offset = 0; offset < 2_000; offset += PAGE) {
      const url = new URL('/events', this.opts.gammaUrl);
      url.searchParams.set('tag_slug', tag);
      url.searchParams.set('active', 'true');
      url.searchParams.set('closed', 'false');
      // Eventos já jogados continuam "active" até a resolução, com book vazio.
      url.searchParams.set('end_date_min', new Date().toISOString());
      // Esportes tradicionais: corta futuros (campeão da temporada etc.) e jogos distantes.
      if (endMax) url.searchParams.set('end_date_max', endMax.toISOString());
      url.searchParams.set('limit', String(PAGE));
      url.searchParams.set('offset', String(offset));
      const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
      this.net.record(res.status);
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

      const games: Array<{ ev: GammaEvent; teamA: string; teamB: string; eventKey: string; game: Game; start?: number; entries: Entry[] }> = [];
      for (const ev of events.values()) {
        if (ev.closed) continue;
        const m = pickMatchWinner(ev);
        if (!m) continue;
        const [teamA, teamB] = parseList(m.outcomes);
        const [tokenA, tokenB] = parseList(m.clobTokenIds);
        games.push({
          ev,
          teamA,
          teamB,
          eventKey: `polymarket:${m.id}`,
          game: detectGame(...(ev.tags ?? []).flatMap((t) => [t.slug, t.label]), ev.title),
          start: toEpoch(m.eventStartTime) ?? toEpoch(m.gameStartTime) ?? toEpoch(ev.startTime),
          entries: [{ market: m, spec: WINNER, tokenA, tokenB }, ...pickLineMarkets(ev, teamA, teamB)],
        });
      }
      games.push(...(await this.discoverSports()));

      const seen = new Set<string>();
      const newTokens: string[] = [];
      for (const { ev, teamA, teamB, eventKey, game, start, entries } of games) {
        const base = {
          teamA,
          teamB,
          eventName: ev.title,
          game,
          league: ev.series?.[0]?.title,
          startTime: start,
          url: `https://polymarket.com/event/${ev.slug}`,
        };
        for (const e of entries) {
          // O 1X2 junta três mercados: a chave é o evento, não um mercado.
          const marketId = e.tokenDraw ? `1x2:${ev.id}` : String(e.market.id);
          if (seen.has(marketId)) continue;
          seen.add(marketId);
          if (this.markets.has(marketId)) continue;
          const tracked: TrackedMarket = {
            ...base,
            ...derivedQuoteFields(eventKey, e.spec, teamA, teamB, game),
            marketId,
            tokenA: e.tokenA,
            tokenB: e.tokenB,
            tokenDraw: e.tokenDraw,
            takerFeeRate: e.market.feesEnabled === false ? 0 : (e.market.feeSchedule?.rate ?? 0),
          };
          this.markets.set(marketId, tracked);
          this.tokenIndex.set(e.tokenA, { marketId, side: 'A' });
          this.tokenIndex.set(e.tokenB, { marketId, side: 'B' });
          newTokens.push(e.tokenA, e.tokenB);
          if (e.tokenDraw) {
            this.tokenIndex.set(e.tokenDraw, { marketId, side: 'D' });
            newTokens.push(e.tokenDraw);
          }
          this.store.upsert(this.toQuote(tracked, null, null));
        }
      }

      for (const [marketId, t] of this.markets) {
        if (seen.has(marketId)) continue;
        this.markets.delete(marketId);
        for (const token of [t.tokenA, t.tokenB, t.tokenDraw]) {
          if (!token) continue;
          this.tokenIndex.delete(token);
          this.books.delete(token);
        }
        this.store.remove(t.key);
      }

      if (newTokens.length && this.ws.isOpen) {
        for (const chunk of chunks(newTokens)) this.ws.send({ assets_ids: chunk, operation: 'subscribe' });
      }
      const all = [...this.markets.values()];
      const winners = all.filter((t) => t.market.type === 'winner' && t.key === t.eventKey).length;
      const sports = all.filter((t) => isSport(t.game)).length;
      const sportsTxt = sports ? ` · ${sports} de esportes` : '';
      this.detail = `${winners} jogos · ${this.markets.size - winners} handicaps/totais${sportsTxt}`;
      log.info(`descoberta: ${events.size} eventos, ${winners} jogos + ${this.markets.size - winners} handicaps/totais (${newTokens.length} tokens novos)${sportsTxt}`);
    } catch (err) {
      this.detail = `falha na descoberta: ${(err as Error).message}`;
      log.error('falha na descoberta de mercados', err);
    }
  }

  /**
   * Jogos de esportes tradicionais: o evento principal tem o vencedor (2 vias, ou o 1X2 do
   * futebol em três Sim/Não); handicaps/totais/ambas marcam do futebol ficam em eventos irmãos
   * com o mesmo slug + sufixo ("-more-markets").
   */
  private async discoverSports() {
    const tags = this.opts.sportTagSlugs ?? [];
    if (!tags.length) return [];
    const horizon = Date.now() + (this.opts.sportsHorizonH ?? 48) * 3_600_000;
    const events = new Map<string, GammaEvent>();
    for (const tag of tags) {
      try {
        // O end_date do evento vem bem depois do jogo (tênis: ~1 semana): o corte fino é pelo início.
        for (const ev of await this.fetchEvents(tag, new Date(horizon + 10 * 86_400_000))) events.set(String(ev.id), ev);
      } catch (err) {
        log.warn(`descoberta de esportes (${tag}) falhou`, err);
      }
    }
    const bySlug = [...events.values()];
    const out: Array<{ ev: GammaEvent; teamA: string; teamB: string; eventKey: string; game: Game; start?: number; entries: Entry[] }> = [];
    for (const ev of events.values()) {
      const game = sportOf(ev);
      if (!game || ev.closed || !/\svs\.?\s/i.test(ev.title)) continue;
      const siblings = bySlug.filter((e) => e !== ev && e.slug.startsWith(`${ev.slug}-`));
      let teamA: string;
      let teamB: string;
      let winner: Entry;
      if (hasDraw(game)) {
        const x = pickSoccer1x2(ev);
        if (!x) continue;
        ({ teamA, teamB } = x);
        winner = x.entry;
      } else {
        const m = pickMatchWinner(ev);
        if (!m || m.sportsMarketType !== 'moneyline') continue;
        [teamA, teamB] = parseList(m.outcomes);
        const [tokenA, tokenB] = parseList(m.clobTokenIds);
        winner = { market: m, spec: WINNER, tokenA, tokenB };
      }
      // Início do jogo: o do evento é o do torneio no tênis.
      const start = toEpoch(winner.market.gameStartTime) ?? toEpoch(winner.market.eventStartTime) ?? toEpoch(ev.startTime);
      if (start !== undefined && start > horizon) continue;
      const lines = pickSportLineMarkets([ev, ...siblings], teamA, teamB).filter((e) => marketKeySupported(e.spec));
      out.push({ ev, teamA, teamB, eventKey: `polymarket:${winner.tokenDraw ? `1x2:${ev.id}` : winner.market.id}`, game, start, entries: [winner, ...lines] });
    }
    return out;
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
    const d = t.tokenDraw ? this.side(t.tokenDraw) : null;
    this.store.upsert(this.toQuote(t, this.side(t.tokenA), this.side(t.tokenB), d));
  }

  private toQuote(t: TrackedMarket, a: SideBook | null, b: SideBook | null, d: SideBook | null = null): Quote {
    return {
      // 1X2: presença de `oddsDraw` (mesmo null) marca o mercado como 3 vias.
      ...(t.tokenDraw ? { oddsDraw: d?.odds ?? null, maxStakeDraw: d?.liquidity } : {}),
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
