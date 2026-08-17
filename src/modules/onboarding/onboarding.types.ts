import { z } from 'zod';

/**
 * The step machine the iOS app polls on launch to decide where to resume.
 *
 * Note what is **not** here: a `device` step. An earlier design had one, for
 * enrolling a Secure Enclave key; that was dropped from the product (D10), and
 * push is advisory rather than a step (D12).
 */
export const onboardingSteps = ['billing', 'bank', 'ready'] as const;
export const onboardingStepSchema = z.enum(onboardingSteps);
export type OnboardingStep = z.infer<typeof onboardingStepSchema>;

export const onboardingStatusSchema = z.object({
  /** The first unsatisfied step, in the order billing → bank → ready. */
  step: onboardingStepSchema,
  subscriptionActive: z.boolean(),
  planCode: z.string().nullable(),
  bankConnected: z.boolean(),
  /**
   * Advisory. `ready` never depends on this — declining notifications must not
   * brick the app — but the client should keep prompting, because a rule that
   * cannot notify cannot be approved.
   */
  pushRegistered: z.boolean(),
});
export type OnboardingStatus = z.infer<typeof onboardingStatusSchema>;
