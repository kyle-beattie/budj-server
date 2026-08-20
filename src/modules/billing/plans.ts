/**
 * The plan catalogue, in code and deliberately not in a table.
 *
 * A `plans` table would mean a migration every time a limit changes, and it is
 * data that never varies per user — the stored `plan_code` is the only thing
 * the database needs to know. Everything a plan *grants* is resolved from here.
 *
 * The App Store owns the price. This owns what the price buys.
 */

/**
 * One plan, deliberately.
 *
 * The catalogue used to sell rule and connection counts. Those describe what a
 * plan costs to run rather than what it is worth, and the cheaper tier could not
 * initiate a transfer — which does not make it a cheaper Budj so much as a
 * broken one, since moving money on a condition is the whole product. Upstream
 * open-banking cost is per user rather than per rule, so tiering did not track
 * cost either.
 *
 * `maxRules` and `maxConnections` survive as **abuse guardrails, not a product
 * tier**. They are generous, never marketed, and exist so a single account
 * cannot consume unbounded upstream capacity. Keep them enforced.
 */
export const PLAN_CODES = ['standard'] as const;
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
  standard: {
    code: 'standard',
    name: 'Budj',
    /**
     * Yearly, not monthly. The buyer is self-employed and buying a deductible
     * business tool whose renewal aligns with a tax year, and annual billing
     * converts the largest churn risk into cash up front.
     */
    productId: 'com.budj.standard.yearly',
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

/**
 * The codes this catalogue used to have.
 *
 * A row still storing one of these resolves to no entitlement at all, which
 * reads as an unsubscribed user. That is the correct behaviour for an unknown
 * code and the wrong outcome for a paying customer, so if any such row ever
 * existed it must be migrated rather than left to fail quietly.
 */
export const RETIRED_PLAN_CODES = ['starter', 'pro'] as const;
