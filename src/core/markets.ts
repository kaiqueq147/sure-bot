import type { MarketSpec } from '../types.js';

export const WINNER: MarketSpec = { type: 'winner' };

/** Linhas x.5 não têm devolução (push); só elas permitem cobrir os dois lados com lucro garantido. */
export const isHalfLine = (line: number): boolean => Number.isFinite(line) && Math.abs((Math.abs(line) % 1) - 0.5) < 1e-9;

export function marketKey(spec: MarketSpec): string {
  if (spec.type === 'handicap') return `hcp:${spec.line}`;
  if (spec.type === 'total') return `tot:${spec.line}`;
  if (spec.type === 'map') return `map:${spec.line}`;
  return 'win';
}

export const MAX_MAP = 7;
export const isMapNumber = (n: number): boolean => Number.isInteger(n) && n >= 1 && n <= MAX_MAP;

export function sameMarket(a: MarketSpec, b: MarketSpec): boolean {
  return a.type === b.type && (a.line ?? 0) === (b.line ?? 0);
}

export const fmtLine = (line: number): string => (line > 0 ? `+${line}` : String(line));

export function marketLabel(spec: MarketSpec): string {
  if (spec.type === 'handicap') return `Handicap de mapas ${fmtLine(spec.line!)}`;
  if (spec.type === 'total') return `Total de mapas ${spec.line}`;
  if (spec.type === 'map') return `Vencedor do mapa ${spec.line}`;
  return 'Vencedor da partida';
}

/** Rótulos das duas seleções do mercado. */
export function selectionLabels(spec: MarketSpec, teamA: string, teamB: string): [string, string] {
  if (spec.type === 'handicap') return [`${teamA} ${fmtLine(spec.line!)}`, `${teamB} ${fmtLine(-spec.line!)}`];
  if (spec.type === 'total') return [`Mais de ${spec.line} mapas`, `Menos de ${spec.line} mapas`];
  if (spec.type === 'map') return [`${teamA} (mapa ${spec.line})`, `${teamB} (mapa ${spec.line})`];
  return [teamA, teamB];
}

/** Chave e rótulos de um mercado derivado do evento `eventKey`. */
export function derivedQuoteFields(eventKey: string, spec: MarketSpec, teamA: string, teamB: string) {
  const [selA, selB] = selectionLabels(spec, teamA, teamB);
  return { key: spec.type === 'winner' ? eventKey : `${eventKey}:${marketKey(spec)}`, eventKey, market: spec, selA, selB };
}
