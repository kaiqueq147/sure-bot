try {
  process.loadEnvFile();
} catch {
  // .env é opcional
}

const env = (key: string, fallback = ""): string =>
  process.env[key]?.trim() || fallback;
const num = (key: string, fallback: number): number => {
  const v = Number(process.env[key]);
  return Number.isFinite(v) && process.env[key]?.trim() ? v : fallback;
};
const bool = (key: string, fallback: boolean): boolean => {
  const v = process.env[key]?.trim().toLowerCase();
  if (!v) return fallback;
  return ["1", "true", "yes", "on"].includes(v);
};
const list = (key: string, fallback: string): string[] =>
  env(key, fallback)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const volume = process.env.RAILWAY_VOLUME_MOUNT_PATH?.trim().replace(
  /[\\/]+$/,
  "",
);
const configuredDb = process.env.DB_PATH?.trim();
/** No Railway, o caminho local padrão vai para o volume, se existir um montado. */
const dbPath =
  volume && (!configuredDb || configuredDb === "data/sure-bot.db")
    ? `${volume}/sure-bot.db`
    : configuredDb || "data/sure-bot.db";

export const config = {
  port: num("PORT", 3000),
  host: env("HOST", "0.0.0.0"),
  simulator: process.argv.includes("--simulator") || bool("SIMULATOR", false),

  polymarket: {
    enabled: bool("POLYMARKET_ENABLED", true),
    gammaUrl: env("POLYMARKET_GAMMA_URL", "https://gamma-api.polymarket.com"),
    wsUrl: env(
      "POLYMARKET_WS_URL",
      "wss://ws-subscriptions-clob.polymarket.com/ws/market",
    ),
    tagSlugs: list("POLYMARKET_TAG_SLUGS", "esports"),
    discoveryIntervalMs: num("POLYMARKET_DISCOVERY_INTERVAL_MS", 60_000),
    commissionPct: num("POLYMARKET_COMMISSION_PCT", 0),
    /** A odd publicada é o preço médio para comprar este valor (US$): ignora ordens de centavos no topo do livro */
    minFillUsd: num("POLYMARKET_MIN_FILL_USD", 10),
    /** Níveis do livro enviados ao dashboard para o cálculo de lucro pela banca */
    depthLevels: num("POLYMARKET_DEPTH_LEVELS", 15),
  },

  thunderpick: {
    enabled: bool("THUNDERPICK_ENABLED", true),
    mode: env("THUNDERPICK_MODE", "browser") as "browser" | "poll",
    pageUrls: list("THUNDERPICK_PAGE_URLS", "https://thunderpick.io/esports"),
    apiUrl: env("THUNDERPICK_API_URL"),
    pollIntervalMs: num("THUNDERPICK_POLL_INTERVAL_MS", 3_000),
    responseFilter: new RegExp(
      env("THUNDERPICK_RESPONSE_FILTER", "thunderpick"),
      "i",
    ),
    matchUrlTemplate: env("THUNDERPICK_MATCH_URL_TEMPLATE"),
    headless: bool("THUNDERPICK_HEADLESS", false),
    offscreen: bool("THUNDERPICK_OFFSCREEN", true),
    profileDir: env("THUNDERPICK_PROFILE_DIR", ".thunderpick-profile"),
    refreshMs: num("THUNDERPICK_REFRESH_MS", 30_000),
    reloadMs: num("THUNDERPICK_RELOAD_MS", 30 * 60_000),
    watchdogMs: num("THUNDERPICK_WATCHDOG_MS", 120_000),
    staleMs: num("THUNDERPICK_STALE_MS", 45_000),
    commissionPct: num("THUNDERPICK_COMMISSION_PCT", 0),
    captureDir: env("THUNDERPICK_CAPTURE_DIR"),
  },

  duel: {
    enabled: bool("DUEL_ENABLED", true),
    book: "duel" as const,
    apiBase: env(
      "DUEL_API_BASE",
      "https://api-a-c7818b61-600.sptpub.com/api/v4",
    ),
    brandId: env("DUEL_BRAND_ID", "2482975601191952386"),
    siteUrl: env("DUEL_SITE_URL", "https://duel.com"),
    lang: env("DUEL_LANG", "en"),
    liveIntervalMs: num("DUEL_LIVE_INTERVAL_MS", 1_000),
    prematchIntervalMs: num("DUEL_PREMATCH_INTERVAL_MS", 3_000),
    commissionPct: num("DUEL_COMMISSION_PCT", 0),
  },

  cloudbet: {
    enabled: bool("CLOUDBET_ENABLED", true),
    apiBase: env(
      "CLOUDBET_API_BASE",
      "https://www.cloudbet.com/sports-api/c/v6",
    ),
    siteUrl: env("CLOUDBET_SITE_URL", "https://www.cloudbet.com"),
    lang: env("CLOUDBET_LANG", "en"),
    sports: list(
      "CLOUDBET_SPORTS",
      "counter-strike,dota-2,league-of-legends,esport-valorant,rainbow-six,overwatch,rocket-league,call-of-duty,starcraft,esport-king-of-glory,esport-arena-of-valor",
    ),
    /** Intervalo entre requisições (só os jogos ao vivo, payload pequeno) */
    liveIntervalMs: num("CLOUDBET_LIVE_INTERVAL_MS", 1_500),
    /** A cada quanto uma das voltas busca todos os jogos (pré-jogo muda pouco e pesa mais) */
    allIntervalMs: num("CLOUDBET_ALL_INTERVAL_MS", 15_000),
    /** Pausa pedida pela Cloudflare num 429, preservada entre reinícios */
    cooldownFile: env(
      "CLOUDBET_COOLDOWN_FILE",
      volume ? `${volume}/cloudbet-cooldown.json` : "data/cloudbet-cooldown.json",
    ),
    staleMs: num("CLOUDBET_STALE_MS", 20_000),
    commissionPct: num("CLOUDBET_COMMISSION_PCT", 0),
  },

  stake: {
    enabled: bool("STAKE_ENABLED", true),
    apiUrl: env("STAKE_API_URL", "https://stake.com/_api/graphql"),
    siteUrl: env("STAKE_SITE_URL", "https://stake.com"),
    lang: env("STAKE_LANG", "en"),
    sports: list(
      "STAKE_SPORTS",
      "counter-strike,dota-2,league-of-legends,valorant,rainbow-six,overwatch,rocket-league,call-of-duty,starcraft-2,king-of-glory,arena-of-valor,mobile-legends",
    ),
    useTlsClient: process.env.STAKE_USE_TLS_CLIENT === "true",
    /** Uma requisição traz todos os jogos (ao vivo + pré-jogo); nunca abaixo de 1s */
    intervalMs: num("STAKE_INTERVAL_MS", 1_000),
    /** Cookie completo ou só o valor do cf_clearance */
    cookie: env("STAKE_COOKIE") || env("STAKE_CF_CLEARANCE"),
    /** Arquivo com o cookie, relido a cada 403 (para trocar o cf_clearance sem reiniciar) */
    cookieFile: env("STAKE_COOKIE_FILE"),
    accessToken: env("STAKE_ACCESS_TOKEN"),
    /** FlareSolverr (ex.: http://localhost:8191/v1): gera cookies + User-Agent e renova num 403 */
    flareSolverrUrl: env("STAKE_FLARESOLVERR_URL"),
    userAgent: env(
      "STAKE_USER_AGENT",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    ),
    usePlaywright: process.env.STAKE_USE_PLAYWRIGHT === "true",
    staleMs: num("STAKE_STALE_MS", 20_000),
    commissionPct: num("STAKE_COMMISSION_PCT", 0),
  },

  db: {
    enabled: bool("DB_ENABLED", true),
    path: dbPath,
    retentionDays: num("DB_RETENTION_DAYS", 90),
  },

  engine: {
    minProfitPct: num("MIN_PROFIT_PCT", 0),
    maxProfitPct: num("MAX_PROFIT_PCT", 15),
    confirmMs: num("CONFIRM_MS", 1_500),
    matchThreshold: num("MATCH_THRESHOLD", 0.78),
    maxStartDiffMs: num("MAX_START_DIFF_MS", 6 * 3600_000),
    /** Ao vivo: preço parado por este tempo enquanto a outra casa se mexe vira aviso de odd congelada (0 desliga) */
    frozenMs: num("ENGINE_FROZEN_MS", 30_000),
  },

  ev: {
    /** EV mínimo (%) para uma seleção aparecer na aba EV */
    minEvPct: num("EV_MIN_PCT", 0),
    /** Acima disso o card avisa que provavelmente é erro de pareamento ou odd congelada */
    warnEvPct: num("EV_WARN_PCT", 20),
    /**
     * Casas com margem (1/oA + 1/oB − 1) acima disso não entram no consenso: em livros finos da
     * Polymarket o spread chega a 30–80% e a probabilidade "sem margem" deixa de significar algo.
     */
    maxOverroundPct: num("EV_MAX_OVERROUND_PCT", 12),
    /** Mínimo de outras casas no consenso para calcular a odd justa (1 = aceita uma só) */
    minConsensusBooks: num("EV_MIN_CONSENSUS_BOOKS", 2),
    frozenMs: num("ENGINE_FROZEN_MS", 30_000),
  },
};

export type AppConfig = typeof config;
