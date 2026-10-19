import { EventEmitter } from 'node:events';
import type { BookId, Quote } from '../types.js';

/**
 * Estado em memória das odds de todas as casas.
 *
 * Eventos:
 *  - `update` (quote): preço mudou
 *  - `keys`: conjunto de mercados mudou (entrou/saiu) — dispara novo matching
 *  - `availability` (book, available)
 */
export class OddsStore extends EventEmitter {
  private readonly quotes = new Map<string, Quote>();
  private readonly ttl = new Map<BookId, number>();
  private readonly unavailable = new Set<BookId>();

  /** Define por quanto tempo uma odd sem atualização continua válida para a casa. */
  setTtl(book: BookId, ms: number): void {
    this.ttl.set(book, ms);
  }

  upsert(quote: Quote): void {
    const isNew = !this.quotes.has(quote.key);
    this.quotes.set(quote.key, quote);
    if (isNew) this.emit('keys');
    this.emit('update', quote);
  }

  patch(key: string, partial: Partial<Quote>): Quote | undefined {
    const prev = this.quotes.get(key);
    if (!prev) return undefined;
    const next = { ...prev, ...partial };
    this.quotes.set(key, next);
    this.emit('update', next);
    return next;
  }

  remove(key: string): void {
    if (this.quotes.delete(key)) this.emit('keys');
  }

  get(key: string): Quote | undefined {
    return this.quotes.get(key);
  }

  all(): Quote[] {
    return [...this.quotes.values()];
  }

  byBook(book: BookId): Quote[] {
    return [...this.quotes.values()].filter((q) => q.book === book);
  }

  count(book: BookId): number {
    let n = 0;
    for (const q of this.quotes.values()) if (q.book === book) n++;
    return n;
  }

  /** Marca a casa inteira como indisponível (ex: WebSocket caiu): nenhuma odd dela é usada. */
  setAvailable(book: BookId, available: boolean): void {
    const was = !this.unavailable.has(book);
    if (available) this.unavailable.delete(book);
    else this.unavailable.add(book);
    if (was !== available) this.emit('availability', book, available);
  }

  isAvailable(book: BookId): boolean {
    return !this.unavailable.has(book);
  }

  isFresh(q: Quote, now = Date.now()): boolean {
    if (this.unavailable.has(q.book) || q.suspended) return false;
    if (!q.oddsA || !q.oddsB || q.oddsA <= 1 || q.oddsB <= 1) return false;
    const ttl = this.ttl.get(q.book);
    return ttl === undefined || now - q.updatedAt <= ttl;
  }
}
