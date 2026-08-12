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

### Requirement: Executions are created only by server-side ingestion

A pending execution SHALL be writable only by the ingestion and approval paths
running as service role. The owner's database role SHALL hold `select` on
`pending_executions` and nothing further: no `insert`, no `update`, no `delete`.

The approval endpoint deliberately performs no check that a webhook preceded the
execution, because the existence of the row *is* that evidence and because the
reconciliation sweep legitimately creates executions with no webhook at all (E17).
That reasoning only holds while the row cannot be forged, which is what this
requirement establishes.

This inverts the codebase's usual pattern, in which RLS is the owner's write gate.
Here it is a read-only window onto rows the server wrote — the shape already used
by `public.profiles`.

#### Scenario: A user cannot insert their own execution

- **WHEN** an authenticated user posts a `pending_executions` row directly to
  PostgREST, naming their own `user_id`, an invented transaction identifier and
  an effect transferring money
- **THEN** the insert is refused by policy, no row exists, and there is
  consequently nothing to approve

#### Scenario: A user cannot rewrite an execution before approving it

- **WHEN** an authenticated user updates a pending execution's `effects`, its
  `status`, or its `expires_at` directly through PostgREST
- **THEN** the update is refused by policy and the stored instructions are
  unchanged

#### Scenario: A user cannot delete their audit trail

- **WHEN** an authenticated user deletes a resolved execution directly through
  PostgREST
- **THEN** the delete is refused by policy and the row remains

#### Scenario: The owner can still read their pending list

- **WHEN** an authenticated user lists their pending executions
- **THEN** their own rows are returned, because `select` remains permitted

### Requirement: An execution records how it was proposed

Each execution SHALL record its provenance — webhook delivery or reconciliation
sweep — so that the audit trail can answer how a payment came to be proposed, and
so that a silently dead webhook endpoint is detectable as a shift in that mix.

#### Scenario: Provenance distinguishes the two ingestion paths

- **WHEN** an execution created from a webhook delivery and one created by the
  reconciliation sweep are inspected
- **THEN** each records which path proposed it

#### Scenario: Both provenances are equally approvable

- **WHEN** the owner approves an execution created by the reconciliation sweep
- **THEN** it is approved normally, because a missed webhook is a delivery
  failure and not a reason to strand the user's rule

### Requirement: Approval requires the authenticated owner and nothing further

Approval SHALL require a valid access token belonging to the execution's owner.
No signature, device key or biometric assertion is required. The exposure this
accepts — that a valid session can approve a payment — is bounded by the consent
limits the bank enforces, and is recorded in design decision E11.

#### Scenario: The owner approves with a session alone

- **WHEN** the authenticated owner approves a pending execution
- **THEN** the execution moves to `executing` and payment is initiated

#### Scenario: An anonymous approval is refused

- **WHEN** an approval is submitted with no `Authorization` header
- **THEN** the response is 401 and no payment is initiated

#### Scenario: A user cannot approve another user's execution

- **WHEN** a user approves an execution belonging to someone else
- **THEN** the response is 404 and no payment is initiated

#### Scenario: The approved amounts are the stored ones

- **WHEN** an approval request carries effect amounts in its body
- **THEN** they are ignored and the stored effects are what execute, because the
  amount was resolved at proposal time and the client cannot restate it

### Requirement: Declining requires authentication only

Declining an execution SHALL require authentication only, because refusing to
move money is always safe.

#### Scenario: Owner declines a pending execution

- **WHEN** an authenticated owner declines a pending execution
- **THEN** the execution moves to `declined` and no payment is initiated

### Requirement: State transitions are compare-and-swap

Every transition out of `pending` SHALL be a conditional update that also matches
the current status, because there is no database transaction available and
Akahu's payment endpoint documents no idempotency mechanism. With the signature
and its single-use nonce removed, this is the *only* remaining defence against a
double tap initiating two payments.

#### Scenario: Concurrent approvals initiate exactly one payment

- **WHEN** two approval requests for the same execution are processed
  simultaneously, both authenticated as the owner
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
