## ADDED Requirements

### Requirement: A device registers a Secure Enclave public key

The iOS app SHALL generate a P-256 key pair in the Secure Enclave, gated on the
current biometric set, and register the public key with the server. The private
key never leaves the device. This change stores the key and performs no
verification with it.

#### Scenario: Public key is enrolled

- **WHEN** an authenticated user registers a device identifier and a P-256 public
  key
- **THEN** the key is stored against that user and device and reported as enrolled

#### Scenario: A malformed key is refused

- **WHEN** a registration supplies a value that is not a valid P-256 public key
- **THEN** the request is rejected with 400 and nothing is stored

#### Scenario: No private key material is ever accepted

- **WHEN** the registration schema is inspected
- **THEN** it accepts a public key only, and there is no field in which a private
  key could be submitted

### Requirement: A user may have several registered devices

Registration SHALL be keyed by user and device identifier so that a person using
more than one device has one enrolled key per device.

#### Scenario: Second device is added

- **WHEN** the same user registers a key from a second device identifier
- **THEN** both registrations exist and neither replaces the other

#### Scenario: Re-registration of the same device replaces the key

- **WHEN** a user re-registers a key for a device identifier that already has one,
  as happens after the biometric set changes and invalidates the old key
- **THEN** the stored key is replaced and the registration remains a single row

### Requirement: Registrations can be revoked

A device registration SHALL be revocable by its owner, and revocation SHALL be
recorded rather than deleted.

#### Scenario: Owner revokes a device

- **WHEN** an authenticated user revokes one of their device registrations
- **THEN** the registration is marked revoked and is no longer reported as
  enrolled

#### Scenario: A user cannot revoke another user's device

- **WHEN** a user attempts to revoke a device registration belonging to someone
  else
- **THEN** the response is 404

### Requirement: An APNs token may be registered and is not required

The app SHALL be able to register an APNs device token. Absence of one MUST NOT
prevent a user from completing onboarding.

#### Scenario: APNs token is stored

- **WHEN** an authenticated user registers an APNs token for a device identifier
- **THEN** it is stored against that device

#### Scenario: Declining notifications does not block completion

- **WHEN** a user completes every other step but registers no APNs token
- **THEN** onboarding status reports `ready`
