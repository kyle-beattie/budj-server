import { z } from 'zod';

/**
 * Device registration for push.
 *
 * **There is no field for a cryptographic key here, and there must never be
 * one.** An earlier design enrolled a Secure Enclave P-256 key so a future
 * change could require a signature over a server challenge before moving money.
 * That was dropped from the product, not deferred (D10) — the compensating
 * control is Akahu's enduring payment consent, whose limits the bank enforces.
 *
 * This table exists for exactly one reason: `add-rule-triggers` needs somewhere
 * to send an APNs push.
 */

export const registerDeviceSchema = z.object({
  /** The app's own stable identifier for this device. */
  deviceId: z.string().trim().min(1).max(200),
  /** APNs device token. Opaque to this server. */
  apnsToken: z.string().trim().min(1).max(400),
});
export type RegisterDeviceInput = z.infer<typeof registerDeviceSchema>;

export const deviceSchema = z.object({
  id: z.uuid(),
  deviceId: z.string(),
  registeredAt: z.iso.datetime(),
  revokedAt: z.iso.datetime().nullable(),
});
export type Device = z.infer<typeof deviceSchema>;

/**
 * The APNs token is deliberately absent from the response. The client sent it
 * and has no use for it back, and echoing a delivery credential to anyone who
 * can list devices is free risk.
 */
export const deviceListSchema = z.object({
  data: z.array(deviceSchema),
});

export const deviceIdParamSchema = z.object({
  deviceId: z.string().min(1),
});
