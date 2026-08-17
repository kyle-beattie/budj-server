/**
 * The plan catalogue, in code and deliberately not in a table.
 *
 * A `plans` table would mean a migration every time a limit changes, and it is
 * data that never varies per user — the stored `plan_code` is the only thing
 * the database needs to know. Everything a plan *grants* is resolved from here.
 *
 * The App Store owns the price. This owns what the price buys.
 */

export const PLAN_CODES = ['starter', 'pro'] as const;
export type PlanCode = (typeof PLAN_CODES)[number];

/** Rule effects a plan permits. `transfer` is inert until add-rule-triggers. */
export type PlanEffect = 'notify' | 'transfer';

export interface Plan {
  code: PlanCode;
  name: string;
  /** App Store product identifier. The join key to what Apple reports. */
  productId: string;
  maxRules: number;
  maxConnections: number;
  effects: readonly PlanEffect[];
}

export const PLANS: Readonly<Record<PlanCode, Plan>> = {
  starter: {
    code: 'starter',
    name: 'Starter',
    productId: 'com.budj.starter.monthly',
    maxRules: 10,
    maxConnections: 2,
    effects: ['notify'],
  },
  pro: {
    code: 'pro',
    name: 'Pro',
    productId: 'com.budj.pro.monthly',
    maxRules: 100,
    maxConnections: 10,
    effects: ['notify', 'transfer'],
  },
} as const;

export const PLAN_LIST: readonly Plan[] = Object.values(PLANS);

function isPlanCode(value: string): value is PlanCode {
  return (PLAN_CODES as readonly string[]).includes(value);
}

/** Resolve a stored `plan_code` to its plan, or undefined if it is unknown. */
export function planByCode(code: string): Plan | undefined {
  return isPlanCode(code) ? PLANS[code] : undefined;
}

/**
 * Resolve an App Store product identifier to a plan.
 *
 * Returns undefined for a product this build has never heard of, which is what
 * a notification for a newly published product looks like before a deploy. The
 * caller decides; this does not guess.
 */
export function planByProductId(productId: string): Plan | undefined {
  return PLAN_LIST.find((plan) => plan.productId === productId);
}

/**
 * Entitlements for a subscription that is currently active.
 *
 * `null` means no entitlement at all — there is no free tier, so an
 * unsubscribed user gets nothing rather than reduced limits.
 */
export function entitlementsFor(planCode: string | null | undefined): Plan | null {
  if (!planCode) return null;
  return planByCode(planCode) ?? null;
}
