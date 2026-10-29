import { EventEmitter } from 'node:events';
import type { OddsStore } from '../core/OddsStore.js';
import { createLogger } from '../core/logger.js';
import { isHandicapType, isOrderIndependent, marketLabel, sameMarket } from '../core/markets.js';
import { matchQuotes, type MatchPair } from '../matching/matcher.js';
import type { BookId, ClosedReason, Leg, Opportunity, Quote } from '../types.js';
import { arbMargin, effectiveOdds, frozenFor, profitPct } from './math.js';

export interface EngineOptions {
  minProfitPct: number;
  maxProfitPct: number;
  confirmMs: number;
  matchThreshold: number;
  maxStartDiffMs: number;
  commissionPct: Partial<Record<BookId, number>>;
  /** Ao vivo: preço parado por este tempo enquanto a outra casa se mexe = odd congelada (0 desliga) */
  frozenMs?: number;
}

const DEFAULT_FROZEN_MS = 30_000;

const log = createLogger('engine');
const REOPEN_GRACE_MS = 15_000;

/** Âncora do pareamento: o vencedor do jogo inteiro (`key === eventKey`). */
export const isAnchor = (q: Quote): boolean => q.key === q.eventKey;

/** Mercado de 3 vias (1X2 com empate): duas pernas não cobrem o resultado. */
export const isThreeWay = (q: Quote): boolean => q.oddsDraw != null;

/**
 * Pareia handicaps e totais a partir dos jogos já pareados pelo vencedor: mesmo tipo e mesma
 * linha. Com os times invertidos entre as casas, a linha do teamA da direita é −linha.
 */
export function derivedPairs(winners: readonly MatchPair[], left: Quote[], right: Quote[]): MatchPair[] {
  const byEvent = (qs: Quote[]) => {
    const m = new Map<string, Quote[]>();
    for (const q of qs) {
      if (isAnchor(q)) continue;
      if (!m.has(q.eventKey)) m.set(q.eventKey, []);
      m.get(q.eventKey)!.push(q);
    }
    return m;
  };
  const leftBy = byEvent(left);
  const rightBy = byEvent(right);
  const out: MatchPair[] = [];
  for (const p of winners) {
    const rs = rightBy.get(p.rightKey) ?? [];
    for (const dl of leftBy.get(p.leftKey) ?? []) {
      // Total/ambas marcam não dependem da ordem dos times; handicap troca o lado e nega a linha;
      // mapa, empate anula e vencedor de período só trocam o lado.
      const swapped = !isOrderIndependent(dl.market.type) && p.swapped;
      const negate = isHandicapType(dl.market.type) && swapped;
      const want = { ...dl.market, line: negate ? -dl.market.line! : dl.market.line };
      const dr = rs.find((q) => sameMarket(q.market, want));
      if (dr) out.push({ id: `${dl.key}|${dr.key}`, leftKey: dl.key, rightKey: dr.key, swapped, score: p.score });
    }
  }
  return out;
}

/**
 * Eventos:
 *  - `opportunity` (Opportunity): nova ou alterada (odds, status)
 *  - `closed` (id, reason)
 *  - `pairs` (count)
 */
export class ArbitrageEngine extends EventEmitter {
  private pairs: MatchPair[] = [];
  private readonly opps = new Map<string, Opportunity>();
  /** Oportunidades que acabaram de sumir: se voltarem logo, mantêm firstSeen (e a confirmação). */
  private readonly recentlyClosed = new Map<string, { firstSeen: number; at: number }>();
  private evalScheduled = false;
  private rematchTimer?: NodeJS.Timeout;
  private sweepTimer?: NodeJS.Timeout;

  constructor(
    private readonly store: OddsStore,
    private readonly opts: EngineOptions,
    private readonly left: BookId = 'polymarket',
    private readonly right: BookId = 'thunderpick',
  ) {
    super();
    store.on('update', () => this.scheduleEvaluate());
    store.on('availability', () => this.scheduleEvaluate());
    store.on('keys', () => this.scheduleRematch());
  }

  start(): void {
    // Varredura periódica: promove pending -> confirmed e expira odds stale mesmo sem novos ticks.
    this.sweepTimer = setInterval(() => this.evaluate(), 1_000);
  }

  stop(): void {
    clearInterval(this.sweepTimer);
    clearTimeout(this.rematchTimer);
  }

  list(): Opportunity[] {
    return [...this.opps.values()].sort((a, b) => b.profitPct - a.profitPct);
  }

  listPairs() {
    return this.pairs.map((p) => {
      const l = this.store.get(p.leftKey);
      const r = this.store.get(p.rightKey);
      return {
        ...p,
        left: l && { event: l.eventName, teamA: l.teamA, teamB: l.teamB, oddsA: l.oddsA, oddsB: l.oddsB },
        right: r && { event: r.eventName, teamA: r.teamA, teamB: r.teamB, oddsA: r.oddsA, oddsB: r.oddsB },
      };
    });
  }

  matchedPairs(): readonly MatchPair[] {
    return this.pairs;
  }

  /** Jogos pareados (só o mercado de vencedor; handicaps/totais ficam de fora da contagem). */
  get pairCount(): number {
    return this.pairs.filter((p) => {
      const q = this.store.get(p.leftKey);
      return q !== undefined && isAnchor(q);
    }).length;
  }

  /** Rematching é caro (O(n·m)); só roda quando o conjunto de mercados muda, com debounce. */
  private scheduleRematch(): void {
    clearTimeout(this.rematchTimer);
    this.rematchTimer = setTimeout(() => this.rematch(), 500);
  }

  private rematch(): void {
    const before = this.pairs.length;
    const left = this.store.byBook(this.left);
    const right = this.store.byBook(this.right);
    const winners = matchQuotes(
      left.filter(isAnchor),
      right.filter(isAnchor),
      { threshold: this.opts.matchThreshold, maxStartDiffMs: this.opts.maxStartDiffMs },
    );
    this.pairs = [...winners, ...derivedPairs(winners, left, right)];
    if (this.pairs.length !== before) {
      log.info(`${winners.length} eventos pareados entre ${this.left} e ${this.right} (${this.pairs.length - winners.length} mercados de handicap/total/mapa)`);
    }
    this.emit('pairs', this.pairs.length);
    this.evaluate();
  }

  /** Agrupa rajadas de ticks do WebSocket em uma única avaliação por ciclo do event loop. */
  private scheduleEvaluate(): void {
    if (this.evalScheduled) return;
    this.evalScheduled = true;
    setImmediate(() => {
      this.evalScheduled = false;
      this.evaluate();
    });
  }

  private leg(q: Quote, side: 'A' | 'B'): Leg {
    const odds = (side === 'A' ? q.oddsA : q.oddsB) as number;
    return {
      book: q.book,
      key: q.key,
      side,
      marketId: q.marketId,
      selection: side === 'A' ? (q.selA ?? q.teamA) : (q.selB ?? q.teamB),
      odds,
      effectiveOdds: effectiveOdds(q, odds, this.opts.commissionPct),
      maxStake: side === 'A' ? q.maxStakeA : q.maxStakeB,
      depth: side === 'A' ? q.depthA : q.depthB,
      takerFeeRate: q.takerFeeRate,
      commissionPct: this.opts.commissionPct[q.book],
      url: q.url,
      updatedAt: q.updatedAt,
    };
  }

  evaluate(): void {
    const now = Date.now();
    const alive = new Set<string>();
    const pairIds = new Set<string>();

    for (const p of this.pairs) {
      pairIds.add(p.id);
      const l = this.store.get(p.leftKey);
      const r = this.store.get(p.rightKey);
      if (!l || !r || !this.store.isFresh(l, now) || !this.store.isFresh(r, now)) continue;
      // 1X2 continua âncora do pareamento, mas fica com o ThreeWayEngine.
      if (isThreeWay(l) || isThreeWay(r)) continue;

      // Time A da casa esquerda contra o oponente na casa direita, e vice-versa.
      const combos: Array<[string, Leg, Leg]> = [
        [`${p.id}#A`, this.leg(l, 'A'), this.leg(r, p.swapped ? 'A' : 'B')],
        [`${p.id}#B`, this.leg(l, 'B'), this.leg(r, p.swapped ? 'B' : 'A')],
      ];

      for (const [id, leg1, leg2] of combos) {
        const margin = arbMargin(leg1.effectiveOdds, leg2.effectiveOdds);
        if (margin >= 1) continue;
        const pct = profitPct(margin);
        if (pct < this.opts.minProfitPct) continue;
        alive.add(id);
        this.upsert(id, p, l, [leg1, leg2], margin, pct, now);
      }
    }

    for (const [id, opp] of this.opps) {
      if (alive.has(id)) continue;
      this.opps.delete(id);
      this.recentlyClosed.set(id, { firstSeen: opp.firstSeen, at: now });
      const reason = this.closeReason(opp, pairIds, now);
      this.emit('closed', id, reason);
    }
    for (const [id, c] of this.recentlyClosed) if (now - c.at > REOPEN_GRACE_MS) this.recentlyClosed.delete(id);
  }

  private closeReason(opp: Opportunity, pairIds: Set<string>, now: number): ClosedReason {
    if (!pairIds.has(opp.pairId)) return 'unmatched';
    const [lk, rk] = opp.pairId.split('|');
    const l = this.store.get(lk);
    const r = this.store.get(rk);
    if (!l || !r || !this.store.isFresh(l, now) || !this.store.isFresh(r, now)) return 'stale';
    return 'odds_moved';
  }

  private upsert(id: string, pair: MatchPair, l: Quote, legs: [Leg, Leg], margin: number, pct: number, now: number): void {
    const prev = this.opps.get(id);
    const firstSeen = prev?.firstSeen ?? this.recentlyClosed.get(id)?.firstSeen ?? now;
    this.recentlyClosed.delete(id);
    const status = now - firstSeen >= this.opts.confirmMs ? 'confirmed' : 'pending';

    const warnings: string[] = [];
    if (pct > this.opts.maxProfitPct) warnings.push('Lucro anormalmente alto: confira se é o mesmo jogo/mercado e se a odd não está congelada.');
    if (pair.score < 0.9) warnings.push(`Correspondência de times incerta (score ${pair.score.toFixed(2)}).`);
    // Vencedor do mapa guarda o número em `line`; os demais mercados de um mapa, em `map`.
    const mapNo = l.market.type === 'map' ? l.market.line : l.market.map;
    if (mapNo !== undefined && mapNo >= 3) {
      warnings.push(`O mapa ${mapNo} pode não ser jogado se a série acabar antes; cada casa tem sua regra de anulação, confira antes de apostar.`);
    }
    if (mapNo !== undefined && l.startTime && l.startTime <= now) {
      warnings.push('Jogo em andamento: o mapa pode já ter começado ou terminado em uma das casas.');
    }
    if (l.market.type === 'map_rounds_hcp' || l.market.type === 'map_rounds_total') {
      warnings.push('Rounds: confira se as duas casas contam a prorrogação (overtime) do mesmo jeito.');
    }
    const quotes = legs.map((lg) => this.store.get(lg.key));
    legs.forEach((lg, i) => {
      const q = quotes[i];
      const peer = quotes[1 - i];
      if (!q || !peer) return;
      const frozen = frozenFor(q, [peer], now, this.opts.frozenMs ?? DEFAULT_FROZEN_MS);
      if (frozen === undefined) return;
      lg.frozenMs = frozen;
      warnings.push(`Odd da ${lg.book} parada há ${Math.round(frozen / 1000)}s com o jogo ao vivo: pode estar congelada.`);
    });

    const opp: Opportunity = {
      id,
      pairId: pair.id,
      game: l.game,
      eventName: l.eventName,
      market: l.market,
      marketLabel: marketLabel(l.market, l.game),
      league: l.league,
      startTime: l.startTime,
      legs,
      margin,
      profitPct: pct,
      status,
      firstSeen,
      updatedAt: now,
      matchScore: pair.score,
      warnings,
    };

    const changed =
      !prev ||
      prev.status !== status ||
      prev.legs.some(
        (lg, i) => lg.odds !== legs[i].odds || lg.maxStake !== legs[i].maxStake || !lg.frozenMs !== !legs[i].frozenMs,
      );

    this.opps.set(id, opp);
    if (changed) this.emit('opportunity', opp);
  }
}
