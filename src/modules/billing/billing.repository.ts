import { toAppError, type Supabase, type Tables } from '../../supabase/index.js';
import type { SubscriptionStatus } from './billing.types.js';

export type SubscriptionRow = Tables<'billing_subscriptions'>;

export interface EntitlementWrite {
  userId: string;
  originalTransactionId: string;
  productId: string;
  planCode: string;
  status: SubscriptionStatus;
  expiresAt: string | null;
  notificationUuid: string | null;
  notificationAt: string | null;
}

/**
 * The cached entitlement row: *our* record of what a purchase buys, keyed by
 * our `user_id` rather than by anything Apple owns.
 *
 * Reads happen through a user client (owner select policy). **Writes must use a
 * service-role client** — `billing_subscriptions` is select-only for its owner,
 * because a user who could insert here would grant themselves a plan.
 */
export class BillingRepository {
  constructor(private readonly supabase: Supabase) {}

  async findByUserId(userId: string): Promise<SubscriptionRow | undefined> {
    const { data, error } = await this.supabase
      .from('billing_subscriptions')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();

    if (error) throw toAppError(error, { resource: 'Subscription' });
    return data ?? undefined;
  }

  /**
   * Look up by Apple's key rather than ours. This is how a notification finds
   * the account it concerns: Apple knows about a purchase and nothing about our
   * users, so `original_transaction_id` is the only join available.
   */
  async findByOriginalTransactionId(
    originalTransactionId: string,
  ): Promise<SubscriptionRow | undefined> {
    const { data, error } = await this.supabase
      .from('billing_subscriptions')
      .select('*')
      .eq('original_transaction_id', originalTransactionId)
      .maybeSingle();

    if (error) throw toAppError(error, { resource: 'Subscription' });
    return data ?? undefined;
  }

  /** Service role only. Upserts on `user_id` — one entitlement per account. */
  async upsert(values: EntitlementWrite): Promise<SubscriptionRow> {
    const { data, error } = await this.supabase
      .from('billing_subscriptions')
      .upsert(
        {
          user_id: values.userId,
          original_transaction_id: values.originalTransactionId,
          product_id: values.productId,
          plan_code: values.planCode,
          status: values.status,
          expires_at: values.expiresAt,
          last_notification_uuid: values.notificationUuid,
          last_notification_at: values.notificationAt,
        },
        { onConflict: 'user_id' },
      )
      .select()
      .single();

    if (error) {
      throw toAppError(error, {
        resource: 'Subscription',
        // The unique index on original_transaction_id is what stops one App
        // Store subscription entitling two accounts.
        conflictMessage: 'That App Store subscription is already linked to another account',
      });
    }
    return data;
  }
}
