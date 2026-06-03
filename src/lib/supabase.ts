import { createClient } from "@supabase/supabase-js";

const supabaseUrl = (
  import.meta.env.VITE_SUPABASE_URL as string | undefined
)?.trim();
const supabasePublishableKey = (
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ??
  import.meta.env.VITE_SUPABASE_ANON_KEY
)?.trim() as string | undefined;

function getSupabaseHost(url?: string) {
  if (!url) return null;

  try {
    return new URL(url).host;
  } catch {
    return "URL invalide";
  }
}

function getKeyKind(key?: string) {
  if (!key) return null;
  if (key.startsWith("sb_publishable_")) return "publishable";
  if (key.startsWith("eyJ")) return "legacy anon";
  if (key.startsWith("sb_secret_")) return "secret invalide cote client";
  return "format inconnu";
}

export const hasSupabaseConfig = Boolean(
  supabaseUrl && supabasePublishableKey,
);

export const supabaseConfigDiagnostics = {
  hasUrl: Boolean(supabaseUrl),
  hasKey: Boolean(supabasePublishableKey),
  host: getSupabaseHost(supabaseUrl),
  keyKind: getKeyKind(supabasePublishableKey),
};

export const supabase = hasSupabaseConfig
  ? createClient(supabaseUrl!, supabasePublishableKey!)
  : null;
