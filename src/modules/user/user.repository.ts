import { eq } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import { user, type UserRow } from '../auth/auth.schema.js';

/** Reads and profile-only writes against the better-auth `user` table. */
export class UserRepository {
  constructor(private readonly db: Database) {}

  async findById(id: string): Promise<UserRow | undefined> {
    const [row] = await this.db.select().from(user).where(eq(user.id, id)).limit(1);
    return row;
  }

  async findByEmail(email: string): Promise<UserRow | undefined> {
    const [row] = await this.db.select().from(user).where(eq(user.email, email)).limit(1);
    return row;
  }

  async updateProfile(
    id: string,
    values: Partial<Pick<UserRow, 'name' | 'image'>>,
  ): Promise<UserRow | undefined> {
    const [row] = await this.db
      .update(user)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(user.id, id))
      .returning();
    return row;
  }
}
