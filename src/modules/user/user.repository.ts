import { toAppError, type Supabase, type Tables, type UpdateDto } from '../../supabase/index.js';

export type ProfileRow = Tables<'profiles'>;
export type ProfilePatch = UpdateDto<'profiles'>;

/**
 * Reads and writes `public.profiles` — the application-owned record for a user.
 * `auth.users` belongs to Supabase and is never written to from here; email and
 * password changes go through the auth module.
 */
export class UserRepository {
  constructor(private readonly supabase: Supabase) {}

  async findById(id: string): Promise<ProfileRow | undefined> {
    const { data, error } = await this.supabase
      .from('profiles')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (error) throw toAppError(error, { resource: 'Profile' });
    return data ?? undefined;
  }

  async updateProfile(id: string, values: ProfilePatch): Promise<ProfileRow | undefined> {
    const { data, error } = await this.supabase
      .from('profiles')
      .update(values)
      .eq('id', id)
      .select()
      .maybeSingle();

    if (error) throw toAppError(error, { resource: 'Profile' });
    return data ?? undefined;
  }
}
