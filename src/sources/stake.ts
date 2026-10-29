import { lookup } from "node:dns/promises";
import { readFileSync } from "node:fs";
import type { OddsStore } from "../core/OddsStore.js";
import { backoffDelay, createLogger, sleep } from "../core/logger.js";
import { Ewma } from "../core/Health.js";
import { describeHttpError } from "./httpError.js";
import { NetStats } from "./netStats.js";
import { hotEvents } from "../core/hotEvents.js";
import {
  derivedQuoteFields,
  isHalfLine,
  isMapNumber,
  isHandicapType,
  marketKey,
  WINNER,
} from "../core/markets.js";
import type {
  Game,
  MarketSpec,
  MarketType,
  Quote,
  Source,
  SourceStatus,
} from "../types.js";

/**
 * Stake GraphQL com bypass de TLS fingerprint.
 * STAKE_USE_TLS_CLIENT=true → usa node-curl-impersonate (Chrome handshake real).
 * Continua suportando FlareSolverr e Playwright como fallback.
 */

export interface StakeOutcome {
  name: string;
  odds: number;
  active: boolean;
}

export interface StakeMarket {
  id: string;
  status: string;
  specifiers: string;
  outcomes: StakeOutcome[];
}

interface StakeGroup {
  name: string;
  templates: Array<{ extId: string; markets: StakeMarket[] }>;
}

export interface StakeFixture {
  id: string;
  slug: string;
  status: string;
  data?: { startTime?: string; competitors?: Array<{ name: string }> } | null;
  tournament?: {
    name: string;
    slug: string;
    category?: { slug: string } | null;
  } | null;
  main?: StakeGroup[];
  maps?: StakeGroup[];
}

interface StakeSport {
  slug: string;
  live?: StakeFixture[] | null;
  up?: StakeFixture[] | null;
}

export interface StakeResponse {
  data?: Record<string, StakeSport | null> | null;
  errors?: Array<{ message: string; path?: string[] }>;
}

interface Tracked {
  sport: string;
  fx: StakeFixture;
  live: boolean;
}

export interface StakeOptions {
  apiUrl: string;
  siteUrl: string;
  lang: string;
  sports: string[];
  intervalMs: number;
  cookie: string;
  cookieFile: string;
  accessToken: string;
  userAgent: string;
  flareSolverrUrl: string;
  usePlaywright: boolean;
  /** Usa node-curl-impersonate (TLS fingerprint de Chrome) */
  useTlsClient: boolean;
  /** Esportes tradicionais (slugs da Stake); vazio desliga. Ciclo próprio, só com o cliente TLS. */
  tradSports?: string[];
  /** Cadência do ao vivo dos esportes tradicionais */
  tradLiveIntervalMs?: number;
  /** Cadência do pré-jogo dos esportes tradicionais (paginado, o payload pesa) */
  tradPrematchIntervalMs?: number;
  /** Máximo de jogos de pré-jogo por esporte */
  tradPrematchMax?: number;
  /** Só pré-jogo que começa dentro desta janela (horas) */
  tradHorizonH?: number;
}

export const STAKE_SPORTS: Record<string, Game> = {
  "counter-strike": "cs2",
  "dota-2": "dota2",
  "league-of-legends": "lol",
  valorant: "valorant",
  "rainbow-six": "r6",
  overwatch: "overwatch",
  "rocket-league": "rl",
  "call-of-duty": "cod",
  "starcraft-2": "sc2",
  starcraft: "sc2",
  "king-of-glory": "hok",
  "arena-of-valor": "aov",
  "mobile-legends": "mlbb",
};

/** Slug da Stake -> esporte tradicional (aba "Esportes"). */
export const STAKE_TRAD_SPORTS: Record<string, Game> = {
  soccer: "soccer",
  basketball: "basketball",
  baseball: "baseball",
  tennis: "tennis",
  "american-football": "american_football",
};

/**
 * Grupos pedidos por esporte. Cada grupo traz templates inteiros (placar exato, combos...), então
 * só os que têm mercados usados: 40 jogos de futebol com "main" ~133 KB; com "goals" ~238 KB.
 */
const TRAD_GROUPS: Record<string, string[]> = {
  soccer: ["main"],
  basketball: ["main", "half"],
  "american-football": ["main", "half"],
  tennis: ["main"],
  baseball: ["main"],
};
/** A API recusa `limit` acima de 50 (numberLessEqual). */
const TRAD_PAGE = 50;

const FIXTURE_LIMIT = 50;
/** Quanto tempo reutilizar o IP resolvido antes de consultar o DNS de novo. */
const DNS_TTL_MS = 5 * 60_000;
/**
 * Pré-jogo muda pouco e pesa ~2/3 da resposta: a cada volta buscamos só o ao
 * vivo e a lista completa (ao vivo + pré-jogo) apenas a cada UPCOMING_EVERY_MS.
 */
const UPCOMING_EVERY_MS = 15_000;
/** Cadência quando não há jogo ao vivo (o pré-jogo segue a cada UPCOMING_EVERY_MS). */
const IDLE_INTERVAL_MS = 5_000;
/**
 * Eventos numa oportunidade aberta (hotEvents) são consultados à parte, um alias por fixture
 * numa só requisição (~300-400ms), nesta cadência; no máximo HOT_MAX por vez.
 */
const HOT_INTERVAL_MS = 500;
const HOT_MAX = 8;
const MIN_INTERVAL_MS = 1_000;
const CLOSED = new Set([
  "ended",
  "closed",
  "cancelled",
  "canceled",
  "suspended",
  "deactivated",
]);

const MARKETS = `markets { id status specifiers outcomes { active name odds } }`;
const FIXTURE_FIELDS = `id slug status
  data { ... on SportFixtureDataMatch { startTime competitors { name } } }
  tournament { name slug category { slug } }
  main: groups(groups: ["winner", "handicap", "total"], status: [active, suspended, deactivated]) {
    name templates(includeEmpty: false) { extId ${MARKETS} }
  }
  maps: groups(groups: ["maps"], status: [active, suspended, deactivated]) {
    name templates(includeEmpty: false) { extId ${MARKETS} }
  }`;

export function buildStakeQuery(sports: string[], upcoming = true): string {
  const list = (type: string) =>
    `fixtureList(type: ${type}, limit: $limit, offset: 0) { ${FIXTURE_FIELDS} }`;
  const up = upcoming ? ` up: ${list("upcoming")}` : "";
  const body = sports
    .map(
      (s, i) =>
        `s${i}: slugSport(sport: ${JSON.stringify(s)}) { slug live: ${list("live")}${up} }`,
    )
    .join("\n");
  return `query StakeEsports($limit: Int!) {\n${body}\n}`;
}

/** Só os eventos quentes, um alias por fixture (`h0`, `h1`, ...), na mesma requisição. */
export function buildHotQuery(fixtureIds: string[]): string {
  const body = fixtureIds
    .map((id, i) => `h${i}: sportFixture(fixtureId: ${JSON.stringify(id)}) { ${FIXTURE_FIELDS} }`)
    .join("\n");
  return `query StakeHot {\n${body}\n}`;
}

/**
 * Esportes tradicionais: um alias por esporte (`t0`, `t1`, ...) com os grupos de TRAD_GROUPS.
 * Os grupos ficam no alias `main` para reaproveitar `StakeFixture`.
 */
export function buildStakeSportsQuery(sports: string[], type: "live" | "upcoming", offset = 0): string {
  const body = sports
    .map((s, i) => {
      const groups = JSON.stringify(TRAD_GROUPS[s] ?? ["main"]);
      return `t${i}: slugSport(sport: ${JSON.stringify(s)}) { slug list: fixtureList(type: ${type}, limit: ${TRAD_PAGE}, offset: ${offset}) {
  id slug status
  data { ... on SportFixtureDataMatch { startTime competitors { name } } }
  tournament { name slug category { slug } }
  main: groups(groups: ${groups}, status: [active, suspended, deactivated]) { name templates(includeEmpty: false) { extId ${MARKETS} } }
} }`;
    })
    .join("\n");
  return `query StakeSports {\n${body}\n}`;
}

type Period = NonNullable<MarketSpec["period"]>;
/** teams = casa/fora; ou = mais/menos; yesno = sim/não; three = casa/empate/fora (`result3`) */
interface TradTemplate {
  type: MarketType;
  sel: "teams" | "ou" | "yesno" | "three";
  period?: Period;
  /** specifier exigido (ex.: só o 1º quarto) */
  only?: [string, string];
}

/** IDs Sportradar (`extId`) usados por esporte; o mesmo id muda de sentido entre esportes. */
const TRAD_TEMPLATES: Record<string, Record<string, TradTemplate>> = {
  soccer: {
    "11": { type: "dnb", sel: "teams" },
    "29": { type: "btts", sel: "yesno" },
    "75": { type: "btts", sel: "yesno", period: "h1" },
    "16": { type: "handicap", sel: "teams" },
    "18": { type: "total", sel: "ou" },
    "66": { type: "handicap", sel: "teams", period: "h1" },
    "68": { type: "total", sel: "ou", period: "h1" },
  },
  basketball: {
    "219": { type: "winner", sel: "teams" },
    "223": { type: "handicap", sel: "teams" },
    "225": { type: "total", sel: "ou" },
    "66": { type: "handicap", sel: "teams", period: "h1" },
    "68": { type: "total", sel: "ou", period: "h1" },
    "303": { type: "handicap", sel: "teams", period: "q1", only: ["quarternr", "1"] },
    "236": { type: "total", sel: "ou", period: "q1", only: ["quarternr", "1"] },
    // 3 vias (empate possível): tempo regulamentar, 1º tempo e 1º quarto
    "1": { type: "result3", sel: "three" },
    "60": { type: "result3", sel: "three", period: "h1" },
    "235": { type: "result3", sel: "three", period: "q1", only: ["quarternr", "1"] },
  },
  baseball: {
    "251": { type: "winner", sel: "teams" },
    "256": { type: "handicap", sel: "teams" },
    "258": { type: "total", sel: "ou" },
    "1124": { type: "winner", sel: "teams", period: "i5" },
  },
  tennis: {
    "186": { type: "winner", sel: "teams" },
    // Handicap e total de games (o 188 é handicap de sets: não entra)
    "187": { type: "handicap", sel: "teams" },
    "189": { type: "total", sel: "ou" },
    "202": { type: "winner", sel: "teams", period: "set1", only: ["setnr", "1"] },
    "203": { type: "handicap", sel: "teams", period: "set1", only: ["setnr", "1"] },
    "204": { type: "total", sel: "ou", period: "set1", only: ["setnr", "1"] },
  },
};
TRAD_TEMPLATES["american-football"] = TRAD_TEMPLATES.basketball;

type SportOdds = TwoWayOdds & { spec: MarketSpec; draw?: number | null };

/** 1X2: casa/fora pelo nome (não pela posição) e o empate ("Draw"); suspenso se faltar preço. */
function threeWayOdds(m: StakeMarket, home: string, away: string): (TwoWayOdds & { draw: number | null }) | null {
  const draw = m.outcomes.find((o) => /^draw$/i.test(o.name.trim()));
  const teams = m.outcomes.filter((o) => o !== draw);
  if (!draw || teams.length !== 2) return null;
  const odds = pairOdds(m, ...homeAway({ ...m, outcomes: teams }, home, away));
  if (!odds) return null;
  const d = m.status === "active" && Number.isFinite(draw.odds) && draw.odds > 1 ? draw.odds : null;
  return { ...odds, suspended: odds.suspended || !draw.active || d === null, draw: d };
}

/**
 * Mercados de 2 vias (e os de 3 vias, com `draw`) de um jogo de esporte tradicional.
 * Handicap: `hcp=<linha da casa>`; total: `total=<linha>`. Só linhas x.5.
 */
export function stakeSportMarkets(sport: string, fx: StakeFixture): SportOdds[] {
  const [home, away] = (fx.data?.competitors ?? []).map((c) => c.name);
  if (!home || !away) return [];
  const out: SportOdds[] = [];
  const templates = TRAD_TEMPLATES[sport] ?? {};
  const seen = new Set<string>();
  const markets = (extId: string) =>
    (fx.main ?? [])
      .flatMap((g) => g.templates.filter((t) => t.extId === extId).flatMap((t) => t.markets))
      // O mesmo template aparece em mais de um grupo (ex.: "main" e "winner").
      .filter((m) => !seen.has(`${extId}:${m.id}`) && seen.add(`${extId}:${m.id}`));

  if (sport === "soccer") {
    for (const m of markets("1")) {
      const odds = threeWayOdds(m, home, away);
      if (odds) out.push({ ...odds, spec: WINNER });
    }
  }

  for (const [extId, tpl] of Object.entries(templates)) {
    for (const m of markets(extId)) {
      const spec = specifiers(m.specifiers);
      if (tpl.only && spec[tpl.only[0]] !== tpl.only[1]) continue;
      const side = (re: RegExp) => m.outcomes.find((o) => re.test(o.name.trim()));
      let line: number | undefined;
      let odds: TwoWayOdds | null;
      if (tpl.sel === "three") {
        const three = threeWayOdds(m, home, away);
        if (three) out.push({ ...three, spec: tpl.period ? { type: tpl.type, period: tpl.period } : { type: tpl.type } });
        continue;
      }
      if (tpl.sel === "ou") {
        line = Number(spec.total);
        if (!isHalfLine(line)) continue;
        odds = pairOdds(m, side(/^over\b/i), side(/^under\b/i));
      } else if (tpl.sel === "yesno") {
        odds = pairOdds(m, side(/^yes$/i), side(/^no$/i));
      } else {
        if (tpl.type === "handicap") {
          line = Number(spec.hcp);
          if (!isHalfLine(line)) continue;
        }
        odds = pairOdds(m, ...homeAway(m, home, away));
      }
      if (!odds) continue;
      const ms: MarketSpec = { type: tpl.type };
      if (line !== undefined) ms.line = line;
      if (tpl.period) ms.period = tpl.period;
      out.push({ ...odds, spec: ms });
    }
  }
  return out;
}

/**
 * `markets.ts` ainda sem suporte a um tipo/período devolve uma chave que colide com outro
 * mercado (o `winner` do evento, ou o mesmo handicap do jogo inteiro): esses ficam de fora.
 */
export function marketKeySupported(spec: MarketSpec): boolean {
  const k = marketKey(spec);
  if (spec.type !== "winner" && k === "win") return false;
  if (spec.period && !k.includes(spec.period)) return false;
  return true;
}

export class StakeBlockedError extends Error {}

export interface CfSession {
  cookie: string;
  cfClearance?: string;
  userAgent: string;
  expiresAt: number;
}

interface FlareSolverrResponse {
  status: string;
  message?: string;
  solution?: {
    status: number;
    userAgent: string;
    cookies: Array<{ name: string; value: string }>;
  };
}

export const CF_SESSION_TTL_MS = 12 * 60_000;

export async function solveCloudflare(
  flareSolverrUrl: string,
  siteUrl: string,
): Promise<CfSession> {
  const res = await fetch(flareSolverrUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      cmd: "request.get",
      url: siteUrl,
      maxTimeout: 60_000,
    }),
    signal: AbortSignal.timeout(75_000),
  });
  if (!res.ok) throw new Error(`FlareSolverr HTTP ${res.status}`);
  const body = (await res.json()) as FlareSolverrResponse;
  const sol = body.solution;
  if (body.status !== "ok" || !sol)
    throw new Error(`FlareSolverr: ${body.message ?? body.status}`);
  if (!sol.cookies.length) throw new Error("FlareSolverr não devolveu cookies");
  return {
    cookie: sol.cookies.map((c) => `${c.name}=${c.value}`).join("; "),
    cfClearance: sol.cookies.find((c) => c.name === "cf_clearance")?.value,
    userAgent: sol.userAgent,
    expiresAt: Date.now() + CF_SESSION_TTL_MS,
  };
}

type TwoWayOdds = { a: number | null; b: number | null; suspended: boolean };

const specifiers = (s: string): Record<string, string> =>
  Object.fromEntries(
    s.split("|").map((kv) => kv.split("=") as [string, string]),
  );

const norm = (s: string) => s.trim().toLowerCase();

function pairOdds(
  m: StakeMarket,
  x?: StakeOutcome,
  y?: StakeOutcome,
): TwoWayOdds | null {
  if (m.status !== "active") return { a: null, b: null, suspended: true };
  if (!x || !y) return null;
  const parse = (o: StakeOutcome) =>
    Number.isFinite(o.odds) && o.odds > 1 ? o.odds : null;
  const a = parse(x);
  const b = parse(y);
  return {
    a,
    b,
    suspended: !x.active || !y.active || a === null || b === null,
  };
}

function homeAway(
  m: StakeMarket,
  home: string,
  away: string,
): [StakeOutcome?, StakeOutcome?] {
  if (m.outcomes.length !== 2) return [];
  const of = (team: string) =>
    m.outcomes.find(
      (o) =>
        norm(o.name) === norm(team) ||
        norm(o.name).startsWith(`${norm(team)} (`),
    );
  const h = of(home);
  const a = of(away);
  return h && a && h !== a ? [h, a] : [m.outcomes[0], m.outcomes[1]];
}

export function stakeMarkets(
  fx: StakeFixture,
): Array<TwoWayOdds & { spec: MarketSpec }> {
  const [home, away] = (fx.data?.competitors ?? []).map((c) => c.name);
  if (!home || !away) return [];
  const out: Array<TwoWayOdds & { spec: MarketSpec }> = [];
  const markets = (groups: StakeGroup[] | undefined, extId: string) =>
    (groups ?? []).flatMap((g) =>
      g.templates.filter((t) => t.extId === extId).flatMap((t) => t.markets),
    );

  for (const m of markets(fx.main, "1")) {
    if (specifiers(m.specifiers).way !== "two") continue;
    const odds = pairOdds(m, ...homeAway(m, home, away));
    if (odds) out.push({ ...odds, spec: WINNER });
  }
  for (const m of markets(fx.main, "2")) {
    const line = Number(specifiers(m.specifiers).handicap);
    if (!isHalfLine(line)) continue;
    const odds = pairOdds(m, ...homeAway(m, home, away));
    if (odds) out.push({ ...odds, spec: { type: "handicap", line } });
  }
  for (const m of markets(fx.main, "3")) {
    const line = Number(specifiers(m.specifiers).threshold);
    if (!isHalfLine(line)) continue;
    const side = (re: RegExp) => m.outcomes.find((o) => re.test(o.name));
    const odds = pairOdds(m, side(/^over\b/i), side(/^under\b/i));
    if (odds) out.push({ ...odds, spec: { type: "total", line } });
  }
  for (const m of markets(fx.maps, "6")) {
    const spec = specifiers(m.specifiers);
    const n = Number(spec.map);
    if (spec.way !== "two" || !isMapNumber(n)) continue;
    const odds = pairOdds(m, ...homeAway(m, home, away));
    if (odds) out.push({ ...odds, spec: { type: "map", line: n } });
  }

  // Mercados de um mapa. Handicap: `handicap=<linha da casa>|map=<n>`; total: `map=<n>|threshold=<linha>`.
  const perMap: Array<[string, MarketSpec["type"]]> = [
    ["11", "map_rounds_hcp"],
    ["24", "map_rounds_total"],
    ["95", "map_kills_hcp"],
    ["34", "map_kills_total"],
  ];
  for (const [extId, type] of perMap) {
    for (const m of markets(fx.maps, extId)) {
      const spec = specifiers(m.specifiers);
      const map = Number(spec.map);
      const line = Number(isHandicapType(type) ? spec.handicap : spec.threshold);
      if (!isMapNumber(map) || !isHalfLine(line)) continue;
      const side = (re: RegExp) => m.outcomes.find((o) => re.test(o.name));
      const odds = isHandicapType(type)
        ? pairOdds(m, ...homeAway(m, home, away))
        : pairOdds(m, side(/^over\b/i), side(/^under\b/i));
      if (odds) out.push({ ...odds, spec: { type, line, map } });
    }
  }
  return out;
}

export class StakeSource implements Source {
  readonly name = "stake";
  private stopped = true;
  private readonly fixtures = new Map<string, Tracked>();
  /** Esportes tradicionais: mapa à parte (o ingest dos eSports apaga o que não vê) */
  private readonly tradFixtures = new Map<string, Tracked>();
  private tradLastFullAt = 0;
  private readonly published = new Map<string, string>();
  private readonly fixtureKeys = new Map<string, Set<string>>();
  private readonly latency = new Ewma();
  private readonly net = new NetStats();
  private cookie: string;
  private cf?: CfSession;
  private cfPending?: Promise<CfSession>;
  private lastOkAt?: number;
  private state: SourceStatus["state"] = "idle";
  private detail?: string;
  private readonly log = createLogger("stake");

  private browser?: import("playwright").BrowserContext;
  private page?: import("playwright").Page;
  private http?: import("cuimp").CuimpHttp;
  private resolved?: { host: string; ip: string; at: number };
  /** true quando a requisição atual inclui o pré-jogo. */
  private full = true;
  private lastFullAt = 0;

  constructor(
    private readonly store: OddsStore,
    private readonly opts: StakeOptions,
  ) {
    this.cookie = opts.cookie;
    this.reloadCookie();
  }

  start(): void {
    this.stopped = false;
    this.state = "connecting";
    void this.loop();
    void this.hotLoop();
    void this.tradLoop();
  }

  stop(): void {
    this.stopped = true;
    this.browser?.close().catch(() => {});
  }

  status(): SourceStatus {
    return {
      book: "stake",
      state: this.state,
      quotes: this.store.count("stake"),
      lastMessageAt: this.lastOkAt,
      detail: this.detail,
      latencyMs: this.latency.value,
      ...this.net.fields(),
    };
  }

  private reloadCookie(): boolean {
    if (!this.opts.cookieFile) return false;
    try {
      const next = readFileSync(this.opts.cookieFile, "utf8").trim();
      if (!next || next === this.cookie) return false;
      this.cookie = next;
      return true;
    } catch (err) {
      this.log.warn(`não consegui ler ${this.opts.cookieFile}`, err);
      return false;
    }
  }

  private async cfSession(force = false): Promise<CfSession> {
    if (!force && this.cf && Date.now() < this.cf.expiresAt) return this.cf;
    this.cfPending ??= solveCloudflare(
      this.opts.flareSolverrUrl,
      this.opts.siteUrl,
    )
      .then((s) => {
        this.cf = s;
        this.log.info(
          `sessão Cloudflare renovada via FlareSolverr${s.cfClearance ? "" : " (sem cf_clearance)"}`,
        );
        return s;
      })
      .finally(() => (this.cfPending = undefined));
    return this.cfPending;
  }

  private async ensurePlaywright(): Promise<import("playwright").Page> {
    if (this.page && !this.page.isClosed()) return this.page;
    const { chromium } = await import("playwright");
    this.browser = await chromium.launchPersistentContext(
      "./stake-pw-profile",
      {
        headless: true,
        viewport: { width: 1280, height: 800 },
      },
    );
    this.page = await this.browser.newPage();
    await this.page.goto(this.opts.siteUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await this.page.waitForTimeout(3000);
    this.log.info("Playwright context pronto");
    return this.page;
  }

  /**
   * O resolvedor interno do curl-impersonate (c-ares) leva ~2s no Windows, tanto
   * no registro A quanto na busca do registro HTTPS para ECH. Resolvemos com o
   * DNS do sistema (cacheado) e desligamos ECH: ~2,4s → ~0,2s por requisição.
   */
  private async curlNetArgs(): Promise<string[]> {
    const args = ["--ech", "false"];
    const url = new URL(this.opts.apiUrl);
    const port = url.port || (url.protocol === "http:" ? "80" : "443");
    const r = this.resolved;
    if (!r || r.host !== url.hostname || Date.now() - r.at > DNS_TTL_MS) {
      try {
        const { address } = await lookup(url.hostname, { family: 4 });
        this.resolved = { host: url.hostname, ip: address, at: Date.now() };
      } catch (err) {
        this.log.warn(`DNS de ${url.hostname} falhou`, err);
        if (!r) return args;
      }
    }
    return [...args, "--resolve", `${url.hostname}:${port}:${this.resolved!.ip}`];
  }

  private async fetchWithTlsClient(
    body: import("cuimp").CuimpRequestConfig["data"] = {
      query: buildStakeQuery(this.opts.sports, this.full),
      variables: { limit: FIXTURE_LIMIT },
      operationName: "StakeEsports",
    },
  ): Promise<StakeResponse> {
    if (!this.http) {
      const { createCuimpHttp } = await import("cuimp");
      this.http = createCuimpHttp({
        descriptor: { browser: "chrome", version: "latest" },
      });
    }
    const cookie = this.cf?.cookie || this.cookie;

    const res = await this.http.post(
      this.opts.apiUrl,
      body,
      {
        extraCurlArgs: await this.curlNetArgs(),
        timeout: 15_000,
        headers: {
          "content-type": "application/json",
          origin: this.opts.siteUrl,
          referer: `${this.opts.siteUrl}/sports/esports`,
          "x-language": this.opts.lang,
          ...(cookie ? { cookie } : {}),
          ...(this.opts.accessToken
            ? { "x-access-token": this.opts.accessToken }
            : {}),
        },
      },
    );

    this.net.record(res.status);
    const html = typeof res.data === "string";
    if (res.status === 403 || res.status === 503 || html) {
      const body = res.rawBody?.toString("utf8") ?? "";
      throw new StakeBlockedError(
        `bloqueado no cliente TLS: ${describeHttpError(res.status, new Headers(res.headers), body)}`,
      );
    }
    return res.data as StakeResponse;
  }

  private async fetchOnce(): Promise<StakeResponse> {
    if (this.opts.useTlsClient) return this.fetchWithTlsClient();

    if (this.opts.usePlaywright) {
      const page = await this.ensurePlaywright();
      const result = await page.evaluate(
        async ({ apiUrl, query, variables, lang }) => {
          const res = await fetch(apiUrl, {
            method: "POST",
            headers: { "content-type": "application/json", "x-language": lang },
            body: JSON.stringify({
              query,
              variables,
              operationName: "StakeEsports",
            }),
          });
          const text = await res.text();
          return { status: res.status, body: text };
        },
        {
          apiUrl: this.opts.apiUrl,
          query: buildStakeQuery(this.opts.sports, this.full),
          variables: { limit: FIXTURE_LIMIT },
          lang: this.opts.lang,
        },
      );
      this.net.record(result.status);
      if (result.status === 403 || result.status === 503) {
        throw new StakeBlockedError(
          `Cloudflare bloqueou (HTTP ${result.status})`,
        );
      }
      try {
        return JSON.parse(result.body) as StakeResponse;
      } catch {
        throw new StakeBlockedError("Resposta não é JSON (provável challenge)");
      }
    }

    if (!this.opts.flareSolverrUrl) {
      // fetch puro (legado)
      const headers: Record<string, string> = {
        "content-type": "application/json",
        accept: "application/json",
        "user-agent": this.opts.userAgent,
        origin: this.opts.siteUrl,
        referer: `${this.opts.siteUrl}/sports/esports`,
        "x-language": this.opts.lang,
      };
      if (this.cookie)
        headers.cookie = this.cookie.includes("=")
          ? this.cookie
          : `cf_clearance=${this.cookie}`;
      if (this.opts.accessToken)
        headers["x-access-token"] = this.opts.accessToken;
      const res = await fetch(this.opts.apiUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({
          query: buildStakeQuery(this.opts.sports, this.full),
          variables: { limit: FIXTURE_LIMIT },
          operationName: "StakeEsports",
        }),
        signal: AbortSignal.timeout(15_000),
      });
      const json = (res.headers.get("content-type") ?? "").includes("json");
      this.net.record(res.status);
      if (res.status === 403 || res.status === 503 || !json) {
        const body = await res.text().catch(() => "");
        throw new StakeBlockedError(describeHttpError(res.status, res.headers, body));
      }
      return (await res.json()) as StakeResponse;
    }

    const s = await this.cfSession();
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json",
      "user-agent": s.userAgent,
      origin: this.opts.siteUrl,
      referer: `${this.opts.siteUrl}/sports/esports`,
      "x-language": this.opts.lang,
      cookie: s.cookie,
    };
    if (this.opts.accessToken)
      headers["x-access-token"] = this.opts.accessToken;
    const res = await fetch(this.opts.apiUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        query: buildStakeQuery(this.opts.sports, this.full),
        variables: { limit: FIXTURE_LIMIT },
        operationName: "StakeEsports",
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const json = (res.headers.get("content-type") ?? "").includes("json");
    this.net.record(res.status);
    if (res.status === 403 || res.status === 503 || !json) {
      const body = await res.text().catch(() => "");
      throw new StakeBlockedError(describeHttpError(res.status, res.headers, body));
    }
    return (await res.json()) as StakeResponse;
  }

  private async fetch(): Promise<StakeResponse> {
    try {
      return await this.fetchOnce();
    } catch (err) {
      if (!(err instanceof StakeBlockedError)) throw err;

      if (this.opts.useTlsClient && this.opts.flareSolverrUrl) {
        this.log.info("403 no TLS client: renovando sessão FlareSolverr");
        await this.cfSession(true);
      } else if (this.opts.usePlaywright && this.page) {
        this.log.info("403 no Playwright: recarregando página");
        await this.page
          .reload({ waitUntil: "domcontentloaded" })
          .catch(() => {});
        await this.page.waitForTimeout(2000);
      } else if (this.opts.flareSolverrUrl) {
        this.log.info("403: renovando sessão no FlareSolverr");
        await this.cfSession(true);
      } else if (this.reloadCookie()) {
        this.log.info("cookie atualizado, repetindo após o 403");
        await sleep(MIN_INTERVAL_MS);
      } else {
        throw err;
      }
      return this.fetchOnce();
    }
  }

  /**
   * Laço rápido só dos eventos quentes. Usa só o cliente TLS (os outros caminhos abrem navegador
   * ou FlareSolverr) e para enquanto o feed principal não estiver conectado.
   */
  private async hotLoop(): Promise<void> {
    let failures = 0;
    while (!this.stopped) {
      const startedAt = Date.now();
      const ids = hotEvents
        .idsFor("stake")
        .filter((id) => this.fixtures.has(id))
        .slice(0, HOT_MAX);
      if (!ids.length || !this.opts.useTlsClient || this.state !== "connected") {
        await sleep(HOT_INTERVAL_MS);
        continue;
      }
      try {
        const body = await this.fetchWithTlsClient({ query: buildHotQuery(ids), operationName: "StakeHot" });
        const data = (body.data ?? {}) as unknown as Record<string, StakeFixture | null>;
        ids.forEach((id, i) => {
          const fx = data[`h${i}`];
          const t = this.fixtures.get(id);
          if (!fx || !t) return;
          this.fixtures.set(id, { ...t, fx });
          this.sync(id);
        });
        failures = 0;
        await sleep(Math.max(0, HOT_INTERVAL_MS - (Date.now() - startedAt)));
      } catch (err) {
        failures++;
        if (failures === 1 || failures % 10 === 0) this.log.warn(`eventos quentes falharam (${failures}x)`, err);
        await sleep(backoffDelay(failures - 1, HOT_INTERVAL_MS, 30_000));
      }
    }
  }

  /**
   * Esportes tradicionais num ciclo próprio e mais lento que o dos eSports: o ao vivo de todos os
   * esportes numa requisição a cada `tradLiveIntervalMs`; o pré-jogo paginado a cada
   * `tradPrematchIntervalMs`, até `tradPrematchMax` jogos por esporte dentro de `tradHorizonH`.
   * Só com o cliente TLS e com o feed principal conectado (bloqueado, não insiste).
   */
  private async tradLoop(): Promise<void> {
    const sports = (this.opts.tradSports ?? []).filter((s) => s in STAKE_TRAD_SPORTS);
    if (!sports.length) return;
    const liveMs = Math.max(MIN_INTERVAL_MS, this.opts.tradLiveIntervalMs ?? 3_000);
    const fullMs = this.opts.tradPrematchIntervalMs ?? 60_000;
    let failures = 0;
    while (!this.stopped) {
      const startedAt = Date.now();
      if (!this.opts.useTlsClient || this.state !== "connected") {
        await sleep(liveMs);
        continue;
      }
      try {
        const live = await this.fetchSports(sports, "live", 0);
        this.ingestTrad(sports, live, true);
        if (startedAt - this.tradLastFullAt >= fullMs) {
          await this.loadTradPrematch(sports);
          this.tradLastFullAt = startedAt;
        }
        failures = 0;
        await sleep(Math.max(0, liveMs - (Date.now() - startedAt)));
      } catch (err) {
        failures++;
        if (failures === 1 || failures % 10 === 0) this.log.warn(`esportes tradicionais falharam (${failures}x)`, err);
        const blocked = err instanceof StakeBlockedError;
        await sleep(backoffDelay(failures - 1, liveMs, blocked ? 120_000 : 60_000));
      }
    }
  }

  private async fetchSports(sports: string[], type: "live" | "upcoming", offset: number): Promise<StakeResponse> {
    const body = await this.fetchWithTlsClient({
      query: buildStakeSportsQuery(sports, type, offset),
      operationName: "StakeSports",
    });
    if (!body.data) throw new Error(body.errors?.[0]?.message ?? "resposta sem data");
    return body;
  }

  /** Pré-jogo paginado: cada página leva só os esportes que ainda têm jogos dentro da janela. */
  private async loadTradPrematch(sports: string[]): Promise<void> {
    const max = this.opts.tradPrematchMax ?? 150;
    const horizon = Date.now() + (this.opts.tradHorizonH ?? 48) * 3_600_000;
    const lists = new Map<string, StakeFixture[]>(sports.map((s) => [s, []]));
    let pending = [...sports];
    for (let offset = 0; pending.length && offset < max; offset += TRAD_PAGE) {
      const body = await this.fetchSports(pending, "upcoming", offset);
      const next: string[] = [];
      pending.forEach((sport, i) => {
        const page = (body.data?.[`t${i}`] as unknown as { list?: StakeFixture[] } | null)?.list;
        if (!page) {
          lists.delete(sport); // falhou: mantém o que já havia desse esporte
          return;
        }
        const inWindow = page.filter((fx) => {
          const t = Date.parse(fx.data?.startTime ?? "");
          return !Number.isFinite(t) || t <= horizon;
        });
        lists.get(sport)!.push(...inWindow);
        if (page.length === TRAD_PAGE && inWindow.length === page.length) next.push(sport);
      });
      pending = next;
    }
    const seen = new Set<string>();
    for (const [sport, list] of lists) {
      for (const fx of list.slice(0, max)) {
        seen.add(fx.id);
        if (this.tradFixtures.get(fx.id)?.live) continue;
        this.tradFixtures.set(fx.id, { sport, fx, live: false });
        this.sync(fx.id);
      }
    }
    for (const [id, t] of this.tradFixtures) {
      if (t.live || seen.has(id) || !lists.has(t.sport)) continue;
      this.tradFixtures.delete(id);
      this.sync(id);
    }
  }

  /** Ao vivo: quem saiu da lista acabou (ou voltou ao pré-jogo, que o ciclo lento traz de novo). */
  private ingestTrad(sports: string[], body: StakeResponse, live: boolean): void {
    const seen = new Set<string>();
    const ok = new Set<string>();
    sports.forEach((sport, i) => {
      const list = (body.data?.[`t${i}`] as unknown as { list?: StakeFixture[] } | null)?.list;
      if (!list) return;
      ok.add(sport);
      for (const fx of list) {
        seen.add(fx.id);
        this.tradFixtures.set(fx.id, { sport, fx, live });
        this.sync(fx.id);
      }
    });
    for (const [id, t] of this.tradFixtures) {
      if (!t.live || seen.has(id) || !ok.has(t.sport)) continue;
      this.tradFixtures.delete(id);
      this.sync(id);
    }
  }

  private async loop(): Promise<void> {
    const intervalMs = Math.max(MIN_INTERVAL_MS, this.opts.intervalMs);
    let failures = 0;
    while (!this.stopped) {
      const startedAt = Date.now();
      this.full = startedAt - this.lastFullAt >= UPCOMING_EVERY_MS;
      try {
        const body = await this.fetch();
        this.latency.add(Date.now() - startedAt);
        if (!body.data)
          throw new Error(body.errors?.[0]?.message ?? "resposta sem data");
        if (body.errors?.length)
          this.log.warn(
            `resposta parcial: ${body.errors.map((e) => `${e.path?.join(".")}: ${e.message}`).join("; ")}`,
          );
        this.ingest(body, this.full);
        if (this.full) this.lastFullAt = startedAt;

        failures = 0;
        this.lastOkAt = Date.now();
        if (this.state !== "connected") {
          this.state = "connected";
          this.store.setAvailable("stake", true);
        }
        const liveCount = [...this.fixtures.values()].filter(
          (t) => t.live,
        ).length;
        const trad = this.tradFixtures.size ? ` · ${this.tradFixtures.size} de esportes` : "";
        this.detail = `${this.fixtures.size} eventos · ${liveCount} ao vivo${trad}`;
        const wait = liveCount === 0 ? Math.max(intervalMs, IDLE_INTERVAL_MS) : intervalMs;
        await sleep(Math.max(0, wait - (Date.now() - startedAt)));
      } catch (err) {
        failures++;
        const blocked = err instanceof StakeBlockedError;
        this.log.warn(`feed falhou (${failures}x)`, err);
        if (blocked || failures >= 3) {
          this.state = "error";
          this.detail =
            blocked && !this.opts.useTlsClient
              ? `${(err as Error).message} — tente STAKE_USE_TLS_CLIENT=true`
              : (err as Error).message;
          this.store.setAvailable("stake", false);
        }
        await sleep(
          backoffDelay(failures - 1, intervalMs, blocked ? 60_000 : 30_000),
        );
      }
    }
  }

  /** full=false: resposta só com ao vivo; o pré-jogo já rastreado é mantido. */
  private ingest(body: StakeResponse, full = true): void {
    const seen = new Set<string>();
    const failed = new Set<string>();
    this.opts.sports.forEach((sport, i) => {
      const s = body.data?.[`s${i}`];
      if (!s || !s.live || (full && !s.up)) {
        if (s !== null) failed.add(sport);
        return;
      }
      for (const [list, live] of [
        [s.live, true],
        [s.up ?? [], false],
      ] as const) {
        for (const fx of list) {
          if (seen.has(fx.id)) continue;
          seen.add(fx.id);
          this.fixtures.set(fx.id, { sport, fx, live });
          this.sync(fx.id);
        }
      }
    });
    for (const [id, t] of this.fixtures) {
      if (seen.has(id) || failed.has(t.sport) || (!full && !t.live)) continue;
      this.fixtures.delete(id);
      this.sync(id);
    }
  }

  private sync(id: string): void {
    const eventKey = `stake:${id}`;
    const t = this.fixtures.get(id) ?? this.tradFixtures.get(id);
    const keys = new Set<string>();
    const [home, away] = (t?.fx.data?.competitors ?? []).map((c) => c.name);
    const trad = !!t && t.sport in STAKE_TRAD_SPORTS;
    const game = t && (STAKE_SPORTS[t.sport] ?? STAKE_TRAD_SPORTS[t.sport]);
    if (t && game && home && away) {
      const tradable = !CLOSED.has(t.fx.status);
      const all: SportOdds[] = trad ? stakeSportMarkets(t.sport, t.fx) : stakeMarkets(t.fx);
      for (const odds of all) {
        if (!marketKeySupported(odds.spec)) continue;
        const fields = derivedQuoteFields(eventKey, odds.spec, home, away, game);
        if (keys.has(fields.key)) continue;
        keys.add(fields.key);
        const suspended = odds.suspended || !tradable;
        const sig = `${odds.a}|${odds.b}|${odds.draw}|${suspended}`;
        const prev = this.store.get(fields.key);
        if (this.published.get(fields.key) === sig && prev) {
          prev.updatedAt = Date.now();
          continue;
        }
        this.published.set(fields.key, sig);
        this.store.upsert({
          ...this.baseQuote(t, game, home, away),
          ...fields,
          oddsA: odds.a,
          oddsB: odds.b,
          // 1X2: presença de `oddsDraw` (mesmo null) marca o mercado como 3 vias.
          ...(odds.draw !== undefined ? { oddsDraw: odds.draw } : {}),
          suspended,
        });
      }
    }
    for (const key of this.fixtureKeys.get(id) ?? []) {
      if (keys.has(key)) continue;
      this.published.delete(key);
      this.store.remove(key);
    }
    if (keys.size) this.fixtureKeys.set(id, keys);
    else this.fixtureKeys.delete(id);
  }

  private baseQuote(
    t: Tracked,
    game: Game,
    home: string,
    away: string,
  ): Omit<Quote, "key" | "eventKey" | "market" | "oddsA" | "oddsB"> {
    const { fx } = t;
    const league = fx.tournament?.name;
    const start = fx.data?.startTime ? Date.parse(fx.data.startTime) : NaN;
    const path = [
      t.sport,
      fx.tournament?.category?.slug,
      fx.tournament?.slug,
      fx.slug,
    ]
      .filter(Boolean)
      .join("/");
    return {
      book: "stake",
      marketId: fx.id,
      game,
      league,
      eventName: league
        ? `${home} vs ${away} - ${league}`
        : `${home} vs ${away}`,
      teamA: home,
      teamB: away,
      startTime: Number.isFinite(start) ? start : undefined,
      url: `${this.opts.siteUrl}/sports/${path}`,
      updatedAt: Date.now(),
    };
  }
}
