import type { Session, User } from "@supabase/supabase-js";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { previewProfile } from "../data/preview";
import { api } from "../lib/api";
import { normalizeError } from "../lib/errors";
import { isPreviewMode, supabase } from "../lib/supabase";
import type { Profile, Role } from "../types/domain";

type RegisterInput = {
  email: string;
  password: string;
  name: string;
  phone: string;
  role: Role;
};

type AuthContextValue = {
  session: Session | null;
  user: User | null;
  profile: Profile | null;
  loading: boolean;
  profileLoading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (input: RegisterInput) => Promise<{ needsEmailConfirmation: boolean }>;
  signOut: () => Promise<void>;
  refreshProfile: () => Promise<void>;
  waitForWallet: () => Promise<string | null>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

const previewSession = {
  access_token: "preview-access-token",
  refresh_token: "preview-refresh-token",
  expires_in: 3600,
  token_type: "bearer",
  user: {
    id: "preview-user",
    aud: "authenticated",
    role: "authenticated",
    email: "inversionista.demo1@paul.test",
    app_metadata: {},
    user_metadata: {},
    created_at: "2026-09-19T12:00:00Z",
  },
} as Session;

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(isPreviewMode ? previewSession : null);
  const [profile, setProfile] = useState<Profile | null>(isPreviewMode ? previewProfile : null);
  const [loading, setLoading] = useState(!isPreviewMode);
  const [profileLoading, setProfileLoading] = useState(false);

  const loadProfile = useCallback(async (userId: string) => {
    setProfileLoading(true);
    try {
      setProfile(await api.profile(userId));
    } finally {
      setProfileLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isPreviewMode) return;
    let active = true;
    supabase.auth.getSession().then(async ({ data }) => {
      if (!active) return;
      setSession(data.session);
      if (data.session) {
        try {
          await loadProfile(data.session.user.id);
        } catch {
          setProfile(null);
        }
      }
      if (active) setLoading(false);
    });

    const { data: listener } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      if (!nextSession) {
        setProfile(null);
      } else {
        setTimeout(() => void loadProfile(nextSession.user.id), 0);
      }
    });

    return () => {
      active = false;
      listener.subscription.unsubscribe();
    };
  }, [loadProfile]);

  const value = useMemo<AuthContextValue>(
    () => ({
      session,
      user: session?.user ?? null,
      profile,
      loading,
      profileLoading,
      async signIn(email, password) {
        if (isPreviewMode) return;
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) {
          const normalized = normalizeError(error);
          throw { ...normalized, message: "El correo o la contraseña no son correctos." };
        }
      },
      async signUp(input) {
        if (isPreviewMode) return { needsEmailConfirmation: false };
        const { data, error } = await supabase.auth.signUp({
          email: input.email,
          password: input.password,
          options: {
            data: {
              rol: input.role,
              nombre_completo: input.name,
              telefono: input.phone || null,
            },
          },
        });
        if (error) throw normalizeError(error);
        return { needsEmailConfirmation: !data.session };
      },
      async signOut() {
        if (isPreviewMode) return;
        const { error } = await supabase.auth.signOut();
        if (error) throw normalizeError(error);
      },
      async refreshProfile() {
        if (session) await loadProfile(session.user.id);
      },
      async waitForWallet() {
        if (!session) return null;
        for (let attempt = 0; attempt < 10; attempt += 1) {
          const nextProfile = await api.profile(session.user.id);
          setProfile(nextProfile);
          if (nextProfile.wallet_public_key) return nextProfile.wallet_public_key;
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
        return null;
      },
    }),
    [loadProfile, loading, profile, profileLoading, session],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth debe usarse dentro de AuthProvider");
  return context;
}
