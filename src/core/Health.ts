import type { OddsStore } from './OddsStore.js';
import type { BookId, SourceStatus } from '../types.js';

/** Média móvel exponencial; `value` fica indefinido até a primeira amostra. */
export class Ewma {
  value?: number;
  constructor(private readonly alpha = 0.2) {}
  add(x: number): void {
    if (!Number.isFinite(x)) return;
    this.value = this.value === undefined ? x : this.value + this.alpha * (x - this.value);
  }
}

export interface BookHealth {
  book: SourceStatus['book'];
  state: SourceStatus['state'];
  detail?: string;
  quotes: number;
  /** Atualizações de odds recebidas no último minuto */
  updatesPerMin: number;
  lastUpdateAt?: number;
  lastMessageAt?: number;
  /** Atraso do dado (Polymarket: carimbo do servidor; Duel: ida e volta do delta) */
  latencyMs?: number;
  /** % do tempo conectada desde a primeira conexão */
  uptimePct: number;
  /** Quedas (saída do estado `connected`) desde que o bot subiu */
  disconnects: number;
  lastDisconnectAt?: number;
  /** Duração somada das quedas */
  downtimeMs: number;
}

interface Track {
  connectedMs: number;
  downtimeMs: number;
  lastState?: SourceStatus['state'];
  lastSampleAt: number;
  disconnects: number;
  lastDisconnectAt?: number;
  /** contagem de updates por segundo (anel de 60 posições) */
  buckets: number[];
  bucketAt: number;
  lastUpdateAt?: number;
}

/** Saúde de cada casa: quedas, uptime, ritmo de atualizações e latência. */
export class HealthMonitor {
  private readonly tracks = new Map<string, Track>();
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly store: OddsStore,
    private readonly statuses: () => SourceStatus[],
  ) {}

  start(): void {
    this.store.on('update', (q) => this.countUpdate(q.book));
    this.timer = setInterval(() => this.sample(), 2_000);
  }

  stop(): void {
    clearInterval(this.timer);
  }

  private track(book: string, now = Date.now()): Track {
    let t = this.tracks.get(book);
    if (!t) {
      t = { connectedMs: 0, downtimeMs: 0, lastSampleAt: now, disconnects: 0, buckets: new Array(60).fill(0), bucketAt: Math.floor(now / 1000) };
      this.tracks.set(book, t);
    }
    return t;
  }

  private roll(t: Track, now: number): void {
    const sec = Math.floor(now / 1000);
    const steps = Math.min(60, sec - t.bucketAt);
    for (let i = 1; i <= steps; i++) t.buckets[(t.bucketAt + i) % 60] = 0;
    if (steps > 0) t.bucketAt = sec;
  }

  countUpdate(book: BookId, now = Date.now()): void {
    const t = this.track(book, now);
    this.roll(t, now);
    t.buckets[t.bucketAt % 60]++;
    t.lastUpdateAt = now;
  }

  sample(now = Date.now()): void {
    for (const s of this.statuses()) {
      const t = this.track(s.book, now);
      const dt = now - t.lastSampleAt;
      // A conexão inicial não conta como queda; depois dela, qualquer estado fora de `connected` conta.
      if (t.lastState === 'connected') t.connectedMs += dt;
      else if (t.connectedMs > 0 || t.disconnects > 0) t.downtimeMs += dt;
      if (t.lastState === 'connected' && s.state !== 'connected') {
        t.disconnects++;
        t.lastDisconnectAt = now;
      }
      t.lastState = s.state;
      t.lastSampleAt = now;
    }
  }

  list(now = Date.now()): BookHealth[] {
    return this.statuses().map((s) => {
      const t = this.track(s.book, now);
      this.roll(t, now);
      const tracked = t.connectedMs + t.downtimeMs;
      return {
        book: s.book,
        state: s.state,
        detail: s.detail,
        quotes: s.quotes,
        updatesPerMin: t.buckets.reduce((a, b) => a + b, 0),
        lastUpdateAt: t.lastUpdateAt,
        lastMessageAt: s.lastMessageAt,
        latencyMs: s.latencyMs,
        uptimePct: tracked > 0 ? (t.connectedMs / tracked) * 100 : s.state === 'connected' ? 100 : 0,
        disconnects: t.disconnects,
        lastDisconnectAt: t.lastDisconnectAt,
        downtimeMs: t.downtimeMs,
      };
    });
  }
}
