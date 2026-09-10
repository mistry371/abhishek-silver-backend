export interface AuthIdentity {
  /** Supabase `auth.users.id` (or the local development provider's id). */
  userId: string;
  email: string | null;
  /** 10-digit Indian mobile number, when known. */
  phone: string | null;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: string;
  identity: AuthIdentity;
}

/**
 * Identity provider boundary. Supabase Auth in production; a local provider
 * issuing Supabase-shaped JWTs for development until the project exists.
 * Phone numbers cross this boundary as 10-digit local numbers.
 */
export interface AuthProvider {
  readonly name: "local" | "supabase";
  verifyAccessToken(token: string): Promise<AuthIdentity>;
  signInWithPassword(input: { email?: string; phone?: string; password: string }): Promise<AuthTokens>;
  signUp(input: { email: string; phone: string; password: string }): Promise<AuthTokens>;
  requestPhoneOtp(phone: string): Promise<{ expiresInSeconds: number; demoCode?: string }>;
  verifyPhoneOtp(phone: string, code: string): Promise<AuthTokens>;
  requestPasswordReset(email: string): Promise<void>;
  changePassword(identity: AuthIdentity, currentPassword: string, newPassword: string): Promise<void>;
  refresh(refreshToken: string): Promise<AuthTokens>;
  signOut(accessToken: string): Promise<void>;
  /** Staff account creation from the admin panel. */
  createUser(input: { email: string; password: string; phone?: string | null }): Promise<AuthIdentity>;
  setPassword(userId: string, password: string): Promise<void>;
}
