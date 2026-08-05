import { z } from 'zod';

/**
 * The `user` table itself belongs to the auth module (better-auth owns it).
 * This module owns the *profile* view of it and everything a user can change
 * about themselves that isn't a credential.
 */
export const userProfileSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.email(),
  emailVerified: z.boolean(),
  image: z.url().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export type UserProfile = z.infer<typeof userProfileSchema>;

/**
 * Email and password changes are credential operations and must go through
 * better-auth (`POST /api/auth/change-email`, `/api/auth/change-password`)
 * so verification and session revocation happen correctly.
 */
export const updateUserProfileSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    image: z.url().max(2048).nullish(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one field must be provided',
  });

export type UpdateUserProfileInput = z.infer<typeof updateUserProfileSchema>;
