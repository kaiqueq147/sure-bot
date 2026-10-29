import type { Game, MarketSpec, MarketType } from '../types.js';
import { isSport } from './sports.js';

export const WINNER: MarketSpec = { type: 'winner' };

/** Linhas x.5 não têm devolução (push); só elas permitem cobrir os dois lados com lucro garantido. */
export const isHalfLine = (line: number): boolean => Number.isFinite(line) && Math.abs((Math.abs(line) % 1) - 0.5) < 1e-9;

/** Handicaps: com os times invertidos entre as casas, o lado troca e a linha muda de sinal. */
export const isHandicapType = (t: MarketType): boolean => t === 'handicap' || t === 'map_rounds_hcp' || t === 'map_kills_hcp';
/** Totais (mais/menos): não dependem da ordem dos times. */
export const isTotalType = (t: MarketType): boolean => t === 'total' || t === 'map_rounds_total' || t === 'map_kills_total';
/** Mercados cujos lados não são os times (mais/menos, sim/não): a ordem dos times não troca o lado. */
export const isOrderIndependent = (t: MarketType): boolean => isTotalType(t) || t === 'btts';

/** Partes do jogo (`MarketSpec.period`): sufixo da chave e rótulo. */
const PERIODS: Record<NonNullable<MarketSpec['period']>, string> = {
  h1: '1º tempo',
  q1: '1º quarto',
  set1: '1º set',
  i5: '5 primeiras entradas',
};

/** Unidade de handicap/total por esporte (eSports: mapas). */
export function unitOf(game?: Game): string {
  switch (game) {
    case 'soccer':
      return 'gols';
    case 'basketball':
    case 'american_football':
      return 'pontos';
    case 'baseball':
      return 'runs';
    case 'tennis':
      return 'games';
    default:
      return 'mapas';
  }
}

/** Mercados de um mapa: prefixo da chave e rótulos (unidade da linha). */
const PER_MAP: Partial<Record<MarketType, { key: string; label: string; unit: string }>> = {
  map_rounds_hcp: { key: 'rhcp', label: 'Handicap de rounds', unit: 'rounds' },
  map_rounds_total: { key: 'rtot', label: 'Total de rounds', unit: 'rounds' },
  map_kills_hcp: { key: 'khcp', label: 'Handicap de kills', unit: 'kills' },
  map_kills_total: { key: 'ktot', label: 'Total de kills', unit: 'kills' },
};

function baseKey(spec: MarketSpec): string {
  if (spec.type === 'handicap') return `hcp:${spec.line}`;
  if (spec.type === 'total') return `tot:${spec.line}`;
  if (spec.type === 'map') return `map:${spec.line}`;
  if (spec.type === 'btts') return 'btts';
  if (spec.type === 'dnb') return 'dnb';
  const per = PER_MAP[spec.type];
  if (per) return `${per.key}:${spec.map}:${spec.line}`;
  return 'win';
}

/** Chave do mercado dentro do evento; `@<período>` quando não é o jogo inteiro. */
export function marketKey(spec: MarketSpec): string {
  const base = baseKey(spec);
  return spec.period ? `${base}@${spec.period}` : base;
}

export const MAX_MAP = 7;
export const isMapNumber = (n: number): boolean => Number.isInteger(n) && n >= 1 && n <= MAX_MAP;

export function sameMarket(a: MarketSpec, b: MarketSpec): boolean {
  return (
    a.type === b.type && (a.line ?? 0) === (b.line ?? 0) && (a.map ?? 0) === (b.map ?? 0) && (a.period ?? '') === (b.period ?? '')
  );
}

export const fmtLine = (line: number): string => (line > 0 ? `+${line}` : String(line));

function baseLabel(spec: MarketSpec, game?: Game): string {
  const unit = unitOf(game);
  if (spec.type === 'handicap') return `Handicap de ${unit} ${fmtLine(spec.line!)}`;
  if (spec.type === 'total') return `Total de ${unit} ${spec.line}`;
  if (spec.type === 'map') return `Vencedor do mapa ${spec.line}`;
  if (spec.type === 'btts') return 'Ambas marcam';
  if (spec.type === 'dnb') return 'Empate anula';
  const per = PER_MAP[spec.type];
  if (per) return `Mapa ${spec.map}: ${per.label} ${isHandicapType(spec.type) ? fmtLine(spec.line!) : spec.line}`;
  // 1X2 tem as 3 seleções; nos demais esportes é a moneyline.
  if (game && isSport(game)) return game === 'soccer' ? 'Resultado final (1X2)' : 'Vencedor (moneyline)';
  return 'Vencedor da partida';
}

/** `game` define a unidade de handicap/total (mapas, gols, pontos, runs, games). */
export function marketLabel(spec: MarketSpec, game?: Game): string {
  const label = baseLabel(spec, game);
  return spec.period ? `${PERIODS[spec.period]}: ${label}` : label;
}

/** Rótulos das duas seleções do mercado. */
export function selectionLabels(spec: MarketSpec, teamA: string, teamB: string, game?: Game): [string, string] {
  const [a, b] = baseSelections(spec, teamA, teamB, game);
  if (!spec.period) return [a, b];
  const tag = ` (${PERIODS[spec.period]})`;
  return [a + tag, b + tag];
}

function baseSelections(spec: MarketSpec, teamA: string, teamB: string, game?: Game): [string, string] {
  const unit = unitOf(game);
  if (spec.type === 'handicap' && game && isSport(game))
    return [`${teamA} ${fmtLine(spec.line!)} ${unit}`, `${teamB} ${fmtLine(-spec.line!)} ${unit}`];
  if (spec.type === 'handicap') return [`${teamA} ${fmtLine(spec.line!)}`, `${teamB} ${fmtLine(-spec.line!)}`];
  if (spec.type === 'total') return [`Mais de ${spec.line} ${unit}`, `Menos de ${spec.line} ${unit}`];
  if (spec.type === 'btts') return ['Ambas marcam: sim', 'Ambas marcam: não'];
  if (spec.type === 'dnb') return [`${teamA} (empate anula)`, `${teamB} (empate anula)`];
  if (spec.type === 'map') return [`${teamA} (mapa ${spec.line})`, `${teamB} (mapa ${spec.line})`];
  const per = PER_MAP[spec.type];
  if (per && isHandicapType(spec.type))
    return [`${teamA} ${fmtLine(spec.line!)} ${per.unit} (mapa ${spec.map})`, `${teamB} ${fmtLine(-spec.line!)} ${per.unit} (mapa ${spec.map})`];
  if (per) return [`Mais de ${spec.line} ${per.unit} (mapa ${spec.map})`, `Menos de ${spec.line} ${per.unit} (mapa ${spec.map})`];
  return [teamA, teamB];
}

/** Chave e rótulos de um mercado derivado do evento `eventKey`. */
export function derivedQuoteFields(eventKey: string, spec: MarketSpec, teamA: string, teamB: string, game?: Game) {
  const [selA, selB] = selectionLabels(spec, teamA, teamB, game);
  // Só o vencedor do jogo inteiro é a âncora (`key === eventKey`); o de um período é derivado.
  const anchor = spec.type === 'winner' && !spec.period;
  return { key: anchor ? eventKey : `${eventKey}:${marketKey(spec)}`, eventKey, market: spec, selA, selB };
}
