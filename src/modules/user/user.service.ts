import { NotFoundError } from '../../lib/errors.js';
import type { UserRow } from '../auth/auth.schema.js';
import type { UserRepository } from './user.repository.js';
import type { UpdateUserProfileInput, UserProfile } from './user.types.js';

function toProfile(row: UserRow): UserProfile {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    emailVerified: row.emailVerified,
    image: row.image,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export class UserService {
  constructor(private readonly repository: UserRepository) {}

  async getProfile(userId: string): Promise<UserProfile> {
    const row = await this.repository.findById(userId);
    if (!row) throw new NotFoundError('User', userId);
    return toProfile(row);
  }

  async updateProfile(userId: string, input: UpdateUserProfileInput): Promise<UserProfile> {
    const row = await this.repository.updateProfile(userId, {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.image !== undefined ? { image: input.image ?? null } : {}),
    });
    if (!row) throw new NotFoundError('User', userId);
    return toProfile(row);
  }
}
