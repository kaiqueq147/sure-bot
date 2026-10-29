import type { Quote } from '../types.js';

/** Resultado de um 1X2 do ponto de vista do grupo (time A do grupo = casa). */
export type Outcome = 'home' | 'draw' | 'away';

export const OUTCOMES: readonly Outcome[] = ['home', 'draw', 'away'];

/** Membro de um grupo 1X2 com as três odds já orientadas para os times do grupo. */
export interface ThreeWayMember {
  q: Quote;
  flip: boolean;
  odds: Record<Outcome, number>;
}

const valid = (o: number | null | undefined): o is number => typeof o === 'number' && Number.isFinite(o) && o > 1;

/** Lado do quote que corresponde ao resultado (`flip`: teamA da casa é o lado B do grupo). */
export function sideOf(outcome: Outcome, flip: boolean): 'A' | 'B' | 'D' {
  if (outcome === 'draw') return 'D';
  return (outcome === 'home') !== flip ? 'A' : 'B';
}

/** Odds 1X2 orientadas; null quando alguma das três falta ou é inválida. */
export function orient(q: Quote, flip: boolean): Record<Outcome, number> | null {
  const home = flip ? q.oddsB : q.oddsA;
  const away = flip ? q.oddsA : q.oddsB;
  if (!valid(home) || !valid(away) || !valid(q.oddsDraw)) return null;
  return { home, draw: q.oddsDraw, away };
}

/** Soma das probabilidades implícitas das três seleções (< 1 = arbitragem). */
export const margin3 = (home: number, draw: number, away: number): number => 1 / home + 1 / draw + 1 / away;

/** Probabilidade justa de cada resultado numa casa, removendo a margem proporcionalmente. */
export function fairProbs3(odds: Record<Outcome, number>): Record<Outcome, number> {
  const sum = margin3(odds.home, odds.draw, odds.away);
  return { home: 1 / odds.home / sum, draw: 1 / odds.draw / sum, away: 1 / odds.away / sum };
}

/** Rótulo da seleção de um resultado, com os nomes de times do quote de referência. */
export function outcomeLabel(outcome: Outcome, ref: Quote): string {
  if (outcome === 'draw') return 'Empate';
  return outcome === 'home' ? ref.teamA : ref.teamB;
}
