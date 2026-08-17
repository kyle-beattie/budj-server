import type { Database, TablesInsert, TablesUpdate } from './database.types.js';

export { createAnonClient, createServiceClient, createUserClient } from './client.js';
export type { Supabase } from './client.js';
export { toAppError, toAuthAppError } from './errors.js';
export type { Database, Json, Tables, Enums } from './database.types.js';

/**
 * `InsertDto` / `UpdateDto` are this codebase's names for the generated
 * `TablesInsert` / `TablesUpdate`.
 *
 * They live here rather than in `database.types.ts` because that file is
 * produced by `pnpm types:generate` and any edit to it is erased on the next
 * run. An earlier version of it carried these two aliases by hand, and they
 * vanished the first time the generator was actually pointed at a database.
 */
export type InsertDto<T extends keyof Database['public']['Tables']> = TablesInsert<T>;
export type UpdateDto<T extends keyof Database['public']['Tables']> = TablesUpdate<T>;
