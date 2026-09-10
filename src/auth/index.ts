import { env } from "@/config/env";
import { LocalAuthProvider } from "./local-provider";
import { SupabaseAuthProvider } from "./supabase-provider";
import type { AuthProvider } from "./types";

let provider: AuthProvider | null = null;

export function auth(): AuthProvider {
  provider ??= env.AUTH_PROVIDER === "supabase" ? new SupabaseAuthProvider() : new LocalAuthProvider();
  return provider;
}

export type { AuthIdentity, AuthProvider, AuthTokens } from "./types";
