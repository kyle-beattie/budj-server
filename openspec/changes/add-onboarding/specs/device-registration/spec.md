## ADDED Requirements

### Requirement: A device registers for push notifications

The iOS app SHALL be able to register a device identifier and an APNs token
against the authenticated user, so that `add-rule-triggers` has somewhere to
deliver approval notifications.

#### Scenario: APNs token is stored

- **WHEN** an authenticated user registers an APNs token for a device identifier
- **THEN** it is stored against that user and device

#### Scenario: No key material is accepted

- **WHEN** the registration schema is inspected
- **THEN** it carries a device identifier and an APNs token only, and there is no
  field for a cryptographic key of any kind

### Requirement: Push registration is advisory and never blocks onboarding

Absence of an APNs token MUST NOT prevent a user from completing onboarding, and
MUST NOT be a step the user is held at.

#### Scenario: Declining notifications does not block completion

- **WHEN** a user completes every other step but registers no APNs token
- **THEN** onboarding status reports `ready`

### Requirement: A user may have several registered devices

Registration SHALL be keyed by user and device identifier so that a person using
more than one device has one registration per device.

#### Scenario: Second device is added

- **WHEN** the same user registers a token from a second device identifier
- **THEN** both registrations exist and neither replaces the other

#### Scenario: Re-registering the same device replaces its token

- **WHEN** a user re-registers a device identifier that already has a
  registration, as happens when APNs issues a new token
- **THEN** the stored token is replaced and the registration remains a single row

### Requirement: Registrations can be revoked

A device registration SHALL be revocable by its owner, and revocation SHALL be
recorded rather than deleted, so a lost device stops receiving notifications.

#### Scenario: Owner revokes a device

- **WHEN** an authenticated user revokes one of their device registrations
- **THEN** the registration is marked revoked and is no longer a delivery target

#### Scenario: A user cannot revoke another user's device

- **WHEN** a user attempts to revoke a device registration belonging to someone
  else
- **THEN** the response is 404
