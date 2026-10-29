/**
 * Odd provavelmente congelada: jogo ao vivo, preço parado há `thresholdMs` ou mais e alguma outra
 * casa do mesmo mercado mudou de preço depois disso. Pré-jogo fica parado legitimamente.
 * Retorna há quanto tempo o preço está parado, ou undefined se não parece congelada.
 */
export function frozenFor(
  q: { startTime?: number; updatedAt: number; changedAt?: number },
  peers: ReadonlyArray<{ updatedAt: number; changedAt?: number }>,
  now: number,
  thresholdMs: number,
): number | undefined {
  if (!thresholdMs || !q.startTime || q.startTime > now) return undefined;
  const changed = q.changedAt ?? q.updatedAt;
  const age = now - changed;
  if (age < thresholdMs) return undefined;
  return peers.some((p) => (p.changedAt ?? p.updatedAt) > changed) ? age : undefined;
}

/** Soma das probabilidades implícitas. < 1 indica arbitragem. */
export function arbMargin(odds1: number, odds2: number): number {
  return 1 / odds1 + 1 / odds2;
}

/** Lucro garantido (%) sobre a banca total, dado a margem. */
export function profitPct(margin: number): number {
  return (1 / margin - 1) * 100;
}

/** Odds efetiva quando a casa cobra comissão (%) sobre o lucro líquido. */
export function applyCommission(odds: number, commissionPct: number): number {
  if (!commissionPct) return odds;
  return 1 + (odds - 1) * (1 - commissionPct / 100);
}

/**
 * Odd efetiva comprando shares na Polymarket como taker.
 * Taxa oficial: fee = shares × feeRate × p × (1 − p), logo custo/share = p·(1 + feeRate·(1 − p)).
 */
export function polymarketTakerOdds(price: number, feeRate: number): number {
  return 1 / (price * (1 + feeRate * (1 - price)));
}

/** Odd que o apostador realmente recebe: desconta a taxa de taker da Polymarket e a comissão da casa. */
export function effectiveOdds(
  q: { book: string; takerFeeRate?: number },
  odds: number,
  commissionPct: Partial<Record<string, number>>,
): number {
  const afterFee = q.takerFeeRate ? polymarketTakerOdds(1 / odds, q.takerFeeRate) : odds;
  return applyCommission(afterFee, commissionPct[q.book] ?? 0);
}

/** Probabilidade justa (sem margem) do lado A de um mercado de 2 vias. */
export function fairProbA(oddsA: number, oddsB: number): number {
  return 1 / oddsA / (1 / oddsA + 1 / oddsB);
}

/** Custo de uma share ao preço `p` comprando como taker (preço + taxa). */
const shareCost = (p: number, feeRate: number) => p * (1 + feeRate * (1 - p));

/**
 * Odd média obtida ao investir `usd` percorrendo o livro (melhor preço primeiro).
 * `filled` < `usd` quando o livro não tem profundidade suficiente.
 */
export function depthOdds(depth: Array<[number, number]>, usd: number, feeRate = 0): { odds: number; filled: number } | null {
  let remaining = usd;
  let shares = 0;
  for (const [p, size] of depth) {
    if (remaining <= 0) break;
    const unit = shareCost(p, feeRate);
    const take = Math.min(remaining, unit * size);
    shares += take / unit;
    remaining -= take;
  }
  const filled = usd - remaining;
  return filled > 0 ? { odds: shares / filled, filled } : null;
}

/** Converte preço de share (0..1) da Polymarket em odd decimal. */
export function priceToDecimalOdds(price: number): number | null {
  return price > 0 && price < 1 ? 1 / price : null;
}

/**
 * Distribui a banca para que o retorno seja igual nas duas pernas:
 * stake_i = banca * (1/odd_i) / margem
 */
export function splitStakes(bankroll: number, odds1: number, odds2: number) {
  const margin = arbMargin(odds1, odds2);
  const stake1 = (bankroll * (1 / odds1)) / margin;
  const stake2 = (bankroll * (1 / odds2)) / margin;
  const payout = bankroll / margin;
  return { stake1, stake2, payout, profit: payout - bankroll, margin };
}
