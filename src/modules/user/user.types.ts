import { z } from 'zod';

/**
 * `auth.users` belongs to Supabase. This module owns `public.profiles` — the
 * editable, application-level record — and joins the verified email from the
 * caller's JWT claims onto it for convenience.
 */
export const userProfileSchema = z.object({
  id: z.uuid(),
  email: z.email().nullable(),
  displayName: z.string(),
  avatarUrl: z.url().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export type UserProfile = z.infer<typeof userProfileSchema>;

/**
 * Email and password changes are credential operations owned by Supabase Auth;
 * use POST /api/auth/password, or supabase.auth.updateUser for email.
 */
export const updateUserProfileSchema = z
  .object({
    displayName: z.string().trim().min(1).max(120).optional(),
    avatarUrl: z.url().max(2048).nullish(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one field must be provided',
  });

export type UpdateUserProfileInput = z.infer<typeof updateUserProfileSchema>;
