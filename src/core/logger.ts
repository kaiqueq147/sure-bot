type Level = 'debug' | 'info' | 'warn' | 'error';

const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = order[(process.env.LOG_LEVEL as Level) ?? 'info'] ?? order.info;

export function createLogger(scope: string) {
  const write = (level: Level, msg: string, extra?: unknown) => {
    if (order[level] < threshold) return;
    const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}`;
    const out = level === 'error' || level === 'warn' ? console.error : console.log;
    if (extra === undefined) out(line);
    else out(line, extra instanceof Error ? extra.message : extra);
  };
  return {
    debug: (m: string, e?: unknown) => write('debug', m, e),
    info: (m: string, e?: unknown) => write('info', m, e),
    warn: (m: string, e?: unknown) => write('warn', m, e),
    error: (m: string, e?: unknown) => write('error', m, e),
  };
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function backoffDelay(attempt: number, minMs = 1_000, maxMs = 30_000): number {
  const base = Math.min(maxMs, minMs * 2 ** attempt);
  return Math.round(base / 2 + Math.random() * (base / 2));
}
