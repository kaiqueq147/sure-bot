import type { OddsStore } from './OddsStore.js';

/** [timestamp, odd A, odd B]; odd nula = sem preço ou suspenso */
export type HistorySample = [number, number | null, number | null];

export interface OddsHistoryOptions {
  windowMs: number;
  /** Amostras mais próximas que isto substituem a anterior (o livro da Polymarket muda várias vezes por segundo) */
  resolutionMs: number;
  maxSamples: number;
}

/** Série temporal das odds de cada quote, em memória, para os gráficos do dashboard. */
export class OddsHistory {
  private readonly series = new Map<string, HistorySample[]>();
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly store: OddsStore,
    private readonly opts: OddsHistoryOptions = { windowMs: 3 * 3_600_000, resolutionMs: 5_000, maxSamples: 720 },
  ) {}

  start(): void {
    this.store.on('update', (q) => {
      const live = !q.suspended && q.oddsA && q.oddsB;
      this.record(q.key, live ? q.oddsA : null, live ? q.oddsB : null, q.updatedAt);
    });
    this.timer = setInterval(() => this.prune(), 60_000);
  }

  stop(): void {
    clearInterval(this.timer);
  }

  record(key: string, a: number | null, b: number | null, t = Date.now()): void {
    let s = this.series.get(key);
    if (!s) this.series.set(key, (s = []));
    const last = s[s.length - 1];
    if (last && last[1] === a && last[2] === b) return;
    const prev = s[s.length - 2];
    // Mantém o primeiro ponto de cada janela de resolução para o gráfico não perder o "antes".
    if (last && prev && last[0] - prev[0] < this.opts.resolutionMs) s[s.length - 1] = [t, a, b];
    else s.push([t, a, b]);
    if (s.length > this.opts.maxSamples) s.splice(0, s.length - this.opts.maxSamples);
  }

  entries(): IterableIterator<[string, HistorySample[]]> {
    return this.series.entries();
  }

  get(keys: string[]): Record<string, HistorySample[]> {
    const out: Record<string, HistorySample[]> = {};
    for (const k of keys) out[k] = this.series.get(k) ?? [];
    return out;
  }

  private prune(now = Date.now()): void {
    const min = now - this.opts.windowMs;
    for (const [key, s] of this.series) {
      const i = s.findIndex((x) => x[0] >= min);
      // Guarda o último ponto anterior à janela: é o valor vigente no início do gráfico.
      if (i === -1) {
        if (!this.store.get(key)) this.series.delete(key);
        else s.splice(0, s.length - 1);
      } else if (i > 1) s.splice(0, i - 1);
    }
  }
}
