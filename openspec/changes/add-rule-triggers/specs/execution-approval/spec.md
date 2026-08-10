## ADDED Requirements

### Requirement: A pending execution stores instructions, never transaction data

The execution row SHALL store the Akahu transaction identifier, the triggering
account, and the resolved effects. It MUST NOT store the transaction's amount,
merchant, description or reference.

#### Scenario: No Akahu transaction data is persisted

- **WHEN** a pending execution row is inspected directly in the database
- **THEN** it contains a transaction identifier and the user's own instructions,
  and no amount, merchant, description or reference belonging to the transaction

#### Scenario: The transfer amount is resolved at proposal time

- **WHEN** a rule transferring 10% of a credit of `1000.00` fires
- **THEN** the stored effect reads `100.00`, not a percentage to be recomputed

### Requirement: One proposal carries every matching rule's effects

Matching rules SHALL be folded in priority order, honouring `stopProcessing`, into
a single execution with one entry per effect. Each entry MUST carry its own
status.

#### Scenario: Three matching rules produce one proposal

- **WHEN** three rules match a single transaction
- **THEN** exactly one pending execution exists, carrying three effects, and one
  notification is sent

#### Scenario: Partial failure is recorded per effect

- **WHEN** an approved execution has two transfers succeed and one declined for
  insufficient funds
- **THEN** each effect records its own outcome and the execution is not reported
  as wholly successful

### Requirement: Approval requires a signature over a server-issued challenge

Approval SHALL require an ES256 signature, produced by the device key enrolled
during onboarding, over a canonical encoding of the execution identifier, a
server-issued nonce, and a digest of the effects including every amount.

#### Scenario: Approval without a valid signature is refused

- **WHEN** an approval is submitted with a missing or invalid signature
- **THEN** the request is rejected with 401 and no payment is initiated

#### Scenario: A stolen session alone cannot move money

- **WHEN** an approval is submitted with a valid access token but no signature
- **THEN** the request is rejected and no payment is initiated

#### Scenario: Tampering with the amount invalidates the signature

- **WHEN** an approval carries a signature produced over different effect amounts
  than those stored
- **THEN** verification fails and no payment is initiated

#### Scenario: A nonce cannot be reused

- **WHEN** a nonce that has already been used is presented again
- **THEN** the request is rejected

#### Scenario: An expired challenge is refused

- **WHEN** a signature is presented against a nonce issued beyond its time to live
- **THEN** the request is rejected

### Requirement: The canonical signing payload is published as test vectors

The server SHALL publish the canonical encoding as versioned test vectors, and
MUST verify its own canonicaliser against them in CI, because the client is built
in a separate repository and a one-byte disagreement fails every approval with an
error neither side can diagnose alone.

#### Scenario: Vectors cover the encoding, not the signature

- **WHEN** the published vectors are inspected
- **THEN** each carries inputs, the expected canonical byte string and its
  digest, and no signature, since device keys differ

#### Scenario: Drift fails the build

- **WHEN** the canonical encoding changes without the vectors being regenerated
- **THEN** the server's own test suite fails

### Requirement: Declining requires no signature

Declining an execution SHALL require authentication only, because refusing to
move money is always safe.

#### Scenario: Decline succeeds without a signature

- **WHEN** an authenticated owner declines a pending execution
- **THEN** the execution moves to `declined` and no payment is initiated

### Requirement: State transitions are compare-and-swap

Every transition out of `pending` SHALL be a conditional update that also matches
the current status, because there is no database transaction available and
Akahu's payment endpoint documents no idempotency mechanism.

#### Scenario: Concurrent approvals initiate exactly one payment

- **WHEN** two approval requests for the same execution are processed
  simultaneously, both with valid signatures
- **THEN** exactly one payment is initiated and the other request returns the
  current state without error

#### Scenario: Approving an already-resolved execution is refused

- **WHEN** an execution that is already `declined`, `expired` or `invalidated` is
  approved
- **THEN** the request is refused and no payment is initiated

### Requirement: The status advances before the payment call, never after

The execution SHALL move to `executing` before `POST /payments` is called, so
that a crash mid-flight leaves a recoverable row rather than one that will be
paid twice on retry.

#### Scenario: A crash after the state write does not double pay

- **WHEN** the process fails between the status update and the payment call, and
  the user retries
- **THEN** the retry finds the execution in `executing` and does not initiate a
  second payment

### Requirement: Payment outcome is settled asynchronously

Success SHALL NOT be reported from the payment initiation response. The Akahu
payment identifier is recorded per effect and the final outcome is applied from
payment webhook events.

#### Scenario: Initiation is not success

- **WHEN** `POST /payments` returns a processing status
- **THEN** the effect records the payment identifier and remains unsettled

#### Scenario: A payment webhook settles the effect

- **WHEN** a verified payment event reports `SENT` for a recorded payment
  identifier
- **THEN** that effect is marked succeeded

#### Scenario: A declined payment is recorded with its reason

- **WHEN** a payment event reports a failure with a status code such as
  `INSUFFICIENT_FUNDS` or `CONSENT_REVOKED`
- **THEN** the effect is marked failed and the reason is retained for the user

### Requirement: Proposals expire

A pending execution SHALL expire after its time to live, defaulting to 48 hours,
and MUST NOT be approvable afterwards.

#### Scenario: An old proposal cannot be approved

- **WHEN** a user approves an execution whose expiry has passed
- **THEN** the request is refused and no payment is initiated

#### Scenario: The sweep marks lapsed proposals

- **WHEN** the expiry sweep runs
- **THEN** every pending execution past its expiry moves to `expired`

### Requirement: Resolved executions are retained

Executions SHALL be retained after resolution in every terminal state, because
they are the audit trail for money movement.

#### Scenario: History survives resolution

- **WHEN** an execution succeeds, is declined, or expires
- **THEN** the row remains readable by its owner and is not deleted

#### Scenario: A user cannot read another user's executions

- **WHEN** a user requests an execution belonging to someone else
- **THEN** the response is 404
