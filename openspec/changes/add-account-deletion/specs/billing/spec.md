## ADDED Requirements

### Requirement: The subscription gate also enforces deletion state

The hook guarding routes on subscription status SHALL refuse callers whose
account is being deleted, reusing its existing lookup rather than adding a second
query. Local JWT verification performs no revocation check, so this is the only
place a deleting account can be stopped before its token expires.

#### Scenario: A deleting account is refused on a gated route

- **WHEN** a request carrying a still-valid access token reaches a gated route
  after deletion was recorded
- **THEN** it is refused

#### Scenario: One lookup serves both checks

- **WHEN** the hook runs
- **THEN** entitlement and deletion state are resolved together, not by two
  separate queries

### Requirement: Revoking external access is a single shared routine

Cutting off a user's external access SHALL be implemented once and used by both
loss of entitlement and account deletion, because two implementations of the same
teardown would drift and the less-exercised one would be the broken one.

#### Scenario: Lapse and deletion share the routine

- **WHEN** the code paths for lost entitlement and account deletion are inspected
- **THEN** both call the same revocation routine

#### Scenario: The routine is idempotent

- **WHEN** the routine runs twice for the same user
- **THEN** the second run completes without error and changes nothing

### Requirement: A user with an active subscription is warned before deletion

The server SHALL report whether entitlement is currently active so the app can
warn that deletion will not stop the charging, because Apple provides no way to
cancel a subscription on a user's behalf.

#### Scenario: An active subscription is reported before deletion

- **WHEN** a user with active entitlement opens the deletion flow
- **THEN** the response indicates a subscription is active and must be cancelled
  by the user in App Store settings

#### Scenario: The warning does not block deletion

- **WHEN** a user with an active subscription confirms deletion anyway
- **THEN** deletion proceeds

### Requirement: Teardown ends local entitlement and records the subscription as left live

Teardown SHALL end entitlement locally and record that the store subscription
could not be cancelled. It MUST NOT report the subscription as cancelled.

#### Scenario: The outcome is recorded honestly

- **WHEN** teardown completes for a user whose subscription was still active
- **THEN** the deletion record shows the store subscription was left live

#### Scenario: No cancellation is attempted

- **WHEN** teardown runs
- **THEN** no call is made that purports to cancel the store subscription, since
  no such capability exists
