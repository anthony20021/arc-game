export type ConnectionStatus =
  | "idle"
  | "connecting"
  | "SUBSCRIBED"
  | "CHANNEL_ERROR"
  | "TIMED_OUT"
  | "CLOSED";

export type Player = {
  id: string;
  name: string;
  joinedAt: number;
  isHost: boolean;
};

export type GamePhase = "clue" | "guess" | "reveal";

export type GameState = {
  phase: GamePhase;
  round: number;
  theme: string;
  clueGiverId: string;
  guesserId: string;
  clue?: string;
  guess?: number;
  secret?: number;
  score?: number;
  distance?: number;
  scores: Record<string, number>;
  updatedAt: number;
};

export type ChatMessage = {
  id: string;
  playerId: string;
  playerName: string;
  text: string;
  createdAt: number;
};

export type RoomEvent =
  | {
      kind: "chat-message";
      message: ChatMessage;
      from: string;
    }
  | {
      kind: "sync-request";
      from: string;
    }
  | {
      kind: "state-sync";
      state: GameState;
      from: string;
      to?: string;
    }
  | {
      kind: "diagnostic-ping";
      id: string;
      from: string;
      sentAt: number;
    }
  | {
      kind: "diagnostic-pong";
      id: string;
      from: string;
      to: string;
      sentAt: number;
      receivedAt: number;
    };

export type PresenceMeta = Player & {
  onlineAt: string;
};
