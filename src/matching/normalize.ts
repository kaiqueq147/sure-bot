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

/** Similaridade 0..1 entre dois nomes de time. */
export function teamSimilarity(a: string, b: string): number {
  const cacheKey = `${a}\u0000${b}`;
  const cached = simCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const result = computeSimilarity(a, b);
  if (simCache.size > 50_000) simCache.clear();
  simCache.set(cacheKey, result);
  return result;
}

function computeSimilarity(a: string, b: string): number {
  const na = normalizeTeam(a);
  const nb = normalizeTeam(b);
  const ca = canonicalTeam(a);
  const cb = canonicalTeam(b);

  const ta = new Set(na.split(' '));
  const tb = new Set(nb.split(' '));
  const distinct = [...ta].some((t) => DISTINGUISHING.has(t) && !tb.has(t)) ||
    [...tb].some((t) => DISTINGUISHING.has(t) && !ta.has(t));
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
  if ((ia.length >= 2 && ia === cb) || (ib.length >= 2 && ib === ca)) score = Math.max(score, 0.9);

  return score;
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
