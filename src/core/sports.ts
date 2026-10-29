import type { Game } from '../types.js';

/** Esportes tradicionais: aparecem na aba "Esportes", separados dos eSports. */
export const SPORT_GAMES: readonly Game[] = ['soccer', 'basketball', 'baseball', 'tennis', 'american_football'];

const SPORTS = new Set<Game>(SPORT_GAMES);

export const isSport = (game: Game): boolean => SPORTS.has(game);

/** Esportes em que o resultado do jogo admite empate (vencedor de 3 vias). */
export const hasDraw = (game: Game): boolean => game === 'soccer';
