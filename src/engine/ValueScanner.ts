import { EventEmitter } from 'node:events';
import type { OddsStore } from '../core/OddsStore.js';
import { marketLabel } from '../core/markets.js';
import type { MatchPair } from '../matching/matcher.js';
import type { BookId, Quote, ValueBet, ValueBookOdds } from '../types.js';
import { effectiveOdds, fairProbA } from './math.js';

export interface ValueOptions {
  minEvPct: number;
  warnEvPct: number;
  maxOverroundPct: number;
  commissionPct: Partial<Record<BookId, number>>;
}

/** Jogo pareado entre casas; `flip` = teamA da casa corresponde ao lado B do grupo. */
export interface EventGroup {
  id: string;
  members: Array<{ key: string; flip: boolean }>;
}

/**
 * Junta os pares de cada motor (polymarket×thunderpick, polymarket×duel, thunderpick×duel)
 * em grupos por jogo, orientando os times de todas as casas para o mesmo lado.
 * Grupos com orientação contraditória ou duas entradas da mesma casa são descartados.
 */
export function buildGroups(pairs: readonly MatchPair[], bookOf: (key: string) => BookId | undefined): EventGroup[] {
  const adj = new Map<string, Array<{ to: string; swapped: boolean }>>();
  const link = (a: string, b: string, swapped: boolean) => {
    if (!adj.has(a)) adj.set(a, []);
    adj.get(a)!.push({ to: b, swapped });
  };
  for (const p of pairs) {
    link(p.leftKey, p.rightKey, p.swapped);
    link(p.rightKey, p.leftKey, p.swapped);
  }

  const seen = new Set<string>();
  const groups: EventGroup[] = [];
  for (const start of [...adj.keys()].sort()) {
    if (seen.has(start)) continue;
    const flip = new Map<string, boolean>([[start, false]]);
    const queue = [start];
    let consistent = true;
    while (queue.length) {
      const k = queue.shift()!;
      seen.add(k);
      for (const e of adj.get(k) ?? []) {
        const expected = flip.get(k)! !== e.swapped;
        const known = flip.get(e.to);
        if (known === undefined) {
          flip.set(e.to, expected);
          queue.push(e.to);
        } else if (known !== expected) consistent = false;
      }
    }
    const members = [...flip].map(([key, f]) => ({ key, flip: f }));
    const books = members.map((m) => bookOf(m.key));
    if (!consistent || new Set(books).size !== books.length || books.includes(undefined)) continue;
    groups.push({ id: members.map((m) => m.key).sort().join('|'), members });
  }
  return groups;
}

/**
 * Apostas de valor: para cada seleção, compara a melhor odd entre as casas com a probabilidade
 * justa (margem removida) que as outras casas atribuem a ela. Não exige arbitragem.
 *
 * Eventos: `changed` (ValueBet[]) quando a lista muda.
 */
export class ValueScanner extends EventEmitter {
  private bets = new Map<string, ValueBet>();
  private readonly opening = new Map<string, { a: number; b: number }>();
  private signature = '';
  private timer?: NodeJS.Timeout;
  private scheduled = false;

  constructor(
    private readonly store: OddsStore,
    private readonly pairs: () => readonly MatchPair[],
    private readonly opts: ValueOptions,
  ) {
    super();
    store.on('update', () => this.schedule());
  }

  start(): void {
    this.timer = setInterval(() => this.scan(), 1_000);
  }

  stop(): void {
    clearInterval(this.timer);
  }

  list(): ValueBet[] {
    return [...this.bets.values()].sort((a, b) => b.evPct - a.evPct);
  }

  /** Ticks chegam em rajadas; no máximo uma varredura a cada 250ms. */
  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    setTimeout(() => {
      this.scheduled = false;
      this.scan();
    }, 250);
  }

  private trackOpening(q: Quote): { a: number; b: number } {
    let o = this.opening.get(q.key);
    if (!o) {
      o = { a: q.oddsA!, b: q.oddsB! };
      this.opening.set(q.key, o);
    }
    return o;
  }

  scan(now = Date.now()): void {
    for (const key of this.opening.keys()) if (!this.store.get(key)) this.opening.delete(key);

    const next = new Map<string, ValueBet>();
    const groups = buildGroups(this.pairs(), (k) => this.store.get(k)?.book);
    for (const g of groups) {
      const members = g.members
        .map((m) => ({ ...m, q: this.store.get(m.key)! }))
        .filter((m) => m.q && this.store.isFresh(m.q, now));
      for (const m of members) this.trackOpening(m.q);
      if (members.length < 2) continue;

      for (const side of ['A', 'B'] as const) {
        const rows = members.map(({ q, flip }) => {
          const own: 'A' | 'B' = (side === 'A') !== flip ? 'A' : 'B';
          const odds = (own === 'A' ? q.oddsA : q.oddsB)!;
          const other = (own === 'A' ? q.oddsB : q.oddsA)!;
          const open = this.opening.get(q.key)!;
          const overroundPct = (1 / odds + 1 / other - 1) * 100;
          return {
            q,
            own,
            row: {
              book: q.book,
              key: q.key,
              side: own,
              odds,
              effectiveOdds: effectiveOdds(q, odds, this.opts.commissionPct),
              openingOdds: own === 'A' ? open.a : open.b,
              fairProb: fairProbA(odds, other),
              overroundPct,
              inConsensus: overroundPct <= this.opts.maxOverroundPct,
              maxStake: own === 'A' ? q.maxStakeA : q.maxStakeB,
              url: q.url,
              updatedAt: q.updatedAt,
            } satisfies ValueBookOdds,
          };
        });
        rows.sort((a, b) => b.row.effectiveOdds - a.row.effectiveOdds);
        const best = rows[0];
        const others = rows.slice(1).filter((r) => r.row.inConsensus);
        if (!others.length) continue;
        const fairProb = others.reduce((s, r) => s + r.row.fairProb, 0) / others.length;
        const evPct = (best.row.effectiveOdds * fairProb - 1) * 100;
        if (evPct < this.opts.minEvPct) continue;

        const id = `${g.id}#${side}`;
        const prev = this.bets.get(id);
        const ref = best.q;
        const warnings: string[] = [];
        if (evPct > this.opts.warnEvPct) warnings.push('EV anormalmente alto: confira se é o mesmo jogo e se a odd não está congelada.');
        const live = !!ref.startTime && ref.startTime <= now;
        if (live) warnings.push('Jogo ao vivo: as odds mudam em segundos.');
        if (others.length === 1) warnings.push('Consenso baseado em uma única casa.');
        if (best.row.maxStake != null && best.row.maxStake < 50)
          warnings.push(`Pouca liquidez na melhor odd ($${best.row.maxStake.toFixed(2)}).`);

        const minOdds = Math.min(...rows.map((r) => r.row.odds));
        next.set(id, {
          id,
          game: ref.game,
          eventName: ref.eventName,
          market: ref.market,
          marketLabel: marketLabel(ref.market),
          league: ref.league,
          startTime: ref.startTime,
          live,
          selection: best.own === 'A' ? (ref.selA ?? ref.teamA) : (ref.selB ?? ref.teamB),
          opponent: best.own === 'A' ? (ref.selB ?? ref.teamB) : (ref.selA ?? ref.teamA),
          books: rows.map((r) => r.row),
          bestBook: best.row.book,
          fairProb,
          fairOdds: 1 / fairProb,
          evPct,
          disparityPct: (best.row.odds / minOdds - 1) * 100,
          oddsDiff: best.row.odds - minOdds,
          firstSeen: prev?.firstSeen ?? now,
          updatedAt: now,
          warnings,
        });
      }
    }

    this.bets = next;
    const sig = [...next.values()].map((b) => `${b.id}:${b.books.map((r) => r.odds).join(',')}`).sort().join(';');
    if (sig !== this.signature) {
      this.signature = sig;
      this.emit('changed', this.list());
    }
  }
}
