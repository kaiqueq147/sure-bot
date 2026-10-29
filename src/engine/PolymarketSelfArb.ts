import { EventEmitter } from 'node:events';
import type { OddsStore } from '../core/OddsStore.js';
import { marketLabel } from '../core/markets.js';
import type { BookId, ClosedReason, DepthLevel, Leg, Opportunity, Quote } from '../types.js';
import { arbMargin, effectiveOdds, profitPct } from './math.js';

export interface SelfArbOptions {
  minProfitPct: number;
  commissionPct: Partial<Record<BookId, number>>;
  /** Tempo contínuo até virar `confirmed` (como no ArbitrageEngine; 0 = confirma na hora) */
  confirmMs?: number;
}

const REOPEN_GRACE_MS = 15_000;

/** Custo de uma share ao preço `p` como taker (mesma fórmula de math.ts). */
const shareCost = (p: number, feeRate: number) => p * (1 + feeRate * (1 - p));

/**
 * Quantas shares de cada lado dá para comprar em par mantendo o custo do par abaixo de $1:
 * percorre os dois livros juntos e para no primeiro par de níveis que já não dá lucro.
 * Cada par de shares paga exatamente $1 no fim, qualquer que seja o resultado.
 */
export function pairedFill(
  depthA: readonly DepthLevel[],
  depthB: readonly DepthLevel[],
  feeRate = 0,
): { shares: number; costA: number; costB: number; profit: number } {
  let i = 0;
  let j = 0;
  let leftA = depthA[0]?.[1] ?? 0;
  let leftB = depthB[0]?.[1] ?? 0;
  let shares = 0;
  let costA = 0;
  let costB = 0;
  while (i < depthA.length && j < depthB.length) {
    const ca = shareCost(depthA[i][0], feeRate);
    const cb = shareCost(depthB[j][0], feeRate);
    if (ca + cb >= 1) break;
    const n = Math.min(leftA, leftB);
    shares += n;
    costA += n * ca;
    costB += n * cb;
    leftA -= n;
    leftB -= n;
    if (leftA <= 1e-12) leftA = depthA[++i]?.[1] ?? 0;
    if (leftB <= 1e-12) leftB = depthB[++j]?.[1] ?? 0;
  }
  return { shares, costA, costB, profit: shares - costA - costB };
}

/**
 * Arbitragem dentro da própria Polymarket: comprar as shares dos dois lados de um mercado
 * custando menos de $1 por par. A odd de cada lado já é a média para `minFillUsd` (ver
 * polymarket.ts); a profundidade dá até quanto a operação continua lucrativa.
 *
 * Eventos iguais aos do ArbitrageEngine: `opportunity` (Opportunity) e `closed` (id, reason).
 */
export class PolymarketSelfArb extends EventEmitter {
  private readonly opps = new Map<string, Opportunity>();
  private readonly recentlyClosed = new Map<string, { firstSeen: number; at: number }>();
  private evalScheduled = false;
  private sweepTimer?: NodeJS.Timeout;
  private readonly onUpdate = (q: Quote) => {
    if (q.book === 'polymarket') this.scheduleEvaluate();
  };
  private readonly onAvailability = () => this.scheduleEvaluate();

  constructor(
    private readonly store: OddsStore,
    private readonly opts: SelfArbOptions,
  ) {
    super();
  }

  start(): void {
    this.store.on('update', this.onUpdate);
    this.store.on('availability', this.onAvailability);
    // Promove pending -> confirmed e expira odds stale mesmo sem novos ticks.
    this.sweepTimer = setInterval(() => this.evaluate(), 1_000);
  }

  stop(): void {
    clearInterval(this.sweepTimer);
    this.store.off('update', this.onUpdate);
    this.store.off('availability', this.onAvailability);
  }

  list(): Opportunity[] {
    return [...this.opps.values()].sort((a, b) => b.profitPct - a.profitPct);
  }

  private scheduleEvaluate(): void {
    if (this.evalScheduled) return;
    this.evalScheduled = true;
    setImmediate(() => {
      this.evalScheduled = false;
      this.evaluate();
    });
  }

  evaluate(now = Date.now()): void {
    const alive = new Set<string>();
    for (const q of this.store.byBook('polymarket')) {
      if (!this.store.isFresh(q, now)) continue;
      const legs: [Leg, Leg] = [this.leg(q, 'A'), this.leg(q, 'B')];
      const margin = arbMargin(legs[0].effectiveOdds, legs[1].effectiveOdds);
      if (margin >= 1) continue;
      const pct = profitPct(margin);
      if (pct < this.opts.minProfitPct) continue;
      const id = `self:${q.key}`;
      alive.add(id);
      this.upsert(id, q, legs, margin, pct, now);
    }

    for (const [id, opp] of this.opps) {
      if (alive.has(id)) continue;
      this.opps.delete(id);
      this.recentlyClosed.set(id, { firstSeen: opp.firstSeen, at: now });
      this.emit('closed', id, this.closeReason(opp, now));
    }
    for (const [id, c] of this.recentlyClosed) if (now - c.at > REOPEN_GRACE_MS) this.recentlyClosed.delete(id);
  }

  private leg(q: Quote, side: 'A' | 'B'): Leg {
    const odds = (side === 'A' ? q.oddsA : q.oddsB) as number;
    return {
      book: 'polymarket',
      key: q.key,
      side,
      marketId: q.marketId,
      selection: side === 'A' ? (q.selA ?? q.teamA) : (q.selB ?? q.teamB),
      odds,
      effectiveOdds: effectiveOdds(q, odds, this.opts.commissionPct),
      depth: side === 'A' ? q.depthA : q.depthB,
      takerFeeRate: q.takerFeeRate,
      commissionPct: this.opts.commissionPct.polymarket,
      url: q.url,
      updatedAt: q.updatedAt,
    };
  }

  private closeReason(opp: Opportunity, now: number): ClosedReason {
    const q = this.store.get(opp.pairId);
    if (!q || !this.store.isFresh(q, now)) return 'stale';
    return 'odds_moved';
  }

  private upsert(id: string, q: Quote, legs: [Leg, Leg], margin: number, pct: number, now: number): void {
    const prev = this.opps.get(id);
    const firstSeen = prev?.firstSeen ?? this.recentlyClosed.get(id)?.firstSeen ?? now;
    this.recentlyClosed.delete(id);
    const status = now - firstSeen >= (this.opts.confirmMs ?? 0) ? 'confirmed' : 'pending';

    // Até onde os dois livros juntos continuam pagando: o valor de cada perna nesse ponto.
    const fill = pairedFill(q.depthA ?? [], q.depthB ?? [], q.takerFeeRate ?? 0);
    if (fill.shares > 0) {
      legs[0].maxStake = fill.costA;
      legs[1].maxStake = fill.costB;
    }

    const warnings = [
      'Arbitragem dentro da Polymarket: compre os dois lados do mesmo mercado (cada par de shares paga $1).',
    ];
    if (fill.shares > 0) {
      warnings.push(`Lucrativa até ~$${(fill.costA + fill.costB).toFixed(2)} no total (lucro máx. ~$${fill.profit.toFixed(2)}).`);
    }

    const opp: Opportunity = {
      id,
      pairId: q.key,
      game: q.game,
      eventName: q.eventName,
      market: q.market,
      marketLabel: marketLabel(q.market),
      league: q.league,
      startTime: q.startTime,
      legs,
      margin,
      profitPct: pct,
      status,
      firstSeen,
      updatedAt: now,
      matchScore: 1,
      warnings,
    };

    const changed =
      !prev ||
      prev.status !== status ||
      prev.legs.some((lg, i) => lg.odds !== legs[i].odds || lg.maxStake !== legs[i].maxStake);
    this.opps.set(id, opp);
    if (changed) this.emit('opportunity', opp);
  }
}
