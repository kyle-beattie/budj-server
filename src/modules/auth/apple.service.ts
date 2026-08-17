import type { FastifyBaseLogger } from 'fastify';
import { config } from '../../config/index.js';
import { encryptToken } from '../../lib/token-crypto.js';
import { AppleExchangeError, exchangeAuthorizationCode } from './apple.client.js';
import type { AppleGrantRepository } from './apple.repository.js';
import type { AppleGrantResult } from './auth.types.js';

/**
 * Captures Apple's authorization code at sign-in and stores the refresh token
 * it exchanges for.
 *
 * The entire payoff of this lands in a *different* change — account deletion,
 * which must revoke the user's tokens with Apple. It is built now because the
 * code is single-use and expires in about five minutes, so it can only be
 * captured during sign-in. Ship onboarding without this and every user who
 * signs up beforehand has no stored grant and can never be properly revoked
 * (D13).
 */
export class AppleGrantService {
  constructor(
    private readonly repository: AppleGrantRepository,
    private readonly logger: FastifyBaseLogger,
  ) {}

  /**
   * A failed exchange is **recorded and swallowed**. The user is already signed
   * in by the time this is called — Supabase issued their session directly —
   * and failing the request would turn a deletion-time inconvenience into a
   * sign-in outage. There is no retry to offer either: the code is spent.
   */
  async capture(userId: string, authorizationCode: string): Promise<AppleGrantResult> {
    try {
      const { refreshToken } = await exchangeAuthorizationCode(
        config.apple,
        authorizationCode,
      );

      await this.repository.upsert(
        userId,
        encryptToken(config.tokenCrypto.keyring, refreshToken),
      );

      return { stored: true };
    } catch (error) {
      const reason = error instanceof AppleExchangeError ? error.appleCode : 'unexpected_error';

      // Log the reason, never the code or the token.
      this.logger.warn(
        { userId, reason },
        'Apple authorization code exchange failed; this user cannot be revoked with Apple at deletion',
      );

      return { stored: false, reason };
    }
  }
}
