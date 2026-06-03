import {
  FormEvent,
  PointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Bug,
  CheckCircle2,
  Copy,
  Crown,
  LogOut,
  MessageCircle,
  Play,
  Plus,
  Radio,
  Send,
  Users,
} from "lucide-react";
import {
  clampPercent,
  createNextTurn,
  createPlayerId,
  createRoomCode,
  createSecretPosition,
  normalizeRoomCode,
  scoreGuess,
  sortPlayers,
} from "./game";
import { hasSupabaseConfig, supabase } from "./lib/supabase";
import { supabaseConfigDiagnostics } from "./lib/supabase";
import type {
  ChatMessage,
  ConnectionStatus,
  GameState,
  Player,
  PresenceMeta,
  RoomEvent,
} from "./types";

const PLAYER_ID_STORAGE_KEY = "arc-clue-player-id";
const PLAYER_NAME_STORAGE_KEY = "arc-clue-player-name";
const LAST_ROOM_STORAGE_KEY = "arc-clue-last-room";
const ROOM_ROLE_STORAGE_PREFIX = "arc-clue-room-role:";
const ROOM_STATE_STORAGE_PREFIX = "arc-clue-room-state:";
const ROOM_SECRETS_STORAGE_PREFIX = "arc-clue-room-secrets:";
const CHANNEL_EVENT = "room-event";
const ROOM_RESUME_TTL_MS = 12 * 60 * 60 * 1000;

type RoomRole = "host" | "player";

type StoredGameState = {
  savedAt: number;
  state: GameState;
};

type DiagnosticLevel = "info" | "ok" | "warn" | "error";

type DiagnosticEntry = {
  id: string;
  createdAt: number;
  level: DiagnosticLevel;
  label: string;
  detail?: string;
};

type RealtimeStats = {
  sentEvents: number;
  receivedEvents: number;
  presenceSyncs: number;
  errors: number;
  lastAck?: string;
  lastAckMs?: number;
  lastTrack?: string;
  lastTrackMs?: number;
  lastPongAt?: number;
  pendingPingId?: string;
};

function getStoredPlayerId() {
  const stored = localStorage.getItem(PLAYER_ID_STORAGE_KEY);

  if (stored) return stored;

  const playerId = createPlayerId();
  localStorage.setItem(PLAYER_ID_STORAGE_KEY, playerId);
  return playerId;
}

function getRoomRoleStorageKey(roomCode: string) {
  return `${ROOM_ROLE_STORAGE_PREFIX}${roomCode}`;
}

function getRoomStateStorageKey(roomCode: string) {
  return `${ROOM_STATE_STORAGE_PREFIX}${roomCode}`;
}

function getRoomSecretsStorageKey(roomCode: string, playerId: string) {
  return `${ROOM_SECRETS_STORAGE_PREFIX}${roomCode}:${playerId}`;
}

function getStoredRoomRole(roomCode: string): RoomRole {
  return localStorage.getItem(getRoomRoleStorageKey(roomCode)) === "host"
    ? "host"
    : "player";
}

function rememberRoom(roomCode: string, role: RoomRole) {
  localStorage.setItem(LAST_ROOM_STORAGE_KEY, roomCode);
  localStorage.setItem(getRoomRoleStorageKey(roomCode), role);
}

function forgetLastRoom(roomCode: string) {
  if (localStorage.getItem(LAST_ROOM_STORAGE_KEY) === roomCode) {
    localStorage.removeItem(LAST_ROOM_STORAGE_KEY);
  }
}

function loadStoredGameState(roomCode: string) {
  if (!roomCode) return null;

  const rawState = localStorage.getItem(getRoomStateStorageKey(roomCode));

  if (!rawState) return null;

  try {
    const parsed = JSON.parse(rawState) as StoredGameState;

    if (!parsed.state || Date.now() - parsed.savedAt > ROOM_RESUME_TTL_MS) {
      localStorage.removeItem(getRoomStateStorageKey(roomCode));
      return null;
    }

    return parsed.state;
  } catch {
    localStorage.removeItem(getRoomStateStorageKey(roomCode));
    return null;
  }
}

function saveStoredGameState(roomCode: string, state: GameState | null) {
  const key = getRoomStateStorageKey(roomCode);

  if (!state) {
    localStorage.removeItem(key);
    return;
  }

  localStorage.setItem(
    key,
    JSON.stringify({
      savedAt: Date.now(),
      state,
    } satisfies StoredGameState),
  );
}

function loadStoredSecrets(roomCode: string, playerId: string) {
  if (!roomCode) return {};

  const rawSecrets = localStorage.getItem(
    getRoomSecretsStorageKey(roomCode, playerId),
  );

  if (!rawSecrets) return {};

  try {
    const parsed = JSON.parse(rawSecrets) as Record<string, number>;

    return Object.fromEntries(
      Object.entries(parsed)
        .map(([round, secret]) => [Number(round), secret])
        .filter(([round, secret]) => {
          return Number.isFinite(round) && typeof secret === "number";
        }),
    ) as Record<number, number>;
  } catch {
    localStorage.removeItem(getRoomSecretsStorageKey(roomCode, playerId));
    return {};
  }
}

function saveStoredSecrets(
  roomCode: string,
  playerId: string,
  secrets: Record<number, number>,
) {
  const key = getRoomSecretsStorageKey(roomCode, playerId);

  if (Object.keys(secrets).length === 0) {
    localStorage.removeItem(key);
    return;
  }

  localStorage.setItem(key, JSON.stringify(secrets));
}

function getResumeInfo(playerId: string) {
  const storedName = localStorage.getItem(PLAYER_NAME_STORAGE_KEY);
  const roomCode = normalizeRoomCode(
    localStorage.getItem(LAST_ROOM_STORAGE_KEY) ?? "",
  );

  if (!hasSupabaseConfig || !storedName || roomCode.length !== 5) {
    return {
      isHost: false,
      roomCode: "",
      secretByRound: {},
      state: null,
    };
  }

  return {
    isHost: getStoredRoomRole(roomCode) === "host",
    roomCode,
    secretByRound: loadStoredSecrets(roomCode, playerId),
    state: loadStoredGameState(roomCode),
  };
}

function playerNameFor(players: Player[], id?: string) {
  return players.find((player) => player.id === id)?.name ?? "Joueur";
}

function formatPercent(value?: number) {
  if (typeof value !== "number") return "--";
  return `${Math.round(value)}%`;
}

function flattenPresence(state: Record<string, PresenceMeta[]>) {
  return dedupePlayers(
    Object.values(state)
      .flat()
      .filter((meta) => meta.id && meta.name && meta.joinedAt),
  );
}

function dedupePlayers(players: Player[]) {
  const byId = new Map<string, Player>();

  for (const player of players) {
    const current = byId.get(player.id);

    if (!current) {
      byId.set(player.id, player);
      continue;
    }

    byId.set(player.id, {
      ...current,
      name: player.name || current.name,
      joinedAt: Math.min(current.joinedAt, player.joinedAt),
      isHost: current.isHost || player.isHost,
    });
  }

  return sortPlayers([...byId.values()]);
}

function pickActivePlayers(players: Player[]) {
  const uniquePlayers = dedupePlayers(players);
  const host = uniquePlayers.find((player) => player.isHost) ?? uniquePlayers[0];

  if (!host) return [];

  return [
    host,
    ...uniquePlayers.filter((player) => player.id !== host.id),
  ].slice(0, 2);
}

function describeRealtimeResponse(response: unknown) {
  if (typeof response === "string") return response;

  try {
    return JSON.stringify(response);
  } catch {
    return String(response);
  }
}

function responseLooksOk(response: unknown) {
  if (typeof response === "string") {
    return response.toLowerCase() === "ok";
  }

  if (response && typeof response === "object" && "status" in response) {
    return String(response.status).toLowerCase() === "ok";
  }

  return false;
}

function formatDiagnosticTime(timestamp: number) {
  return new Intl.DateTimeFormat("fr-FR", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(timestamp);
}

export function App() {
  const showDiagnostics = window.location.pathname
    .replace(/\/+$/, "")
    .endsWith("/dev");
  const [playerId] = useState(getStoredPlayerId);
  const [resumeInfo] = useState(() => getResumeInfo(playerId));
  const [playerName, setPlayerName] = useState(
    () => localStorage.getItem(PLAYER_NAME_STORAGE_KEY) ?? "",
  );
  const [roomCodeInput, setRoomCodeInput] = useState(resumeInfo.roomCode);
  const [roomCode, setRoomCode] = useState(resumeInfo.roomCode);
  const [isHost, setIsHost] = useState(resumeInfo.isHost);
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>("idle");
  const [players, setPlayers] = useState<Player[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [messageDraft, setMessageDraft] = useState("");
  const [gameState, setGameState] = useState<GameState | null>(
    resumeInfo.state,
  );
  const [secretByRound, setSecretByRound] = useState<Record<number, number>>(
    resumeInfo.secretByRound,
  );
  const [clueDraft, setClueDraft] = useState("");
  const [guess, setGuess] = useState(50);
  const [diagnostics, setDiagnostics] = useState<DiagnosticEntry[]>([]);
  const [realtimeStats, setRealtimeStats] = useState<RealtimeStats>({
    sentEvents: 0,
    receivedEvents: 0,
    presenceSyncs: 0,
    errors: 0,
  });

  const channelRef = useRef<RealtimeChannel | null>(null);
  const gameStateRef = useRef<GameState | null>(null);
  const localJoinedAtRef = useRef(Date.now());
  const autoStartedKeyRef = useRef<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  const localPlayer = useMemo<Player>(
    () => ({
      id: playerId,
      name: playerName.trim() || "Moi",
      joinedAt: localJoinedAtRef.current,
      isHost,
    }),
    [isHost, playerId, playerName],
  );
  const sortedPlayers = useMemo(() => {
    const hasLocalPresence = players.some((player) => player.id === playerId);
    const roster = hasLocalPresence || !roomCode ? players : [...players, localPlayer];

    return dedupePlayers(roster);
  }, [localPlayer, playerId, players, roomCode]);
  const activePlayers = useMemo(
    () => pickActivePlayers(sortedPlayers),
    [sortedPlayers],
  );
  const currentPlayer = sortedPlayers.find((player) => player.id === playerId);
  const roomHost =
    sortedPlayers.find((player) => player.isHost) ?? sortedPlayers[0] ?? null;
  const userIsHost = isHost || roomHost?.id === playerId;
  const userIsActive = activePlayers.some((player) => player.id === playerId);
  const clueGiverName = playerNameFor(sortedPlayers, gameState?.clueGiverId);
  const guesserName = playerNameFor(sortedPlayers, gameState?.guesserId);
  const userIsClueGiver = gameState?.clueGiverId === playerId;
  const userIsGuesser = gameState?.guesserId === playerId;
  const secretPosition =
    gameState && userIsClueGiver ? secretByRound[gameState.round] : undefined;

  const addDiagnostic = useCallback(
    (level: DiagnosticLevel, label: string, detail?: string) => {
      setDiagnostics((current) =>
        [
          {
            id: createPlayerId(),
            createdAt: Date.now(),
            level,
            label,
            detail,
          },
          ...current,
        ].slice(0, 12),
      );
    },
    [],
  );

  const broadcastRoomEvent = useCallback(
    async (event: RoomEvent, label = "Evenement Realtime") => {
      const channel = channelRef.current;

      if (!channel) {
        setRealtimeStats((current) => ({
          ...current,
          errors: current.errors + 1,
        }));
        addDiagnostic(
          "error",
          `${label}: channel absent`,
          "Aucune connexion Realtime active. Rejoins ou cree une room.",
        );
        return false;
      }

      const startedAt = performance.now();
      setRealtimeStats((current) => ({
        ...current,
        sentEvents: current.sentEvents + 1,
      }));

      try {
        const response = await channel.send({
          type: "broadcast",
          event: CHANNEL_EVENT,
          payload: event,
        });
        const ackMs = Math.round(performance.now() - startedAt);
        const ack = describeRealtimeResponse(response);
        const isOk = responseLooksOk(response);

        setRealtimeStats((current) => ({
          ...current,
          errors: isOk ? current.errors : current.errors + 1,
          lastAck: ack,
          lastAckMs: ackMs,
        }));
        addDiagnostic(
          isOk ? "ok" : "error",
          isOk ? `${label}: ack OK` : `${label}: ack KO`,
          `${ack} en ${ackMs}ms`,
        );

        return isOk;
      } catch (error) {
        setRealtimeStats((current) => ({
          ...current,
          errors: current.errors + 1,
          lastAck: "exception",
        }));
        addDiagnostic(
          "error",
          `${label}: exception`,
          error instanceof Error ? error.message : String(error),
        );
        return false;
      }
    },
    [addDiagnostic],
  );

  useEffect(() => {
    gameStateRef.current = gameState;
  }, [gameState]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    if (!roomCode) return;

    rememberRoom(roomCode, isHost ? "host" : "player");
  }, [isHost, roomCode]);

  useEffect(() => {
    if (!roomCode) return;

    saveStoredGameState(roomCode, gameState);
  }, [gameState, roomCode]);

  useEffect(() => {
    if (!roomCode) return;

    saveStoredSecrets(roomCode, playerId, secretByRound);
  }, [playerId, roomCode, secretByRound]);

  useEffect(() => {
    if (resumeInfo.roomCode) {
      addDiagnostic(
        "ok",
        "Room reprise",
        `Reconnexion automatique a la room ${resumeInfo.roomCode}.`,
      );
    }
  }, [addDiagnostic, resumeInfo.roomCode]);

  useEffect(() => {
    if (!gameState || !userIsClueGiver || secretByRound[gameState.round]) {
      return;
    }

    setSecretByRound((current) => ({
      ...current,
      [gameState.round]: createSecretPosition(),
    }));
  }, [gameState, secretByRound, userIsClueGiver]);

  useEffect(() => {
    if (
      !roomCode ||
      gameState ||
      !userIsHost ||
      activePlayers.length < 2 ||
      connectionStatus !== "SUBSCRIBED"
    ) {
      return;
    }

    const activeKey = `${roomCode}:${activePlayers
      .map((player) => player.id)
      .join(":")}`;

    if (autoStartedKeyRef.current === activeKey) {
      return;
    }

    autoStartedKeyRef.current = activeKey;

    const timer = window.setTimeout(() => {
      if (gameStateRef.current) return;

      const nextState = createNextTurn(activePlayers);
      setClueDraft("");
      setGuess(50);
      sendRoomEvent(
        { kind: "state-sync", state: nextState, from: playerId },
        "Demarrage auto",
      );
      addDiagnostic(
        "ok",
        "Manche demarree",
        "Deux joueurs detectes, la partie est lancee automatiquement.",
      );
    }, 300);

    return () => window.clearTimeout(timer);
  }, [
    activePlayers,
    addDiagnostic,
    connectionStatus,
    gameState,
    playerId,
    roomCode,
    userIsHost,
  ]);

  useEffect(() => {
    if (!roomCode) return;

    if (!supabase) {
      addDiagnostic(
        "error",
        "Configuration Supabase absente",
        "Vite ne voit pas VITE_SUPABASE_URL et VITE_SUPABASE_PUBLISHABLE_KEY.",
      );
      return;
    }

    const realtimeClient = supabase;
    const topic = `arc-clue:${roomCode}`;

    setConnectionStatus("connecting");
    addDiagnostic("info", "Connexion Realtime", topic);

    const channel = realtimeClient.channel(topic, {
      config: {
        broadcast: { self: false, ack: true },
        presence: { enabled: true, key: playerId } as {
          enabled: true;
          key: string;
        },
      },
    });

    channelRef.current = channel;

    channel
      .on("presence", { event: "sync" }, () => {
        const nextPlayers = flattenPresence(
          channel.presenceState() as Record<string, PresenceMeta[]>,
        );
        setPlayers(nextPlayers);
        setRealtimeStats((current) => ({
          ...current,
          presenceSyncs: current.presenceSyncs + 1,
        }));
        addDiagnostic(
          "ok",
          "Presence sync",
          `${nextPlayers.length} client(s) detecte(s) dans la room.`,
        );
      })
      .on("broadcast", { event: CHANNEL_EVENT }, ({ payload }) => {
        const event = payload as RoomEvent;

        setRealtimeStats((current) => ({
          ...current,
          receivedEvents: current.receivedEvents + 1,
        }));

        if (event.kind === "diagnostic-ping") {
          addDiagnostic(
            "info",
            "Ping diagnostic recu",
            `Ping recu depuis ${event.from.slice(0, 8)}.`,
          );

          if (event.from !== playerId) {
            void broadcastRoomEvent(
              {
                kind: "diagnostic-pong",
                id: event.id,
                from: playerId,
                to: event.from,
                sentAt: Date.now(),
                receivedAt: event.sentAt,
              },
              "Pong diagnostic",
            );
          }
        }

        if (event.kind === "diagnostic-pong" && event.to === playerId) {
          setRealtimeStats((current) => ({
            ...current,
            pendingPingId:
              current.pendingPingId === event.id
                ? undefined
                : current.pendingPingId,
            lastPongAt: Date.now(),
          }));
          addDiagnostic(
            "ok",
            "Pong diagnostic recu",
            `Un autre client a recu le ping ${event.id.slice(0, 8)}.`,
          );
        }

        if (event.kind === "chat-message") {
          setMessages((current) => {
            if (current.some((message) => message.id === event.message.id)) {
              return current;
            }

            return [...current, event.message].slice(-80);
          });
        }

        if (event.kind === "state-sync") {
          if (!event.to || event.to === playerId) {
            setGameState((current) => {
              if (current && current.updatedAt > event.state.updatedAt) {
                return current;
              }

              return event.state;
            });
          }
        }

        if (event.kind === "sync-request") {
          const currentState = gameStateRef.current;

          if (currentState) {
            void broadcastRoomEvent(
              {
                kind: "state-sync",
                state: currentState,
                from: playerId,
                to: event.from,
              },
              "Sync ciblee",
            );
          }
        }
      })
      .subscribe(async (status) => {
        setConnectionStatus(status as ConnectionStatus);
        addDiagnostic(
          status === "SUBSCRIBED" ? "ok" : "warn",
          "Statut channel",
          status,
        );

        if (status === "SUBSCRIBED") {
          const startedAt = performance.now();
          const trackResponse = await channel.track({
            id: playerId,
            name: playerName.trim(),
            joinedAt: Date.now(),
            isHost,
            onlineAt: new Date().toISOString(),
          } satisfies PresenceMeta);
          const trackMs = Math.round(performance.now() - startedAt);
          const track = describeRealtimeResponse(trackResponse);
          const trackOk = responseLooksOk(trackResponse);

          setRealtimeStats((current) => ({
            ...current,
            errors: trackOk ? current.errors : current.errors + 1,
            lastTrack: track,
            lastTrackMs: trackMs,
          }));
          addDiagnostic(
            trackOk ? "ok" : "error",
            trackOk ? "Presence track OK" : "Presence track KO",
            `${track} en ${trackMs}ms`,
          );

          void broadcastRoomEvent(
            { kind: "sync-request", from: playerId },
            "Demande de sync",
          );
        }

        if (
          status === "CHANNEL_ERROR" ||
          status === "TIMED_OUT" ||
          status === "CLOSED"
        ) {
          setRealtimeStats((current) => ({
            ...current,
            errors: current.errors + 1,
          }));
        }
      });

    return () => {
      channelRef.current = null;
      realtimeClient.removeChannel(channel);
    };
  }, [
    addDiagnostic,
    broadcastRoomEvent,
    isHost,
    playerId,
    playerName,
    roomCode,
  ]);

  const applyLocalEvent = (event: RoomEvent) => {
    if (event.kind === "chat-message") {
      setMessages((current) => [...current, event.message].slice(-80));
    }

    if (event.kind === "state-sync") {
      setGameState(event.state);
    }
  };

  const sendRoomEvent = (event: RoomEvent, label?: string) => {
    applyLocalEvent(event);
    void broadcastRoomEvent(event, label);
  };

  const runRealtimeTest = () => {
    if (connectionStatus !== "SUBSCRIBED") {
      addDiagnostic(
        "error",
        "Test impossible",
        "Le channel n'est pas encore SUBSCRIBED.",
      );
      return;
    }

    const id = createPlayerId();
    setRealtimeStats((current) => ({
      ...current,
      pendingPingId: id,
    }));
    addDiagnostic(
      "info",
      "Test broadcast lance",
      "Ouvre un deuxieme onglet dans la meme room pour recevoir un pong.",
    );
    void broadcastRoomEvent(
      { kind: "diagnostic-ping", id, from: playerId, sentAt: Date.now() },
      "Ping diagnostic",
    );

    window.setTimeout(() => {
      setRealtimeStats((current) => {
        if (current.pendingPingId !== id) return current;

        addDiagnostic(
          "warn",
          "Aucun pong recu",
          "Ack serveur possible, mais aucun autre client n'a repondu.",
        );
        return {
          ...current,
          pendingPingId: undefined,
        };
      });
    }, 3500);
  };

  const clearDiagnostics = () => {
    setDiagnostics([]);
  };

  const joinRoom = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!hasSupabaseConfig) return;

    const trimmedName = playerName.trim().slice(0, 24);
    const normalizedRoomCode = normalizeRoomCode(roomCodeInput);

    if (!trimmedName || !normalizedRoomCode) return;

    const storedRole = getStoredRoomRole(normalizedRoomCode);

    localStorage.setItem(PLAYER_NAME_STORAGE_KEY, trimmedName);
    setPlayerName(trimmedName);
    rememberRoom(normalizedRoomCode, storedRole);
    setIsHost(storedRole === "host");
    setRoomCode(normalizedRoomCode);
    setMessages([]);
    setGameState(loadStoredGameState(normalizedRoomCode));
    setSecretByRound(loadStoredSecrets(normalizedRoomCode, playerId));
  };

  const createRoom = () => {
    if (!hasSupabaseConfig) return;

    const trimmedName = playerName.trim().slice(0, 24);

    if (!trimmedName) return;

    const nextRoomCode = createRoomCode();

    localStorage.setItem(PLAYER_NAME_STORAGE_KEY, trimmedName);
    rememberRoom(nextRoomCode, "host");
    setPlayerName(trimmedName);
    setIsHost(true);
    setRoomCodeInput(nextRoomCode);
    setRoomCode(nextRoomCode);
    setMessages([]);
    setGameState(null);
    setSecretByRound({});
  };

  const leaveRoom = () => {
    forgetLastRoom(roomCode);
    setRoomCode("");
    setRoomCodeInput("");
    setPlayers([]);
    setMessages([]);
    setGameState(null);
    setSecretByRound({});
    setClueDraft("");
    setGuess(50);
    setConnectionStatus("idle");
    autoStartedKeyRef.current = null;
  };

  const copyRoomCode = async () => {
    await navigator.clipboard.writeText(roomCode);
  };

  const startNextRound = () => {
    if (!userIsHost || activePlayers.length < 2) return;

    const nextState = createNextTurn(activePlayers, gameState ?? undefined);
    setClueDraft("");
    setGuess(50);
    sendRoomEvent({ kind: "state-sync", state: nextState, from: playerId });
  };

  const submitClue = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!gameState || !userIsClueGiver) return;

    const clue = clueDraft.trim().slice(0, 80);
    const secret = secretByRound[gameState.round];

    if (!clue || typeof secret !== "number") return;

    sendRoomEvent({
      kind: "state-sync",
      state: {
        ...gameState,
        phase: "guess",
        clue,
        updatedAt: Date.now(),
      },
      from: playerId,
    });
  };

  const submitGuess = () => {
    if (!gameState || !userIsGuesser) return;

    sendRoomEvent({
      kind: "state-sync",
      state: {
        ...gameState,
        guess: clampPercent(guess),
        updatedAt: Date.now(),
      },
      from: playerId,
    });
  };

  const revealRound = () => {
    if (!gameState || !userIsClueGiver || typeof gameState.guess !== "number") {
      return;
    }

    const secret = secretByRound[gameState.round];

    if (typeof secret !== "number") return;

    const result = scoreGuess(secret, gameState.guess);
    const scores = {
      ...gameState.scores,
      [gameState.guesserId]:
        (gameState.scores[gameState.guesserId] ?? 0) + result.points,
    };

    sendRoomEvent({
      kind: "state-sync",
      state: {
        ...gameState,
        phase: "reveal",
        secret,
        score: result.points,
        distance: result.distance,
        scores,
        updatedAt: Date.now(),
      },
      from: playerId,
    });
  };

  const sendMessage = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const text = messageDraft.trim().slice(0, 240);

    if (!text || !currentPlayer) return;

    const message: ChatMessage = {
      id: createPlayerId(),
      playerId,
      playerName: currentPlayer.name,
      text,
      createdAt: Date.now(),
    };

    sendRoomEvent({ kind: "chat-message", message, from: playerId });
    setMessageDraft("");
  };

  if (!roomCode) {
    return (
      <main className="shell shell--entry">
        <section className="entry">
          <div className="brand-mark">
            <Radio aria-hidden="true" />
          </div>
          <p className="kicker">Arc Clue</p>
          <h1>Donne l'indice juste assez flou.</h1>
          <p className="entry-copy">
            Une room ephemere, deux joueurs, un theme, un arc et un chat live.
          </p>

          {!hasSupabaseConfig && (
            <div className="notice" role="alert">
              Ajoute les variables Supabase dans `.env.local` pour activer le
              temps reel.
            </div>
          )}

          <form className="entry-form" onSubmit={joinRoom}>
            <label>
              Pseudo
              <input
                autoComplete="name"
                maxLength={24}
                placeholder="Alex"
                value={playerName}
                onChange={(event) => setPlayerName(event.target.value)}
              />
            </label>

            <label>
              Code room
              <input
                autoComplete="off"
                maxLength={5}
                placeholder="A7K2P"
                value={roomCodeInput}
                onChange={(event) =>
                  setRoomCodeInput(normalizeRoomCode(event.target.value))
                }
              />
            </label>

            <div className="entry-actions">
              <button
                className="button button--secondary"
                disabled={!hasSupabaseConfig || !playerName.trim()}
                type="button"
                onClick={createRoom}
              >
                <Plus aria-hidden="true" />
                Creer
              </button>
              <button
                className="button"
                disabled={
                  !hasSupabaseConfig ||
                  !playerName.trim() ||
                  normalizeRoomCode(roomCodeInput).length < 5
                }
                type="submit"
              >
                Rejoindre
                <ArrowRight aria-hidden="true" />
              </button>
            </div>
          </form>

          {showDiagnostics && (
            <DiagnosticsPanel
              connectionStatus={connectionStatus}
              diagnostics={diagnostics}
              playersCount={players.length}
              realtimeStats={realtimeStats}
              roomCode={roomCode}
              onClear={clearDiagnostics}
              onRunTest={runRealtimeTest}
            />
          )}
        </section>
      </main>
    );
  }

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <p className="kicker">Room</p>
          <button className="room-code" type="button" onClick={copyRoomCode}>
            {roomCode}
            <Copy aria-hidden="true" />
          </button>
        </div>

        <div className="connection-pill" data-state={connectionStatus}>
          <span />
          {connectionStatus === "SUBSCRIBED" ? "Live" : connectionStatus}
        </div>

        <button className="icon-button" type="button" onClick={leaveRoom}>
          <LogOut aria-hidden="true" />
          <span className="sr-only">Quitter</span>
        </button>
      </header>

      <section className="game-layout">
        <aside className="side-panel">
          <div className="panel-heading">
            <Users aria-hidden="true" />
            <h2>Joueurs</h2>
          </div>

          <div className="players">
            {sortedPlayers.map((player, index) => (
              <div className="player-row" key={player.id}>
                <span className="avatar">{player.name.slice(0, 1).toUpperCase()}</span>
                <div>
                  <strong>{player.name}</strong>
                  <small>
                    {player.isHost && <Crown aria-hidden="true" />}
                    {index < 2 ? "En jeu" : "Spectateur"}
                  </small>
                </div>
                <b>{gameState?.scores[player.id] ?? 0}</b>
              </div>
            ))}
          </div>

          {!userIsActive && (
            <p className="helper">
              La room est deja pleine. Tu peux suivre la manche en spectateur.
            </p>
          )}

          {showDiagnostics && (
            <DiagnosticsPanel
              connectionStatus={connectionStatus}
              diagnostics={diagnostics}
              playersCount={players.length}
              realtimeStats={realtimeStats}
              roomCode={roomCode}
              onClear={clearDiagnostics}
              onRunTest={runRealtimeTest}
            />
          )}
        </aside>

        <section className="play-area">
          <RoundHeader
            activePlayers={activePlayers}
            clueGiverName={clueGiverName}
            gameState={gameState}
            guesserName={guesserName}
            userIsHost={userIsHost}
            onStartRound={startNextRound}
          />

          <GameBoard
            clueDraft={clueDraft}
            gameState={gameState}
            guess={guess}
            secretPosition={secretPosition}
            userIsClueGiver={userIsClueGiver}
            userIsGuesser={userIsGuesser}
            userIsHost={userIsHost}
            onClueDraftChange={setClueDraft}
            onGuessChange={setGuess}
            onRevealRound={revealRound}
            onStartRound={startNextRound}
            onSubmitClue={submitClue}
            onSubmitGuess={submitGuess}
          />
        </section>

        <aside className="chat-panel">
          <div className="panel-heading">
            <MessageCircle aria-hidden="true" />
            <h2>Chat</h2>
          </div>

          <div className="messages">
            {messages.length === 0 && (
              <p className="empty-message">Aucun message pour l'instant.</p>
            )}
            {messages.map((message) => (
              <article
                className={
                  message.playerId === playerId
                    ? "message message--mine"
                    : "message"
                }
                key={message.id}
              >
                <strong>{message.playerName}</strong>
                <p>{message.text}</p>
              </article>
            ))}
            <div ref={messagesEndRef} />
          </div>

          <form className="chat-form" onSubmit={sendMessage}>
            <input
              maxLength={240}
              placeholder="Message"
              value={messageDraft}
              onChange={(event) => setMessageDraft(event.target.value)}
            />
            <button className="icon-button icon-button--filled" type="submit">
              <Send aria-hidden="true" />
              <span className="sr-only">Envoyer</span>
            </button>
          </form>
        </aside>
      </section>
    </main>
  );
}

type RoundHeaderProps = {
  activePlayers: Player[];
  clueGiverName: string;
  gameState: GameState | null;
  guesserName: string;
  userIsHost: boolean;
  onStartRound: () => void;
};

type DiagnosticsPanelProps = {
  connectionStatus: ConnectionStatus;
  diagnostics: DiagnosticEntry[];
  playersCount: number;
  realtimeStats: RealtimeStats;
  roomCode: string;
  onClear: () => void;
  onRunTest: () => void;
};

function DiagnosticsPanel({
  connectionStatus,
  diagnostics,
  playersCount,
  realtimeStats,
  roomCode,
  onClear,
  onRunTest,
}: DiagnosticsPanelProps) {
  const urlOk = supabaseConfigDiagnostics.hasUrl;
  const keyOk =
    supabaseConfigDiagnostics.hasKey &&
    supabaseConfigDiagnostics.keyKind !== "secret invalide cote client";
  const channelOk = connectionStatus === "SUBSCRIBED";

  return (
    <section className="diagnostic-panel" aria-label="Diagnostic Supabase">
      <div className="panel-heading diagnostic-heading">
        <Bug aria-hidden="true" />
        <h2>Diagnostic</h2>
      </div>

      <div className="diagnostic-grid">
        <DiagnosticItem
          label="URL"
          level={urlOk ? "ok" : "error"}
          value={supabaseConfigDiagnostics.host ?? "manquante"}
        />
        <DiagnosticItem
          label="Key"
          level={keyOk ? "ok" : "error"}
          value={supabaseConfigDiagnostics.keyKind ?? "manquante"}
        />
        <DiagnosticItem
          label="Channel"
          level={channelOk ? "ok" : roomCode ? "warn" : "info"}
          value={roomCode ? connectionStatus : "hors room"}
        />
        <DiagnosticItem
          label="Presence"
          level={playersCount > 0 ? "ok" : roomCode ? "warn" : "info"}
          value={`${playersCount} client(s)`}
        />
      </div>

      <div className="diagnostic-stats">
        <span>Envoyes {realtimeStats.sentEvents}</span>
        <span>Recus {realtimeStats.receivedEvents}</span>
        <span>Sync {realtimeStats.presenceSyncs}</span>
        <span>Erreurs {realtimeStats.errors}</span>
      </div>

      {(realtimeStats.lastAck || realtimeStats.lastTrack) && (
        <div className="diagnostic-details">
          {realtimeStats.lastAck && (
            <span>
              Ack {realtimeStats.lastAck}
              {typeof realtimeStats.lastAckMs === "number"
                ? ` (${realtimeStats.lastAckMs}ms)`
                : ""}
            </span>
          )}
          {realtimeStats.lastTrack && (
            <span>
              Track {realtimeStats.lastTrack}
              {typeof realtimeStats.lastTrackMs === "number"
                ? ` (${realtimeStats.lastTrackMs}ms)`
                : ""}
            </span>
          )}
          {realtimeStats.lastPongAt && (
            <span>Pong {formatDiagnosticTime(realtimeStats.lastPongAt)}</span>
          )}
        </div>
      )}

      <div className="diagnostic-actions">
        <button
          className="button button--small"
          disabled={!roomCode || !channelOk}
          type="button"
          onClick={onRunTest}
        >
          <Activity aria-hidden="true" />
          Tester
        </button>
        <button
          className="button button--small button--ghost"
          disabled={diagnostics.length === 0}
          type="button"
          onClick={onClear}
        >
          Effacer
        </button>
      </div>

      <div className="diagnostic-log">
        {diagnostics.length === 0 ? (
          <p>Aucun evenement diagnostic.</p>
        ) : (
          diagnostics.map((entry) => (
            <article className="diagnostic-entry" data-level={entry.level} key={entry.id}>
              <div>
                <strong>{entry.label}</strong>
                <time>{formatDiagnosticTime(entry.createdAt)}</time>
              </div>
              {entry.detail && <p>{entry.detail}</p>}
            </article>
          ))
        )}
      </div>
    </section>
  );
}

type DiagnosticItemProps = {
  label: string;
  level: DiagnosticLevel;
  value: string;
};

function DiagnosticItem({ label, level, value }: DiagnosticItemProps) {
  const Icon = level === "ok" ? CheckCircle2 : AlertTriangle;

  return (
    <div className="diagnostic-item" data-level={level}>
      <Icon aria-hidden="true" />
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function RoundHeader({
  activePlayers,
  clueGiverName,
  gameState,
  guesserName,
  userIsHost,
  onStartRound,
}: RoundHeaderProps) {
  if (!gameState) {
    return (
      <div className="round-header">
        <div>
          <p className="kicker">Lobby</p>
          <h1>En attente de la manche</h1>
        </div>
        <button
          className="button"
          disabled={!userIsHost || activePlayers.length < 2}
          type="button"
          onClick={onStartRound}
        >
          <Play aria-hidden="true" />
          Lancer
        </button>
      </div>
    );
  }

  return (
    <div className="round-header">
      <div>
        <p className="kicker">Manche {gameState.round}</p>
        <h1>{gameState.theme}</h1>
      </div>
      <div className="turn-badges">
        <span>{clueGiverName} indice</span>
        <span>{guesserName} devine</span>
      </div>
    </div>
  );
}

type GameBoardProps = {
  clueDraft: string;
  gameState: GameState | null;
  guess: number;
  secretPosition?: number;
  userIsClueGiver: boolean;
  userIsGuesser: boolean;
  userIsHost: boolean;
  onClueDraftChange: (value: string) => void;
  onGuessChange: (value: number) => void;
  onRevealRound: () => void;
  onStartRound: () => void;
  onSubmitClue: (event: FormEvent<HTMLFormElement>) => void;
  onSubmitGuess: () => void;
};

function GameBoard({
  clueDraft,
  gameState,
  guess,
  secretPosition,
  userIsClueGiver,
  userIsGuesser,
  userIsHost,
  onClueDraftChange,
  onGuessChange,
  onRevealRound,
  onStartRound,
  onSubmitClue,
  onSubmitGuess,
}: GameBoardProps) {
  if (!gameState) {
    return (
      <div className="board board--empty">
        <ArcDial mode="preview" value={50} />
        <p>Invite un deuxieme joueur avec le code de room.</p>
      </div>
    );
  }

  if (gameState.phase === "clue") {
    return (
      <div className="board">
        <ArcDial mode="secret" value={secretPosition ?? 50} />
        {userIsClueGiver ? (
          <form className="clue-form" onSubmit={onSubmitClue}>
            <label>
              Ton objet
              <input
                autoFocus
                maxLength={80}
                placeholder="Ex: raclette, Zelda, Interstellar..."
                value={clueDraft}
                onChange={(event) => onClueDraftChange(event.target.value)}
              />
            </label>
            <button
              className="button"
              disabled={!clueDraft.trim() || typeof secretPosition !== "number"}
              type="submit"
            >
              Envoyer l'indice
              <Send aria-hidden="true" />
            </button>
          </form>
        ) : (
          <p className="stage-copy">Le joueur indice choisit son objet.</p>
        )}
      </div>
    );
  }

  if (gameState.phase === "guess") {
    return (
      <div className="board">
        <ArcDial
          mode={userIsGuesser ? "interactive" : "waiting"}
          value={userIsGuesser ? guess : gameState.guess ?? 50}
          onChange={onGuessChange}
        />
        <div className="clue-card">
          <span>Indice</span>
          <strong>{gameState.clue}</strong>
        </div>

        {userIsGuesser && typeof gameState.guess !== "number" && (
          <button className="button" type="button" onClick={onSubmitGuess}>
            Valider {formatPercent(guess)}
            <ArrowRight aria-hidden="true" />
          </button>
        )}

        {userIsClueGiver && typeof gameState.guess === "number" && (
          <button className="button" type="button" onClick={onRevealRound}>
            Reveler
            <Play aria-hidden="true" />
          </button>
        )}

        {!userIsGuesser && typeof gameState.guess !== "number" && (
          <p className="stage-copy">Le joueur devine place son curseur.</p>
        )}

        {typeof gameState.guess === "number" && !userIsClueGiver && (
          <p className="stage-copy">Proposition recue. En attente de la revelation.</p>
        )}
      </div>
    );
  }

  return (
    <div className="board">
      <ArcDial mode="reveal" value={gameState.secret ?? 50} guess={gameState.guess} />
      <div className="result-grid">
        <div>
          <span>Position</span>
          <strong>{formatPercent(gameState.secret)}</strong>
        </div>
        <div>
          <span>Guess</span>
          <strong>{formatPercent(gameState.guess)}</strong>
        </div>
        <div>
          <span>Score</span>
          <strong>{gameState.score ?? 0} pts</strong>
        </div>
      </div>
      <p className="stage-copy">
        Ecart de {gameState.distance ?? 0}. Le score est ajoute au joueur qui
        devine.
      </p>
      {userIsHost && (
        <button className="button" type="button" onClick={onStartRound}>
          Manche suivante
          <ArrowRight aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

type ArcMode = "preview" | "secret" | "interactive" | "waiting" | "reveal";

type ArcDialProps = {
  guess?: number;
  mode: ArcMode;
  value: number;
  onChange?: (value: number) => void;
};

function ArcDial({ guess, mode, value, onChange }: ArcDialProps) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const activeValue = clampPercent(value);
  const marker = pointOnArc(activeValue);
  const guessMarker = typeof guess === "number" ? pointOnArc(guess) : null;
  const isInteractive = mode === "interactive";

  const updateFromPointer = (event: PointerEvent<SVGSVGElement>) => {
    if (!isInteractive || !svgRef.current || !onChange) return;

    const rect = svgRef.current.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * 640;
    const y = ((event.clientY - rect.top) / rect.height) * 340;
    const dx = x - 320;
    const dy = 300 - y;
    const angle = Math.max(0, Math.min(Math.PI, Math.atan2(dy, dx)));
    const percent = ((Math.PI - angle) / Math.PI) * 100;

    onChange(clampPercent(percent));
  };

  return (
    <div className="arc-shell">
      <svg
        ref={svgRef}
        aria-label="Demi cercle de precision"
        className={isInteractive ? "arc arc--interactive" : "arc"}
        role="img"
        viewBox="0 0 640 340"
        onPointerDown={updateFromPointer}
        onPointerMove={(event) => {
          if (event.buttons > 0) updateFromPointer(event);
        }}
      >
        <path className="arc-track" d="M 80 300 A 240 240 0 0 1 560 300" />
        <path className="arc-glow" d="M 80 300 A 240 240 0 0 1 560 300" />
        {[0, 25, 50, 75, 100].map((tick) => {
          const tickPoint = pointOnArc(tick);

          return (
            <g key={tick}>
              <circle className="arc-tick" cx={tickPoint.x} cy={tickPoint.y} r="5" />
              <text className="arc-label" x={tickPoint.x} y={tickPoint.y + 32}>
                {tick}
              </text>
            </g>
          );
        })}
        {guessMarker && (
          <g>
            <line
              className="arc-guess-line"
              x1="320"
              x2={guessMarker.x}
              y1="300"
              y2={guessMarker.y}
            />
            <circle className="arc-guess-dot" cx={guessMarker.x} cy={guessMarker.y} r="14" />
          </g>
        )}
        <line
          className={mode === "secret" || mode === "reveal" ? "arc-line" : "arc-line arc-line--muted"}
          x1="320"
          x2={marker.x}
          y1="300"
          y2={marker.y}
        />
        <circle
          className={mode === "secret" || mode === "reveal" ? "arc-dot" : "arc-dot arc-dot--guess"}
          cx={marker.x}
          cy={marker.y}
          r="18"
        />
        <circle className="arc-center" cx="320" cy="300" r="9" />
      </svg>
      <div className="scale-labels">
        <span>Mouais</span>
        <strong>{mode === "interactive" ? formatPercent(activeValue) : "?"}</strong>
        <span>J'adore</span>
      </div>
    </div>
  );
}

function pointOnArc(percent: number) {
  const angle = Math.PI - (clampPercent(percent) / 100) * Math.PI;
  const radius = 240;

  return {
    x: 320 + radius * Math.cos(angle),
    y: 300 - radius * Math.sin(angle),
  };
}
