import type { GameState, Player } from "./types";

export const DEFAULT_TARGET_SCORE = 15;

export const DEFAULT_THEMES = [
  "Nourriture sucree",
  "Nourriture salee",
  "Plat maison",
  "Dessert",
  "Snack",
  "Fast food",
  "Saveur de glace",
  "Bonbon",
  "Boisson",
  "Sauce",
  "Fruit",
  "Fromage",
  "Pizza",
  "Burger",
  "Tacos",
  "Jeu video",
  "Chanteur",
  "Chanteuse",
  "Rappeur",
  "Couleur",
  "Parfum",
  "Style de musique",
  "Star ac",
  "Activité",
  "Boisson sans alcool",
  "Boisson alcoolisée",
  "Boisson chaude",
  "Légume",
  "Marque de vêtements",
  "Ciao kombucha",
  "Matière scolaire",
  "Serie",
  "Film",
  "Phrase",
  "Dessin animé",
  "Série",
];

export const THEMES = DEFAULT_THEMES;

type NextTurnOptions = {
  resetScores?: boolean;
  targetScore?: number;
  themes?: string[];
};

export function createRoomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length: 5 }, () => {
    return alphabet[Math.floor(Math.random() * alphabet.length)];
  }).join("");
}

export function createPlayerId() {
  if ("randomUUID" in crypto) {
    return crypto.randomUUID();
  }

  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function normalizeRoomCode(value: string) {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 5);
}

export function clampPercent(value: number) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function createSecretPosition() {
  return Math.round(8 + Math.random() * 84);
}

export function scoreGuess(secret: number, guess: number) {
  const distance = Math.abs(secret - guess);

  if (distance <= 8) return { points: 3, distance };
  if (distance <= 18) return { points: 2, distance };
  if (distance <= 30) return { points: 1, distance };
  return { points: 0, distance };
}

export function sortPlayers(players: Player[]) {
  return [...players].sort((a, b) => {
    if (a.isHost !== b.isHost) return a.isHost ? -1 : 1;
    return a.joinedAt - b.joinedAt;
  });
}

export function pickTheme(themes = DEFAULT_THEMES, previousTheme?: string) {
  const usableThemes = themes.length > 0 ? themes : DEFAULT_THEMES;
  const availableThemes = usableThemes.filter((theme) => theme !== previousTheme);
  const pool = availableThemes.length > 0 ? availableThemes : usableThemes;

  return pool[Math.floor(Math.random() * pool.length)];
}

export function createNextTurn(
  players: Player[],
  previous?: GameState,
  options: NextTurnOptions = {},
): GameState {
  const activePlayers = sortPlayers(players).slice(0, 2);

  if (activePlayers.length < 2) {
    throw new Error("Deux joueurs sont necessaires.");
  }

  const round = (previous?.round ?? 0) + 1;
  const clueGiver = activePlayers[(round - 1) % activePlayers.length];
  const guesser = activePlayers[round % activePlayers.length];
  const targetScore = Math.max(
    1,
    Math.round(options.targetScore ?? previous?.targetScore ?? DEFAULT_TARGET_SCORE),
  );

  return {
    phase: "clue",
    round,
    theme: pickTheme(options.themes, previous?.theme),
    targetScore,
    clueGiverId: clueGiver.id,
    guesserId: guesser.id,
    scores: options.resetScores ? {} : previous?.scores ?? {},
    updatedAt: Date.now(),
  };
}
