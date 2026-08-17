import { toAppError, type Supabase, type Tables } from '../../supabase/index.js';

export type DeviceRow = Tables<'device_registrations'>;

export class DevicesRepository {
  constructor(private readonly supabase: Supabase) {}

  async list(userId: string, includeRevoked: boolean): Promise<DeviceRow[]> {
    let query = this.supabase
      .from('device_registrations')
      .select('*')
      .eq('user_id', userId)
      .order('registered_at', { ascending: true });

    if (!includeRevoked) query = query.is('revoked_at', null);

    const { data, error } = await query;
    if (error) throw toAppError(error, { resource: 'Device' });
    return data ?? [];
  }

  /**
   * Upsert on `(user_id, device_id)`.
   *
   * APNs reissues tokens, so re-registering the same device is routine and must
   * replace rather than accumulate. Registering again also clears `revoked_at`:
   * a user who revoked a device and then reinstalled has un-revoked it.
   */
  async register(userId: string, deviceId: string, apnsToken: string): Promise<DeviceRow> {
    const { data, error } = await this.supabase
      .from('device_registrations')
      .upsert(
        {
          user_id: userId,
          device_id: deviceId,
          apns_token: apnsToken,
          registered_at: new Date().toISOString(),
          revoked_at: null,
        },
        { onConflict: 'user_id,device_id' },
      )
      .select()
      .single();

    if (error) throw toAppError(error, { resource: 'Device' });
    return data;
  }

  /** Marks revoked rather than deleting, so a lost device stops being a target. */
  async revoke(userId: string, deviceId: string): Promise<boolean> {
    const { data, error } = await this.supabase
      .from('device_registrations')
      .update({ revoked_at: new Date().toISOString() })
      .eq('user_id', userId)
      .eq('device_id', deviceId)
      .is('revoked_at', null)
      .select('id');

    if (error) throw toAppError(error, { resource: 'Device' });
    return (data?.length ?? 0) > 0;
  }

  /** Whether push can reach this user at all. Advisory — see the onboarding module. */
  async hasActiveDevice(userId: string): Promise<boolean> {
    const { count, error } = await this.supabase
      .from('device_registrations')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .is('revoked_at', null);

    if (error) throw toAppError(error, { resource: 'Device' });
    return (count ?? 0) > 0;
  }
}
