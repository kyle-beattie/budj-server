import { z } from 'zod';

export const credentialsSchema = z.object({
  email: z.email(),
  password: z.string().min(8, 'Password must be at least 8 characters').max(72),
});

export const signUpSchema = credentialsSchema.extend({
  displayName: z.string().trim().min(1).max(120).optional(),
});
export type SignUpInput = z.infer<typeof signUpSchema>;

export const signInSchema = credentialsSchema;
export type SignInInput = z.infer<typeof signInSchema>;

export const refreshSchema = z.object({
  refreshToken: z.string().min(1),
});
export type RefreshInput = z.infer<typeof refreshSchema>;

export const requestPasswordResetSchema = z.object({
  email: z.email(),
});

export const updatePasswordSchema = z.object({
  password: z.string().min(8).max(72),
});

/** Tokens are returned in the body: this API is consumed by non-browser clients too. */
export const sessionSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  tokenType: z.literal('bearer'),
  /** Seconds until the access token expires. */
  expiresIn: z.number().int(),
  expiresAt: z.iso.datetime().nullable(),
  user: z.object({
    id: z.uuid(),
    email: z.email().nullable(),
    emailConfirmed: z.boolean(),
  }),
});
export type Session = z.infer<typeof sessionSchema>;

/**
 * Sign-up does not always produce a session: with email confirmation enabled,
 * Supabase creates the user and returns no tokens until they confirm.
 */
export const signUpResponseSchema = z.object({
  session: sessionSchema.nullable(),
  confirmationRequired: z.boolean(),
});

export const currentUserSchema = z.object({
  id: z.uuid(),
  email: z.email().nullable(),
  role: z.string().nullable(),
});

/**
 * Apple's `authorizationCode`, captured at sign-in.
 *
 * Note what this is **not**: an identity token. Those go straight from the app
 * to Supabase and this server never sees one (D2). This is the separate,
 * single-use code that can be exchanged for a refresh token, which is the only
 * way to revoke the user with Apple when they delete their account (D13).
 */
export const appleGrantSchema = z.object({
  authorizationCode: z.string().min(1).max(2048),
});
export type AppleGrantInput = z.infer<typeof appleGrantSchema>;

/**
 * Always 200, even when the exchange failed. The user is signed in either way,
 * and there is no retry to offer — the code is spent. `stored: false` means
 * this account cannot be revoked with Apple at deletion.
 */
export const appleGrantResultSchema = z.object({
  stored: z.boolean(),
  /** Apple's error code when `stored` is false, e.g. `invalid_grant`. */
  reason: z.string().optional(),
});
export type AppleGrantResult = z.infer<typeof appleGrantResultSchema>;
