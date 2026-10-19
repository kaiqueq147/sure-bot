import type { Quote } from '../types.js';
import { gamesCompatible, teamSimilarity } from './normalize.js';

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

/** Score de correspondência entre dois eventos, considerando as duas orientações possíveis. */
export function scoreEvents(l: Quote, r: Quote, minTeam = 0.7): { score: number; swapped: boolean } | null {
  const sA = teamSimilarity(l.teamA, r.teamA);
  const sB = teamSimilarity(l.teamB, r.teamB);
  const xA = teamSimilarity(l.teamA, r.teamB);
  const xB = teamSimilarity(l.teamB, r.teamA);

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

  for (const l of left) {
    for (const r of right) {
      if (!gamesCompatible(l.game, r.game)) continue;
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
