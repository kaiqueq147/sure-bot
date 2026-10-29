import { lookup } from "node:dns/promises";
import { readFileSync } from "node:fs";
import type { OddsStore } from "../core/OddsStore.js";
import { backoffDelay, createLogger, sleep } from "../core/logger.js";
import { Ewma } from "../core/Health.js";
import { NetStats } from "./netStats.js";
import { hotEvents } from "../core/hotEvents.js";
import {
  derivedQuoteFields,
  isHalfLine,
  isMapNumber,
  isHandicapType,
  WINNER,
} from "../core/markets.js";
import type {
  Game,
  MarketSpec,
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
    if (res.status === 403 || res.status === 503) {
      throw new StakeBlockedError(`Cloudflare bloqueou (HTTP ${res.status})`);
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
        throw new StakeBlockedError(
          `Cloudflare bloqueou (HTTP ${res.status}${json ? "" : ", página HTML"})`,
        );
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
      throw new StakeBlockedError(
        `Cloudflare bloqueou (HTTP ${res.status}${json ? "" : ", página HTML"})`,
      );
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
        this.detail = `${this.fixtures.size} eventos · ${liveCount} ao vivo`;
        const wait = liveCount === 0 ? Math.max(intervalMs, IDLE_INTERVAL_MS) : intervalMs;
        await sleep(Math.max(0, wait - (Date.now() - startedAt)));
      } catch (err) {
        failures++;
        const blocked = err instanceof StakeBlockedError;
        this.log.warn(`feed falhou (${failures}x)`, err);
        if (blocked || failures >= 3) {
          this.state = "error";
          this.detail = blocked
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
    const t = this.fixtures.get(id);
    const keys = new Set<string>();
    const [home, away] = (t?.fx.data?.competitors ?? []).map((c) => c.name);
    const game = t && STAKE_SPORTS[t.sport];
    if (t && game && home && away) {
      const tradable = !CLOSED.has(t.fx.status);
      for (const odds of stakeMarkets(t.fx)) {
        const fields = derivedQuoteFields(eventKey, odds.spec, home, away);
        keys.add(fields.key);
        const suspended = odds.suspended || !tradable;
        const sig = `${odds.a}|${odds.b}|${suspended}`;
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
