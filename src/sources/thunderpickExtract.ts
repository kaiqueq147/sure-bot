import { detectGame } from '../matching/normalize.js';
import { isHalfLine, isMapNumber } from '../core/markets.js';
import type { Game, MarketSpec } from '../types.js';

/**
 * Extração de odds dos payloads internos da Thunderpick.
 *
 * Formato observado:
 *  - REST `GET /api/matches` -> `{ data: { upcoming: Match[], live: Match[] } }`, onde
 *    Match = { id, gameId, startTime, teams: { home, away }, competition, market, preferredMarkets[] }
 *  - SignalR `wss://thunderpick.io/ws/websockets`, frames `{type:1,target,arguments:[{type,data:{list}}]}`
 *    separados por \x1e, com mercados atualizados ({ eventId, id, name, selections[] }) e
 *    `marketsHidden` ({ id, eventId }) quando um mercado é suspenso/removido.
 *
 * Objetos que não seguem esse formato passam por uma heurística genérica
 * (dois competidores + mercado de 2 vias), útil se a casa mudar o schema.
 */

export interface ParsedMatch {
  id: string;
  /** id do mercado de vencedor da partida, quando conhecido */
  marketId?: string;
  teamA: string;
  teamB: string;
  oddsA: number | null;
  oddsB: number | null;
  suspended: boolean;
  game: Game;
  league?: string;
  competitionId?: string;
  gameId?: string;
  startTime?: number;
  slug?: string;
  url?: string;
  /** Handicap/total de mapas; `undefined` quando o payload não traz a lista de mercados */
  lines?: LineMarket[];
}

/** Handicap (linha relativa ao time da casa) ou total de mapas (A = mais, B = menos) */
export interface LineMarket {
  marketId: string;
  spec: MarketSpec;
  oddsA: number | null;
  oddsB: number | null;
  suspended: boolean;
}

export interface OddsPatch {
  /** id da partida */
  id: string;
  marketId?: string;
  oddsA: number | null;
  oddsB: number | null;
  suspended: boolean;
}

export interface LinePatch extends LineMarket {
  /** id da partida */
  id: string;
}

export interface HiddenMarket {
  id: string;
  marketId: string;
}

type Rec = Record<string, unknown>;

/** gameId da Thunderpick -> modalidade (observado em /api/matches) */
export const THUNDERPICK_GAME_IDS: Record<string, Game> = {
  '1': 'overwatch',
  '2': 'sc2',
  '3': 'lol',
  '4': 'dota2',
  '6': 'cs2',
  '23': 'r6',
  '32': 'valorant',
  '39': 'aov',
  '41': 'mlbb',
};

const isObj = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' && Number.isFinite(v) ? String(v) : undefined;

const ODDS_KEYS = ['odds', 'decimalOdds', 'decimal', 'price', 'coefficient', 'coef', 'rate', 'value'];
const START_KEYS = ['startTime', 'start_time', 'startDate', 'start_date', 'startsAt', 'starts_at', 'scheduledAt', 'scheduled_at', 'beginAt', 'begin_at', 'kickoff'];
const TEAM_LIST_KEYS = ['teams', 'competitors', 'participants', 'opponents', 'contestants'];
const MARKET_KEYS = ['market', 'mainMarket', 'main_market', 'matchWinner', 'match_winner', 'moneyline', 'winner', 'odds'];
const WINNER_MARKET = /winner|moneyline|match|1x2|^ml$|result/i;
const PARTIAL_MARKET = /\b(map|game|round|half|period|set|quarter)\s*#?\d|handicap|total|over|under|first|overtime|pointers/i;

const isWinnerName = (name: unknown) => {
  const s = String(name ?? '');
  return WINNER_MARKET.test(s) && !PARTIAL_MARKET.test(s) && !/1x2/i.test(s);
};

function nameOf(t: unknown, depth = 0): string | undefined {
  if (typeof t === 'string') return t.trim() || undefined;
  if (!isObj(t) || depth > 2) return undefined;
  return (
    str(t.name) ?? str(t.title) ?? str(t.displayName) ?? str(t.shortName) ??
    nameOf(t.team, depth + 1) ?? nameOf(t.opponent, depth + 1) ?? nameOf(t.participant, depth + 1)
  );
}

export function oddsOf(x: unknown, depth = 0): number | undefined {
  let n: number | undefined;
  if (typeof x === 'number') n = x;
  else if (typeof x === 'string' && x.trim() !== '' && !Number.isNaN(Number(x))) n = Number(x);
  else if (isObj(x) && depth < 2) {
    for (const k of ODDS_KEYS) {
      if (x[k] === undefined) continue;
      n = oddsOf(x[k], depth + 1);
      if (n !== undefined) break;
    }
  }
  return n !== undefined && Number.isFinite(n) && n > 1 && n < 1000 ? n : undefined;
}

/** Thunderpick usa status numérico (1 = aberto); outras fontes usam flags/strings. */
function isSuspended(x: unknown): boolean {
  if (!isObj(x)) return false;
  if (typeof x.status === 'number') return x.status !== 1;
  return (
    x.suspended === true || x.isSuspended === true || x.locked === true || x.isLocked === true ||
    x.disabled === true || /suspend|lock|closed|settled/i.test(String(x.status ?? x.state ?? ''))
  );
}

function readTeams(o: Rec): [string, string] | null {
  const pairs: Array<[unknown, unknown]> = [];
  for (const k of TEAM_LIST_KEYS) {
    const v = o[k];
    if (Array.isArray(v) && v.length === 2) pairs.push([v[0], v[1]]);
    else if (isObj(v)) pairs.push([v.home, v.away], [v.team1, v.team2], [v['1'], v['2']]);
  }
  pairs.push(
    [o.homeTeam, o.awayTeam], [o.home_team, o.away_team], [o.team1, o.team2],
    [o.teamA, o.teamB], [o.home, o.away], [o.competitor1, o.competitor2],
  );
  for (const [x, y] of pairs) {
    const a = nameOf(x);
    const b = nameOf(y);
    if (a && b && a !== b) return [a, b];
  }
  return null;
}

interface TwoWay {
  a: number | null;
  b: number | null;
  suspended: boolean;
  marketId?: string;
}

function selectionsTwoWay(arr: unknown[], teams?: [string, string]): TwoWay | undefined {
  if (arr.length !== 2) return undefined;
  let [x, y] = arr;
  const tx = isObj(x) ? x.type : undefined;
  if (tx === 'away' || tx === 'draw') [x, y] = [y, x];
  else if (teams && tx !== 'home') {
    const nx = nameOf(x)?.toLowerCase();
    if (nx && nx === teams[1].toLowerCase()) [x, y] = [y, x];
  }
  if ([x, y].some((s) => isObj(s) && s.type === 'draw')) return undefined;
  const a = oddsOf(x);
  const b = oddsOf(y);
  const suspended = isSuspended(x) || isSuspended(y);
  if ((a && b) || (suspended && (a || b || isObj(x)))) return { a: a ?? null, b: b ?? null, suspended };
  return undefined;
}

function twoWay(m: unknown, teams?: [string, string]): TwoWay | undefined {
  if (Array.isArray(m)) return selectionsTwoWay(m, teams);
  if (!isObj(m)) return undefined;
  const marketId = str(m.id);

  for (const [hk, ak, dk] of [['home', 'away', 'draw'], ['1', '2', 'x'], ['team1', 'team2', 'draw']] as const) {
    if (m[hk] === undefined || m[ak] === undefined) continue;
    if (oddsOf(m[dk]) !== undefined) return undefined; // mercado de 3 vias
    const a = oddsOf(m[hk]);
    const b = oddsOf(m[ak]);
    const suspended = isSuspended(m) || isSuspended(m[hk]) || isSuspended(m[ak]);
    if ((a && b) || suspended) return { a: a ?? null, b: b ?? null, suspended, marketId };
  }
  for (const k of ['selections', 'outcomes', 'odds', 'options', 'runners', 'prices']) {
    const arr = m[k];
    if (Array.isArray(arr)) {
      const r = selectionsTwoWay(arr, teams);
      if (r) return { ...r, suspended: r.suspended || isSuspended(m), marketId };
    }
  }
  return undefined;
}

function readOdds(o: Rec, teams?: [string, string]): TwoWay | undefined {
  const markets: unknown[] = [];
  for (const k of MARKET_KEYS) if (o[k] !== undefined) markets.push(o[k]);
  for (const k of ['preferredMarkets', 'markets']) {
    const list = o[k];
    if (!Array.isArray(list)) continue;
    const ms = list.filter(isObj);
    const named = ms.filter((m) => isSeriesMarket(m) && isWinnerName(m.name ?? m.nickName ?? m.type ?? m.title));
    markets.push(...(named.length ? named : ms.length === 1 && k === 'markets' ? ms : []));
  }
  for (const m of markets) {
    if (isObj(m) && m.name !== undefined && !isWinnerName(m.name) && !isWinnerName(m.nickName)) continue;
    const r = twoWay(m, teams);
    if (r) return r;
  }
  const a = oddsOf(o.homeOdds ?? o.odds1 ?? o.home_odds);
  const b = oddsOf(o.awayOdds ?? o.odds2 ?? o.away_odds);
  if (a && b) return { a, b, suspended: isSuspended(o) };
  return undefined;
}

const MATCH_HANDICAP = /^match handicap$/i;
const TOTAL_MAPS = /^total maps( played)?( over\/under)?$/i;
const MAP_WINNER = /winner/i;
const NOT_MAP_WINNER = /handicap|total|round|half|first|kill|odd|even|tower|baron|dragon|roshan|pistol/i;

/** Número do mapa de um mercado parcial (`period.type = 'map'` ou "... - Map N"); `undefined` = série. */
function mapNumber(m: Rec): number | undefined {
  if (isObj(m.period)) return m.period.type === 'map' ? Number(m.period.number) : NaN;
  if (m.period !== null && m.period !== undefined) return NaN;
  const n = /\bmap\s*#?(\d+)\b/i.exec(String(m.name ?? ''))?.[1];
  return n ? Number(n) : undefined;
}

/** Mercado da série inteira (sem período de mapa/round). */
const isSeriesMarket = (m: Rec) => (m.period === null || m.period === undefined) && mapNumber(m) === undefined;

/**
 * "Match Handicap": selections com `type` home/away e `handicap` próprio (o da casa é a linha A).
 * "Total Maps Played Over/Under": `baseLine` + selections Over/Under. Só a série inteira (`period` nulo).
 */
export function readLineMarket(m: Rec): LineMarket | undefined {
  const marketId = str(m.id);
  const sels = Array.isArray(m.selections) ? m.selections.filter(isObj) : [];
  if (!marketId || sels.length !== 2) return undefined;
  const names = [m.name, m.nickName].map((n) => String(n ?? '').trim());

  // Vencedor do mapa N: `period: { type: 'map', number: N }`, selections home/away.
  const map = mapNumber(m);
  if (map !== undefined) {
    if (!isMapNumber(map) || !names.some((n) => MAP_WINNER.test(n) && !NOT_MAP_WINNER.test(n))) return undefined;
    const home = sels.find((s) => s.type === 'home');
    const away = sels.find((s) => s.type === 'away');
    if (!home || !away) return undefined;
    return lineOdds(marketId, { type: 'map', line: map }, home, away, m);
  }
  if (m.period !== null && m.period !== undefined) return undefined;

  if (names.some((n) => MATCH_HANDICAP.test(n))) {
    const home = sels.find((s) => s.type === 'home');
    const away = sels.find((s) => s.type === 'away');
    const line = Number(home?.handicap);
    if (!home || !away || !isHalfLine(line)) return undefined;
    return lineOdds(marketId, { type: 'handicap', line }, home, away, m);
  }
  if (names.some((n) => TOTAL_MAPS.test(n))) {
    const over = sels.find((s) => /^over$/i.test(String(s.name ?? '')));
    const under = sels.find((s) => /^under$/i.test(String(s.name ?? '')));
    const line = Number(m.baseLine ?? over?.total);
    if (!over || !under || !isHalfLine(line)) return undefined;
    return lineOdds(marketId, { type: 'total', line }, over, under, m);
  }
  return undefined;
}

function lineOdds(marketId: string, spec: MarketSpec, x: Rec, y: Rec, m: Rec): LineMarket {
  const a = oddsOf(x) ?? null;
  const b = oddsOf(y) ?? null;
  const suspended = isSuspended(m) || isSuspended(x) || isSuspended(y) || a === null || b === null;
  return { marketId, spec, oddsA: a, oddsB: b, suspended };
}

function readLines(o: Rec): LineMarket[] | undefined {
  let lists = 0;
  const out: LineMarket[] = [];
  for (const k of ['preferredMarkets', 'markets']) {
    const list = o[k];
    if (!Array.isArray(list)) continue;
    lists++;
    for (const m of list.filter(isObj)) {
      const l = readLineMarket(m);
      if (l) out.push(l);
    }
  }
  return lists ? out : undefined;
}

function readStart(o: Rec): number | undefined {
  for (const k of START_KEYS) {
    const v = o[k];
    if (typeof v === 'number' && v > 0) return v < 1e12 ? v * 1000 : v;
    if (typeof v === 'string') {
      const t = Date.parse(v);
      if (Number.isFinite(t)) return t;
    }
  }
  return undefined;
}

function readGame(o: Rec, fallback?: Game): Game {
  const byId = THUNDERPICK_GAME_IDS[str(o.gameId) ?? ''];
  if (byId) return byId;
  const g = o.game ?? o.videogame ?? o.discipline ?? o.sport ?? o.category;
  const hint = nameOf(g) ?? str(o.gameName) ?? str(o.gameSlug) ?? nameOf(isObj(o.tournament) ? o.tournament.game : undefined);
  const game = detectGame(hint, nameOf(o.competition), nameOf(o.tournament));
  return game === 'other' && fallback ? fallback : game;
}

export function extractThunderpick(payload: unknown, opts: { defaultGame?: Game } = {}) {
  const matches: ParsedMatch[] = [];
  const patches: OddsPatch[] = [];
  const linePatches: LinePatch[] = [];
  const hidden: HiddenMarket[] = [];
  const seen = new WeakSet<object>();

  const visit = (node: unknown, depth: number) => {
    if (depth > 12 || node === null || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const x of node) visit(x, depth + 1);
      return;
    }
    const o = node as Rec;

    if (o.type === 'marketsHidden' && isObj(o.data) && Array.isArray(o.data.list)) {
      for (const h of o.data.list.filter(isObj)) {
        const id = str(h.eventId);
        const marketId = str(h.id);
        if (id && marketId) hidden.push({ id, marketId });
      }
      return;
    }

    const teams = readTeams(o);
    if (teams) {
      const odds = readOdds(o, teams);
      if (odds) {
        const startTime = readStart(o);
        const competition = isObj(o.competition) ? o.competition : undefined;
        const id = str(o.id) ?? str(o.matchId) ?? str(o.match_id) ?? str(o.eventId) ?? str(o.event_id);
        matches.push({
          id: id ?? `${teams[0]}|${teams[1]}|${startTime ?? ''}`,
          marketId: odds.marketId,
          teamA: teams[0],
          teamB: teams[1],
          oddsA: odds.a,
          oddsB: odds.b,
          suspended: odds.suspended || (typeof o.status !== 'number' && isSuspended(o)),
          game: readGame(o, opts.defaultGame),
          league: nameOf(o.competition) ?? nameOf(o.tournament) ?? nameOf(o.league) ?? str(o.tournamentName),
          competitionId: str(competition?.id),
          gameId: str(o.gameId),
          startTime,
          slug: str(o.slug),
          url: str(o.url) ?? str(o.link) ?? str(o.path),
          lines: readLines(o),
        });
        return;
      }
    } else if (o.eventId !== undefined && Array.isArray(o.selections)) {
      // Delta de mercado vindo do WebSocket: o id da partida é `eventId`.
      const id = str(o.eventId);
      if (id && isSeriesMarket(o) && (isWinnerName(o.name) || isWinnerName(o.nickName))) {
        const r = twoWay(o);
        if (r) patches.push({ id, marketId: str(o.id), oddsA: r.a, oddsB: r.b, suspended: r.suspended });
      } else if (id) {
        const l = readLineMarket(o);
        if (l) linePatches.push({ ...l, id });
      }
      return;
    } else {
      const id = str(o.id) ?? str(o.matchId) ?? str(o.match_id);
      const odds = id ? readOdds(o) : undefined;
      if (id && odds) patches.push({ id, marketId: odds.marketId, oddsA: odds.a, oddsB: odds.b, suspended: odds.suspended });
    }

    for (const v of Object.values(o)) visit(v, depth + 1);
  };

  visit(payload, 0);
  return { matches, patches, linePatches, hidden };
}

export function slugify(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Decodifica frames WebSocket: JSON puro, socket.io (`42["evt",{...}]`) ou SignalR (separador \x1e). */
export function parseWsFrame(frame: string): unknown[] {
  const out: unknown[] = [];
  for (const part of frame.split('\x1e')) {
    const s = part.trim();
    if (!s) continue;
    const candidates = [s, s.replace(/^\d+/, '')];
    for (const c of candidates) {
      if (!c.startsWith('{') && !c.startsWith('[')) continue;
      try {
        out.push(JSON.parse(c));
        break;
      } catch {
        // tenta o próximo formato
      }
    }
  }
  return out;
}
