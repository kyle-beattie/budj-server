import { NotFoundError } from '../../lib/errors.js';
import type { ProfileRow, UserRepository } from './user.repository.js';
import type { UpdateUserProfileInput, UserProfile } from './user.types.js';

function toProfile(row: ProfileRow, email: string | null): UserProfile {
  return {
    id: row.id,
    email,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

/**
 * The email is taken from the verified JWT claims rather than stored alongside
 * the profile — Supabase owns it, and duplicating it would let the two drift.
 */
export class UserService {
  constructor(private readonly repository: UserRepository) {}

  async getProfile(userId: string, email: string | null): Promise<UserProfile> {
    const row = await this.repository.findById(userId);
    if (!row) throw new NotFoundError('Profile', userId);
    return toProfile(row, email);
  }

  async updateProfile(
    userId: string,
    email: string | null,
    input: UpdateUserProfileInput,
  ): Promise<UserProfile> {
    const row = await this.repository.updateProfile(userId, {
      ...(input.displayName !== undefined ? { display_name: input.displayName } : {}),
      ...(input.avatarUrl !== undefined ? { avatar_url: input.avatarUrl ?? null } : {}),
    });
    if (!row) throw new NotFoundError('Profile', userId);
    return toProfile(row, email);
  }
}
