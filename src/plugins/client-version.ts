import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { AppError } from '../lib/errors.js';

/**
 * Client version gating (D15).
 *
 * A deployed server updates in seconds. A shipped iOS build persists for as
 * long as users decline to update and **cannot be recalled** — an expedited
 * release still requires every user to act. For an application that moves
 * money that is a real operational risk, so the server enforces a minimum
 * supported build and can independently disable money-moving operations for a
 * known-bad range.
 *
 * Built now because it cannot be built in a hurry: the version that needs
 * blocking is, by definition, already shipped, and a client that does not send
 * its build identifier cannot be gated at all.
 *
 * Configuration is environment-driven rather than a table, because this must
 * change during an incident without a migration.
 */

export const CLIENT_BUILD_HEADER = 'x-client-build';

/**
 * Distinct from 401 and 402 on purpose. The app has to tell "sign in again"
 * from "buy a subscription" from "update the app", and each leads somewhere
 * different — the last one to the App Store.
 */
export class ClientUpdateRequiredError extends AppError {
  constructor(message = 'This version of the app is no longer supported') {
    super(message, { statusCode: 426, code: 'CLIENT_UPDATE_REQUIRED' });
  }
}

/** Money movement blocked for this build, but the rest of the app still works. */
export class ClientBuildBlockedError extends AppError {
  constructor(message = 'This version of the app cannot be used for payments') {
    super(message, { statusCode: 409, code: 'CLIENT_BUILD_BLOCKED' });
  }
}

export interface ClientGateOptions {
  /**
   * Lowest build allowed to call the API at all. `null` disables the gate
   * entirely — intended for local development and tests. `env.ts` refuses to
   * boot in production without it, so "forgot to configure it" cannot silently
   * mean "no gating".
   */
  minimumBuild: number | null;
  /**
   * Builds refused for money movement while remaining otherwise usable.
   * Inclusive range. Separate from `minimumBuild` on purpose: killing an entire
   * client version because its amount digest is wrong is a worse outcome than
   * refusing only the operations that depend on it.
   */
  blockedMoneyBuilds: { from: number; to: number } | null;
}

export type ClientVerdict =
  | { allowed: true; build: number | null }
  | { allowed: false; reason: 'unsupported' | 'missing' | 'malformed' };

/**
 * Pure: given a header and the configuration, is this client allowed?
 *
 * Split out so every case is testable without an HTTP request, and so the
 * "missing means unsupported" rule is impossible to lose in hook plumbing.
 */
export function evaluateClientBuild(
  rawHeader: string | undefined,
  options: ClientGateOptions,
): ClientVerdict {
  if (options.minimumBuild === null) {
    return { allowed: true, build: parseBuild(rawHeader) };
  }

  if (rawHeader === undefined || rawHeader.trim() === '') {
    // **A missing identifier is unsupported, not exempt.** A client that cannot
    // be identified cannot be gated, so treating absence as "probably fine"
    // hands every attacker and every stale build a bypass.
    return { allowed: false, reason: 'missing' };
  }

  const build = parseBuild(rawHeader);
  if (build === null) return { allowed: false, reason: 'malformed' };
  if (build < options.minimumBuild) return { allowed: false, reason: 'unsupported' };

  return { allowed: true, build };
}

/** Whether this build may initiate money movement. */
export function isMoneyMovementBlocked(
  build: number | null,
  options: ClientGateOptions,
): boolean {
  if (!options.blockedMoneyBuilds) return false;
  // An unidentifiable client is not trusted with money either.
  if (build === null) return true;

  return build >= options.blockedMoneyBuilds.from && build <= options.blockedMoneyBuilds.to;
}

function parseBuild(rawHeader: string | undefined): number | null {
  if (rawHeader === undefined) return null;

  const trimmed = rawHeader.trim();
  // Integer builds only. iOS `CFBundleVersion` is monotonic, and comparing
  // semver strings is a class of bug this does not need during an incident.
  if (!/^\d{1,10}$/.test(trimmed)) return null;

  return Number(trimmed);
}

/**
 * Routes that are not client requests at all.
 *
 * App Store notifications come from Apple and Akahu's webhook will come from
 * Akahu; neither has an app build and gating them would silently break
 * subscription state and, later, transaction ingestion. Matched by prefix so a
 * sub-path cannot escape the exemption.
 */
const EXEMPT_PREFIXES = [
  '/api/billing/apple/notifications',
  '/api/akahu/webhook',
  '/healthz',
  '/docs',
  '/openapi.json',
] as const;

export function isExemptPath(path: string): boolean {
  return EXEMPT_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

const clientVersionPlugin: FastifyPluginAsync<ClientGateOptions> = async (fastify, options) => {
  fastify.decorateRequest('clientBuild', null);

  fastify.addHook('onRequest', async (request: FastifyRequest) => {
    if (isExemptPath(request.url.split('?')[0] ?? request.url)) return;

    const verdict = evaluateClientBuild(
      request.headers[CLIENT_BUILD_HEADER] as string | undefined,
      options,
    );

    if (!verdict.allowed) {
      request.log.info(
        { reason: verdict.reason, path: request.url },
        'Refused an unsupported client build',
      );
      throw new ClientUpdateRequiredError();
    }

    request.clientBuild = verdict.build;
  });

  /**
   * The money-movement gate, as a named hook rather than a global one.
   *
   * **Nothing in this change initiates a payment**, so nothing applies it yet.
   * It exists and is proven to refuse, so `add-rule-triggers` inherits a
   * working gate rather than having to build one at the moment it is needed —
   * which is to say, during an incident.
   */
  fastify.decorate('requireMoneyMovementAllowed', async (request: FastifyRequest) => {
    if (isMoneyMovementBlocked(request.clientBuild ?? null, options)) {
      request.log.warn(
        { build: request.clientBuild, path: request.url },
        'Refused money movement from a blocked client build',
      );
      throw new ClientBuildBlockedError();
    }
  });
};

export default fp(clientVersionPlugin, { name: 'client-version' });
