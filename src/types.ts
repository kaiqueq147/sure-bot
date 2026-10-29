export type BookId = 'polymarket' | 'thunderpick' | 'duel' | 'cloudbet' | 'stake';

export type Game =
  | 'cs2'
  | 'dota2'
  | 'lol'
  | 'valorant'
  | 'r6'
  | 'overwatch'
  | 'rl'
  | 'cod'
  | 'sc2'
  | 'mlbb'
  | 'hok'
  | 'aov'
  | 'other';

export type MarketType =
  | 'winner'
  | 'handicap'
  | 'total'
  | 'map'
  | 'map_rounds_hcp'
  | 'map_rounds_total'
  | 'map_kills_hcp'
  | 'map_kills_total';

/**
 * Mercado de 2 vias da série. Handicap: `line` é a linha do teamA (ex: −1.5) e o teamB tem −line.
 * Total de mapas: lado A = mais de `line`, lado B = menos de `line`. Só linhas x.5 (sem devolução).
 * Vencedor do mapa: `line` é o número do mapa; lados A/B = teamA/teamB, como no vencedor.
 * Mercados de um mapa (`map_*`): `map` é o número do mapa e `line` segue a regra de handicap/total.
 */
export interface MarketSpec {
  type: MarketType;
  line?: number;
  map?: number;
}

/** Nível do livro de ofertas: [preço por share 0..1, quantidade de shares] */
export type DepthLevel = [number, number];

/** Odds de um mercado de 2 vias de uma casa, já em formato decimal. */
export interface Quote {
  /** Vencedor: `${book}:${idDoEvento}`; demais: `${eventKey}:${marketKey(spec)}` */
  key: string;
  /** Chave do mercado de vencedor do mesmo jogo na mesma casa (âncora do pareamento) */
  eventKey: string;
  market: MarketSpec;
  book: BookId;
  marketId: string;
  game: Game;
  league?: string;
  eventName: string;
  teamA: string;
  teamB: string;
  /** Rótulos das seleções (ex: "NAVI −1.5", "Mais de 2.5 mapas"); vencedor usa os times */
  selA?: string;
  selB?: string;
  /** epoch ms */
  startTime?: number;
  oddsA: number | null;
  oddsB: number | null;
  /** Liquidez total (moeda da casa) disponível no livro, quando conhecida */
  maxStakeA?: number;
  maxStakeB?: number;
  /** Livro de ofertas (Polymarket), do melhor para o pior preço */
  depthA?: DepthLevel[];
  depthB?: DepthLevel[];
  suspended?: boolean;
  /** Taxa de taker da Polymarket (feeSchedule.rate) aplicada sobre p·(1−p) */
  takerFeeRate?: number;
  url: string;
  /** epoch ms da última atualização de preço */
  updatedAt: number;
  /** epoch ms em que odds/suspensão mudaram pela última vez (definido pelo OddsStore) */
  changedAt?: number;
}

export interface Leg {
  book: BookId;
  /** Chave do quote e lado apostado (para buscar o histórico) */
  key: string;
  side: 'A' | 'B';
  marketId: string;
  selection: string;
  odds: number;
  /** Odds após comissão da casa — usada nos cálculos */
  effectiveOdds: number;
  maxStake?: number;
  depth?: DepthLevel[];
  takerFeeRate?: number;
  commissionPct?: number;
  url: string;
  updatedAt: number;
  /** Quando o preço desta perna mudou pela última vez (preenchido ao enviar ao dashboard) */
  changedAt?: number;
  /** Jogo ao vivo com o preço parado há este tempo enquanto a outra casa se mexeu (provável odd congelada) */
  frozenMs?: number;
}

export type OpportunityStatus = 'pending' | 'confirmed';

export interface Opportunity {
  id: string;
  pairId: string;
  game: Game;
  eventName: string;
  market: MarketSpec;
  marketLabel: string;
  league?: string;
  startTime?: number;
  legs: [Leg, Leg];
  margin: number;
  profitPct: number;
  status: OpportunityStatus;
  firstSeen: number;
  updatedAt: number;
  matchScore: number;
  warnings: string[];
  /** `eventKey` dos eventos das duas pernas (preenchido ao enviar ao dashboard, para "par errado") */
  pairEvents?: [string, string];
}

export type ClosedReason = 'odds_moved' | 'stale' | 'unmatched';

/** Odd de uma casa para a seleção de uma aposta de valor. */
export interface ValueBookOdds {
  book: BookId;
  key: string;
  side: 'A' | 'B';
  odds: number;
  effectiveOdds: number;
  /** Primeira odd vista pelo bot neste mercado (desde que ele entrou no feed) */
  openingOdds?: number;
  /** Probabilidade justa (sem margem) que esta casa atribui à seleção */
  fairProb: number;
  /** Margem do mercado nesta casa, em % (1/oA + 1/oB − 1) */
  overroundPct: number;
  /** false quando a margem é alta demais para a casa entrar no consenso */
  inConsensus: boolean;
  maxStake?: number;
  url: string;
  updatedAt: number;
  /** Jogo ao vivo com o preço parado há este tempo enquanto outras casas se mexeram */
  frozenMs?: number;
  /** Evento desta casa (preenchido ao enviar ao dashboard, para "par errado") */
  eventKey?: string;
  /** Score do pareamento direto com a casa da melhor odd (preenchido ao enviar ao dashboard) */
  matchScore?: number;
}

/** Seleção cuja melhor odd está acima do consenso das outras casas (EV+). */
export interface ValueBet {
  /** `${groupId}#A|B` */
  id: string;
  game: Game;
  eventName: string;
  market: MarketSpec;
  marketLabel: string;
  league?: string;
  startTime?: number;
  live: boolean;
  selection: string;
  opponent: string;
  /** Todas as casas para esta seleção, da maior para a menor odd */
  books: ValueBookOdds[];
  bestBook: BookId;
  /** Probabilidade justa de consenso das outras casas e a odd equivalente */
  fairProb: number;
  fairOdds: number;
  /** (odd efetiva da melhor casa × probabilidade justa − 1) × 100 */
  evPct: number;
  /** (maior odd / menor odd − 1) × 100 */
  disparityPct: number;
  /** maior odd − menor odd */
  oddsDiff: number;
  firstSeen: number;
  updatedAt: number;
  warnings: string[];
}

export interface SourceStatus {
  book: BookId | 'simulator';
  state: 'idle' | 'connecting' | 'connected' | 'degraded' | 'disconnected' | 'error';
  quotes: number;
  lastMessageAt?: number;
  detail?: string;
  /** Atraso médio do dado, quando a fonte consegue medir */
  latencyMs?: number;
  /** Respostas 403/503/challenge da Cloudflare no último minuto */
  blockedPerMin?: number;
  /** Respostas 429 no último minuto */
  rateLimitedPerMin?: number;
}

export interface Source {
  readonly name: string;
  start(): void | Promise<void>;
  stop(): void | Promise<void>;
  status(): SourceStatus;
}
