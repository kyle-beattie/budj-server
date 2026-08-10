## ADDED Requirements

### Requirement: Payment consent is requested when a money-moving rule needs it

Consent SHALL be requested at the point a rule requires it, not during
onboarding, because a consent is bound to a single payer account and can only pay
payees named in the request.

#### Scenario: Creating a transfer rule returns a consent requirement

- **WHEN** a user creates a transfer rule for a payer account whose existing
  consents do not cover the destination
- **THEN** the rule is stored as `pending_consent` and the response contains an
  Akahu authorisation URL

#### Scenario: An already-covered destination needs no redirect

- **WHEN** a user creates a second transfer rule with the same payer and the same
  destination as an existing consent
- **THEN** the rule is stored as `active` and no authorisation URL is returned

### Requirement: Consent coverage is determined by reading Akahu, not local state

Whether a destination is covered SHALL be determined from the payer account's
`payment_consents` as reported by Akahu, and the payer account MUST carry the
`PAYMENT_FROM` attribute.

#### Scenario: A payer account without the attribute is refused

- **WHEN** a transfer rule names a payer account that does not carry
  `PAYMENT_FROM`
- **THEN** the request is rejected and the rule is not stored

#### Scenario: Coverage reflects Akahu rather than a cached list

- **WHEN** a consent has been revoked at the bank but local state has not caught
  up
- **THEN** the destination is treated as uncovered and consent is requested again

### Requirement: Consents are labelled per payer account and nominate the union of destinations

Each authorisation request SHALL use a label derived from the payer account and
SHALL nominate every destination the user has requested from that payer, because
re-consenting with an existing label replaces it.

#### Scenario: Adding a destination preserves the existing ones

- **WHEN** a user adds a second destination for a payer that already has one
- **THEN** the new authorisation request nominates both destinations under the
  same label

#### Scenario: Consents for different payers are independent

- **WHEN** a user holds consents for two payer accounts
- **THEN** replacing one leaves the other unchanged

### Requirement: Destinations are verified and their tokens are not stored

Destinations SHALL be nominated using account verification tokens generated on
demand. A verification token MUST NOT be persisted.

#### Scenario: Tokens are generated per request

- **WHEN** an authorisation request is built
- **THEN** a verification token is generated for each destination at that moment

#### Scenario: No verification token is stored

- **WHEN** the database is inspected
- **THEN** no table holds an account verification token

### Requirement: Account numbers are fetched at payment time, never stored

Payment initiation SHALL fetch the destination account number and holder name
from Akahu at the moment of payment. Neither MUST be persisted.

#### Scenario: No account numbers at rest

- **WHEN** the generated database types are inspected
- **THEN** no table has a column holding a bank account number

### Requirement: Both consent limits are collected and shown to the user

The authorisation request SHALL carry a single-payment limit and a periodic
limit, and the app MUST present them, as these are the only controls enforced
outside this system.

#### Scenario: Limits are required

- **WHEN** an authorisation request is built without both limits
- **THEN** the request is rejected before reaching Akahu

#### Scenario: Granted limits are readable

- **WHEN** a user views a payer account's authorisation
- **THEN** the single-payment limit, periodic limit and period are shown

### Requirement: Revocation invalidates dependent rules and proposals

Revoking a consent, removing a connection, or receiving a token deletion SHALL
move every dependent pending execution to `invalidated` and every dependent rule
to `pending_consent`.

#### Scenario: Revocation stops in-flight proposals

- **WHEN** a consent is revoked while a pending execution depends on it
- **THEN** that execution moves to `invalidated` and cannot be approved

#### Scenario: Dependent rules stop firing and say so

- **WHEN** a consent covering a rule's destination is revoked
- **THEN** the rule moves to `pending_consent` and is reported as needing
  reauthorisation

#### Scenario: A disconnected account breaks its rules visibly

- **WHEN** an account referenced by a rule is marked disconnected
- **THEN** the rule is reported as broken rather than remaining silently inert
