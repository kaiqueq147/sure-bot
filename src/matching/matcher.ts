import { isSport } from '../core/sports.js';
import type { Quote } from '../types.js';
import { gamesCompatible, sportKeys, teamSimilarity } from './normalize.js';

export interface MatchPair {
  id: string;
  leftKey: string;
  rightKey: string;
  /** true quando teamA da esquerda corresponde a teamB da direita */
  swapped: boolean;
  score: number;
}

export interface MatchOptions {
  threshold: number;
  maxStartDiffMs: number;
  /** Similaridade mínima exigida para cada time individualmente */
  minTeamScore?: number;
}

/** Pares que o usuário marcou como errados (por `eventKey` das duas casas); padrão: nenhum. */
let isBlocked: (a: string, b: string) => boolean = () => false;

/** Define a lista de bloqueio consultada por `matchQuotes`; `undefined` desliga. */
export function setPairBlocklist(fn?: (a: string, b: string) => boolean): void {
  isBlocked = fn ?? (() => false);
}

/** Chave canônica de um par de eventos, independente da ordem. */
export const pairKey = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`);

interface Bucket {
  /** Ordenados por `startTime` */
  timed: Quote[];
  untimed: Quote[];
  /** Esportes tradicionais: prefixo de palavra dos times -> eventos (ver `sportKeys`) */
  byKey?: Map<string, Quote[]>;
  /** Chaves presentes em muitos jogos ("unit", "city", "real"): só usadas se não houver outra */
  common?: Set<string>;
}

const keysOf = (q: Quote) => sportKeys([q.teamA, q.teamB], q.game);

/**
 * Candidatos de esporte tradicional: só eventos que compartilham uma chave de nome e estão na
 * janela de horário. Com milhares de jogos de futebol por dia, a janela sozinha ainda deixa
 * centenas de candidatos por jogo.
 */
function nearByKey(b: Bucket | undefined, l: Quote, maxDiff: number): Quote[] {
  if (!b) return [];
  if (!b.byKey) {
    b.byKey = new Map();
    for (const r of [...b.timed, ...b.untimed]) {
      for (const k of keysOf(r)) {
        let list = b.byKey.get(k);
        if (!list) b.byKey.set(k, (list = []));
        list.push(r);
      }
    }
    const limit = Math.max(50, (b.timed.length + b.untimed.length) * 0.02);
    b.common = new Set([...b.byKey].filter(([, list]) => list.length > limit).map(([k]) => k));
  }
  const keys = keysOf(l);
  const rare = keys.filter((k) => !b.common!.has(k));
  const out = new Set<Quote>();
  for (const k of rare.length ? rare : keys) {
    for (const r of b.byKey.get(k) ?? []) {
      if (l.startTime && r.startTime && Math.abs(l.startTime - r.startTime) > maxDiff) continue;
      out.add(r);
    }
  }
  return [...out];
}

/** Primeiro índice com startTime >= t (busca binária). */
function lowerBound(qs: Quote[], t: number): number {
  let lo = 0;
  let hi = qs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (qs[mid].startTime! < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Eventos do balde que podem ser o mesmo jogo: horário na janela ±maxDiff, ou sem horário. */
function near(b: Bucket | undefined, startTime: number | undefined, maxDiff: number): Quote[] {
  if (!b) return [];
  if (!startTime) return [...b.timed, ...b.untimed];
  const from = lowerBound(b.timed, startTime - maxDiff);
  const to = lowerBound(b.timed, startTime + maxDiff + 1);
  return [...b.timed.slice(from, to), ...b.untimed];
}

/** Score de correspondência entre dois eventos, considerando as duas orientações possíveis. */
export function scoreEvents(l: Quote, r: Quote, minTeam = 0.7): { score: number; swapped: boolean } | null {
  // O jogo liga as regras de nome de esportes tradicionais ('other' de uma casa herda o da outra).
  const game = l.game === 'other' ? r.game : l.game;
  const sA = teamSimilarity(l.teamA, r.teamA, game);
  const sB = teamSimilarity(l.teamB, r.teamB, game);
  const xA = teamSimilarity(l.teamA, r.teamB, game);
  const xB = teamSimilarity(l.teamB, r.teamA, game);

  const straight = Math.min(sA, sB) >= minTeam ? (sA + sB) / 2 : 0;
  const crossed = Math.min(xA, xB) >= minTeam ? (xA + xB) / 2 : 0;
  if (!straight && !crossed) return null;
  return crossed > straight ? { score: crossed, swapped: true } : { score: straight, swapped: false };
}

/**
 * Cruza os eventos de duas casas. Atribuição gulosa pelo maior score, garantindo que
 * cada evento participe de no máximo um par (evita parear a mesma série com dois jogos diferentes).
 */
export function matchQuotes(left: Quote[], right: Quote[], opts: MatchOptions): MatchPair[] {
  const candidates: Array<MatchPair & { rank: number }> = [];

  // Separa a direita por jogo (cada evento só é comparado com o mesmo jogo ou com 'other') e,
  // dentro do jogo, por horário: com milhares de jogos de futebol, só a janela ±maxStartDiff conta.
  const byGame = new Map<string, Bucket>();
  for (const r of right) {
    let b = byGame.get(r.game);
    if (!b) byGame.set(r.game, (b = { timed: [], untimed: [] }));
    (r.startTime ? b.timed : b.untimed).push(r);
  }
  for (const b of byGame.values()) b.timed.sort((x, y) => x.startTime! - y.startTime!);
  const others = byGame.get('other');

  for (const l of left) {
    const pool =
      l.game === 'other'
        ? [...byGame.values()].flatMap((b) => near(b, l.startTime, opts.maxStartDiffMs))
        : [
            ...(isSport(l.game)
              ? nearByKey(byGame.get(l.game), l, opts.maxStartDiffMs)
              : near(byGame.get(l.game), l.startTime, opts.maxStartDiffMs)),
            ...near(others, l.startTime, opts.maxStartDiffMs),
          ];
    for (const r of pool) {
      if (!gamesCompatible(l.game, r.game)) continue;
      if (isBlocked(l.eventKey, r.eventKey)) continue;
      let startPenalty = 0;
      if (l.startTime && r.startTime) {
        const diff = Math.abs(l.startTime - r.startTime);
        if (diff > opts.maxStartDiffMs) continue;
        startPenalty = (diff / opts.maxStartDiffMs) * 0.05;
      }
      const res = scoreEvents(l, r, opts.minTeamScore);
      if (!res || res.score < opts.threshold) continue;
      candidates.push({
        id: `${l.key}|${r.key}`,
        leftKey: l.key,
        rightKey: r.key,
        swapped: res.swapped,
        score: res.score,
        rank: res.score - startPenalty,
      });
    }
  }

  candidates.sort((a, b) => b.rank - a.rank);
  const usedL = new Set<string>();
  const usedR = new Set<string>();
  const pairs: MatchPair[] = [];
  for (const c of candidates) {
    if (usedL.has(c.leftKey) || usedR.has(c.rightKey)) continue;
    usedL.add(c.leftKey);
    usedR.add(c.rightKey);
    const { rank: _rank, ...pair } = c;
    pairs.push(pair);
  }
  return pairs;
}
