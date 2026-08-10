## ADDED Requirements

### Requirement: Push payloads carry no financial detail

An APNs payload SHALL contain the execution identifier and a generic title only.
It MUST NOT contain an amount, an account name, a merchant, or any other
financial detail.

#### Scenario: The payload is thin

- **WHEN** a notification is sent for a pending execution
- **THEN** its payload contains the execution identifier and a generic title, and
  no amount or account name

#### Scenario: Detail is fetched over the API

- **WHEN** the app opens an execution from a notification
- **THEN** the amounts and account names are retrieved from the API over TLS

### Requirement: A notification is sent once per execution

Notification SHALL be tied to the creation of an execution, so that a folded
proposal covering several rules produces one notification.

#### Scenario: Three matching rules produce one notification

- **WHEN** three rules match a single transaction
- **THEN** one notification is sent

#### Scenario: Redelivered webhooks do not re-notify

- **WHEN** a webhook is redelivered for a transaction that already has an
  execution
- **THEN** no further notification is sent

### Requirement: Notification delivery is never the sole route to a proposal

Every pending execution SHALL be reachable from an in-app list independent of
notification delivery, because a failed push would otherwise mean a rule silently
never ran.

#### Scenario: A user with no APNs token still sees pending work

- **WHEN** a user who never granted notification permission opens the app
- **THEN** their pending executions are listed and can be approved

#### Scenario: Push failure does not affect the proposal

- **WHEN** APNs rejects a delivery
- **THEN** the pending execution remains valid, approvable, and listed

### Requirement: Notifications are sent only to enrolled, unrevoked devices

Delivery SHALL target the user's registered devices, skipping revoked
registrations and those with no APNs token.

#### Scenario: Revoked devices are skipped

- **WHEN** a user has two registered devices and one is revoked
- **THEN** the notification is delivered only to the remaining device

#### Scenario: An APNs token rejected as invalid is cleared

- **WHEN** APNs reports a device token as no longer valid
- **THEN** that token is cleared from the registration and delivery is not
  retried against it
