import { createClient } from "@supabase/supabase-js";

function getAdminEnv() {
  return {
    supabaseUrl: process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    initialAdminEmail:
      process.env.INITIAL_ADMIN_EMAIL || "admin@arc-clue.local",
    initialAdminPassword: process.env.INITIAL_ADMIN_PASSWORD || "admin",
  };
}

function json(res, status, body) {
  res.status(status).json(body);
}

function cleanUsername(value) {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 24);
}

function cleanEmail(value) {
  const email = String(value ?? "").trim().toLowerCase();

  if (!email) return "";
  return email.includes("@") ? email : `${email}@arc-clue.local`;
}

function requireAdminClient(res) {
  const { serviceRoleKey, supabaseUrl } = getAdminEnv();

  if (!supabaseUrl || !serviceRoleKey) {
    json(res, 500, {
      error:
        "SUPABASE_SERVICE_ROLE_KEY et SUPABASE_URL sont requis pour les actions admin.",
    });
    return null;
  }

  return createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") return JSON.parse(req.body || "{}");
  return {};
}

async function getRequestUser(supabase, req) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";

  if (!token) return null;

  const { data, error } = await supabase.auth.getUser(token);

  if (error || !data.user) return null;
  return data.user;
}

async function isAdmin(supabase, userId) {
  const { data, error } = await supabase
    .from("profiles")
    .select("is_admin")
    .eq("id", userId)
    .maybeSingle();

  if (error) throw error;
  return Boolean(data?.is_admin);
}

async function requireAdmin(supabase, req, res) {
  const user = await getRequestUser(supabase, req);

  if (!user) {
    json(res, 401, { error: "Session admin requise." });
    return null;
  }

  if (!(await isAdmin(supabase, user.id))) {
    json(res, 403, { error: "Droits admin requis." });
    return null;
  }

  return user;
}

async function listAuthUsers(supabase) {
  const { data, error } = await supabase.auth.admin.listUsers({
    page: 1,
    perPage: 1000,
  });

  if (error) throw error;
  return data.users ?? [];
}

async function findAuthUserByEmail(supabase, email) {
  const users = await listAuthUsers(supabase);
  return (
    users.find((user) => user.email?.toLowerCase() === email.toLowerCase()) ??
    null
  );
}

async function listUsers(supabase, res) {
  const { data: profiles, error } = await supabase
    .from("profiles")
    .select("id, username, is_admin, created_at")
    .order("created_at", { ascending: true });

  if (error) throw error;

  const authUsers = await listAuthUsers(supabase);
  const authById = new Map(authUsers.map((user) => [user.id, user]));

  json(res, 200, {
    users: (profiles ?? []).map((profile) => {
      const authUser = authById.get(profile.id);

      return {
        id: profile.id,
        username: profile.username,
        is_admin: profile.is_admin,
        created_at: profile.created_at,
        email: authUser?.email ?? null,
        last_sign_in_at: authUser?.last_sign_in_at ?? null,
      };
    }),
  });
}

async function bootstrapAdmin(supabase, res) {
  const { initialAdminEmail, initialAdminPassword } = getAdminEnv();

  const { count, error: countError } = await supabase
    .from("profiles")
    .select("id", { count: "exact", head: true })
    .eq("is_admin", true);

  if (countError) throw countError;

  if ((count ?? 0) > 0) {
    json(res, 409, { error: "Un admin existe deja." });
    return;
  }

  const existingUser = await findAuthUserByEmail(supabase, initialAdminEmail);
  const user =
    existingUser ??
    (
      await supabase.auth.admin.createUser({
        email: initialAdminEmail,
        password: initialAdminPassword,
        email_confirm: true,
        user_metadata: { username: "admin" },
      })
    ).data.user;

  if (!user) {
    json(res, 500, { error: "Impossible de creer le compte admin." });
    return;
  }

  if (existingUser) {
    const { error: passwordError } = await supabase.auth.admin.updateUserById(
      user.id,
      {
        password: initialAdminPassword,
        email_confirm: true,
        user_metadata: { username: "admin" },
      },
    );

    if (passwordError) throw passwordError;
  }

  const { error: profileError } = await supabase.from("profiles").upsert({
    id: user.id,
    username: "admin",
    is_admin: true,
  });

  if (profileError) throw profileError;

  json(res, 200, {
    email: initialAdminEmail,
    password: initialAdminPassword,
    username: "admin",
  });
}

async function bootstrapStatus(supabase, res) {
  const { count, error } = await supabase
    .from("profiles")
    .select("id", { count: "exact", head: true })
    .eq("is_admin", true);

  if (error) throw error;

  json(res, 200, {
    needsBootstrap: (count ?? 0) === 0,
  });
}

async function createUser(supabase, body, res) {
  const email = cleanEmail(body.email);
  const username = cleanUsername(body.username);
  const password = String(body.password ?? "");
  const is_admin = Boolean(body.is_admin);

  if (!email || !username || password.length < 6) {
    json(res, 400, {
      error: "Email/user, pseudo et mot de passe de 6 caracteres minimum requis.",
    });
    return;
  }

  const { data, error } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { username },
  });

  if (error) throw error;
  if (!data.user) throw new Error("Utilisateur cree introuvable.");

  const { error: profileError } = await supabase.from("profiles").upsert({
    id: data.user.id,
    username,
    is_admin,
  });

  if (profileError) throw profileError;

  json(res, 201, { userId: data.user.id });
}

async function setAdmin(supabase, actorId, body, res) {
  const userId = String(body.userId ?? "");
  const is_admin = Boolean(body.is_admin);

  if (!userId) {
    json(res, 400, { error: "userId requis." });
    return;
  }

  if (userId === actorId && !is_admin) {
    json(res, 400, { error: "Tu ne peux pas retirer ton propre admin." });
    return;
  }

  const { error } = await supabase
    .from("profiles")
    .update({ is_admin })
    .eq("id", userId);

  if (error) throw error;

  json(res, 200, { ok: true });
}

async function setPassword(supabase, body, res) {
  const userId = String(body.userId ?? "");
  const password = String(body.password ?? "");

  if (!userId || password.length < 6) {
    json(res, 400, {
      error: "Utilisateur et mot de passe de 6 caracteres minimum requis.",
    });
    return;
  }

  const { error } = await supabase.auth.admin.updateUserById(userId, {
    password,
  });

  if (error) throw error;

  json(res, 200, { ok: true });
}

export default async function handler(req, res) {
  const supabase = requireAdminClient(res);

  if (!supabase) return;

  try {
    if (req.method === "GET") {
      const url = new URL(req.url ?? "", "http://localhost");

      if (url.searchParams.get("bootstrap") === "status") {
        await bootstrapStatus(supabase, res);
        return;
      }

      const actor = await requireAdmin(supabase, req, res);
      if (!actor) return;

      await listUsers(supabase, res);
      return;
    }

    if (req.method === "POST") {
      const body = await readBody(req);

      if (body.action === "bootstrap") {
        await bootstrapAdmin(supabase, res);
        return;
      }

      const actor = await requireAdmin(supabase, req, res);
      if (!actor) return;

      if (body.action === "createUser") {
        await createUser(supabase, body, res);
        return;
      }
    }

    if (req.method === "PATCH") {
      const actor = await requireAdmin(supabase, req, res);
      if (!actor) return;

      const body = await readBody(req);

      if (body.action === "setAdmin") {
        await setAdmin(supabase, actor.id, body, res);
        return;
      }

      if (body.action === "setPassword") {
        await setPassword(supabase, body, res);
        return;
      }
    }

    json(res, 405, { error: "Action admin inconnue." });
  } catch (error) {
    json(res, 500, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
