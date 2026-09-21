import { createClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL?.trim();
const supabasePublishableKey = (
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || import.meta.env.VITE_SUPABASE_ANON_KEY
)?.trim();

const previewRequested = import.meta.env.DEV && new URLSearchParams(window.location.search).get("preview") === "1";
if (previewRequested) sessionStorage.setItem("paul-ui-preview", "1");

export const isSupabaseConfigured = Boolean(supabaseUrl && supabasePublishableKey);
export const isPreviewMode = import.meta.env.DEV && sessionStorage.getItem("paul-ui-preview") === "1";

export const supabase = createClient(
  supabaseUrl || "https://configuration-required.supabase.co",
  supabasePublishableKey || "configuration-required",
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  },
);

export const edgeFunctionsUrl = supabaseUrl ? `${supabaseUrl}/functions/v1` : "";
