-- Idempotency and ordering state for App Store Server Notifications.
--
-- The first append-only migration. `00000000000001_initial_schema.sql` was
-- edited in place exactly once, because it had never been applied anywhere;
-- that is over. Everything from here gets its own file.
--
-- Why two columns rather than none:
--
-- Apple redelivers notifications, and does not guarantee order. Making the
-- handlers deterministic upserts gets replay *mostly* right, but not out-of-
-- order delivery: a stale EXPIRED arriving after a fresh SUBSCRIBED would
-- revoke a paying customer's bank access.
--
-- `updated_at` cannot stand in for either. It records when *we* wrote the row,
-- not when Apple signed the notification, so a notification signed at 10:02 but
-- delivered at 10:06 looks older than one signed at 10:00 and processed at
-- 10:05. Comparing against it drops legitimate updates.
--
--   last_notification_uuid  exact replay: Apple resends the same UUID
--   last_notification_at    ordering: Apple's signedDate, not our clock

alter table public.billing_subscriptions
  add column last_notification_uuid text,
  add column last_notification_at   timestamptz;

comment on column public.billing_subscriptions.last_notification_uuid is
  'notificationUUID of the last applied App Store notification; a repeat is a redelivery and is ignored.';

comment on column public.billing_subscriptions.last_notification_at is
  'signedDate of the last applied notification. Apple''s clock, deliberately — used to discard out-of-order delivery.';
