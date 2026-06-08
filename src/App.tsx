import {
  FormEvent,
  PointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { RealtimeChannel, Session, User } from "@supabase/supabase-js";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Bug,
  CheckCircle2,
  Copy,
  Crown,
  LockKeyhole,
  LogOut,
  Mail,
  MessageCircle,
  Play,
  Plus,
  Radio,
  Save,
  Send,
  ShieldCheck,
  Trash2,
  UserCheck,
  UserPlus,
  Users,
} from "lucide-react";
import {
  clampPercent,
  createNextTurn,
  createPlayerId,
  createRoomCode,
  DEFAULT_TARGET_SCORE,
  DEFAULT_THEMES,
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
const MIN_TARGET_SCORE = 3;
const MAX_TARGET_SCORE = 99;

type RoomRole = "host" | "player";
type AuthMode = "login" | "register";
type FriendStatus = "pending" | "accepted";

type Profile = {
  id: string;
  username: string;
  is_admin: boolean;
};

type AdminPlayer = Profile & {
  email: string | null;
  last_sign_in_at: string | null;
  created_at?: string;
};

type ThemeRow = {
  id: number;
  label: string;
  created_by: string | null;
  created_at?: string;
};

type ThemeGroup = {
  id: string;
  owner_id: string;
  name: string;
  created_at?: string;
  themes: ThemeRow[];
};

type FriendLink = {
  id: string;
  requester_id: string;
  addressee_id: string;
  status: FriendStatus;
  requester?: Profile | null;
  addressee?: Profile | null;
};

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

function clampTargetScore(value: number) {
  if (!Number.isFinite(value)) return DEFAULT_TARGET_SCORE;
  return Math.max(MIN_TARGET_SCORE, Math.min(MAX_TARGET_SCORE, Math.round(value)));
}

function cleanUsername(value: string) {
  return value.trim().replace(/\s+/g, " ").slice(0, 24);
}

function cleanThemeLabel(value: string) {
  return value.trim().replace(/\s+/g, " ").slice(0, 60);
}

function normalizeAuthEmail(value: string) {
  const trimmed = value.trim().toLowerCase();

  if (!trimmed) return "";
  return trimmed.includes("@") ? trimmed : `${trimmed}@arc-clue.local`;
}

function getFallbackUsername(user: User) {
  const metadataName =
    typeof user.user_metadata?.username === "string"
      ? user.user_metadata.username
      : "";
  const emailName = user.email?.split("@")[0] ?? "";
  const cleaned = cleanUsername(metadataName || emailName);

  return cleaned || `joueur-${user.id.slice(0, 8)}`;
}

function normalizeJoinedProfile(value: unknown) {
  const profile = Array.isArray(value) ? value[0] : value;

  if (!profile || typeof profile !== "object") return null;

  return profile as Profile;
}

async function ensureProfile(user: User, requestedUsername?: string) {
  if (!supabase) return null;

  const fallbackUsername = getFallbackUsername(user);
  const username = cleanUsername(requestedUsername ?? fallbackUsername);

  const { data: existing, error: selectError } = await supabase
    .from("profiles")
    .select("id, username, is_admin")
    .eq("id", user.id)
    .maybeSingle();

  if (selectError) throw selectError;

  if (existing) {
    const profile = existing as Profile;

    if (requestedUsername && username && profile.username !== username) {
      const { data: updated, error: updateError } = await supabase
        .from("profiles")
        .update({ username })
        .eq("id", user.id)
        .select("id, username, is_admin")
        .maybeSingle();

      if (!updateError && updated) return updated as Profile;
    }

    return profile;
  }

  const { data: inserted, error: insertError } = await supabase
    .from("profiles")
    .insert({
      id: user.id,
      username,
    })
    .select("id, username, is_admin")
    .maybeSingle();

  if (insertError) {
    const { data: fallback, error: fallbackError } = await supabase
      .from("profiles")
      .insert({
        id: user.id,
        username: `joueur-${user.id.slice(0, 8)}`,
      })
      .select("id, username, is_admin")
      .maybeSingle();

    if (fallbackError) throw insertError;
    return fallback as Profile;
  }

  return inserted as Profile;
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
  const [session, setSession] = useState<Session | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [authMode, setAuthMode] = useState<AuthMode>("login");
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authUsername, setAuthUsername] = useState("");
  const [authError, setAuthError] = useState("");
  const [authLoading, setAuthLoading] = useState(false);
  const [needsBootstrapAdmin, setNeedsBootstrapAdmin] = useState(false);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [profileLoading, setProfileLoading] = useState(false);
  const [databaseLoading, setDatabaseLoading] = useState(false);
  const [databaseError, setDatabaseError] = useState("");
  const [themes, setThemes] = useState<ThemeRow[]>([]);
  const [themeEdits, setThemeEdits] = useState<Record<number, string>>({});
  const [newThemeLabel, setNewThemeLabel] = useState("");
  const [themeGroups, setThemeGroups] = useState<ThemeGroup[]>([]);
  const [selectedThemeGroupId, setSelectedThemeGroupId] = useState("");
  const [groupName, setGroupName] = useState("");
  const [groupThemeIds, setGroupThemeIds] = useState<number[]>([]);
  const [friends, setFriends] = useState<FriendLink[]>([]);
  const [friendSearch, setFriendSearch] = useState("");
  const [adminPlayers, setAdminPlayers] = useState<AdminPlayer[]>([]);
  const [adminCreateLogin, setAdminCreateLogin] = useState("");
  const [adminCreateUsername, setAdminCreateUsername] = useState("");
  const [adminCreatePassword, setAdminCreatePassword] = useState("");
  const [adminCreateIsAdmin, setAdminCreateIsAdmin] = useState(false);
  const [adminPasswordEdits, setAdminPasswordEdits] = useState<Record<string, string>>(
    {},
  );
  const [adminUsersLoading, setAdminUsersLoading] = useState(false);
  const [adminUserMessage, setAdminUserMessage] = useState("");
  const [anonymousPlayerId] = useState(getStoredPlayerId);
  const playerId = session?.user.id ?? anonymousPlayerId;
  const [resumeInfo] = useState(() => getResumeInfo(playerId));
  const [playerName, setPlayerName] = useState(
    () => localStorage.getItem(PLAYER_NAME_STORAGE_KEY) ?? "",
  );
  const [roomCodeInput, setRoomCodeInput] = useState(resumeInfo.roomCode);
  const [roomCode, setRoomCode] = useState(resumeInfo.roomCode);
  const [isHost, setIsHost] = useState(resumeInfo.isHost);
  const [targetScore, setTargetScore] = useState(DEFAULT_TARGET_SCORE);
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
  const selectedThemeGroup = useMemo(
    () =>
      themeGroups.find((themeGroup) => themeGroup.id === selectedThemeGroupId) ??
      null,
    [selectedThemeGroupId, themeGroups],
  );
  const gameThemeLabels = useMemo(() => {
    const groupThemes = selectedThemeGroup?.themes.map((theme) => theme.label) ?? [];

    if (groupThemes.length > 0) return groupThemes;
    if (themes.length > 0) return themes.map((theme) => theme.label);
    return DEFAULT_THEMES;
  }, [selectedThemeGroup, themes]);
  const resolvedTargetScore = clampTargetScore(targetScore);
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

  const adminApiRequest = useCallback(
    async <T,>(method: string, body?: Record<string, unknown>) => {
      const token = session?.access_token;

      if (!token) throw new Error("Session admin absente.");

      const response = await fetch("/api/admin-users", {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const payload = (await response.json()) as T & { error?: string };

      if (!response.ok) {
        throw new Error(payload.error ?? "Action admin impossible.");
      }

      return payload;
    },
    [session?.access_token],
  );

  const loadAdminUsers = useCallback(async () => {
    if (!profile?.is_admin || !session?.access_token) return;

    setAdminUsersLoading(true);

    try {
      const payload = await adminApiRequest<{ users: AdminPlayer[] }>("GET");
      setAdminPlayers(payload.users);
    } catch (error) {
      setAdminUserMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setAdminUsersLoading(false);
    }
  }, [adminApiRequest, profile?.is_admin, session?.access_token]);

  const loadDatabaseData = useCallback(async () => {
    if (!supabase || !profile) return;

    setDatabaseLoading(true);
    setDatabaseError("");

    try {
      const { data: themeRows, error: themesError } = await supabase
        .from("themes")
        .select("id, label, created_by, created_at")
        .order("label", { ascending: true });

      if (themesError) throw themesError;

      const nextThemes = (themeRows ?? []) as ThemeRow[];
      setThemes(nextThemes);
      setThemeEdits(
        Object.fromEntries(
          nextThemes.map((theme) => [theme.id, theme.label]),
        ) as Record<number, string>,
      );

      const { data: groupRows, error: groupsError } = await supabase
        .from("theme_groups")
        .select("id, owner_id, name, created_at")
        .eq("owner_id", profile.id)
        .order("created_at", { ascending: false });

      if (groupsError) throw groupsError;

      const groups = (groupRows ?? []) as Omit<ThemeGroup, "themes">[];
      const groupIds = groups.map((group) => group.id);
      const itemRows =
        groupIds.length > 0
          ? await supabase
              .from("theme_group_items")
              .select(
                "group_id, themes(id, label, created_by, created_at)",
              )
              .in("group_id", groupIds)
          : { data: [], error: null };

      if (itemRows.error) throw itemRows.error;

      const themesByGroup = new Map<string, ThemeRow[]>();

      for (const item of itemRows.data ?? []) {
        const row = item as {
          group_id: string;
          themes?: ThemeRow | ThemeRow[] | null;
        };
        const theme = Array.isArray(row.themes) ? row.themes[0] : row.themes;

        if (!theme) continue;

        themesByGroup.set(row.group_id, [
          ...(themesByGroup.get(row.group_id) ?? []),
          theme,
        ]);
      }

      const nextThemeGroups = groups.map((group) => ({
        ...group,
        themes: themesByGroup.get(group.id) ?? [],
      }));

      setThemeGroups(nextThemeGroups);
      setSelectedThemeGroupId((current) =>
        current && nextThemeGroups.some((group) => group.id === current)
          ? current
          : "",
      );

      const { data: friendRows, error: friendsError } = await supabase
        .from("friendships")
        .select(
          [
            "id",
            "requester_id",
            "addressee_id",
            "status",
            "requester:profiles!friendships_requester_id_fkey(id, username, is_admin)",
            "addressee:profiles!friendships_addressee_id_fkey(id, username, is_admin)",
          ].join(", "),
        )
        .or(`requester_id.eq.${profile.id},addressee_id.eq.${profile.id}`)
        .order("created_at", { ascending: false });

      if (friendsError) throw friendsError;

      setFriends(
        ((friendRows ?? []) as unknown as Array<
          FriendLink & {
            requester?: unknown;
            addressee?: unknown;
          }
        >).map((friend) => ({
          id: friend.id,
          requester_id: friend.requester_id,
          addressee_id: friend.addressee_id,
          status: friend.status,
          requester: normalizeJoinedProfile(friend.requester),
          addressee: normalizeJoinedProfile(friend.addressee),
        })),
      );
    } catch (error) {
      setDatabaseError(error instanceof Error ? error.message : String(error));
    } finally {
      setDatabaseLoading(false);
    }
  }, [profile]);

  useEffect(() => {
    if (!supabase) {
      setAuthReady(true);
      return;
    }

    let isMounted = true;

    supabase.auth
      .getSession()
      .then(({ data }) => {
        if (!isMounted) return;
        setSession(data.session);
        setAuthReady(true);
      })
      .catch((error) => {
        if (!isMounted) return;
        setAuthError(error instanceof Error ? error.message : String(error));
        setAuthReady(true);
      });

    const { data: authListener } = supabase.auth.onAuthStateChange(
      (_event, nextSession) => {
        setSession(nextSession);
      },
    );

    return () => {
      isMounted = false;
      authListener.subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!hasSupabaseConfig) return;

    let isMounted = true;

    fetch("/api/admin-users?bootstrap=status")
      .then(async (response) => {
        const payload = (await response.json()) as {
          needsBootstrap?: boolean;
        };

        if (!isMounted || !response.ok) return;
        setNeedsBootstrapAdmin(Boolean(payload.needsBootstrap));
      })
      .catch(() => {
        if (!isMounted) return;
        setNeedsBootstrapAdmin(false);
      });

    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    if (!supabase || !session?.user) {
      setProfile(null);
      return;
    }

    let isMounted = true;

    setProfileLoading(true);
    ensureProfile(session.user)
      .then((nextProfile) => {
        if (!isMounted) return;
        setProfile(nextProfile);
      })
      .catch((error) => {
        if (!isMounted) return;
        setDatabaseError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (!isMounted) return;
        setProfileLoading(false);
      });

    return () => {
      isMounted = false;
    };
  }, [session]);

  useEffect(() => {
    if (!profile) return;

    const storedName = localStorage.getItem(PLAYER_NAME_STORAGE_KEY);

    if (!storedName) {
      setPlayerName(profile.username);
      localStorage.setItem(PLAYER_NAME_STORAGE_KEY, profile.username);
    }
  }, [profile]);

  useEffect(() => {
    void loadDatabaseData();
  }, [loadDatabaseData]);

  useEffect(() => {
    void loadAdminUsers();
  }, [loadAdminUsers]);

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

      const nextState = createNextTurn(activePlayers, undefined, {
        targetScore: resolvedTargetScore,
        themes: gameThemeLabels,
      });
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
    gameThemeLabels,
    playerId,
    resolvedTargetScore,
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

    const nextState = createNextTurn(activePlayers, gameState ?? undefined, {
      resetScores: gameState?.phase === "finished",
      targetScore: gameState?.phase === "finished"
        ? resolvedTargetScore
        : gameState?.targetScore ?? resolvedTargetScore,
      themes: gameThemeLabels,
    });
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
    const nextScore = scores[gameState.guesserId] ?? 0;
    const target = gameState.targetScore ?? DEFAULT_TARGET_SCORE;
    const winnerId = nextScore >= target ? gameState.guesserId : undefined;

    sendRoomEvent({
      kind: "state-sync",
      state: {
        ...gameState,
        phase: winnerId ? "finished" : "reveal",
        secret,
        score: result.points,
        distance: result.distance,
        winnerId,
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

  const submitAuth = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!supabase) return;

    const email = normalizeAuthEmail(authEmail);
    const password = authPassword;
    const username = cleanUsername(authUsername);

    if (!email || !password || (authMode === "register" && !username)) {
      setAuthError("Renseigne tous les champs.");
      return;
    }

    setAuthLoading(true);
    setAuthError("");

    try {
      if (authMode === "register") {
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: {
            data: { username },
          },
        });

        if (error) throw error;

        if (data.user) {
          await ensureProfile(data.user, username);
        }

        if (!data.session) {
          setAuthError(
            "Compte cree, mais Supabase attend une confirmation mail. Desactive Confirm email dans Auth > Providers > Email.",
          );
        }
      } else {
        const { error } = await supabase.auth.signInWithPassword({
          email,
          password,
        });

        if (error) throw error;
      }
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : String(error));
    } finally {
      setAuthLoading(false);
    }
  };

  const signOut = async () => {
    leaveRoom();
    await supabase?.auth.signOut();
    setProfile(null);
    setSession(null);
  };

  const bootstrapAdmin = async () => {
    if (!supabase) return;

    setAuthLoading(true);
    setAuthError("");

    try {
      const response = await fetch("/api/admin-users", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ action: "bootstrap" }),
      });
      const payload = (await response.json()) as {
        email?: string;
        password?: string;
        error?: string;
      };

      if (!response.ok) {
        throw new Error(payload.error ?? "Initialisation admin impossible.");
      }

      const email = payload.email ?? "admin@arc-clue.local";
      const password = payload.password ?? "admin";

      setNeedsBootstrapAdmin(false);
      setAuthMode("login");
      setAuthEmail("admin");
      setAuthPassword(password);

      const { error } = await supabase.auth.signInWithPassword({
        email,
        password,
      });

      if (error) throw error;
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : String(error));
    } finally {
      setAuthLoading(false);
    }
  };

  const createAdminPlayer = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!profile?.is_admin) return;

    const username = cleanUsername(adminCreateUsername);
    const email = normalizeAuthEmail(adminCreateLogin);

    if (!email || !username || adminCreatePassword.length < 6) {
      setAdminUserMessage("Identifiant, pseudo et mot de passe requis.");
      return;
    }

    setAdminUsersLoading(true);
    setAdminUserMessage("");

    try {
      await adminApiRequest("POST", {
        action: "createUser",
        email,
        username,
        password: adminCreatePassword,
        is_admin: adminCreateIsAdmin,
      });
      setAdminCreateLogin("");
      setAdminCreateUsername("");
      setAdminCreatePassword("");
      setAdminCreateIsAdmin(false);
      setAdminUserMessage("Joueur cree.");
      await loadAdminUsers();
    } catch (error) {
      setAdminUserMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setAdminUsersLoading(false);
    }
  };

  const setPlayerAdmin = async (userId: string, isAdmin: boolean) => {
    if (!profile?.is_admin) return;

    setAdminUsersLoading(true);
    setAdminUserMessage("");

    try {
      await adminApiRequest("PATCH", {
        action: "setAdmin",
        userId,
        is_admin: isAdmin,
      });
      setAdminUserMessage(isAdmin ? "Admin ajoute." : "Admin retire.");
      await loadAdminUsers();
    } catch (error) {
      setAdminUserMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setAdminUsersLoading(false);
    }
  };

  const changePlayerPassword = async (userId: string) => {
    if (!profile?.is_admin) return;

    const password = adminPasswordEdits[userId] ?? "";

    if (password.length < 6) {
      setAdminUserMessage("Mot de passe de 6 caracteres minimum.");
      return;
    }

    setAdminUsersLoading(true);
    setAdminUserMessage("");

    try {
      await adminApiRequest("PATCH", {
        action: "setPassword",
        userId,
        password,
      });
      setAdminPasswordEdits((current) => ({
        ...current,
        [userId]: "",
      }));
      setAdminUserMessage("Mot de passe change.");
    } catch (error) {
      setAdminUserMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setAdminUsersLoading(false);
    }
  };

  const addTheme = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!supabase || !profile?.is_admin) return;

    const label = cleanThemeLabel(newThemeLabel);

    if (!label) return;

    setDatabaseError("");

    const { error } = await supabase.from("themes").insert({
      label,
      created_by: profile.id,
    });

    if (error) {
      setDatabaseError(error.message);
      return;
    }

    setNewThemeLabel("");
    await loadDatabaseData();
  };

  const saveTheme = async (themeId: number) => {
    if (!supabase || !profile?.is_admin) return;

    const label = cleanThemeLabel(themeEdits[themeId] ?? "");

    if (!label) return;

    setDatabaseError("");

    const { error } = await supabase
      .from("themes")
      .update({ label })
      .eq("id", themeId);

    if (error) {
      setDatabaseError(error.message);
      return;
    }

    await loadDatabaseData();
  };

  const deleteTheme = async (themeId: number) => {
    if (!supabase || !profile?.is_admin) return;

    setDatabaseError("");

    const { error } = await supabase.from("themes").delete().eq("id", themeId);

    if (error) {
      setDatabaseError(error.message);
      return;
    }

    await loadDatabaseData();
  };

  const toggleGroupTheme = (themeId: number) => {
    setGroupThemeIds((current) =>
      current.includes(themeId)
        ? current.filter((currentId) => currentId !== themeId)
        : [...current, themeId],
    );
  };

  const createThemeGroup = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!supabase || !profile) return;

    const name = cleanThemeLabel(groupName);
    const selectedThemeIds = groupThemeIds.filter((themeId) =>
      themes.some((theme) => theme.id === themeId),
    );

    if (!name || selectedThemeIds.length === 0) {
      setDatabaseError("Ajoute un nom et au moins un theme au groupe.");
      return;
    }

    setDatabaseError("");

    const { data: group, error: groupError } = await supabase
      .from("theme_groups")
      .insert({
        name,
        owner_id: profile.id,
      })
      .select("id")
      .maybeSingle();

    if (groupError || !group) {
      setDatabaseError(groupError?.message ?? "Groupe introuvable apres creation.");
      return;
    }

    const { error: itemsError } = await supabase.from("theme_group_items").insert(
      selectedThemeIds.map((themeId) => ({
        group_id: (group as { id: string }).id,
        theme_id: themeId,
      })),
    );

    if (itemsError) {
      setDatabaseError(itemsError.message);
      return;
    }

    setGroupName("");
    setGroupThemeIds([]);
    setSelectedThemeGroupId((group as { id: string }).id);
    await loadDatabaseData();
  };

  const deleteThemeGroup = async (groupId: string) => {
    if (!supabase || !profile) return;

    setDatabaseError("");

    const { error } = await supabase
      .from("theme_groups")
      .delete()
      .eq("id", groupId)
      .eq("owner_id", profile.id);

    if (error) {
      setDatabaseError(error.message);
      return;
    }

    await loadDatabaseData();
  };

  const sendFriendRequest = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!supabase || !profile) return;

    const username = cleanUsername(friendSearch);

    if (!username) return;

    setDatabaseError("");

    const { data: target, error: targetError } = await supabase
      .from("profiles")
      .select("id, username, is_admin")
      .ilike("username", username)
      .maybeSingle();

    if (targetError || !target) {
      setDatabaseError(targetError?.message ?? "Aucun joueur avec ce pseudo.");
      return;
    }

    if ((target as Profile).id === profile.id) {
      setDatabaseError("Tu es deja ton propre meilleur ami, techniquement.");
      return;
    }

    const { error } = await supabase.from("friendships").insert({
      requester_id: profile.id,
      addressee_id: (target as Profile).id,
      status: "pending",
    });

    if (error) {
      setDatabaseError(error.message);
      return;
    }

    setFriendSearch("");
    await loadDatabaseData();
  };

  const acceptFriendRequest = async (friendshipId: string) => {
    if (!supabase || !profile) return;

    setDatabaseError("");

    const { error } = await supabase
      .from("friendships")
      .update({ status: "accepted" })
      .eq("id", friendshipId)
      .eq("addressee_id", profile.id);

    if (error) {
      setDatabaseError(error.message);
      return;
    }

    await loadDatabaseData();
  };

  const removeFriendship = async (friendshipId: string) => {
    if (!supabase || !profile) return;

    setDatabaseError("");

    const { error } = await supabase
      .from("friendships")
      .delete()
      .eq("id", friendshipId);

    if (error) {
      setDatabaseError(error.message);
      return;
    }

    await loadDatabaseData();
  };

  if (!authReady || (session && profileLoading)) {
    return <LoadingScreen />;
  }

  if (!hasSupabaseConfig) {
    return (
      <AuthScreen
        authEmail={authEmail}
        authError="Ajoute VITE_SUPABASE_URL et VITE_SUPABASE_PUBLISHABLE_KEY pour activer les comptes."
        authLoading={authLoading}
        authMode={authMode}
        authPassword={authPassword}
        authUsername={authUsername}
        hasSupabaseConfig={hasSupabaseConfig}
        needsBootstrapAdmin={needsBootstrapAdmin}
        onAuthEmailChange={setAuthEmail}
        onAuthModeChange={setAuthMode}
        onAuthPasswordChange={setAuthPassword}
        onAuthUsernameChange={setAuthUsername}
        onBootstrapAdmin={bootstrapAdmin}
        onSubmitAuth={submitAuth}
      />
    );
  }

  if (!session || !profile) {
    return (
      <AuthScreen
        authEmail={authEmail}
        authError={authError}
        authLoading={authLoading}
        authMode={authMode}
        authPassword={authPassword}
        authUsername={authUsername}
        hasSupabaseConfig={hasSupabaseConfig}
        needsBootstrapAdmin={needsBootstrapAdmin}
        onAuthEmailChange={setAuthEmail}
        onAuthModeChange={setAuthMode}
        onAuthPasswordChange={setAuthPassword}
        onAuthUsernameChange={setAuthUsername}
        onBootstrapAdmin={bootstrapAdmin}
        onSubmitAuth={submitAuth}
      />
    );
  }

  if (!roomCode) {
    return (
      <main className="shell shell--entry">
        <section className="entry entry--wide">
          <LobbyHeader profile={profile} onSignOut={signOut} />

          {databaseError && (
            <div className="notice" role="alert">
              {databaseError}
            </div>
          )}

          <form className="entry-form" onSubmit={joinRoom}>
            <div className="entry-grid">
              <label>
                Pseudo de partie
                <input
                  autoComplete="name"
                  maxLength={24}
                  placeholder={profile.username}
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

              <label>
                Score final
                <input
                  max={MAX_TARGET_SCORE}
                  min={MIN_TARGET_SCORE}
                  type="number"
                  value={targetScore}
                  onChange={(event) =>
                    setTargetScore(
                      clampTargetScore(event.currentTarget.valueAsNumber),
                    )
                  }
                />
              </label>

              <label>
                Groupe de themes
                <select
                  value={selectedThemeGroupId}
                  onChange={(event) => setSelectedThemeGroupId(event.target.value)}
                >
                  <option value="">Tous les themes</option>
                  {themeGroups.map((themeGroup) => (
                    <option key={themeGroup.id} value={themeGroup.id}>
                      {themeGroup.name} ({themeGroup.themes.length})
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className="entry-actions">
              <button
                className="button button--secondary"
                disabled={!playerName.trim()}
                type="button"
                onClick={createRoom}
              >
                <Plus aria-hidden="true" />
                Creer en {resolvedTargetScore}
              </button>
              <button
                className="button"
                disabled={
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

          <div className="lobby-tools">
            <ThemeGroupPanel
              databaseLoading={databaseLoading}
              groupName={groupName}
              groupThemeIds={groupThemeIds}
              selectedThemeGroupId={selectedThemeGroupId}
              themeGroups={themeGroups}
              themes={themes}
              onCreateThemeGroup={createThemeGroup}
              onDeleteThemeGroup={deleteThemeGroup}
              onGroupNameChange={setGroupName}
              onSelectedThemeGroupChange={setSelectedThemeGroupId}
              onToggleTheme={toggleGroupTheme}
            />

            <FriendsPanel
              friendSearch={friendSearch}
              friendships={friends}
              profile={profile}
              onAcceptFriendRequest={acceptFriendRequest}
              onFriendSearchChange={setFriendSearch}
              onRemoveFriendship={removeFriendship}
              onSendFriendRequest={sendFriendRequest}
            />

            {profile.is_admin && (
              <>
                <AdminPlayersPanel
                  createIsAdmin={adminCreateIsAdmin}
                  createLogin={adminCreateLogin}
                  createPassword={adminCreatePassword}
                  createUsername={adminCreateUsername}
                  currentProfileId={profile.id}
                  loading={adminUsersLoading}
                  message={adminUserMessage}
                  passwordEdits={adminPasswordEdits}
                  players={adminPlayers}
                  onChangePassword={changePlayerPassword}
                  onCreateIsAdminChange={setAdminCreateIsAdmin}
                  onCreateLoginChange={setAdminCreateLogin}
                  onCreatePasswordChange={setAdminCreatePassword}
                  onCreatePlayer={createAdminPlayer}
                  onCreateUsernameChange={setAdminCreateUsername}
                  onPasswordEditChange={(userId, value) =>
                    setAdminPasswordEdits((current) => ({
                      ...current,
                      [userId]: value,
                    }))
                  }
                  onSetAdmin={setPlayerAdmin}
                />

                <AdminThemePanel
                  newThemeLabel={newThemeLabel}
                  themeEdits={themeEdits}
                  themes={themes}
                  onAddTheme={addTheme}
                  onDeleteTheme={deleteTheme}
                  onNewThemeLabelChange={setNewThemeLabel}
                  onSaveTheme={saveTheme}
                  onThemeEditChange={(themeId, value) =>
                    setThemeEdits((current) => ({
                      ...current,
                      [themeId]: value,
                    }))
                  }
                />
              </>
            )}
          </div>

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
            winnerName={playerNameFor(sortedPlayers, gameState?.winnerId)}
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

function LoadingScreen() {
  return (
    <main className="shell shell--entry">
      <section className="entry">
        <div className="brand-mark">
          <Radio aria-hidden="true" />
        </div>
        <p className="kicker">Arc Clue</p>
        <h1>Chargement</h1>
      </section>
    </main>
  );
}

type AuthScreenProps = {
  authEmail: string;
  authError: string;
  authLoading: boolean;
  authMode: AuthMode;
  authPassword: string;
  authUsername: string;
  hasSupabaseConfig: boolean;
  needsBootstrapAdmin: boolean;
  onAuthEmailChange: (value: string) => void;
  onAuthModeChange: (value: AuthMode) => void;
  onAuthPasswordChange: (value: string) => void;
  onAuthUsernameChange: (value: string) => void;
  onBootstrapAdmin: () => void;
  onSubmitAuth: (event: FormEvent<HTMLFormElement>) => void;
};

function AuthScreen({
  authEmail,
  authError,
  authLoading,
  authMode,
  authPassword,
  authUsername,
  hasSupabaseConfig,
  needsBootstrapAdmin,
  onAuthEmailChange,
  onAuthModeChange,
  onAuthPasswordChange,
  onAuthUsernameChange,
  onBootstrapAdmin,
  onSubmitAuth,
}: AuthScreenProps) {
  const isRegister = authMode === "register";

  return (
    <main className="shell shell--entry">
      <section className="entry">
        <div className="brand-mark">
          <Radio aria-hidden="true" />
        </div>
        <p className="kicker">Arc Clue</p>
        <h1>{isRegister ? "Cree ton compte" : "Connecte-toi"}</h1>
        <p className="entry-copy">
          Les rooms restent live, les themes et les amis passent en base.
        </p>

        {authError && (
          <div className="notice" role="alert">
            {authError}
          </div>
        )}

        <form className="entry-form" onSubmit={onSubmitAuth}>
          {isRegister && (
            <label>
              Pseudo
              <input
                autoComplete="username"
                maxLength={24}
                placeholder="Alex"
                value={authUsername}
                onChange={(event) => onAuthUsernameChange(event.target.value)}
              />
            </label>
          )}

          <label>
            Email ou user
            <span className="input-icon">
              <Mail aria-hidden="true" />
              <input
                autoComplete="username"
                placeholder={isRegister ? "alex@mail.fr" : "admin ou alex@mail.fr"}
                type="text"
                value={authEmail}
                onChange={(event) => onAuthEmailChange(event.target.value)}
              />
            </span>
          </label>

          <label>
            Mot de passe
            <span className="input-icon">
              <LockKeyhole aria-hidden="true" />
              <input
                autoComplete={isRegister ? "new-password" : "current-password"}
                minLength={6}
                type="password"
                value={authPassword}
                onChange={(event) => onAuthPasswordChange(event.target.value)}
              />
            </span>
          </label>

          <button
            className="button"
            disabled={!hasSupabaseConfig || authLoading}
            type="submit"
          >
            {authLoading ? "Patiente" : isRegister ? "Creer le compte" : "Connexion"}
            <ArrowRight aria-hidden="true" />
          </button>

          <button
            className="button button--ghost"
            type="button"
            onClick={() => onAuthModeChange(isRegister ? "login" : "register")}
          >
            {isRegister ? "J'ai deja un compte" : "Creer un compte"}
          </button>

          {!isRegister && needsBootstrapAdmin && (
            <button
              className="button button--ghost"
              disabled={!hasSupabaseConfig || authLoading}
              type="button"
              onClick={onBootstrapAdmin}
            >
              Initialiser admin/admin
            </button>
          )}
        </form>
      </section>
    </main>
  );
}

type LobbyHeaderProps = {
  profile: Profile;
  onSignOut: () => void;
};

function LobbyHeader({ profile, onSignOut }: LobbyHeaderProps) {
  return (
    <header className="lobby-header">
      <div>
        <div className="brand-mark">
          <Radio aria-hidden="true" />
        </div>
        <p className="kicker">Arc Clue</p>
        <h1>Donne l'indice juste assez flou.</h1>
        <p className="entry-copy">
          Cree une partie, choisis tes themes et invite un deuxieme joueur.
        </p>
      </div>

      <aside className="account-card">
        <span className="avatar">{profile.username.slice(0, 1).toUpperCase()}</span>
        <div>
          <strong>{profile.username}</strong>
          <small>
            {profile.is_admin ? (
              <>
                <ShieldCheck aria-hidden="true" />
                Admin
              </>
            ) : (
              "Joueur"
            )}
          </small>
        </div>
        <button className="icon-button" type="button" onClick={onSignOut}>
          <LogOut aria-hidden="true" />
          <span className="sr-only">Deconnexion</span>
        </button>
      </aside>
    </header>
  );
}

type ThemeGroupPanelProps = {
  databaseLoading: boolean;
  groupName: string;
  groupThemeIds: number[];
  selectedThemeGroupId: string;
  themeGroups: ThemeGroup[];
  themes: ThemeRow[];
  onCreateThemeGroup: (event: FormEvent<HTMLFormElement>) => void;
  onDeleteThemeGroup: (groupId: string) => void;
  onGroupNameChange: (value: string) => void;
  onSelectedThemeGroupChange: (groupId: string) => void;
  onToggleTheme: (themeId: number) => void;
};

function ThemeGroupPanel({
  databaseLoading,
  groupName,
  groupThemeIds,
  selectedThemeGroupId,
  themeGroups,
  themes,
  onCreateThemeGroup,
  onDeleteThemeGroup,
  onGroupNameChange,
  onSelectedThemeGroupChange,
  onToggleTheme,
}: ThemeGroupPanelProps) {
  return (
    <section className="tool-panel">
      <div className="panel-heading">
        <Radio aria-hidden="true" />
        <h2>Groupes de themes</h2>
      </div>

      <label>
        Groupe actif
        <select
          value={selectedThemeGroupId}
          onChange={(event) => onSelectedThemeGroupChange(event.target.value)}
        >
          <option value="">Tous les themes</option>
          {themeGroups.map((themeGroup) => (
            <option key={themeGroup.id} value={themeGroup.id}>
              {themeGroup.name} ({themeGroup.themes.length})
            </option>
          ))}
        </select>
      </label>

      <form className="compact-form" onSubmit={onCreateThemeGroup}>
        <label>
          Nouveau groupe
          <input
            maxLength={60}
            placeholder="Soiree films"
            value={groupName}
            onChange={(event) => onGroupNameChange(event.target.value)}
          />
        </label>

        <div className="theme-checklist">
          {themes.length === 0 ? (
            <p className="empty-message">Aucun theme en base pour l'instant.</p>
          ) : (
            themes.map((theme) => (
              <label className="theme-checkbox" key={theme.id}>
                <input
                  checked={groupThemeIds.includes(theme.id)}
                  type="checkbox"
                  onChange={() => onToggleTheme(theme.id)}
                />
                <span>{theme.label}</span>
              </label>
            ))
          )}
        </div>

        <button
          className="button button--small"
          disabled={databaseLoading || themes.length === 0}
          type="submit"
        >
          <Plus aria-hidden="true" />
          Ajouter
        </button>
      </form>

      <div className="mini-list">
        {themeGroups.length === 0 ? (
          <p className="empty-message">Aucun groupe perso.</p>
        ) : (
          themeGroups.map((themeGroup) => (
            <article className="mini-row" key={themeGroup.id}>
              <div>
                <strong>{themeGroup.name}</strong>
                <small>{themeGroup.themes.length} theme(s)</small>
              </div>
              <button
                className="icon-button"
                type="button"
                onClick={() => onDeleteThemeGroup(themeGroup.id)}
              >
                <Trash2 aria-hidden="true" />
                <span className="sr-only">Supprimer</span>
              </button>
            </article>
          ))
        )}
      </div>
    </section>
  );
}

type FriendsPanelProps = {
  friendSearch: string;
  friendships: FriendLink[];
  profile: Profile;
  onAcceptFriendRequest: (friendshipId: string) => void;
  onFriendSearchChange: (value: string) => void;
  onRemoveFriendship: (friendshipId: string) => void;
  onSendFriendRequest: (event: FormEvent<HTMLFormElement>) => void;
};

function FriendsPanel({
  friendSearch,
  friendships,
  profile,
  onAcceptFriendRequest,
  onFriendSearchChange,
  onRemoveFriendship,
  onSendFriendRequest,
}: FriendsPanelProps) {
  const accepted = friendships.filter((friendship) => friendship.status === "accepted");
  const incoming = friendships.filter(
    (friendship) =>
      friendship.status === "pending" && friendship.addressee_id === profile.id,
  );
  const outgoing = friendships.filter(
    (friendship) =>
      friendship.status === "pending" && friendship.requester_id === profile.id,
  );

  const friendName = (friendship: FriendLink) => {
    const friend =
      friendship.requester_id === profile.id
        ? friendship.addressee
        : friendship.requester;

    return friend?.username ?? "Joueur";
  };

  return (
    <section className="tool-panel">
      <div className="panel-heading">
        <UserPlus aria-hidden="true" />
        <h2>Amis</h2>
      </div>

      <form className="compact-form compact-form--inline" onSubmit={onSendFriendRequest}>
        <input
          maxLength={24}
          placeholder="Pseudo exact"
          value={friendSearch}
          onChange={(event) => onFriendSearchChange(event.target.value)}
        />
        <button className="icon-button icon-button--filled" type="submit">
          <UserPlus aria-hidden="true" />
          <span className="sr-only">Ajouter</span>
        </button>
      </form>

      <div className="mini-list">
        {[...incoming, ...accepted, ...outgoing].length === 0 ? (
          <p className="empty-message">Aucun ami pour l'instant.</p>
        ) : (
          <>
            {incoming.map((friendship) => (
              <article className="mini-row" key={friendship.id}>
                <div>
                  <strong>{friendName(friendship)}</strong>
                  <small>Demande recue</small>
                </div>
                <div className="row-actions">
                  <button
                    className="icon-button icon-button--filled"
                    type="button"
                    onClick={() => onAcceptFriendRequest(friendship.id)}
                  >
                    <UserCheck aria-hidden="true" />
                    <span className="sr-only">Accepter</span>
                  </button>
                  <button
                    className="icon-button"
                    type="button"
                    onClick={() => onRemoveFriendship(friendship.id)}
                  >
                    <Trash2 aria-hidden="true" />
                    <span className="sr-only">Refuser</span>
                  </button>
                </div>
              </article>
            ))}

            {accepted.map((friendship) => (
              <article className="mini-row" key={friendship.id}>
                <div>
                  <strong>{friendName(friendship)}</strong>
                  <small>Ami</small>
                </div>
                <button
                  className="icon-button"
                  type="button"
                  onClick={() => onRemoveFriendship(friendship.id)}
                >
                  <Trash2 aria-hidden="true" />
                  <span className="sr-only">Retirer</span>
                </button>
              </article>
            ))}

            {outgoing.map((friendship) => (
              <article className="mini-row" key={friendship.id}>
                <div>
                  <strong>{friendName(friendship)}</strong>
                  <small>En attente</small>
                </div>
                <button
                  className="icon-button"
                  type="button"
                  onClick={() => onRemoveFriendship(friendship.id)}
                >
                  <Trash2 aria-hidden="true" />
                  <span className="sr-only">Annuler</span>
                </button>
              </article>
            ))}
          </>
        )}
      </div>
    </section>
  );
}

type AdminPlayersPanelProps = {
  createIsAdmin: boolean;
  createLogin: string;
  createPassword: string;
  createUsername: string;
  currentProfileId: string;
  loading: boolean;
  message: string;
  passwordEdits: Record<string, string>;
  players: AdminPlayer[];
  onChangePassword: (userId: string) => void;
  onCreateIsAdminChange: (value: boolean) => void;
  onCreateLoginChange: (value: string) => void;
  onCreatePasswordChange: (value: string) => void;
  onCreatePlayer: (event: FormEvent<HTMLFormElement>) => void;
  onCreateUsernameChange: (value: string) => void;
  onPasswordEditChange: (userId: string, value: string) => void;
  onSetAdmin: (userId: string, isAdmin: boolean) => void;
};

function AdminPlayersPanel({
  createIsAdmin,
  createLogin,
  createPassword,
  createUsername,
  currentProfileId,
  loading,
  message,
  passwordEdits,
  players,
  onChangePassword,
  onCreateIsAdminChange,
  onCreateLoginChange,
  onCreatePasswordChange,
  onCreatePlayer,
  onCreateUsernameChange,
  onPasswordEditChange,
  onSetAdmin,
}: AdminPlayersPanelProps) {
  return (
    <section className="tool-panel tool-panel--wide">
      <div className="panel-heading">
        <Users aria-hidden="true" />
        <h2>Joueurs admin</h2>
      </div>

      {message && <p className="admin-message">{message}</p>}

      <form className="admin-create-form" onSubmit={onCreatePlayer}>
        <input
          maxLength={80}
          placeholder="email ou user"
          value={createLogin}
          onChange={(event) => onCreateLoginChange(event.target.value)}
        />
        <input
          maxLength={24}
          placeholder="pseudo"
          value={createUsername}
          onChange={(event) => onCreateUsernameChange(event.target.value)}
        />
        <input
          minLength={6}
          placeholder="mot de passe"
          type="password"
          value={createPassword}
          onChange={(event) => onCreatePasswordChange(event.target.value)}
        />
        <label className="inline-check">
          <input
            checked={createIsAdmin}
            type="checkbox"
            onChange={(event) => onCreateIsAdminChange(event.target.checked)}
          />
          Admin
        </label>
        <button className="button button--small" disabled={loading} type="submit">
          <UserPlus aria-hidden="true" />
          Creer
        </button>
      </form>

      <div className="admin-users-list">
        {players.length === 0 ? (
          <p className="empty-message">Aucun joueur charge.</p>
        ) : (
          players.map((player) => (
            <article className="admin-user-row" key={player.id}>
              <div>
                <strong>{player.username}</strong>
                <small>
                  {player.email ?? "email inconnu"}
                  {player.id === currentProfileId ? " - toi" : ""}
                </small>
              </div>

              <button
                className={player.is_admin ? "button button--small" : "button button--small button--ghost"}
                disabled={loading || (player.id === currentProfileId && player.is_admin)}
                type="button"
                onClick={() => onSetAdmin(player.id, !player.is_admin)}
              >
                <ShieldCheck aria-hidden="true" />
                {player.is_admin ? "Admin" : "Joueur"}
              </button>

              <div className="password-reset">
                <input
                  minLength={6}
                  placeholder="nouveau mdp"
                  type="password"
                  value={passwordEdits[player.id] ?? ""}
                  onChange={(event) =>
                    onPasswordEditChange(player.id, event.target.value)
                  }
                />
                <button
                  className="icon-button icon-button--filled"
                  disabled={loading}
                  type="button"
                  onClick={() => onChangePassword(player.id)}
                >
                  <Save aria-hidden="true" />
                  <span className="sr-only">Changer le mot de passe</span>
                </button>
              </div>
            </article>
          ))
        )}
      </div>
    </section>
  );
}

type AdminThemePanelProps = {
  newThemeLabel: string;
  themeEdits: Record<number, string>;
  themes: ThemeRow[];
  onAddTheme: (event: FormEvent<HTMLFormElement>) => void;
  onDeleteTheme: (themeId: number) => void;
  onNewThemeLabelChange: (value: string) => void;
  onSaveTheme: (themeId: number) => void;
  onThemeEditChange: (themeId: number, value: string) => void;
};

function AdminThemePanel({
  newThemeLabel,
  themeEdits,
  themes,
  onAddTheme,
  onDeleteTheme,
  onNewThemeLabelChange,
  onSaveTheme,
  onThemeEditChange,
}: AdminThemePanelProps) {
  return (
    <section className="tool-panel tool-panel--wide">
      <div className="panel-heading">
        <ShieldCheck aria-hidden="true" />
        <h2>Themes admin</h2>
      </div>

      <form className="compact-form compact-form--inline" onSubmit={onAddTheme}>
        <input
          maxLength={60}
          placeholder="Nouveau theme"
          value={newThemeLabel}
          onChange={(event) => onNewThemeLabelChange(event.target.value)}
        />
        <button className="icon-button icon-button--filled" type="submit">
          <Plus aria-hidden="true" />
          <span className="sr-only">Ajouter</span>
        </button>
      </form>

      <div className="theme-admin-list">
        {themes.map((theme) => (
          <article className="theme-admin-row" key={theme.id}>
            <input
              maxLength={60}
              value={themeEdits[theme.id] ?? theme.label}
              onChange={(event) => onThemeEditChange(theme.id, event.target.value)}
            />
            <div className="row-actions">
              <button
                className="icon-button icon-button--filled"
                type="button"
                onClick={() => onSaveTheme(theme.id)}
              >
                <Save aria-hidden="true" />
                <span className="sr-only">Sauver</span>
              </button>
              <button
                className="icon-button"
                type="button"
                onClick={() => onDeleteTheme(theme.id)}
              >
                <Trash2 aria-hidden="true" />
                <span className="sr-only">Supprimer</span>
              </button>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

type RoundHeaderProps = {
  activePlayers: Player[];
  clueGiverName: string;
  gameState: GameState | null;
  guesserName: string;
  userIsHost: boolean;
  winnerName: string;
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
  winnerName,
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

  if (gameState.phase === "finished") {
    return (
      <div className="round-header">
        <div>
          <p className="kicker">Partie terminee</p>
          <h1>{winnerName} gagne</h1>
        </div>
        <button
          className="button"
          disabled={!userIsHost || activePlayers.length < 2}
          type="button"
          onClick={onStartRound}
        >
          <Play aria-hidden="true" />
          Nouvelle partie
        </button>
      </div>
    );
  }

  return (
    <div className="round-header">
      <div>
        <p className="kicker">
          Manche {gameState.round} / {gameState.targetScore ?? DEFAULT_TARGET_SCORE} pts
        </p>
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
          <div className="guess-controls">
            <label>
              Position
              <input
                max={100}
                min={0}
                step={1}
                type="number"
                value={guess}
                onChange={(event) => {
                  const nextValue = event.currentTarget.valueAsNumber;
                  onGuessChange(clampPercent(Number.isNaN(nextValue) ? 0 : nextValue));
                }}
              />
            </label>
            <button className="button" type="button" onClick={onSubmitGuess}>
              Valider {formatPercent(guess)}
              <ArrowRight aria-hidden="true" />
            </button>
          </div>
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

  const isFinished = gameState.phase === "finished";

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
        {isFinished
          ? `Score cible atteint : ${gameState.targetScore ?? DEFAULT_TARGET_SCORE} points.`
          : `Ecart de ${gameState.distance ?? 0}. Le score est ajoute au joueur qui devine.`}
      </p>
      {userIsHost && (
        <button className="button" type="button" onClick={onStartRound}>
          {isFinished ? "Nouvelle partie" : "Manche suivante"}
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
