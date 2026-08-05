/**
 * Entry point for the better-auth CLI only — it needs a top-level `auth` export.
 *
 *   npm run auth:generate   # re-emit the auth tables after changing plugins
 *
 * The running server never imports this file; it builds its instance from the
 * shared pool in `plugins/auth.ts`.
 */
import { createDatabase } from '../../db/index.js';
import { createAuth } from './auth.config.js';

export const auth = createAuth(createDatabase().db);
