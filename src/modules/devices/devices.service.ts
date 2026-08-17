import { NotFoundError } from '../../lib/errors.js';
import type { DeviceRow, DevicesRepository } from './devices.repository.js';
import type { Device, RegisterDeviceInput } from './devices.types.js';

function toDevice(row: DeviceRow): Device {
  return {
    id: row.id,
    deviceId: row.device_id,
    registeredAt: new Date(row.registered_at).toISOString(),
    revokedAt: row.revoked_at ? new Date(row.revoked_at).toISOString() : null,
  };
}

/**
 * Device registrations, so `add-rule-triggers` has somewhere to deliver an
 * approval notification.
 *
 * Nothing here is a gate. Declining notifications must never brick the app, so
 * onboarding treats push as advisory (D12) — the durable surface is an in-app
 * pending list, which that change provides.
 */
export class DevicesService {
  constructor(private readonly repository: DevicesRepository) {}

  async list(userId: string, includeRevoked = false): Promise<Device[]> {
    const rows = await this.repository.list(userId, includeRevoked);
    return rows.map(toDevice);
  }

  async register(userId: string, input: RegisterDeviceInput): Promise<Device> {
    const row = await this.repository.register(userId, input.deviceId, input.apnsToken);
    return toDevice(row);
  }

  /**
   * 404 when the device is not the caller's — which is also what a user gets
   * for someone else's device, because RLS hides it. The two cases are
   * indistinguishable on purpose: confirming that a device id exists on another
   * account is information nobody needs.
   */
  async revoke(userId: string, deviceId: string): Promise<void> {
    const revoked = await this.repository.revoke(userId, deviceId);
    if (!revoked) throw new NotFoundError('Device', deviceId);
  }
}
