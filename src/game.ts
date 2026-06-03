import type { GameState, Player } from "./types";

export const THEMES = [
  "Nourriture sucree",
  "Nourriture salee",
  "Plat maison",
  "Dessert",
  "Snack",
  "Fast food",
  "Saveur de glace",
  "Bonbon",
  "Gateau",
  "Boisson",
  "Sauce",
  "Fruit",
  "Fromage",
  "Pizza",
  "Burger",
  "Tacos",
  "Sushi",
  "Jeu video",
  "Personnage de jeu video",
  "Console ou accessoire gaming",
  "Chanteur",
  "Chanteuse",
  "Rappeur",
  "Rappeuse",
];

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

export function pickTheme(previousTheme?: string) {
  const availableThemes = THEMES.filter((theme) => theme !== previousTheme);
  return availableThemes[Math.floor(Math.random() * availableThemes.length)];
}

export function createNextTurn(players: Player[], previous?: GameState): GameState {
  const activePlayers = sortPlayers(players).slice(0, 2);

  if (activePlayers.length < 2) {
    throw new Error("Deux joueurs sont necessaires.");
  }

  const round = (previous?.round ?? 0) + 1;
  const clueGiver = activePlayers[(round - 1) % activePlayers.length];
  const guesser = activePlayers[round % activePlayers.length];

  return {
    phase: "clue",
    round,
    theme: pickTheme(previous?.theme),
    clueGiverId: clueGiver.id,
    guesserId: guesser.id,
    scores: previous?.scores ?? {},
    updatedAt: Date.now(),
  };
}
