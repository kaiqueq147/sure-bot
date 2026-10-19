import type { OddsStore } from '../core/OddsStore.js';
import { WINNER } from '../core/markets.js';
import type { Game, Quote, Source, SourceStatus } from '../types.js';

/**
 * Gera odds sintéticas nas três casas com nomes propositalmente diferentes
 * (ex: "Natus Vincere" x "NAVI") e, de vez em quando, um erro de precificação
 * que cria uma arbitragem real — útil para validar matching, motor e UI.
 */
type SimMatch = { game: Game; league: string; poly: [string, string]; tp: [string, string]; duel: [string, string]; swapTp?: boolean };
const MATCHES: SimMatch[] = [
  { game: 'cs2', league: 'IEM Cologne', poly: ['Natus Vincere', 'FaZe Clan'], tp: ['NAVI', 'FaZe'], duel: ['Natus Vincere', 'FaZe'] },
  { game: 'cs2', league: 'BLAST Premier', poly: ['Team Vitality', 'MOUZ'], tp: ['mousesports', 'Vitality'], duel: ['Vitality', 'MOUZ'], swapTp: true },
  { game: 'dota2', league: 'The International', poly: ['Team Spirit', 'Gaimin Gladiators'], tp: ['Spirit', 'Gaimin Gladiators'], duel: ['Team Spirit', 'Gaimin'] },
  { game: 'lol', league: 'LCK', poly: ['T1', 'Gen.G'], tp: ['T1', 'GenG Esports'], duel: ['T1', 'Gen.G Esports'] },
  { game: 'valorant', league: 'VCT EMEA', poly: ['Fnatic', 'Team Heretics'], tp: ['FNATIC', 'Heretics'], duel: ['Fnatic', 'Team Heretics'] },
  { game: 'r6', league: 'Six Invitational', poly: ['FaZe Clan', 'w7m esports'], tp: ['FaZe', 'w7m'], duel: ['FaZe Clan', 'w7m Esports'] },
  { game: 'mlbb', league: 'MPL Indonesia', poly: ['RRQ Hoshi', 'ONIC Esports'], tp: ['RRQ Hoshi', 'ONIC'], duel: ['RRQ Hoshi', 'ONIC Esports'] },
  { game: 'overwatch', league: 'OWCS NA', poly: ['Team Liquid', 'NTMR'], tp: ['Liquid', 'NTMR'], duel: ['Team Liquid', 'NTMR'] },
  { game: 'hok', league: 'King Pro League', poly: ['Wolves', 'Hero JiuJing'], tp: ['Chongqing Wolves', 'Hero JiuJing'], duel: ['Wolves Esports', 'Hero Jiujing'] },
];

interface SimState {
  prob: number;
  glitchUntil: number;
  glitchSide: 'A' | 'B';
}

export class SimulatorSource implements Source {
  readonly name = 'simulator';
  private timer?: NodeJS.Timeout;
  private readonly states: SimState[] = MATCHES.map(() => ({ prob: 0.35 + Math.random() * 0.3, glitchUntil: 0, glitchSide: 'A' }));
  private lastTick?: number;

  constructor(private readonly store: OddsStore) {}

  start(): void {
    this.store.setTtl('polymarket', 30_000);
    this.store.setTtl('thunderpick', 30_000);
    this.store.setTtl('duel', 30_000);
    MATCHES.forEach((_, i) => this.publish(i));
    this.timer = setInterval(() => this.tick(), 700);
  }

  stop(): void {
    clearInterval(this.timer);
  }

  status(): SourceStatus {
    return {
      book: 'simulator',
      state: 'connected',
      quotes: this.store.count('polymarket') + this.store.count('thunderpick') + this.store.count('duel'),
      lastMessageAt: this.lastTick,
      detail: 'odds sintéticas',
    };
  }

  private tick(): void {
    this.lastTick = Date.now();
    const i = Math.floor(Math.random() * MATCHES.length);
    const s = this.states[i];
    s.prob = Math.min(0.85, Math.max(0.15, s.prob + (Math.random() - 0.5) * 0.04));
    if (Date.now() > s.glitchUntil && Math.random() < 0.08) {
      s.glitchUntil = Date.now() + 4_000 + Math.random() * 12_000;
      s.glitchSide = Math.random() < 0.5 ? 'A' : 'B';
    }
    this.publish(i);
  }

  private publish(i: number): void {
    const m = MATCHES[i];
    const s = this.states[i];
    const now = Date.now();
    const start = now + (i + 1) * 3600_000;

    // Polymarket: preço em ticks de 0.01 com spread de ~1 centavo por lado.
    const priceA = Math.min(0.99, Math.round((s.prob + 0.01) * 100) / 100);
    const priceB = Math.min(0.99, Math.round((1 - s.prob + 0.01) * 100) / 100);
    const poly: Quote = {
      key: `polymarket:sim-${i}`,
      eventKey: `polymarket:sim-${i}`,
      market: WINNER,
      book: 'polymarket',
      marketId: `sim-${i}`,
      game: m.game,
      league: m.league,
      eventName: `${m.poly[0]} vs ${m.poly[1]} (BO3) - ${m.league}`,
      teamA: m.poly[0],
      teamB: m.poly[1],
      startTime: start,
      oddsA: 1 / priceA,
      oddsB: 1 / priceB,
      maxStakeA: 50 + Math.random() * 3000,
      maxStakeB: 50 + Math.random() * 3000,
      url: 'https://polymarket.com/esports',
      updatedAt: now,
    };

    // Thunderpick: margem ~5%, com erro de precificação temporário num dos lados.
    const glitch = now < s.glitchUntil ? 1.12 : 1;
    let tA = 1 / (s.prob * 1.05);
    let tB = 1 / ((1 - s.prob) * 1.05);
    if (s.glitchSide === 'A') tB *= glitch;
    else tA *= glitch;
    const [tpTeamA, tpTeamB] = m.tp;
    const [oddsTpA, oddsTpB] = m.swapTp ? [tB, tA] : [tA, tB];
    const tp: Quote = {
      key: `thunderpick:sim-${i}`,
      eventKey: `thunderpick:sim-${i}`,
      market: WINNER,
      book: 'thunderpick',
      marketId: `sim-${i}`,
      game: m.game,
      league: m.league,
      eventName: `${tpTeamA} vs ${tpTeamB} - ${m.league}`,
      teamA: tpTeamA,
      teamB: tpTeamB,
      startTime: start + 5 * 60_000,
      oddsA: Math.round(oddsTpA * 100) / 100,
      oddsB: Math.round(oddsTpB * 100) / 100,
      url: 'https://thunderpick.io/esports',
      updatedAt: now,
    };

    // Duel: margem ~6% com ruído independente por lado.
    const noise = () => 1 + (Math.random() - 0.5) * 0.08;
    const duel: Quote = {
      key: `duel:sim-${i}`,
      eventKey: `duel:sim-${i}`,
      market: WINNER,
      book: 'duel',
      marketId: `sim-${i}`,
      game: m.game,
      league: m.league,
      eventName: `${m.duel[0]} vs ${m.duel[1]} - ${m.league}`,
      teamA: m.duel[0],
      teamB: m.duel[1],
      startTime: start,
      oddsA: Math.round((noise() / (s.prob * 1.06)) * 100) / 100,
      oddsB: Math.round((noise() / ((1 - s.prob) * 1.06)) * 100) / 100,
      url: 'https://duel.com/sports',
      updatedAt: now,
    };

    this.store.upsert(poly);
    this.store.upsert(tp);
    this.store.upsert(duel);
  }
}
