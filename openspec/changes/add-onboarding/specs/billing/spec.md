## ADDED Requirements

### Requirement: An active subscription gates everything beyond identity

Every route SHALL reject a caller whose cached entitlement is not active, except
authentication, the plan catalogue, purchase submission, and onboarding status.
There is no free tier.

#### Scenario: Unsubscribed user is refused a bank connection

- **WHEN** an authenticated user with no active entitlement starts the Akahu
  authorisation flow
- **THEN** the request is rejected with 402 and the error code
  `subscription_required`

#### Scenario: Subscribed user proceeds

- **WHEN** an authenticated user with active entitlement starts the Akahu
  authorisation flow
- **THEN** the request is accepted

### Requirement: The plan catalogue is served from code

Plans and their entitlements SHALL be defined in application code keyed by
`plan_code`, mapped to App Store product identifiers. No `plans` table SHALL
exist.

#### Scenario: Catalogue is readable without a subscription

- **WHEN** an authenticated user requests the plan catalogue
- **THEN** each plan is returned with its code, App Store product identifier, and
  limits

#### Scenario: Entitlement is resolved from code, not storage

- **WHEN** a user's entitlements are resolved
- **THEN** the limits come from the code catalogue keyed by the stored
  `plan_code`, and no limit value is read from the database

### Requirement: Purchases are made with StoreKit and submitted to the server

The app SHALL complete the purchase with StoreKit 2 and submit the signed
transaction. The server SHALL verify the JWS signature against Apple's
certificate chain before granting entitlement.

#### Scenario: A verified transaction grants entitlement

- **WHEN** the app submits a signed transaction whose certificate chain resolves
  to Apple's root
- **THEN** entitlement is recorded for the authenticated user against the
  transaction's original transaction identifier

#### Scenario: An unverifiable transaction grants nothing

- **WHEN** a submitted transaction fails signature or chain verification
- **THEN** the request is rejected and no entitlement is recorded

#### Scenario: Resubmitting the same transaction is idempotent

- **WHEN** the same transaction is submitted twice by the same user
- **THEN** entitlement is unchanged and no duplicate record is created

### Requirement: One subscription entitles exactly one account

The original transaction identifier SHALL be unique across users, so that a
single App Store subscription cannot entitle more than one account.

#### Scenario: A subscription already bound to another account is refused

- **WHEN** a user submits a transaction whose original transaction identifier is
  already recorded against a different user
- **THEN** the request is rejected and the existing entitlement is unchanged

#### Scenario: The constraint is enforced by the database

- **WHEN** the schema is inspected
- **THEN** a unique constraint exists on the original transaction identifier

### Requirement: App Store Server Notifications are the only writer of entitlement state after purchase

Cached entitlement SHALL be updated exclusively by verified App Store Server
Notifications. The server SHALL NOT poll, and SHALL NOT infer continued
entitlement from the absence of a notification.

#### Scenario: An unverifiable notification is rejected

- **WHEN** a notification arrives whose JWS signature or certificate chain does
  not verify
- **THEN** it is rejected and no state is written

#### Scenario: A verified renewal extends entitlement

- **WHEN** a verified `DID_RENEW` notification arrives
- **THEN** the cached expiry for the matching subscription is extended

#### Scenario: Notifications are not subject to JWT authentication

- **WHEN** the notification endpoint is called with no `Authorization` header and
  a verifiable payload
- **THEN** the notification is processed

#### Scenario: Redelivery is idempotent

- **WHEN** the same notification is delivered twice
- **THEN** the second delivery changes nothing

### Requirement: Every route to lost entitlement revokes bank access

Expiry, refund, failed renewal, grace period expiry, and user cancellation SHALL
all revoke the user's Akahu token and mark their connections disconnected.
Gating the API alone is insufficient.

#### Scenario: A refund revokes access

- **WHEN** a verified `REFUND` notification arrives for a user with a stored
  Akahu token
- **THEN** the token is revoked with Akahu, the stored token row is deleted, and
  every connection for that user is marked disconnected

#### Scenario: Expiry revokes access

- **WHEN** a verified `EXPIRED` notification arrives
- **THEN** the same revocation is performed

#### Scenario: Revocation is idempotent

- **WHEN** two notifications that both end entitlement arrive for the same user
- **THEN** the second completes without error and changes nothing

### Requirement: The server cannot cancel, pause, or refund a subscription

The API SHALL NOT claim to cancel a subscription, because Apple provides no such
capability. Any user-facing cancellation MUST direct the user to App Store
subscription management.

#### Scenario: No cancellation route exists

- **WHEN** the OpenAPI document is generated
- **THEN** it contains no route that purports to cancel or pause a subscription

#### Scenario: The user is directed to the App Store

- **WHEN** a user asks to stop their subscription
- **THEN** the response directs them to App Store subscription management rather
  than reporting a cancellation the server cannot perform
