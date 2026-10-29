/** Conta bloqueios (403/503/challenge) e rate limits (429) do último minuto. */
export class NetStats {
  private readonly blocked: number[] = [];
  private readonly limited: number[] = [];

  /** Registra o status HTTP; devolve-o para encadear. */
  record(status: number): number {
    if (status === 429) this.limited.push(Date.now());
    else if (status === 403 || status === 503) this.blocked.push(Date.now());
    return status;
  }

  markBlocked(): void {
    this.blocked.push(Date.now());
  }

  fields(): { blockedPerMin: number; rateLimitedPerMin: number } {
    return { blockedPerMin: recent(this.blocked), rateLimitedPerMin: recent(this.limited) };
  }
}

function recent(list: number[]): number {
  const cutoff = Date.now() - 60_000;
  while (list.length && list[0] < cutoff) list.shift();
  return list.length;
}
