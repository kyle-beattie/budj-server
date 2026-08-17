import { z } from 'zod';

export const bankConnectionSchema = z.object({
  id: z.uuid(),
  /** Akahu's own identifier for the connection (`conn_...`). */
  akahuConnectionId: z.string(),
  name: z.string(),
  logoUrl: z.string().nullable(),
  connectedAt: z.iso.datetime(),
  disconnectedAt: z.iso.datetime().nullable(),
});
export type BankConnection = z.infer<typeof bankConnectionSchema>;

export const bankConnectionListSchema = z.object({
  data: z.array(bankConnectionSchema),
});

export const listBankConnectionsQuerySchema = z.object({
  includeDisconnected: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
});

/**
 * Starting authorisation returns a URL and nothing else.
 *
 * No token, no Akahu identifiers, no `state` — the client's only job is to open
 * this URL. `state` is deliberately withheld: it is a capability that completes
 * a connection, and the server can look it up again on the way back.
 */
export const authorisationSchema = z.object({
  authorisationUrl: z.url(),
});

/**
 * What the app posts back after Akahu redirects.
 *
 * Sent with the caller's own bearer token, so the exchange is bound to a user
 * this server has verified *and* to the `state` issued when the flow started.
 * Two independent bindings; either alone would be weaker.
 */
export const completeAuthorisationSchema = z.object({
  code: z.string().min(1),
  state: z.string().min(1),
});
export type CompleteAuthorisationInput = z.infer<typeof completeAuthorisationSchema>;

export const connectionResultSchema = z.object({
  connections: z.number().int(),
  accounts: z.number().int(),
});
