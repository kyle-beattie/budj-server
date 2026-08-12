## ADDED Requirements

### Requirement: Onboarding step is derived, never stored

The server SHALL compute the current onboarding step from stored facts on each
request. No column SHALL record which step a user has reached.

#### Scenario: No step column exists

- **WHEN** the generated database types are inspected
- **THEN** no table has a column recording an onboarding step or stage

#### Scenario: Step reflects reality immediately

- **WHEN** a user's entitlement becomes active through an App Store notification
- **THEN** the very next status request reports the bank step, with no separate
  write to advance it

### Requirement: The status endpoint reports the first incomplete step

`GET /api/onboarding/status` SHALL return the first unsatisfied step in the order
billing, bank, and otherwise `ready`. Push registration SHALL be reported as
advisory and MUST NOT hold a user back from `ready`.

#### Scenario: Newly signed-in user needs billing

- **WHEN** a user who has just signed in and has no subscription requests status
- **THEN** the step is `billing`

#### Scenario: Subscribed user with no bank needs bank

- **WHEN** a subscribed user with no stored Akahu token requests status
- **THEN** the step is `bank`

#### Scenario: Everything satisfied reports ready

- **WHEN** a subscribed user with a stored Akahu token requests status
- **THEN** the step is `ready`

#### Scenario: Missing push registration is advisory only

- **WHEN** a user who is otherwise complete has registered no APNs token
- **THEN** the step is `ready` and the response indicates push registration is
  outstanding

### Requirement: Onboarding is resumable and every step is idempotent

A user SHALL be able to abandon onboarding at any point and resume from the same
step on the next launch. Repeating a completed step MUST NOT create duplicate
state.

#### Scenario: Resuming after abandonment

- **WHEN** a user completes billing, closes the app before connecting a bank, and
  requests status on the next launch
- **THEN** the step is `bank` and no billing work is repeated

#### Scenario: Repeating a completed step is harmless

- **WHEN** a user who already has a subscription requests subscription creation
  again
- **THEN** no second customer or subscription is created and the response
  describes the existing one

### Requirement: Status requires authentication and is not subscription gated

The endpoint SHALL require a valid token, because it describes a specific user,
and SHALL remain reachable to a user with no subscription, because otherwise a
user could not discover that billing is what they are missing.

#### Scenario: Anonymous caller is rejected before validation

- **WHEN** the status endpoint is called with no `Authorization` header
- **THEN** the response is 401

#### Scenario: Unsubscribed caller still gets a status

- **WHEN** an authenticated user with no subscription requests status
- **THEN** the response is 200 with step `billing`, not 402
