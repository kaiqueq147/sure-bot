import { EventEmitter } from 'node:events';
import type { OddsStore } from '../core/OddsStore.js';
import { drawLabel, marketLabel } from '../core/markets.js';
import type { MatchPair } from '../matching/matcher.js';
import type { BookId, ClosedReason, Leg, Opportunity, Quote } from '../types.js';
import { isThreeWay } from './ArbitrageEngine.js';
import { effectiveOdds, frozenFor, profitPct } from './math.js';
import { orient, OUTCOMES, sideOf, type Outcome, type ThreeWayMember } from './threeWay.js';
import { buildGroups } from './ValueScanner.js';

export interface ThreeWayOptions {
  minProfitPct: number;
  maxProfitPct: number;
  confirmMs: number;
  commissionPct: Partial<Record<BookId, number>>;
  /** Ao vivo: preço parado por este tempo enquanto outra casa se mexe = odd congelada (0 desliga) */
  frozenMs?: number;
}

const DEFAULT_FROZEN_MS = 30_000;
const REOPEN_GRACE_MS = 15_000;

/**
 * Arbitragem de 3 vias: 1X2 do futebol (âncora) e `result3` (1X2 de período, tempo regulamentar).
 * Para cada mercado pareado entre as casas (pares dos motores de 2 vias, âncoras e derivados),
 * pega a melhor odd de casa, empate e fora entre todas as casas. Cada mercado é um grupo próprio:
 * as chaves dos quotes diferem por mercado/período, então 1º tempo nunca se mistura com o jogo inteiro.
 * Margem 1/casa + 1/empate + 1/fora < 1 = lucro garantido com três apostas.
 *
 * Mesma API de eventos do ArbitrageEngine: `opportunity` (Opportunity) e `closed` (id, reason).
 */
export class ThreeWayEngine extends EventEmitter {
  private readonly opps = new Map<string, Opportunity>();
  private readonly recentlyClosed = new Map<string, { firstSeen: number; at: number }>();
  /** id da oportunidade -> chaves dos quotes do grupo (para o motivo de fechamento) */
  private readonly groupKeys = new Map<string, string[]>();
  private evalScheduled = false;
  private sweepTimer?: NodeJS.Timeout;

  constructor(
    private readonly store: OddsStore,
    private readonly pairs: () => readonly MatchPair[],
    private readonly opts: ThreeWayOptions,
  ) {
    super();
    store.on('update', () => this.scheduleEvaluate());
    store.on('availability', () => this.scheduleEvaluate());
  }

  start(): void {
    this.sweepTimer = setInterval(() => this.evaluate(), 1_000);
  }

  stop(): void {
    clearInterval(this.sweepTimer);
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

  /** Grupos de mercados de 3 vias em 2+ casas (1X2 âncora ou `result3` derivado). */
  private groups(): Array<{ id: string; score: number; members: Array<{ key: string; flip: boolean }> }> {
    const threeWay = this.pairs().filter((p) => {
      const l = this.store.get(p.leftKey);
      const r = this.store.get(p.rightKey);
      return !!l && !!r && isThreeWay(l) && isThreeWay(r);
    });
    const scoreOf = new Map<string, number>();
    for (const p of threeWay) {
      for (const k of [p.leftKey, p.rightKey]) scoreOf.set(k, Math.min(scoreOf.get(k) ?? 1, p.score));
    }
    return buildGroups(threeWay, (k) => this.store.get(k)?.book).map((g) => ({
      ...g,
      score: Math.min(...g.members.map((m) => scoreOf.get(m.key) ?? 1)),
    }));
  }

  evaluate(now = Date.now()): void {
    const alive = new Set<string>();
    const groupIds = new Set<string>();

    for (const g of this.groups()) {
      const id = `3w:${g.id}`;
      groupIds.add(id);
      this.groupKeys.set(id, g.members.map((m) => m.key));
      const members: ThreeWayMember[] = [];
      for (const m of g.members) {
        const q = this.store.get(m.key);
        if (!q || !this.store.isFresh(q, now)) continue;
        const odds = orient(q, m.flip);
        if (odds) members.push({ q, flip: m.flip, odds });
      }
      if (members.length < 2) continue;

      const best = (o: Outcome) => {
        let top: { m: ThreeWayMember; eff: number } | undefined;
        for (const m of members) {
          const eff = effectiveOdds(m.q, m.odds[o], this.opts.commissionPct);
          if (!top || eff > top.eff) top = { m, eff };
        }
        return top!;
      };
      const picks = OUTCOMES.map((o) => ({ o, ...best(o) }));
      const margin = picks.reduce((s, p) => s + 1 / p.eff, 0);
      if (margin >= 1) continue;
      const pct = profitPct(margin);
      if (pct < this.opts.minProfitPct) continue;

      // Referência para nomes/horário: um membro na orientação do grupo.
      const ref = (members.find((m) => !m.flip) ?? members[0]).q;
      const legs = picks.map(({ o, m, eff }) => this.leg(m, o, eff)) as [Leg, Leg, Leg];
      alive.add(id);
      this.upsert(id, g.id, g.score, ref, legs, picks.map((p) => p.m.q), margin, pct, now);
    }

    for (const [id, opp] of this.opps) {
      if (alive.has(id)) continue;
      this.opps.delete(id);
      this.recentlyClosed.set(id, { firstSeen: opp.firstSeen, at: now });
      this.emit('closed', id, this.closeReason(id, groupIds, now));
    }
    for (const [id, c] of this.recentlyClosed) if (now - c.at > REOPEN_GRACE_MS) this.recentlyClosed.delete(id);
    for (const id of this.groupKeys.keys()) if (!groupIds.has(id) && !this.opps.has(id)) this.groupKeys.delete(id);
  }

  private leg(m: ThreeWayMember, o: Outcome, eff: number): Leg {
    const side = sideOf(o, m.flip);
    const q = m.q;
    return {
      book: q.book,
      key: q.key,
      side,
      marketId: q.marketId,
      // Nome como aparece no site da casa onde a perna é apostada.
      selection: side === 'D' ? drawLabel(q.market, q.game) : side === 'A' ? (q.selA ?? q.teamA) : (q.selB ?? q.teamB),
      odds: m.odds[o],
      effectiveOdds: eff,
      maxStake: side === 'A' ? q.maxStakeA : side === 'B' ? q.maxStakeB : q.maxStakeDraw,
      depth: side === 'A' ? q.depthA : side === 'B' ? q.depthB : undefined,
      takerFeeRate: q.takerFeeRate,
      commissionPct: this.opts.commissionPct[q.book],
      url: q.url,
      updatedAt: q.updatedAt,
    };
  }

  private closeReason(id: string, groupIds: Set<string>, now: number): ClosedReason {
    if (!groupIds.has(id)) return 'unmatched';
    const keys = this.groupKeys.get(id) ?? [];
    const fresh = keys.filter((k) => {
      const q = this.store.get(k);
      return q && this.store.isFresh(q, now) && orient(q, false);
    });
    return fresh.length < 2 ? 'stale' : 'odds_moved';
  }

  private upsert(
    id: string,
    pairId: string,
    score: number,
    ref: Quote,
    legs: [Leg, Leg, Leg],
    quotes: Quote[],
    margin: number,
    pct: number,
    now: number,
  ): void {
    const prev = this.opps.get(id);
    const firstSeen = prev?.firstSeen ?? this.recentlyClosed.get(id)?.firstSeen ?? now;
    this.recentlyClosed.delete(id);
    const status = now - firstSeen >= this.opts.confirmMs ? 'confirmed' : 'pending';

    const warnings: string[] = [];
    if (pct > this.opts.maxProfitPct) warnings.push('Lucro anormalmente alto: confira se é o mesmo jogo/mercado e se a odd não está congelada.');
    if (score < 0.9) warnings.push(`Correspondência de times incerta (score ${score.toFixed(2)}).`);
    if (ref.startTime && ref.startTime <= now) warnings.push('Jogo ao vivo: um gol muda as três odds em segundos.');
    legs.forEach((lg, i) => {
      const peers = quotes.filter((q, j) => j !== i && q.key !== quotes[i].key);
      const frozen = frozenFor(quotes[i], peers, now, this.opts.frozenMs ?? DEFAULT_FROZEN_MS);
      if (frozen === undefined) return;
      lg.frozenMs = frozen;
      warnings.push(`Odd da ${lg.book} parada há ${Math.round(frozen / 1000)}s com o jogo ao vivo: pode estar congelada.`);
    });

    const opp: Opportunity = {
      id,
      pairId,
      game: ref.game,
      eventName: ref.eventName,
      market: ref.market,
      marketLabel: marketLabel(ref.market, ref.game),
      league: ref.league,
      startTime: ref.startTime,
      legs,
      margin,
      profitPct: pct,
      status,
      firstSeen,
      updatedAt: now,
      matchScore: score,
      warnings,
    };

    const changed =
      !prev ||
      prev.status !== status ||
      prev.legs.length !== legs.length ||
      prev.legs.some(
        (lg, i) =>
          lg.book !== legs[i].book ||
          lg.odds !== legs[i].odds ||
          lg.maxStake !== legs[i].maxStake ||
          !lg.frozenMs !== !legs[i].frozenMs,
      );

    this.opps.set(id, opp);
    if (changed) this.emit('opportunity', opp);
  }
}
