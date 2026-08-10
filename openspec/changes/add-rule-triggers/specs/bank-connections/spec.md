## ADDED Requirements

### Requirement: Webhook subscriptions are created per user at token exchange

The server SHALL subscribe to the Akahu webhooks it needs on a per-user basis
once a token has been exchanged, because Akahu's subscriptions are per user
rather than per application.

#### Scenario: Subscriptions follow a new connection

- **WHEN** a user completes the Akahu authorisation flow
- **THEN** webhook subscriptions for transaction, token and payment events are
  created for that user

#### Scenario: Users onboarded before this change are backfilled

- **WHEN** the backfill runs against a user who connected a bank before webhook
  subscription existed
- **THEN** their subscriptions are created, and running it twice creates no
  duplicates

#### Scenario: A cancelled subscription is noticed

- **WHEN** a `WEBHOOK_CANCELLED` event is received for a user
- **THEN** it is recorded so the connection can be reported as needing
  reauthorisation

### Requirement: Payment capability is recorded in both directions

The account projection SHALL record separately whether an account can pay out and
whether it can receive a payment, because Akahu governs these with different
mechanisms.

#### Scenario: Paying out is driven by the Akahu attribute

- **WHEN** the projection syncs an account whose attributes include
  `PAYMENT_FROM`
- **THEN** the account is stored as capable of being a payer

#### Scenario: Receiving is driven by verification eligibility

- **WHEN** the projection syncs an account that is not a BECS-identifiable New
  Zealand bank account
- **THEN** the account is stored as not capable of receiving a payment

#### Scenario: An account may be one and not the other

- **WHEN** an account can be paid from but cannot receive
- **THEN** both facts are recorded independently and the rule editor can offer it
  as a trigger without offering it as a destination
