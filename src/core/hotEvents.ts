/**
 * Eventos "quentes": os que estão numa oportunidade aberta agora. As fontes consultam esses
 * eventos numa cadência mais rápida que a do feed geral. `eventKey` = Quote.eventKey
 * (ex: "stake:<fixtureId>"). Quem define o conjunto é o main, a partir dos motores.
 */
let current = new Set<string>();

export const hotEvents = {
  set(eventKeys: Iterable<string>): void {
    current = new Set(eventKeys);
  },
  has(eventKey: string): boolean {
    return current.has(eventKey);
  },
  get size(): number {
    return current.size;
  },
  /** Ids dos eventos quentes de uma casa (sem o prefixo "<casa>:"). */
  idsFor(book: string): string[] {
    const prefix = `${book}:`;
    return [...current].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length));
  },
};
