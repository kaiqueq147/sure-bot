import { isSport } from '../core/sports.js';
import type { Game } from '../types.js';

/** Tokens genéricos que as casas adicionam/omitem livremente. */
const STOPWORDS = new Set(['team', 'esports', 'esport', 'gaming', 'clan', 'club', 'the', 'org', 'gg']);

/** Tokens que distinguem equipes diferentes da mesma organização (T1 x T1 Academy). */
const DISTINGUISHING = new Set([
  'academy', 'youth', 'junior', 'jr', 'female', 'fe', 'women', 'ladies', 'young', 'challengers', 'ii', 'b',
]);

/** Nome normalizado (sem stopwords) ou forma compacta -> identificador canônico. */
const ALIASES: Record<string, string> = {
  'natus vincere': 'navi', navi: 'navi', natusvincere: 'navi',
  'ninjas in pyjamas': 'nip', nip: 'nip',
  mousesports: 'mouz', mouz: 'mouz',
  'gen g': 'geng', geng: 'geng',
  bilibili: 'blg', blg: 'blg',
  top: 'tes', tes: 'tes',
  weibo: 'wbg', wbg: 'wbg',
  jd: 'jdg', jdg: 'jdg', 'jingdong': 'jdg',
  cloud9: 'c9', 'cloud 9': 'c9', c9: 'c9',
  'virtus pro': 'vp', virtuspro: 'vp', vp: 'vp',
  'evil geniuses': 'eg', eg: 'eg',
  'royal never give up': 'rng', rng: 'rng',
  '100 thieves': '100t', '100t': '100t',
  'paper rex': 'prx', prx: 'prx',
  betboom: 'bb', bb: 'bb',
  complexity: 'col', col: 'col',
  gamerlegion: 'gl', gl: 'gl',
  'sk telecom t1': 't1', skt: 't1', 'skt t1': 't1',
  'dplus kia': 'dk', dplus: 'dk', dk: 'dk', 'damwon kia': 'dk',
  'kt rolster': 'kt', kt: 'kt',
  'hanwha life': 'hle', hle: 'hle',
  'mongolz': 'mongolz',
  'eternal fire': 'ef',
  'fnatic': 'fnc', fnc: 'fnc',
  'team liquid': 'liquid', liquid: 'liquid', tl: 'liquid',
  'nrg': 'nrg',
  'karmine corp': 'kc', kc: 'kc', 'karmine': 'kc',
  'team heretics': 'heretics', heretics: 'heretics', th: 'heretics',
  'leviatan': 'lev', lev: 'lev',
  'loud': 'loud',
  'furia': 'furia',
  'mibr': 'mibr',
};

/** Esportes tradicionais: siglas de clube que as casas põem ou tiram (FC Barcelona = Barcelona). */
const SPORT_STOPWORDS = new Set([
  'fc', 'cf', 'sc', 'ac', 'afc', 'cfc', 'cd', 'ca', 'club', 'de', 'del', 'la', 'futbol', 'football', 'calcio',
  'ssc', 'as', 'sv', 'fk', 'sk', 'bk', 'if', 'ik', 'rc', 'rcd', 'ud', 'sd', 'us', 'ac', 'vfb', 'vfl', 'tsg', 'the',
]);

/** Abreviações expandidas antes de comparar (Man Utd = Manchester United, LA Lakers = Los Angeles Lakers). */
const SPORT_EXPAND: Record<string, string> = {
  utd: 'united',
  man: 'manchester',
  la: 'los angeles',
  ny: 'new york',
  st: 'saint',
  munchen: 'munich',
  koln: 'cologne',
  psg: 'paris saint germain',
  okc: 'oklahoma city',
};

/** Equipes diferentes do mesmo clube (sub-21, feminino, reservas). */
const SPORT_DISTINGUISHING = new Set([...DISTINGUISHING, 'w', 'reserves', 'reserve', 'castilla', 'u17', 'u18', 'u19', 'u20', 'u21', 'u23']);

export function stripDiacritics(s: string): string {
  return s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
}

/** Minúsculas, sem acentos/pontuação, sem stopwords e sem sufixos de região/tag entre parênteses. */
export function normalizeTeam(name: string): string {
  const base = stripDiacritics(name)
    .toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, ' ')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  const tokens = base.split(/\s+/).filter(Boolean);
  const filtered = tokens.filter((t) => !STOPWORDS.has(t));
  return (filtered.length ? filtered : tokens).join(' ');
}

/** Nome de time de esporte tradicional: expande abreviações e tira siglas de clube. */
export function normalizeSportTeam(name: string): string {
  const base = stripDiacritics(name)
    .toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, ' ')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  // `la` só é Los Angeles antes de outro nome (LA Lakers); sozinho/no fim é artigo (Real Sociedad de la...).
  const raw = base.split(/\s+/).filter(Boolean);
  const expanded = raw.flatMap((t, i) => {
    if (t === 'la' && i !== 0) return [t];
    if (t === 'man' && !['utd', 'united', 'city'].includes(raw[i + 1] ?? '')) return [t];
    return (SPORT_EXPAND[t] ?? t).split(' ');
  });
  const filtered = expanded.filter((t) => !SPORT_STOPWORDS.has(t));
  return (filtered.length ? filtered : expanded).join(' ');
}

export function canonicalTeam(name: string): string {
  const n = normalizeTeam(name);
  const compact = n.replace(/ /g, '');
  return ALIASES[n] ?? ALIASES[compact] ?? compact;
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

export function levenshteinRatio(a: string, b: string): number {
  const max = Math.max(a.length, b.length);
  return max === 0 ? 1 : 1 - levenshtein(a, b) / max;
}

const initials = (normalized: string) =>
  normalized
    .split(' ')
    .filter(Boolean)
    .map((t) => t[0])
    .join('');

const simCache = new Map<string, number>();

type Mode = 'esports' | 'sport' | 'tennis';

const modeOf = (game?: Game): Mode => (game === 'tennis' ? 'tennis' : game && isSport(game) ? 'sport' : 'esports');

/**
 * Similaridade 0..1 entre dois nomes de time. `game` liga as regras de esportes tradicionais
 * (siglas de clube, abreviações; no tênis, sobrenome + inicial); sem ele, regras de eSports.
 */
export function teamSimilarity(a: string, b: string, game?: Game): number {
  const mode = modeOf(game);
  const cacheKey = `${mode}\u0000${a}\u0000${b}`;
  const cached = simCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const result = mode === 'tennis' ? playerSimilarity(a, b) : computeSimilarity(a, b, mode);
  // Esportes tradicionais têm milhares de nomes: cache maior para não recalcular a cada rematch.
  if (simCache.size > 200_000) simCache.clear();
  simCache.set(cacheKey, result);
  return result;
}

interface Prepared {
  n: string;
  c: string;
  tokens: Set<string>;
  distinguishing: Set<string>;
}

/** Cada nome aparece em centenas de comparações: normaliza uma vez só. */
const preparedCache = new Map<string, Prepared>();

function prepare(name: string, mode: Mode = 'esports'): Prepared {
  const cacheKey = `${mode}\u0000${name}`;
  let p = preparedCache.get(cacheKey);
  if (!p) {
    if (mode === 'esports') {
      const n = normalizeTeam(name);
      p = { n, c: canonicalTeam(name), tokens: new Set(n.split(' ')), distinguishing: DISTINGUISHING };
    } else {
      const n = normalizeSportTeam(name);
      p = { n, c: n.replace(/ /g, ''), tokens: new Set(n.split(' ')), distinguishing: SPORT_DISTINGUISHING };
    }
    if (preparedCache.size > 20_000) preparedCache.clear();
    preparedCache.set(cacheKey, p);
  }
  return p;
}

function computeSimilarity(a: string, b: string, mode: Mode = 'esports'): number {
  const { n: na, c: ca, tokens: ta, distinguishing } = prepare(a, mode);
  const { n: nb, c: cb, tokens: tb } = prepare(b, mode);
  const distinct = [...ta].some((t) => distinguishing.has(t) && !tb.has(t)) ||
    [...tb].some((t) => distinguishing.has(t) && !ta.has(t));
  if (distinct) return 0.4;

  if (ca === cb) return 1;

  let score = levenshteinRatio(ca, cb);

  const [short, long] = ca.length <= cb.length ? [ca, cb] : [cb, ca];
  if (short.length >= 3 && long.includes(short)) score = Math.max(score, 0.88);

  const inter = [...ta].filter((t) => tb.has(t)).length;
  const union = new Set([...ta, ...tb]).size;
  if (union) score = Math.max(score, inter / union);

  const ia = initials(na);
  const ib = initials(nb);
  if ((ia.length >= 2 && ia === cb) || (ib.length >= 2 && ib === ca)) return Math.max(score, 0.9);

  // Clubes da mesma cidade/organização (Manchester United x City, Real Madrid x Sociedad): cada
  // lado tem uma palavra própria que não é só outra grafia da do outro lado.
  if (mode === 'sport' && differentClubs(ta, tb)) return Math.min(score, 0.6);
  return score;
}

/** Palavras exclusivas dos dois lados, sem par de grafia parecida (Olympiakos ~ Olympiacos). */
function differentClubs(ta: Set<string>, tb: Set<string>): boolean {
  const onlyA = [...ta].filter((t) => !tb.has(t));
  const onlyB = [...tb].filter((t) => !ta.has(t));
  if (!onlyA.length || !onlyB.length) return false;
  const unmatchedA = onlyA.filter((x) => !onlyB.some((y) => levenshteinRatio(x, y) >= 0.75));
  const unmatchedB = onlyB.filter((y) => !onlyA.some((x) => levenshteinRatio(x, y) >= 0.75));
  return unmatchedA.length > 0 && unmatchedB.length > 0;
}

/**
 * Chaves de pré-filtro de um jogo de esporte tradicional: prefixo (4 letras) de cada palavra
 * relevante dos dois times. Dois nomes do mesmo time quase sempre compartilham uma delas
 * (sobrenome do tenista, nome da cidade/clube), então o matcher só compara quem compartilha.
 */
export function sportKeys(names: string[], game: Game): string[] {
  const words =
    game === 'tennis'
      ? names.flatMap((n) => n.split(/\s*[/&]\s*/).flatMap((p) => parsePlayer(p).surname.split(' ')))
      : names.flatMap((n) => normalizeSportTeam(n).split(' '));
  return [...new Set(words.filter((w) => w.length >= 3).map((w) => w.slice(0, 4)))];
}

interface Player {
  surname: string;
  initial?: string;
}

/**
 * Nome de tenista nas formas "Jannik Sinner", "Sinner J.", "J. Sinner" e "Sinner, Jannik".
 * Sobrenome composto ("Alex de Minaur", "De Minaur A.") fica com todas as palavras.
 */
export function parsePlayer(name: string): Player {
  const raw = stripDiacritics(name).toLowerCase().replace(/\(.*?\)|\[.*?\]/g, ' ').trim();
  const clean = (s: string) => s.replace(/[^a-z\s-]/g, ' ').replace(/-/g, ' ').split(/\s+/).filter(Boolean);
  if (raw.includes(',')) {
    const [last, first] = raw.split(',', 2);
    return { surname: clean(last).join(' '), initial: clean(first)[0]?.[0] };
  }
  const tokens = clean(raw.replace(/\./g, ' . '));
  const words = tokens.filter((t) => t !== '.');
  if (words.length < 2) return { surname: words.join(' ') };
  // "Sinner J." / "De Minaur A.": inicial no fim.
  if (words[words.length - 1].length === 1) return { surname: words.slice(0, -1).join(' '), initial: words[words.length - 1] };
  // "J. Sinner": inicial no começo.
  if (words[0].length === 1) return { surname: words.slice(1).join(' '), initial: words[0] };
  return { surname: words.slice(1).join(' '), initial: words[0][0] };
}

/** Um sobrenome contém o outro em palavras inteiras no fim ("de minaur" ~ "minaur"). */
const surnameMatch = (a: string, b: string): boolean => {
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return long.endsWith(` ${short}`) || long.startsWith(`${short} `);
};

function singlePlayer(a: string, b: string): number {
  const pa = parsePlayer(a);
  const pb = parsePlayer(b);
  if (!pa.surname || !pb.surname) return 0;
  const sameInitial = !pa.initial || !pb.initial || pa.initial === pb.initial;
  if (surnameMatch(pa.surname, pb.surname)) return sameInitial ? 1 : 0.4;
  // Grafias diferentes do sobrenome (transliteração): só com a inicial igual.
  const ratio = levenshteinRatio(pa.surname.replace(/ /g, ''), pb.surname.replace(/ /g, ''));
  return sameInitial ? ratio : Math.min(ratio, 0.4);
}

/** Tênis: simples por sobrenome + inicial; duplas ("A / B") pela melhor combinação das duplas. */
function playerSimilarity(a: string, b: string): number {
  const split = (s: string) => s.split(/\s*[/&]\s*/).filter(Boolean);
  const sa = split(a);
  const sb = split(b);
  if (sa.length !== sb.length) return 0;
  if (sa.length !== 2) return singlePlayer(a, b);
  const straight = Math.min(singlePlayer(sa[0], sb[0]), singlePlayer(sa[1], sb[1]));
  const crossed = Math.min(singlePlayer(sa[0], sb[1]), singlePlayer(sa[1], sb[0]));
  return Math.max(straight, crossed);
}

export function detectGame(...hints: Array<string | undefined | null>): Game {
  const s = hints.filter(Boolean).join(' ').toLowerCase();
  if (/counter[- ]?strike|\bcs ?(2|go)\b|\bcs:/.test(s)) return 'cs2';
  if (/dota/.test(s)) return 'dota2';
  if (/league[- ]of[- ]legends|\blol\b/.test(s)) return 'lol';
  if (/valorant/.test(s)) return 'valorant';
  if (/rainbow|\br6\b|siege/.test(s)) return 'r6';
  if (/overwatch/.test(s)) return 'overwatch';
  if (/rocket[- ]league/.test(s)) return 'rl';
  if (/call[- ]of[- ]duty|\bcod\b/.test(s)) return 'cod';
  if (/starcraft/.test(s)) return 'sc2';
  if (/mobile[- ]legends|\bmlbb\b/.test(s)) return 'mlbb';
  if (/honor[- ]of[- ]kings|king[- ]of[- ]glory|king[- ]pro[- ]league|\bhok\b|\bkpl\b/.test(s)) return 'hok';
  if (/arena[- ]of[- ](valor|glory)|\baov\b/.test(s)) return 'aov';
  return 'other';
}

export function gamesCompatible(a: Game, b: Game): boolean {
  return a === b || a === 'other' || b === 'other';
}
