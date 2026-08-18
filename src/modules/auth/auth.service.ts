import type { Session as SupabaseSession, User } from '@supabase/supabase-js';
import { config } from '../../config/index.js';
import { UnauthorizedError } from '../../lib/errors.js';
import { toAuthAppError, type Supabase } from '../../supabase/index.js';
import type { RefreshInput, Session, SignInInput, SignUpInput } from './auth.types.js';

function toSession(session: SupabaseSession, user: User | null): Session {
  const subject = user ?? session.user;
  return {
    accessToken: session.access_token,
    refreshToken: session.refresh_token,
    tokenType: 'bearer',
    expiresIn: session.expires_in,
    expiresAt: session.expires_at ? new Date(session.expires_at * 1000).toISOString() : null,
    user: {
      id: subject.id,
      email: subject.email ?? null,
      emailConfirmed: Boolean(subject.email_confirmed_at ?? subject.confirmed_at),
    },
  };
}

/**
 * Thin proxy over Supabase Auth (GoTrue). This server never sees a password
 * hash and never mints a token — it forwards credentials and relays the result,
 * translating GoTrue's errors into the application's error vocabulary.
 *
 * `anon` performs user-facing flows; `admin` is only for revocation, which
 * cannot be done with a stateless client.
 */
export class AuthService {
  constructor(
    private readonly anon: Supabase,
    private readonly admin: Supabase,
  ) {}

  async signUp(input: SignUpInput): Promise<{ session: Session | null; confirmationRequired: boolean }> {
    const { data, error } = await this.anon.auth.signUp({
      email: input.email,
      password: input.password,
      options: {
        // Consumed by the handle_new_user() trigger to seed public.profiles.
        data: input.displayName ? { display_name: input.displayName } : {},
        emailRedirectTo: config.auth.confirmUrl,
      },
    });

    if (error) throw toAuthAppError(error);

    // With email confirmation on, Supabase returns a user but no session.
    if (!data.session) {
      return { session: null, confirmationRequired: true };
    }
    return { session: toSession(data.session, data.user), confirmationRequired: false };
  }

  async signIn(input: SignInInput): Promise<Session> {
    const { data, error } = await this.anon.auth.signInWithPassword({
      email: input.email,
      password: input.password,
    });

    if (error) throw toAuthAppError(error);
    if (!data.session) throw new UnauthorizedError('Invalid email or password');

    return toSession(data.session, data.user);
  }

  async refresh(input: RefreshInput): Promise<Session> {
    const { data, error } = await this.anon.auth.refreshSession({
      refresh_token: input.refreshToken,
    });

    if (error) throw toAuthAppError(error);
    if (!data.session) throw new UnauthorizedError('Refresh token is invalid or expired');

    return toSession(data.session, data.user);
  }

  /**
   * Revokes the caller's tokens. Needs the admin client: a stateless server
   * client holds no session to sign out of.
   */
  async signOut(accessToken: string, scope: 'global' | 'local' | 'others' = 'global'): Promise<void> {
    const { error } = await this.admin.auth.admin.signOut(accessToken, scope);
    if (error) throw toAuthAppError(error);
  }

  /** Always resolves — never reveal whether an address is registered. */
  async requestPasswordReset(email: string): Promise<void> {
    await this.anon.auth.resetPasswordForEmail(email, {
      redirectTo: config.auth.redirectUrl,
    });
  }

  /** Changes the password of the user the access token belongs to. */
  async updatePassword(userClient: Supabase, password: string): Promise<void> {
    const { error } = await userClient.auth.updateUser({ password });
    if (error) throw toAuthAppError(error);
  }
}
