import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { OddsStore } from '../core/OddsStore.js';
import { backoffDelay, createLogger, sleep } from '../core/logger.js';
import { Ewma } from '../core/Health.js';
import { derivedQuoteFields, WINNER } from '../core/markets.js';
import { detectGame } from '../matching/normalize.js';
import type { Game, Quote, Source, SourceStatus } from '../types.js';
import { extractThunderpick, parseWsFrame, slugify, type LineMarket, type ParsedMatch } from './thunderpickExtract.js';

export interface ThunderpickOptions {
  mode: 'browser' | 'poll';
  pageUrls: string[];
  apiUrl: string;
  pollIntervalMs: number;
  responseFilter: RegExp;
  matchUrlTemplate: string;
  headless: boolean;
  /** Janela real, posicionada fora da área visível da tela */
  offscreen: boolean;
  profileDir: string;
  refreshMs: number;
  /** Recarrega a página inteira neste intervalo mesmo com o fetch funcionando */
  reloadMs: number;
  watchdogMs: number;
  captureDir: string;
}

const log = createLogger('thunderpick');

interface SnapshotCall {
  url: string;
  method: string;
  body?: string;
  contentType?: string;
  matches: number;
}
const ORIGIN = 'https://thunderpick.io';

/** Segmento de modalidade usado nas URLs de partida (observado no site). */
const GAME_URL_SEGMENT: Partial<Record<Game, string>> = {
  cs2: 'cs2-betting',
  dota2: 'dota-2',
  lol: 'league-of-legends',
};

/* eslint-disable @typescript-eslint/no-explicit-any */
type BrowserContext = any;
type Page = any;

async function loadPlaywright(): Promise<any> {
  const name = 'playwright';
  try {
    return await import(name);
  } catch {
    throw new Error('Playwright não instalado. Rode: npm i playwright && npx playwright install chromium');
  }
}

export class ThunderpickSource implements Source {
  readonly name = 'thunderpick';
  private stopped = true;
  private context?: BrowserContext;
  private lastDataAt = 0;
  private state: SourceStatus['state'] = 'idle';
  private detail?: string;
  /** chave do quote -> id do mercado de vencedor */
  private readonly winnerMarket = new Map<string, string | undefined>();
  /** id do mercado de handicap/total -> chave do quote */
  private readonly lineMarkets = new Map<string, string>();
  /** chave do quote de vencedor -> ids dos mercados de handicap/total publicados */
  private readonly eventLines = new Map<string, Set<string>>();
  /** Ida e volta do fetch do snapshot feito de dentro da página */
  private readonly latency = new Ewma();
  /** aba -> chamadas de API que trouxeram partidas completas (repetidas no lugar do reload) */
  private readonly snapshotCalls = new WeakMap<Page, SnapshotCall[]>();
  /** id da partida -> link real coletado do DOM */
  private readonly links = new Map<string, string>();

  constructor(
    private readonly store: OddsStore,
    private readonly opts: ThunderpickOptions,
  ) {}

  start(): void {
    this.stopped = false;
    if (this.opts.mode === 'poll') {
      if (!this.opts.apiUrl) throw new Error('THUNDERPICK_MODE=poll exige THUNDERPICK_API_URL');
      void this.runPolling();
    } else {
      void this.runBrowser();
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.context?.close().catch(() => undefined);
  }

  status(): SourceStatus {
    return {
      book: 'thunderpick',
      state: this.state,
      quotes: this.store.count('thunderpick'),
      lastMessageAt: this.lastDataAt || undefined,
      detail: this.detail,
      latencyMs: this.latency.value,
    };
  }

  // ------------------------------------------------------------------ ingestão

  /** Retorna quantas partidas completas vieram no payload. */
  private ingest(payload: unknown, pageUrl: string, origin: string): number {
    const { matches, patches, linePatches, hidden } = extractThunderpick(payload, { defaultGame: gameFromUrl(pageUrl) });
    if (!matches.length && !patches.length && !linePatches.length && !hidden.length) return 0;

    const now = Date.now();
    this.lastDataAt = now;
    for (const m of matches) {
      const key = `thunderpick:${m.id}`;
      this.winnerMarket.set(key, m.marketId);
      const winner = this.toQuote(m, key, pageUrl, now);
      this.store.upsert(winner);
      if (m.lines) this.syncLines(winner, m.lines);
    }
    for (const p of linePatches) {
      const known = this.lineMarkets.get(p.marketId);
      const key = derivedQuoteFields(`thunderpick:${p.id}`, p.spec, '', '').key;
      // Linha mudou no delta: o quote antigo some e o novo entra no próximo payload completo.
      if (!known) continue;
      if (known !== key) {
        this.removeLine(p.marketId);
        continue;
      }
      this.store.patch(key, { oddsA: p.oddsA, oddsB: p.oddsB, suspended: p.suspended, updatedAt: now });
    }
    for (const h of hidden) {
      const lineKey = this.lineMarkets.get(h.marketId);
      if (lineKey) this.store.patch(lineKey, { suspended: true, updatedAt: now });
    }
    for (const p of patches) {
      const key = `thunderpick:${p.id}`;
      if (!this.winnerMarket.has(key)) continue;
      const known = this.winnerMarket.get(key);
      if (known && p.marketId && known !== p.marketId) continue;
      this.store.patch(key, { oddsA: p.oddsA, oddsB: p.oddsB, suspended: p.suspended, updatedAt: now });
    }
    for (const h of hidden) {
      const key = `thunderpick:${h.id}`;
      if (this.winnerMarket.get(key) === h.marketId) this.store.patch(key, { suspended: true, updatedAt: now });
    }

    if (this.state !== 'connected') {
      this.state = 'connected';
      this.store.setAvailable('thunderpick', true);
    }
    this.detail = `último payload: ${origin}`;
    void this.capture(origin, payload);
    return matches.length;
  }

  /** Publica os handicaps/totais da partida e remove os que saíram da lista. */
  private syncLines(winner: Quote, lines: LineMarket[]): void {
    const fresh = new Set<string>();
    for (const l of lines) {
      const fields = derivedQuoteFields(winner.key, l.spec, winner.teamA, winner.teamB);
      fresh.add(l.marketId);
      if (this.lineMarkets.get(l.marketId) !== fields.key) this.removeLine(l.marketId);
      this.lineMarkets.set(l.marketId, fields.key);
      this.store.upsert({ ...winner, ...fields, oddsA: l.oddsA, oddsB: l.oddsB, suspended: l.suspended });
    }
    for (const marketId of this.eventLines.get(winner.key) ?? []) {
      if (!fresh.has(marketId)) this.removeLine(marketId);
    }
    this.eventLines.set(winner.key, fresh);
  }

  private removeLine(marketId: string): void {
    const key = this.lineMarkets.get(marketId);
    if (!key) return;
    this.lineMarkets.delete(marketId);
    this.store.remove(key);
  }

  private toQuote(m: ParsedMatch, key: string, pageUrl: string, now: number): Quote {
    return {
      key,
      eventKey: key,
      market: WINNER,
      book: 'thunderpick',
      marketId: m.id,
      game: m.game,
      league: m.league,
      eventName: m.league ? `${m.teamA} vs ${m.teamB} - ${m.league}` : `${m.teamA} vs ${m.teamB}`,
      teamA: m.teamA,
      teamB: m.teamB,
      startTime: m.startTime,
      oddsA: m.oddsA,
      oddsB: m.oddsB,
      suspended: m.suspended,
      url: this.matchUrl(m, pageUrl),
      updatedAt: now,
    };
  }

  private matchUrl(m: ParsedMatch, pageUrl: string): string {
    const harvested = this.links.get(m.id);
    if (harvested) return harvested;
    if (m.url?.startsWith('http')) return m.url;
    if (m.url?.startsWith('/')) return ORIGIN + m.url;
    if (this.opts.matchUrlTemplate) {
      return this.opts.matchUrlTemplate
        .replace('{slug}', encodeURIComponent(m.slug ?? m.id))
        .replace('{id}', encodeURIComponent(m.id))
        .replace('{game}', m.game);
    }
    // Formato do site: /esports/{modalidade}/{campeonato}/{idCampeonato}/{casa}-vs-{fora}/{idPartida}
    const segment = GAME_URL_SEGMENT[m.game];
    if (segment && m.league && m.competitionId) {
      return `${ORIGIN}/esports/${segment}/${slugify(m.league)}/${m.competitionId}/${slugify(m.teamA)}-vs-${slugify(m.teamB)}/${m.id}`;
    }
    return pageUrl;
  }

  private async capture(origin: string, payload: unknown): Promise<void> {
    if (!this.opts.captureDir) return;
    try {
      await mkdir(this.opts.captureDir, { recursive: true });
      const file = path.join(this.opts.captureDir, `thunderpick-${new Date().toISOString().slice(0, 10)}.ndjson`);
      await appendFile(file, JSON.stringify({ at: new Date().toISOString(), origin, payload }) + '\n');
    } catch (err) {
      log.warn('falha ao gravar captura', err);
    }
  }

  // ------------------------------------------------------------- modo browser

  private async runBrowser(): Promise<void> {
    let attempt = 0;
    while (!this.stopped) {
      const startedAt = Date.now();
      try {
        await this.browserSession();
        log.warn(`navegador encerrado após ${Math.round((Date.now() - startedAt) / 1000)}s`);
        if (Date.now() - startedAt > 60_000) attempt = 0;
      } catch (err) {
        this.state = 'error';
        this.detail = (err as Error).message;
        log.error('sessão do navegador falhou', err);
      }
      this.store.setAvailable('thunderpick', false);
      if (this.stopped) break;
      if (this.state !== 'error') this.state = 'disconnected';
      const delay = backoffDelay(attempt++, 2_000, 60_000);
      log.info(`reiniciando navegador em ${delay}ms`);
      await sleep(delay);
    }
  }

  private async browserSession(): Promise<void> {
    const pw = await loadPlaywright();
    this.state = 'connecting';
    // Perfil persistente: cookies/sessão sobrevivem entre reinícios.
    const context: BrowserContext = await pw.chromium.launchPersistentContext(this.opts.profileDir, {
      headless: this.opts.headless,
      locale: 'en-US',
      viewport: { width: 1366, height: 900 },
      args: !this.opts.headless && this.opts.offscreen ? ['--window-position=-32000,-32000'] : [],
    });
    this.context = context;
    const timers: NodeJS.Timeout[] = [];

    try {
      const pages: Page[] = [];
      for (const [i, url] of this.opts.pageUrls.entries()) {
        const page: Page = context.pages()[i] ?? (await context.newPage());
        this.attach(page, url);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        await this.waitForChallenge(page);
        pages.push(page);
        log.info(`monitorando ${url}`);
      }
      this.lastDataAt = Date.now();

      await new Promise<void>((resolve) => {
        context.on('close', () => resolve());
        // Os deltas chegam pelo WebSocket interno; o snapshot completo (partidas novas/encerradas)
        // é renovado repetindo, de dentro da página, a mesma chamada de API que o site fez.
        // Recarregar a página derrubaria o WebSocket a cada ciclo.
        let lastReload = Date.now();
        let busy = false;
        timers.push(
          setInterval(async () => {
            if (busy) return;
            busy = true;
            try {
              for (const p of pages) {
                const due = Date.now() - lastReload > this.opts.reloadMs;
                if (!due && (await this.refetchSnapshot(p))) continue;
                await this.reloadPage(p, due ? 'renovação periódica' : 'snapshot indisponível sem recarregar');
                lastReload = Date.now();
              }
            } finally {
              busy = false;
            }
          }, this.opts.refreshMs),
        );
        timers.push(
          setInterval(() => {
            if (Date.now() - this.lastDataAt > this.opts.watchdogMs) {
              log.warn(`nenhum dado há ${this.opts.watchdogMs}ms, reiniciando navegador`);
              void context.close();
            }
          }, 10_000),
        );
      });
    } finally {
      timers.forEach(clearInterval);
      await context.close().catch(() => undefined);
      this.context = undefined;
    }
  }

  /**
   * Guarda as chamadas que trouxeram partidas. A lista completa vem de um `POST /api/matches`;
   * os GETs com `matchesIds` são partidas avulsas. Fica só o que cobre mais partidas.
   */
  private learnSnapshot(page: Page, call: SnapshotCall): void {
    const calls = this.snapshotCalls.get(page) ?? [];
    const id = `${call.method} ${call.url} ${call.body ?? ''}`;
    const known = calls.find((c) => `${c.method} ${c.url} ${c.body ?? ''}` === id);
    if (known) known.matches = Math.max(known.matches, call.matches);
    else {
      calls.push(call);
      const u = new URL(call.url);
      log.info(`snapshot de partidas: ${call.method} ${u.pathname}${u.search.length > 60 ? u.search.slice(0, 60) + '…' : u.search} (${call.matches})`);
    }
    // Chamadas que trazem bem menos que a maior são recortes dela.
    const best = Math.max(...calls.map((c) => c.matches));
    this.snapshotCalls.set(page, calls.filter((c) => c.matches >= best * 0.5).slice(0, 3));
  }

  /** Repete as chamadas de snapshot vistas nesta aba; a resposta passa pelo listener de `response`. */
  private async refetchSnapshot(page: Page): Promise<boolean> {
    const calls = this.snapshotCalls.get(page) ?? [];
    if (!calls.length) return false;
    const startedAt = Date.now();
    const statuses: number[] = await page
      .evaluate(
        (list: Array<Omit<SnapshotCall, 'matches'>>) =>
          Promise.all(
            list.map((c) =>
              fetch(c.url, {
                method: c.method,
                body: c.method === 'GET' ? undefined : c.body,
                credentials: 'include',
                headers: { accept: 'application/json', ...(c.contentType ? { 'content-type': c.contentType } : {}) },
              })
                .then((r) => r.status)
                .catch(() => 0),
            ),
          ),
        calls.map(({ url, method, body, contentType }) => ({ url, method, body, contentType })),
      )
      .catch(() => calls.map(() => 0));
    if (statuses.some((s) => s >= 200 && s < 300)) {
      this.latency.add(Date.now() - startedAt);
      return true;
    }
    log.warn(`snapshot via fetch falhou (HTTP ${statuses.join(', ')})`);
    return false;
  }

  private async reloadPage(page: Page, reason: string): Promise<void> {
    try {
      log.info(`recarregando a página (${reason})`);
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 });
      await this.waitForChallenge(page);
    } catch (e) {
      log.warn('reload falhou', e);
    }
  }

  /**
   * O Cloudflare apresenta uma página intermediária ("Just a moment...") para navegadores
   * automatizados/headless. Não tentamos burlá-la: com THUNDERPICK_HEADLESS=false o desafio
   * normalmente passa sozinho ou pode ser resolvido manualmente na janela aberta.
   */
  private async waitForChallenge(page: Page): Promise<void> {
    const isChallenge = async () => /just a moment|attention required/i.test(await page.title().catch(() => ''));
    if (!(await isChallenge())) return void (await this.harvestLinks(page));
    this.state = 'degraded';
    this.detail = this.opts.headless
      ? 'bloqueado pelo Cloudflare em modo headless; use THUNDERPICK_HEADLESS=false'
      : this.opts.offscreen
        ? 'desafio do Cloudflare exige interação: rode com THUNDERPICK_OFFSCREEN=false e resolva na janela'
        : 'aguardando desafio do Cloudflare na janela do navegador';
    log.warn(this.detail);
    const deadline = Date.now() + 5 * 60_000;
    while (Date.now() < deadline && !this.stopped) {
      await sleep(2_000);
      if (!(await isChallenge())) {
        log.info('desafio do Cloudflare concluído');
        await page.waitForLoadState('domcontentloaded').catch(() => undefined);
        await this.harvestLinks(page);
        return;
      }
    }
    throw new Error('desafio do Cloudflare não foi concluído');
  }

  private async harvestLinks(page: Page): Promise<void> {
    await sleep(3_000);
    const hrefs: string[] = await page
      .$$eval('a[href*="/esports/"]', (as: any[]) => as.map((a) => a.href as string))
      .catch(() => []);
    for (const href of hrefs) {
      const id = /\/(\d{5,})\/?$/.exec(href)?.[1];
      if (id) this.links.set(id, href);
    }
  }

  private attach(page: Page, pageUrl: string): void {
    page.on('response', async (res: any) => {
      try {
        const ct: string = res.headers()['content-type'] ?? '';
        if (!ct.includes('json') || !this.opts.responseFilter.test(res.url())) return;
        const url = new URL(res.url());
        const found = this.ingest(await res.json(), pageUrl, `http ${url.pathname}`);
        const req = res.request();
        if (found > 0) log.debug(`${req.method()} ${url.href} -> ${found} partidas`);
        if (found > 0 && url.origin === ORIGIN && ['GET', 'POST'].includes(req.method())) {
          this.learnSnapshot(page, {
            url: url.href,
            method: req.method(),
            body: req.postData() ?? undefined,
            contentType: req.headers()['content-type'],
            matches: found,
          });
        }
      } catch {
        // corpo indisponível (redirect, preflight etc.)
      }
    });

    page.on('websocket', (ws: any) => {
      log.info(`websocket interno detectado: ${ws.url()}`);
      ws.on('framereceived', (ev: { payload: string | Buffer }) => {
        const text = typeof ev.payload === 'string' ? ev.payload : ev.payload.toString('utf8');
        for (const json of parseWsFrame(text)) {
          const found = this.ingest(json, pageUrl, `ws ${new URL(ws.url()).pathname}`);
          if (found > 0) log.debug(`ws ${ws.url()} -> ${found} partidas`);
        }
      });
      ws.on('close', () => log.warn(`websocket interno fechado: ${ws.url()}`));
    });

    page.on('close', () => !this.stopped && log.warn('aba da Thunderpick foi fechada; mantenha a janela aberta (pode minimizar)'));
    page.on('crash', () => {
      log.error('página travou, reiniciando navegador');
      void this.context?.close();
    });
  }

  // ---------------------------------------------------------------- modo poll

  /**
   * GET direto do Node. Observação: o Cloudflare costuma responder 403 a clientes fora do
   * navegador; este modo só é útil com um endpoint/proxy próprio que você controle.
   */
  private async runPolling(): Promise<void> {
    let attempt = 0;
    this.state = 'connecting';
    while (!this.stopped) {
      try {
        const res = await fetch(this.opts.apiUrl, {
          headers: { accept: 'application/json' },
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        this.ingest(await res.json(), this.opts.pageUrls[0] ?? ORIGIN, `poll ${this.opts.apiUrl}`);
        attempt = 0;
        await sleep(this.opts.pollIntervalMs);
      } catch (err) {
        this.state = 'error';
        this.detail = (err as Error).message;
        this.store.setAvailable('thunderpick', false);
        const delay = backoffDelay(attempt++, this.opts.pollIntervalMs, 60_000);
        log.warn(`poll falhou, nova tentativa em ${delay}ms`, err);
        await sleep(delay);
      }
    }
  }
}

function gameFromUrl(url: string): Game | undefined {
  const g = detectGame(url.replace(/[-_/]/g, ' '));
  return g === 'other' ? undefined : g;
}
