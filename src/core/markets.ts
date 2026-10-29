import type { MarketSpec, MarketType } from '../types.js';

export const WINNER: MarketSpec = { type: 'winner' };

/** Linhas x.5 não têm devolução (push); só elas permitem cobrir os dois lados com lucro garantido. */
export const isHalfLine = (line: number): boolean => Number.isFinite(line) && Math.abs((Math.abs(line) % 1) - 0.5) < 1e-9;

/** Handicaps: com os times invertidos entre as casas, o lado troca e a linha muda de sinal. */
export const isHandicapType = (t: MarketType): boolean => t === 'handicap' || t === 'map_rounds_hcp' || t === 'map_kills_hcp';
/** Totais (mais/menos): não dependem da ordem dos times. */
export const isTotalType = (t: MarketType): boolean => t === 'total' || t === 'map_rounds_total' || t === 'map_kills_total';

/** Mercados de um mapa: prefixo da chave e rótulos (unidade da linha). */
const PER_MAP: Partial<Record<MarketType, { key: string; label: string; unit: string }>> = {
  map_rounds_hcp: { key: 'rhcp', label: 'Handicap de rounds', unit: 'rounds' },
  map_rounds_total: { key: 'rtot', label: 'Total de rounds', unit: 'rounds' },
  map_kills_hcp: { key: 'khcp', label: 'Handicap de kills', unit: 'kills' },
  map_kills_total: { key: 'ktot', label: 'Total de kills', unit: 'kills' },
};

export function marketKey(spec: MarketSpec): string {
  if (spec.type === 'handicap') return `hcp:${spec.line}`;
  if (spec.type === 'total') return `tot:${spec.line}`;
  if (spec.type === 'map') return `map:${spec.line}`;
  const per = PER_MAP[spec.type];
  if (per) return `${per.key}:${spec.map}:${spec.line}`;
  return 'win';
}

export const MAX_MAP = 7;
export const isMapNumber = (n: number): boolean => Number.isInteger(n) && n >= 1 && n <= MAX_MAP;

export function sameMarket(a: MarketSpec, b: MarketSpec): boolean {
  return a.type === b.type && (a.line ?? 0) === (b.line ?? 0) && (a.map ?? 0) === (b.map ?? 0);
}

export const fmtLine = (line: number): string => (line > 0 ? `+${line}` : String(line));

export function marketLabel(spec: MarketSpec): string {
  if (spec.type === 'handicap') return `Handicap de mapas ${fmtLine(spec.line!)}`;
  if (spec.type === 'total') return `Total de mapas ${spec.line}`;
  if (spec.type === 'map') return `Vencedor do mapa ${spec.line}`;
  const per = PER_MAP[spec.type];
  if (per) return `Mapa ${spec.map}: ${per.label} ${isHandicapType(spec.type) ? fmtLine(spec.line!) : spec.line}`;
  return 'Vencedor da partida';
}

/** Rótulos das duas seleções do mercado. */
export function selectionLabels(spec: MarketSpec, teamA: string, teamB: string): [string, string] {
  if (spec.type === 'handicap') return [`${teamA} ${fmtLine(spec.line!)}`, `${teamB} ${fmtLine(-spec.line!)}`];
  if (spec.type === 'total') return [`Mais de ${spec.line} mapas`, `Menos de ${spec.line} mapas`];
  if (spec.type === 'map') return [`${teamA} (mapa ${spec.line})`, `${teamB} (mapa ${spec.line})`];
  const per = PER_MAP[spec.type];
  if (per && isHandicapType(spec.type))
    return [`${teamA} ${fmtLine(spec.line!)} ${per.unit} (mapa ${spec.map})`, `${teamB} ${fmtLine(-spec.line!)} ${per.unit} (mapa ${spec.map})`];
  if (per) return [`Mais de ${spec.line} ${per.unit} (mapa ${spec.map})`, `Menos de ${spec.line} ${per.unit} (mapa ${spec.map})`];
  return [teamA, teamB];
}

/** Chave e rótulos de um mercado derivado do evento `eventKey`. */
export function derivedQuoteFields(eventKey: string, spec: MarketSpec, teamA: string, teamB: string) {
  const [selA, selB] = selectionLabels(spec, teamA, teamB);
  return { key: spec.type === 'winner' ? eventKey : `${eventKey}:${marketKey(spec)}`, eventKey, market: spec, selA, selB };
}
