## ADDED Requirements

### Requirement: Account deletion is available in the app

The API SHALL expose an endpoint that deletes the authenticated user's account in
full. Deletion MUST NOT require contacting support or any channel outside the
app.

#### Scenario: An authenticated user requests deletion

- **WHEN** an authenticated user requests deletion with a valid confirmation
- **THEN** the request is accepted and the account is recorded as deleting

#### Scenario: Anonymous callers are refused before validation

- **WHEN** the deletion endpoint is called with no `Authorization` header
- **THEN** the response is 401

### Requirement: Deletion is confirmed by the authenticated owner

Deletion SHALL require a valid access token belonging to the account being
deleted, and no cryptographic confirmation, matching what payment approval
requires. The app is responsible for an explicit, unambiguous confirmation
screen, since the action is immediate and irreversible.

#### Scenario: The owner deletes with a session alone

- **WHEN** an authenticated user requests deletion of their own account
- **THEN** the request is accepted and the account is recorded as deleting

#### Scenario: A user cannot delete another account

- **WHEN** a deletion request names an account other than the caller's
- **THEN** it is refused and nothing is deleted

#### Scenario: Deletion is not inferable from the request body

- **WHEN** the endpoint's schema is inspected
- **THEN** the account deleted is taken from the verified token claims and not
  from any client-supplied identifier

### Requirement: Deletion is immediate, irreversible, and has no grace period

The account SHALL become unusable the moment deletion is requested, and the
request MUST NOT be cancellable.

#### Scenario: The session is revoked at request time

- **WHEN** deletion is requested
- **THEN** the user's refresh tokens are revoked and the client is signed out

#### Scenario: There is no way to undo

- **WHEN** the API surface is inspected
- **THEN** no route exists that cancels or reverses a recorded deletion

### Requirement: A deleting account cannot act, even with an unexpired token

Requests SHALL be refused once deletion is recorded, regardless of an access
token that remains cryptographically valid, because tokens are verified locally
against JWKS with no revocation check.

#### Scenario: A cached token cannot approve a payment

- **WHEN** a request carrying an access token issued before deletion attempts to
  approve a pending execution
- **THEN** the request is refused and no payment is initiated

#### Scenario: Refusal does not wait for token expiry

- **WHEN** such a request arrives immediately after deletion is recorded
- **THEN** it is already refused

### Requirement: Teardown runs as a resumable background job

Teardown SHALL be performed by a background worker with per-step completion
marks, retried with backoff. Every step MUST be idempotent, and a provider
reporting the desired state already reached MUST count as success.

#### Scenario: A failed step is retried without repeating completed ones

- **WHEN** a teardown step fails and the job runs again
- **THEN** completed steps are not repeated and the failed step is retried

#### Scenario: Already-revoked is success

- **WHEN** a revocation call reports the target does not exist or is already
  revoked
- **THEN** the step is marked complete

#### Scenario: A stalled deletion is surfaced

- **WHEN** a deletion has not completed within 24 hours
- **THEN** it is raised operationally rather than retried silently

### Requirement: External access is revoked before local data is deleted

Teardown SHALL revoke every external connection before deleting the user, because
the local rows hold the credentials and identifiers those calls require.

#### Scenario: The Akahu token is revoked before the cascade

- **WHEN** teardown runs to completion
- **THEN** the Akahu token was revoked with Akahu before `auth.users` was deleted

#### Scenario: Consents and webhooks are revoked before the token

- **WHEN** teardown runs to completion
- **THEN** payment consents were revoked and webhook subscriptions removed before
  the Akahu token was revoked

#### Scenario: Ordering is asserted, not merely the end state

- **WHEN** the teardown test runs
- **THEN** it asserts the relative order of the external calls, not only that
  each was made

#### Scenario: Deleting the user is the final step

- **WHEN** teardown runs to completion
- **THEN** `auth.users` deletion is the last operation performed

### Requirement: Every external connection that can be revoked is revoked

Teardown SHALL revoke the Akahu token, payment consents and webhook
subscriptions; end local entitlement; revoke the Apple grant; and globally sign
the user out. The store subscription is the one thing it cannot revoke.

#### Scenario: Bank access is fully cut off

- **WHEN** teardown completes
- **THEN** the Akahu token is revoked, consents are revoked, and webhook
  subscriptions are removed, so no further data or payment access remains

#### Scenario: A missing Apple grant is recorded rather than assumed successful

- **WHEN** the user has no stored Apple refresh token
- **THEN** the Apple revocation step is recorded as unrevoked, and is countable
  rather than reported as complete

### Requirement: Deletion removes all personal data

Every table holding data about the user SHALL be removed by the cascade from
`auth.users`. No rules, executions, connections, consents, devices, projections
or profile data MUST survive.

#### Scenario: Nothing remains after completion

- **WHEN** a completed deletion is inspected
- **THEN** no row referencing that user exists in any application table

#### Scenario: Cascade coverage is enforced by test

- **WHEN** the schema test runs
- **THEN** every table in `public` either cascades from `auth.users` or appears
  in an explicit exemption list

### Requirement: The deletion record does not cascade

The record tracking a deletion SHALL hold the user identifier without a foreign
key to `auth.users`, so that deleting the user cannot destroy the record of the
deletion.

#### Scenario: The record survives the cascade

- **WHEN** teardown deletes `auth.users`
- **THEN** the deletion record remains and is marked complete

#### Scenario: A crash mid-cascade leaves evidence

- **WHEN** the worker fails immediately after deleting the user
- **THEN** the deletion record still exists and the job resumes to mark it
  complete

### Requirement: In-flight payments are cancelled where possible and never block deletion

Teardown SHALL invalidate pending executions and attempt cancellation of payments
already initiated. It MUST NOT wait for a payment to settle.

#### Scenario: A cancellable payment is cancelled

- **WHEN** an initiated payment can still be cancelled
- **THEN** cancellation is attempted before the Akahu token is revoked

#### Scenario: An uncancellable payment does not delay deletion

- **WHEN** a payment cannot be cancelled and has not settled
- **THEN** deletion proceeds to completion regardless

### Requirement: An uncancellable in-flight payment leaves a de-identified stub

A payment that will settle after deletion SHALL leave a record carrying the
payment identifier, amount and outcome only. It MUST NOT carry a user, account,
transaction or rule identifier, and MUST be purged once the payment reaches a
terminal state.

#### Scenario: The stub carries no personal data

- **WHEN** a stub is created
- **THEN** it holds a payment identifier, amount, currency and timestamps, and no
  identifier attributable to a person

#### Scenario: A late settlement is recorded, not discarded

- **WHEN** a payment event arrives for a stub after the user is deleted
- **THEN** the outcome is recorded against the stub

#### Scenario: The stub is purged on settlement

- **WHEN** the payment reaches a terminal state
- **THEN** the stub is deleted
