import type { FastifyPluginAsync } from 'fastify';
import { API_PREFIX, AUTH_PREFIX } from '../config/index.js';
import authRoutes from './auth/auth.routes.js';
import accountsRoutes from './accounts/accounts.routes.js';
import rulesRoutes from './rules/rules.routes.js';
import userRoutes from './user/user.routes.js';

/**
 * The one place that knows which modules exist and where they are mounted.
 * Each entry is registered in its own encapsulated Fastify scope, so hooks and
 * content-type parsers declared inside a module stay inside that module.
 *
 * Add a new area of concern by creating `modules/<name>/` and listing it here.
 */
const modules: Array<{ prefix: string; routes: FastifyPluginAsync }> = [
  { prefix: AUTH_PREFIX, routes: authRoutes as FastifyPluginAsync },
  { prefix: `${API_PREFIX}/users`, routes: userRoutes as FastifyPluginAsync },
  { prefix: `${API_PREFIX}/accounts`, routes: accountsRoutes as FastifyPluginAsync },
  { prefix: `${API_PREFIX}/rules`, routes: rulesRoutes as FastifyPluginAsync },
];

export const registerModules: FastifyPluginAsync = async (fastify) => {
  for (const { prefix, routes } of modules) {
    await fastify.register(routes, { prefix });
  }
};

export default registerModules;
