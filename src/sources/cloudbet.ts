import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { OddsStore } from '../core/OddsStore.js';
import { backoffDelay, createLogger, sleep } from '../core/logger.js';
import { Ewma } from '../core/Health.js';
import { derivedQuoteFields, isHalfLine, isMapNumber, WINNER } from '../core/markets.js';
import { NetStats } from './netStats.js';
import type { Game, MarketSpec, Quote, Source, SourceStatus } from '../types.js';

/**
 * Cloudbet: o site consome um feed JSON público e sem desafio anti-bot:
 *  `GET {api}/sports/events?sports=<chave>&markets=<prefixo>.<mercado>&live=true|…`
 * Não há WebSocket de odds para visitantes; o site faz polling desse mesmo endpoint.
 *
 * A Cloudflare limita por IP (429, erro 1015) e o bloqueio pode durar ~1h. Para não chegar lá:
 *  - um único ciclo, nunca duas requisições ao mesmo tempo: cada volta busca só o ao vivo e,
 *    a cada `allIntervalMs`, todos os jogos (o pré-jogo muda pouco e é o payload grande);
 *  - num 429 a pausa pedida (`Retry-After`) é respeitada inteira e gravada em disco, para um
 *    reinício do processo (ex.: `tsx watch`) não voltar a consultar no meio do bloqueio;
 *  - depois de um 429 o intervalo dobra (até 8x) e volta ao normal aos poucos;
 *  - ±10% de jitter no intervalo.
 *
 * Mercados: `<prefixo>.winner` (home/away), `.map_handicap` (params `handicap=<linha da casa>`),
 * `.total_maps` (over/under, `total=<linha>`), `.map_winner` (`map=<n>`).
 */

interface CloudbetSelection {
  outcome: string;
  params: string;
  price: number;
  status: string;
  maxStake?: number;
}

interface CloudbetEvent {
  id: number;
  home?: { name: string } | null;
  away?: { name: string } | null;
  status: string;
  type?: string;
  startTime?: string;
  markets?: Record<string, { submarkets?: Record<string, { selections?: CloudbetSelection[] }> }>;
}

interface CloudbetResponse {
  sports?: Array<{ key: string; competitions?: Array<{ key: string; name: string; events?: CloudbetEvent[] }> }>;
}

interface Tracked {
  sport: string;
  competitionKey: string;
  competitionName: string;
  ev: CloudbetEvent;
  live: boolean;
  seenAt: number;
}

export interface CloudbetOptions {
  /** Arquivo onde a pausa pedida num 429 sobrevive a reinícios (vazio = só em memória) */
  cooldownFile?: string;
  apiBase: string;
  siteUrl: string;
  lang: string;
  sports: string[];
  liveIntervalMs: number;
  allIntervalMs: number;
}

/** Chave de esporte da Cloudbet -> modalidade */
export const CLOUDBET_SPORTS: Record<string, Game> = {
  'counter-strike': 'cs2',
  'dota-2': 'dota2',
  'league-of-legends': 'lol',
  'esport-valorant': 'valorant',
  'rainbow-six': 'r6',
  overwatch: 'overwatch',
  'rocket-league': 'rl',
  'call-of-duty': 'cod',
  starcraft: 'sc2',
  'esport-king-of-glory': 'hok',
  'esport-arena-of-valor': 'aov',
};

const MARKETS = ['winner', 'map_handicap', 'total_maps', 'map_winner'];
/** Um evento some do store se nenhum dos dois ciclos o trouxer por este tempo. */
const FORGET_MS = 60_000;
/** Cadência do ciclo ao vivo quando não há nenhum jogo ao vivo. */
const IDLE_LIVE_INTERVAL_MS = 5_000;
/** Teto do multiplicador de intervalo após 429s seguidos. */
const MAX_SLOWDOWN = 8;
/** A cada resposta OK o multiplicador recua este tanto em direção a 1. */
const SLOWDOWN_DECAY = 0.97;

const jitter = (ms: number) => ms * (0.9 + Math.random() * 0.2);

/**
 * Segundos de pausa de um 429: header `Retry-After` ou o `retry_after` do JSON de erro da
 * Cloudflare (1015). Repetir antes disso só renova o bloqueio. Padrão 60s, teto 1h
 * (a Cloudflare chega a pedir ~50 min).
 */
export async function retryAfterSecs(res: Response): Promise<number> {
  let secs = Number(res.headers.get('retry-after'));
  if (!Number.isFinite(secs) || secs <= 0) {
    try {
      secs = Number(((await res.json()) as { retry_after?: number }).retry_after);
    } catch {
      secs = NaN;
    }
  }
  return Number.isFinite(secs) && secs > 0 ? Math.min(secs, 3600) : 60;
}

type TwoWayOdds = { a: number | null; b: number | null; suspended: boolean; maxA?: number; maxB?: number };

const param = (params: string, name: string): number => Number(new RegExp(`(?:^|&)${name}=(-?[\\d.]+)`).exec(params)?.[1]);

function pairOdds(x?: CloudbetSelection, y?: CloudbetSelection): TwoWayOdds | null {
  if (!x || !y) return null;
  const parse = (s: CloudbetSelection) => (Number.isFinite(s.price) && s.price > 1 ? s.price : null);
  const a = parse(x);
  const b = parse(y);
  const suspended = x.status !== 'SELECTION_ENABLED' || y.status !== 'SELECTION_ENABLED' || a === null || b === null;
  return { a, b, suspended, maxA: x.maxStake, maxB: y.maxStake };
}

/** Mercados de 2 vias do evento: vencedor, handicaps/totais x.5 e vencedor de cada mapa. */
export function cloudbetMarkets(sport: string, ev: CloudbetEvent): Array<TwoWayOdds & { spec: MarketSpec }> {
  const prefix = sport.replace(/-/g, '_');
  const out: Array<TwoWayOdds & { spec: MarketSpec }> = [];
  const selections = (market: string) =>
    Object.values(ev.markets?.[`${prefix}.${market}`]?.submarkets ?? {}).flatMap((s) => s.selections ?? []);
  /** Agrupa as seleções pelo `params` (cada linha é um par complementar). */
  const byParams = (sels: CloudbetSelection[]) => {
    const m = new Map<string, CloudbetSelection[]>();
    for (const s of sels) m.set(s.params, [...(m.get(s.params) ?? []), s]);
    return m;
  };

  const winner = selections('winner');
  // Com empate o mercado não é de 2 vias: não dá para cobrir com duas apostas.
  if (!winner.some((s) => s.outcome === 'draw')) {
    const odds = pairOdds(winner.find((s) => s.outcome === 'home'), winner.find((s) => s.outcome === 'away'));
    if (odds) out.push({ ...odds, spec: WINNER });
  }
  for (const [params, sels] of byParams(selections('map_handicap'))) {
    const line = param(params, 'handicap');
    if (!isHalfLine(line)) continue;
    const odds = pairOdds(sels.find((s) => s.outcome === 'home'), sels.find((s) => s.outcome === 'away'));
    if (odds) out.push({ ...odds, spec: { type: 'handicap', line } });
  }
  for (const [params, sels] of byParams(selections('total_maps'))) {
    const line = param(params, 'total');
    if (!isHalfLine(line)) continue;
    const odds = pairOdds(sels.find((s) => s.outcome === 'over'), sels.find((s) => s.outcome === 'under'));
    if (odds) out.push({ ...odds, spec: { type: 'total', line } });
  }
  for (const [params, sels] of byParams(selections('map_winner'))) {
    const n = param(params, 'map');
    if (!isMapNumber(n)) continue;
    const odds = pairOdds(sels.find((s) => s.outcome === 'home'), sels.find((s) => s.outcome === 'away'));
    if (odds) out.push({ ...odds, spec: { type: 'map', line: n } });
  }
  return out;
}

export class CloudbetSource implements Source {
  readonly name = 'cloudbet';
  private stopped = true;
  private readonly events = new Map<string, Tracked>();
  /** chave do quote -> assinatura das odds publicadas (evita updates redundantes) */
  private readonly published = new Map<string, string>();
  /** id do evento -> chaves publicadas */
  private readonly eventKeys = new Map<string, Set<string>>();
  private readonly latency = new Ewma();
  private readonly net = new NetStats();
  /** Até quando não consultar (429 com retry_after) */
  private cooldownUntil = 0;
  /** Multiplicador do intervalo: sobe a cada 429 e recua a cada resposta OK */
  private slowdown = 1;
  private lastFullAt = 0;
  private lastOkAt?: number;
  private state: SourceStatus['state'] = 'idle';
  private detail?: string;
  private readonly log = createLogger('cloudbet');

  constructor(
    private readonly store: OddsStore,
    private readonly opts: CloudbetOptions,
  ) {}

  start(): void {
    this.stopped = false;
    this.state = 'connecting';
    this.cooldownUntil = this.readCooldown();
    void this.loop();
  }

  stop(): void {
    this.stopped = true;
  }

  status(): SourceStatus {
    return {
      book: 'cloudbet',
      state: this.state,
      quotes: this.store.count('cloudbet'),
      lastMessageAt: this.lastOkAt,
      detail: this.detail,
      latencyMs: this.latency.value,
      ...this.net.fields(),
    };
  }

  private url(live: boolean): string {
    const u = new URL(`${this.opts.apiBase}/sports/events`);
    u.searchParams.set('limit', '999');
    u.searchParams.set('locale', this.opts.lang);
    u.searchParams.set('include-all-event-types', 'false');
    // Sem `live` vêm todos os jogos (ao vivo e pré-jogo).
    if (live) u.searchParams.set('live', 'true');
    for (const s of this.opts.sports) {
      u.searchParams.append('sports', s);
      for (const m of MARKETS) u.searchParams.append('markets', `${s.replace(/-/g, '_')}.${m}`);
    }
    return u.toString();
  }

  private readCooldown(): number {
    if (!this.opts.cooldownFile) return 0;
    try {
      const until = Number(JSON.parse(readFileSync(this.opts.cooldownFile, 'utf8')).until);
      return Number.isFinite(until) && until > Date.now() ? until : 0;
    } catch {
      return 0;
    }
  }

  private saveCooldown(): void {
    if (!this.opts.cooldownFile) return;
    try {
      mkdirSync(dirname(this.opts.cooldownFile), { recursive: true });
      writeFileSync(this.opts.cooldownFile, JSON.stringify({ until: this.cooldownUntil }));
    } catch (err) {
      this.log.warn(`não consegui gravar ${this.opts.cooldownFile}`, err);
    }
  }

  /** Espera a pausa pedida pela Cloudflare, com a casa marcada como indisponível. */
  private async waitCooldown(): Promise<void> {
    const pause = this.cooldownUntil - Date.now();
    if (pause <= 0) return;
    const until = new Date(this.cooldownUntil).toLocaleTimeString('pt-BR');
    this.state = 'degraded';
    this.detail = `Cloudbet pediu pausa (429) até ${until}`;
    // Sem consultar, as odds em memória envelhecem: nenhuma oportunidade deve usá-las.
    this.store.setAvailable('cloudbet', false);
    this.log.warn(`pausado até ${until} (${Math.round(pause / 1000)}s), como pedido no 429`);
    while (!this.stopped && Date.now() < this.cooldownUntil) {
      await sleep(Math.min(5_000, this.cooldownUntil - Date.now()));
    }
  }

  /**
   * Ciclo único: nunca há duas requisições em voo. A lista completa sai a cada `allIntervalMs`,
   * nas demais voltas só o ao vivo. O tempo da requisição é descontado da espera.
   */
  private async loop(): Promise<void> {
    const liveUrl = this.url(true);
    const allUrl = this.url(false);
    let failures = 0;
    while (!this.stopped) {
      await this.waitCooldown();
      if (this.stopped) break;
      const startedAt = Date.now();
      const full = startedAt - this.lastFullAt >= this.opts.allIntervalMs;
      try {
        const res = await fetch(full ? allUrl : liveUrl, {
          headers: { accept: 'application/json' },
          signal: AbortSignal.timeout(15_000),
        });
        this.net.record(res.status);
        if (res.status === 429) {
          const secs = await retryAfterSecs(res);
          this.cooldownUntil = Date.now() + secs * 1000;
          this.slowdown = Math.min(MAX_SLOWDOWN, this.slowdown * 2);
          this.saveCooldown();
          this.log.warn(`HTTP 429: pausa de ${secs}s; intervalo agora ${this.slowdown.toFixed(1)}x o normal`);
          continue;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as CloudbetResponse;
        this.latency.add(Date.now() - startedAt);
        this.ingest(body, !full);
        if (full) this.lastFullAt = startedAt;

        failures = 0;
        this.slowdown = Math.max(1, this.slowdown * SLOWDOWN_DECAY);
        this.lastOkAt = Date.now();
        if (this.state !== 'connected') {
          this.state = 'connected';
          this.store.setAvailable('cloudbet', true);
        }
        const liveCount = [...this.events.values()].filter((t) => t.live).length;
        const slow = this.slowdown > 1.05 ? ` · ritmo ${this.slowdown.toFixed(1)}x mais lento após 429` : '';
        this.detail = `${this.events.size} eventos · ${liveCount} ao vivo${slow}`;
        // Sem jogo ao vivo o ciclo desacelera; a lista completa detecta o próximo que começar.
        const base = liveCount === 0 ? Math.max(this.opts.liveIntervalMs, IDLE_LIVE_INTERVAL_MS) : this.opts.liveIntervalMs;
        await sleep(Math.max(0, jitter(base * this.slowdown) - (Date.now() - startedAt)));
      } catch (err) {
        failures++;
        this.log.warn(`feed ${full ? 'geral' : 'ao vivo'} falhou (${failures}x)`, err);
        if (failures >= 3) {
          this.state = 'error';
          this.detail = (err as Error).message;
          this.store.setAvailable('cloudbet', false);
        }
        await sleep(backoffDelay(failures - 1, this.opts.liveIntervalMs * this.slowdown, 30_000));
      }
    }
  }

  private ingest(body: CloudbetResponse, live: boolean): void {
    const now = Date.now();
    const seen = new Set<string>();
    for (const sport of body.sports ?? []) {
      if (!CLOUDBET_SPORTS[sport.key]) continue;
      for (const comp of sport.competitions ?? []) {
        for (const ev of comp.events ?? []) {
          if (ev.type && ev.type !== 'EVENT_TYPE_EVENT') continue;
          const id = String(ev.id);
          seen.add(id);
          const prev = this.events.get(id);
          // O ciclo ao vivo é mais recente: o geral não sobrescreve um evento que o ao vivo acabou de trazer.
          if (!live && prev?.live && now - prev.seenAt < this.opts.allIntervalMs) continue;
          this.events.set(id, { sport: sport.key, competitionKey: comp.key, competitionName: comp.name, ev, live, seenAt: now });
          this.sync(id);
        }
      }
    }
    for (const [id, t] of this.events) {
      if (seen.has(id)) continue;
      // Saiu do ao vivo (acabou ou ainda está no geral): marca como não-ao-vivo para o geral assumir.
      if (live && t.live) t.live = false;
      if (now - t.seenAt > FORGET_MS || (!live && !t.live)) {
        this.events.delete(id);
        this.sync(id);
      }
    }
  }

  private sync(id: string): void {
    const eventKey = `cloudbet:${id}`;
    const t = this.events.get(id);
    const ev = t?.ev;
    const keys = new Set<string>();
    if (t && ev?.home?.name && ev.away?.name) {
      const game = CLOUDBET_SPORTS[t.sport];
      const tradable = ev.status === 'TRADING' || ev.status === 'TRADING_LIVE';
      for (const odds of cloudbetMarkets(t.sport, ev)) {
        const fields = derivedQuoteFields(eventKey, odds.spec, ev.home.name, ev.away.name);
        keys.add(fields.key);
        const suspended = odds.suspended || !tradable;
        const sig = `${odds.a}|${odds.b}|${suspended}|${odds.maxA}|${odds.maxB}`;
        const prev = this.store.get(fields.key);
        // Sem mudança só renova o carimbo (mantém o quote "fresco" sem disparar reavaliações).
        if (this.published.get(fields.key) === sig && prev) {
          prev.updatedAt = Date.now();
          continue;
        }
        this.published.set(fields.key, sig);
        this.store.upsert({
          ...this.baseQuote(t, game),
          ...fields,
          oddsA: odds.a,
          oddsB: odds.b,
          maxStakeA: odds.maxA,
          maxStakeB: odds.maxB,
          suspended,
        });
      }
    }
    for (const key of this.eventKeys.get(id) ?? []) {
      if (keys.has(key)) continue;
      this.published.delete(key);
      this.store.remove(key);
    }
    if (keys.size) this.eventKeys.set(id, keys);
    else this.eventKeys.delete(id);
  }

  private baseQuote(t: Tracked, game: Game): Omit<Quote, 'key' | 'eventKey' | 'market' | 'oddsA' | 'oddsB'> {
    const ev = t.ev;
    const home = ev.home!.name;
    const away = ev.away!.name;
    // A rota do site usa a chave da competição sem o prefixo do esporte.
    const comp = t.competitionKey.startsWith(`${t.sport}-`) ? t.competitionKey.slice(t.sport.length + 1) : t.competitionKey;
    const start = ev.startTime ? Date.parse(ev.startTime) : NaN;
    return {
      book: 'cloudbet',
      marketId: String(ev.id),
      game,
      league: t.competitionName,
      eventName: `${home} vs ${away} - ${t.competitionName}`,
      teamA: home,
      teamB: away,
      startTime: Number.isFinite(start) ? start : undefined,
      url: `${this.opts.siteUrl}/${this.opts.lang}/esports/${t.sport}/${comp}/${ev.id}`,
      updatedAt: Date.now(),
    };
  }
}
