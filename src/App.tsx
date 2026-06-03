import { FormEvent, PointerEvent, useEffect, useMemo, useRef, useState } from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import {
  ArrowRight,
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
const CHANNEL_EVENT = "room-event";

function getStoredPlayerId() {
  const stored = localStorage.getItem(PLAYER_ID_STORAGE_KEY);

  if (stored) return stored;

  const playerId = createPlayerId();
  localStorage.setItem(PLAYER_ID_STORAGE_KEY, playerId);
  return playerId;
}

function playerNameFor(players: Player[], id?: string) {
  return players.find((player) => player.id === id)?.name ?? "Joueur";
}

function formatPercent(value?: number) {
  if (typeof value !== "number") return "--";
  return `${Math.round(value)}%`;
}

function flattenPresence(state: Record<string, PresenceMeta[]>) {
  return sortPlayers(
    Object.values(state)
      .flat()
      .filter((meta) => meta.id && meta.name && meta.joinedAt),
  );
}

export function App() {
  const [playerId] = useState(getStoredPlayerId);
  const [playerName, setPlayerName] = useState(
    () => localStorage.getItem(PLAYER_NAME_STORAGE_KEY) ?? "",
  );
  const [roomCodeInput, setRoomCodeInput] = useState("");
  const [roomCode, setRoomCode] = useState("");
  const [isHost, setIsHost] = useState(false);
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>("idle");
  const [players, setPlayers] = useState<Player[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [messageDraft, setMessageDraft] = useState("");
  const [gameState, setGameState] = useState<GameState | null>(null);
  const [secretByRound, setSecretByRound] = useState<Record<number, number>>({});
  const [clueDraft, setClueDraft] = useState("");
  const [guess, setGuess] = useState(50);

  const channelRef = useRef<RealtimeChannel | null>(null);
  const gameStateRef = useRef<GameState | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  const sortedPlayers = useMemo(() => sortPlayers(players), [players]);
  const activePlayers = sortedPlayers.slice(0, 2);
  const currentPlayer = sortedPlayers.find((player) => player.id === playerId);
  const roomHost =
    sortedPlayers.find((player) => player.isHost) ?? sortedPlayers[0] ?? null;
  const userIsHost = roomHost?.id === playerId;
  const userIsActive = activePlayers.some((player) => player.id === playerId);
  const clueGiverName = playerNameFor(sortedPlayers, gameState?.clueGiverId);
  const guesserName = playerNameFor(sortedPlayers, gameState?.guesserId);
  const userIsClueGiver = gameState?.clueGiverId === playerId;
  const userIsGuesser = gameState?.guesserId === playerId;
  const secretPosition =
    gameState && userIsClueGiver ? secretByRound[gameState.round] : undefined;

  useEffect(() => {
    gameStateRef.current = gameState;
  }, [gameState]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

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
    if (!roomCode || !supabase) return;

    const realtimeClient = supabase;

    setConnectionStatus("connecting");

    const channel = realtimeClient.channel(`arc-clue:${roomCode}`, {
      config: {
        broadcast: { self: false, ack: true },
        presence: { key: playerId },
      },
    });

    channelRef.current = channel;

    const sendRoomEvent = (event: RoomEvent) => {
      channel.send({
        type: "broadcast",
        event: CHANNEL_EVENT,
        payload: event,
      });
    };

    channel
      .on("presence", { event: "sync" }, () => {
        setPlayers(flattenPresence(channel.presenceState() as Record<string, PresenceMeta[]>));
      })
      .on("broadcast", { event: CHANNEL_EVENT }, ({ payload }) => {
        const event = payload as RoomEvent;

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
            sendRoomEvent({
              kind: "state-sync",
              state: currentState,
              from: playerId,
              to: event.from,
            });
          }
        }
      })
      .subscribe(async (status) => {
        setConnectionStatus(status as ConnectionStatus);

        if (status === "SUBSCRIBED") {
          await channel.track({
            id: playerId,
            name: playerName.trim(),
            joinedAt: Date.now(),
            isHost,
            onlineAt: new Date().toISOString(),
          } satisfies PresenceMeta);

          sendRoomEvent({ kind: "sync-request", from: playerId });
        }
      });

    return () => {
      channelRef.current = null;
      realtimeClient.removeChannel(channel);
    };
  }, [isHost, playerId, playerName, roomCode]);

  const applyLocalEvent = (event: RoomEvent) => {
    if (event.kind === "chat-message") {
      setMessages((current) => [...current, event.message].slice(-80));
    }

    if (event.kind === "state-sync") {
      setGameState(event.state);
    }
  };

  const sendRoomEvent = (event: RoomEvent) => {
    applyLocalEvent(event);
    channelRef.current?.send({
      type: "broadcast",
      event: CHANNEL_EVENT,
      payload: event,
    });
  };

  const joinRoom = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!hasSupabaseConfig) return;

    const trimmedName = playerName.trim().slice(0, 24);
    const normalizedRoomCode = normalizeRoomCode(roomCodeInput);

    if (!trimmedName || !normalizedRoomCode) return;

    localStorage.setItem(PLAYER_NAME_STORAGE_KEY, trimmedName);
    setPlayerName(trimmedName);
    setIsHost(false);
    setRoomCode(normalizedRoomCode);
    setMessages([]);
    setGameState(null);
  };

  const createRoom = () => {
    if (!hasSupabaseConfig) return;

    const trimmedName = playerName.trim().slice(0, 24);

    if (!trimmedName) return;

    localStorage.setItem(PLAYER_NAME_STORAGE_KEY, trimmedName);
    setPlayerName(trimmedName);
    setIsHost(true);
    setRoomCode(createRoomCode());
    setMessages([]);
    setGameState(null);
  };

  const leaveRoom = () => {
    setRoomCode("");
    setRoomCodeInput("");
    setPlayers([]);
    setMessages([]);
    setGameState(null);
    setSecretByRound({});
    setClueDraft("");
    setGuess(50);
    setConnectionStatus("idle");
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
