import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { DatabaseSync as Db } from 'node:sqlite';
import { createLogger } from './logger.js';
import type { BookId, Game } from '../types.js';

const log = createLogger('db');

export interface PersistenceOptions {
  path: string;
  retentionDays: number;
}

export interface TakenLeg {
  book: BookId;
  selection: string;
  odds: number;
  effectiveOdds: number;
  stake: number;
  url: string;
}

/** Instantâneo que o dashboard envia quando você marca "fiz esta". */
export interface TakenInput {
  oppId: string;
  game: Game;
  eventName: string;
  marketLabel: string;
  league?: string;
  startTime?: number;
  profitPct: number;
  bankroll: number;
  stakeA: number;
  stakeB: number;
  payout: number;
  profit: number;
  legs: TakenLeg[];
}

export interface TakenTrade extends TakenInput {
  takenAt: number;
  books: string;
}

export interface ReportGroup {
  key: string;
  count: number;
  avgProfit: number;
  maxProfit: number;
  totalProfit: number;
}

export interface Report {
  from: number;
  to: number;
  count: number;
  totalProfit: number;
  totalBankroll: number;
  avgProfitPct: number;
  byGame: ReportGroup[];
  byBooks: ReportGroup[];
  byMarket: ReportGroup[];
  byHour: number[];
  items: TakenTrade[];
}

interface TakenRow {
  opp_id: string;
  taken_at: number;
  game: string;
  event_name: string;
  market_label: string;
  league: string | null;
  start_time: number | null;
  books: string;
  profit_pct: number;
  bankroll: number;
  stake_a: number;
  stake_b: number;
  payout: number;
  profit: number;
  legs: string;
}

/**
 * Só o que você marcou como feita. Detectadas automaticamente não entram no banco.
 */
export class Persistence {
  private constructor(
    private readonly db: Db,
    private readonly opts: PersistenceOptions,
  ) {
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      DROP TABLE IF EXISTS opportunities;
      DROP TABLE IF EXISTS ev_bets;
      DROP TABLE IF EXISTS odds_history;
      CREATE TABLE IF NOT EXISTS taken (
        opp_id TEXT PRIMARY KEY,
        taken_at INTEGER NOT NULL,
        game TEXT NOT NULL,
        event_name TEXT NOT NULL,
        market_label TEXT NOT NULL,
        league TEXT,
        start_time INTEGER,
        books TEXT NOT NULL,
        profit_pct REAL NOT NULL,
        bankroll REAL NOT NULL,
        stake_a REAL NOT NULL,
        stake_b REAL NOT NULL,
        payout REAL NOT NULL,
        profit REAL NOT NULL,
        legs TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS taken_at ON taken(taken_at);
    `);
  }

  static async open(opts: PersistenceOptions): Promise<Persistence | null> {
    try {
      const { DatabaseSync } = await import('node:sqlite');
      mkdirSync(path.dirname(path.resolve(opts.path)), { recursive: true });
      const p = new Persistence(new DatabaseSync(opts.path), opts);
      log.info(`banco em ${opts.path} (só arbitragens que você marcar)`);
      return p;
    } catch (err) {
      log.warn('persistência desativada: node:sqlite indisponível (use Node ≥ 22.13)', err);
      return null;
    }
  }

  start(): void {
    this.prune();
  }

  close(): void {
    this.db.close();
  }

  clear(): { ok: true; removed: number } {
    const before = this.takenIds().length;
    this.db.exec('DELETE FROM taken');
    log.info(`histórico limpo: ${before} arbitragens apagadas`);
    return { ok: true, removed: before };
  }

  takenIds(): string[] {
    return (this.db.prepare('SELECT opp_id FROM taken').all() as Array<{ opp_id: string }>).map((r) => r.opp_id);
  }

  take(raw: unknown): { ok: true; already: boolean; oppId: string } | { error: string } {
    const input = parseTaken(raw);
    if ('error' in input) return input;
    const existing = this.db.prepare('SELECT opp_id FROM taken WHERE opp_id = ?').get(input.oppId) as { opp_id: string } | undefined;
    if (existing) return { ok: true, already: true, oppId: input.oppId };
    this.db
      .prepare(
        `INSERT INTO taken (opp_id, taken_at, game, event_name, market_label, league, start_time, books,
          profit_pct, bankroll, stake_a, stake_b, payout, profit, legs)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.oppId,
        Date.now(),
        input.game,
        input.eventName,
        input.marketLabel,
        input.league ?? null,
        input.startTime ?? null,
        input.legs.map((l) => l.book).join('×'),
        input.profitPct,
        input.bankroll,
        input.stakeA,
        input.stakeB,
        input.payout,
        input.profit,
        JSON.stringify(input.legs),
      );
    log.info(`feita +${input.profitPct.toFixed(2)}% ${input.eventName} · ${fmtMoney(input.profit)} com ${fmtMoney(input.bankroll)}`);
    return { ok: true, already: false, oppId: input.oppId };
  }

  report(fromMs: number, toMs = Date.now()): Report {
    this.prune();
    const rows = this.db
      .prepare('SELECT * FROM taken WHERE taken_at BETWEEN ? AND ? ORDER BY taken_at DESC')
      .all(fromMs, toMs) as unknown as TakenRow[];
    const items = rows.map(fromRow);
    const group = (key: (t: TakenTrade) => string): ReportGroup[] => {
      const m = new Map<string, TakenTrade[]>();
      for (const t of items) {
        const k = key(t);
        if (!m.has(k)) m.set(k, []);
        m.get(k)!.push(t);
      }
      return [...m.entries()]
        .map(([k, vs]) => ({
          key: k,
          count: vs.length,
          avgProfit: avg(vs.map((v) => v.profitPct)),
          maxProfit: Math.max(...vs.map((v) => v.profitPct)),
          totalProfit: vs.reduce((s, v) => s + v.profit, 0),
        }))
        .sort((a, b) => b.count - a.count);
    };
    const byHour = new Array(24).fill(0);
    for (const t of items) byHour[new Date(t.takenAt).getHours()]++;
    return {
      from: fromMs,
      to: toMs,
      count: items.length,
      totalProfit: items.reduce((s, t) => s + t.profit, 0),
      totalBankroll: items.reduce((s, t) => s + t.bankroll, 0),
      avgProfitPct: avg(items.map((t) => t.profitPct)),
      byGame: group((t) => t.game),
      byBooks: group((t) => t.books),
      byMarket: group((t) => t.marketLabel.replace(/ [+-]?\d+(\.\d+)?$/, '')),
      byHour,
      items: items.slice(0, 300),
    };
  }

  private prune(): void {
    try {
      this.db.prepare('DELETE FROM taken WHERE taken_at < ?').run(Date.now() - this.opts.retentionDays * 86_400_000);
    } catch (err) {
      log.warn('falha na limpeza do banco', err);
    }
  }
}

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const fmtMoney = (v: number) => `$ ${v.toFixed(2)}`;

function fromRow(r: TakenRow): TakenTrade {
  return {
    oppId: r.opp_id,
    takenAt: Number(r.taken_at),
    game: r.game as Game,
    eventName: r.event_name,
    marketLabel: r.market_label,
    league: r.league ?? undefined,
    startTime: r.start_time == null ? undefined : Number(r.start_time),
    books: r.books,
    profitPct: Number(r.profit_pct),
    bankroll: Number(r.bankroll),
    stakeA: Number(r.stake_a),
    stakeB: Number(r.stake_b),
    payout: Number(r.payout),
    profit: Number(r.profit),
    legs: JSON.parse(r.legs || '[]') as TakenLeg[],
  };
}

function parseTaken(raw: unknown): TakenInput | { error: string } {
  if (!raw || typeof raw !== 'object') return { error: 'pedido inválido' };
  const b = raw as Record<string, unknown>;
  const oppId = String(b.oppId ?? '').trim();
  const eventName = String(b.eventName ?? '').trim();
  const marketLabel = String(b.marketLabel ?? '').trim();
  const game = String(b.game ?? 'other') as Game;
  const num = (...keys: string[]) => {
    for (const k of keys) {
      const v = Number(b[k]);
      if (Number.isFinite(v)) return v;
    }
    return NaN;
  };
  const legs = Array.isArray(b.legs)
    ? b.legs.map((l) => {
        const x = l as Record<string, unknown>;
        return {
          book: String(x.book ?? '') as BookId,
          selection: String(x.selection ?? ''),
          odds: Number(x.odds),
          effectiveOdds: Number(x.effectiveOdds ?? x.odds),
          stake: Number(x.stake),
          url: String(x.url ?? ''),
        };
      })
    : [];
  if (!oppId || !eventName || legs.length !== 2) return { error: 'faltam o id, o jogo ou as duas pernas' };
  if (legs.some((l) => !l.book || !l.selection || !(l.odds > 1))) return { error: 'pernas incompletas' };
  const bankroll = num('bankroll');
  const stakeA = num('stakeA');
  const stakeB = num('stakeB');
  const payout = num('payout');
  const profit = num('profit');
  const profitPct = num('profitPct');
  if (![bankroll, stakeA, stakeB, payout, profit, profitPct].every(Number.isFinite)) return { error: 'valores da banca/stakes inválidos' };
  return {
    oppId,
    game,
    eventName,
    marketLabel: marketLabel || 'Vencedor da partida',
    league: typeof b.league === 'string' && b.league ? b.league : undefined,
    startTime: Number.isFinite(Number(b.startTime)) ? Number(b.startTime) : undefined,
    profitPct,
    bankroll,
    stakeA,
    stakeB,
    payout,
    profit,
    legs,
  };
}
