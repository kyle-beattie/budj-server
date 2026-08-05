/**
 * Single import point for Drizzle. Each module owns its own tables; this file
 * only re-exports them so `drizzle-kit` and the query builder see one schema.
 */
export * from '../modules/auth/auth.schema.js';
export * from '../modules/accounts/accounts.schema.js';
export * from '../modules/rules/rules.schema.js';
