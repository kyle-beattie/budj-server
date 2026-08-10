## ADDED Requirements

### Requirement: Akahu webhook signatures are verified before any processing

The handler SHALL verify the RSA-SHA256 signature in `X-Akahu-Signature` against
the public key identified by `X-Akahu-Signing-Key` before parsing or acting on
the body. An unverified request MUST NOT cause any write.

#### Scenario: An unsigned webhook is rejected

- **WHEN** a request arrives at the Akahu webhook endpoint with no signature
  header
- **THEN** the response is 401 and nothing is written

#### Scenario: A tampered body is rejected

- **WHEN** a request arrives whose body does not match its signature
- **THEN** the response is 401 and nothing is written

#### Scenario: Signing keys are cached and their identifiers validated

- **WHEN** a webhook references a signing key identifier not held in cache
- **THEN** the key is fetched from Akahu's key endpoint using a validated
  identifier, and the fetch target is not influenced by any other header value

### Requirement: The user is resolved by reverse lookup, never from the payload

The handler SHALL resolve the local user from the Akahu user identifier via the
token table. It MUST NOT accept a user identifier supplied in the request body as
authoritative.

#### Scenario: An unknown Akahu user is discarded

- **WHEN** a verified webhook references an Akahu user with no local token row
- **THEN** the event is acknowledged and discarded without further processing

#### Scenario: A payment event for an unknown user is recorded, not silently dropped

- **WHEN** a verified *payment* event references a user who cannot be resolved,
  as happens after an account is deleted while a payment was still settling
- **THEN** the outcome is recorded against the payment identifier at warning
  level, because this is the one case where money moved and nobody remains to be
  told

### Requirement: The webhook path cannot move money

Code reachable from the webhook handler SHALL be able to create pending
executions and send notifications, and MUST NOT initiate a payment.

#### Scenario: No payment call exists on the ingestion path

- **WHEN** the ingestion module's dependencies are inspected
- **THEN** no code path from the webhook handler reaches payment initiation

### Requirement: Each transaction produces at most one proposal

Ingestion SHALL be idempotent per transaction, enforced by a unique constraint on
the user and Akahu transaction identifier rather than by an application check
alone.

#### Scenario: Redelivery creates nothing new

- **WHEN** the same transaction event is delivered twice
- **THEN** the second delivery is acknowledged and no second pending execution
  exists

#### Scenario: Concurrent deliveries do not both insert

- **WHEN** the same transaction event is delivered twice simultaneously
- **THEN** exactly one pending execution exists and neither request errors to the
  caller

### Requirement: Only settled transactions produce proposals

Ingestion SHALL act on settled transactions only, because a pending transaction
can change amount or disappear.

#### Scenario: A pending transaction is not acted upon

- **WHEN** a transaction event describes a pending transaction
- **THEN** no pending execution is created

#### Scenario: The same transaction is acted upon once settled

- **WHEN** that transaction is later reported as settled
- **THEN** a pending execution is created, and only one

### Requirement: Historic transaction replay does not generate proposals

The handler SHALL ignore the initial historic backfill that follows a new
connection, so that connecting a bank cannot produce months of proposals at once.

#### Scenario: Initial backfill is discarded

- **WHEN** an `INITIAL_UPDATE` event arrives after a new connection
- **THEN** no pending executions are created

#### Scenario: Ongoing updates are processed

- **WHEN** a `DEFAULT_UPDATE` event arrives
- **THEN** its settled transactions are evaluated normally

### Requirement: A reconciliation sweep recovers missed deliveries

A scheduled sweep SHALL identify settled transactions with no corresponding
execution row and process them, because Akahu retries for approximately a day and
may then disable the endpoint.

#### Scenario: A missed transaction is recovered

- **WHEN** a transaction was never delivered by webhook and the sweep runs
- **THEN** a pending execution is created for it

#### Scenario: The sweep does not duplicate delivered work

- **WHEN** the sweep encounters a transaction that already has an execution row
- **THEN** it is skipped and nothing is written

### Requirement: Token and connection events invalidate dependent state

A `TOKEN` deletion, connection removal, or account deletion event SHALL mark the
affected accounts disconnected and invalidate their pending executions.

#### Scenario: Token revocation invalidates pending proposals

- **WHEN** a verified token deletion event arrives for a user with pending
  executions
- **THEN** every pending execution for that user moves to `invalidated` and none
  remains approvable

### Requirement: A user whose connection dies is told, not left paying for silence

The server SHALL notify the user when access is lost outside this app — a revoked
token, a cancelled webhook, a removed connection — because they are subscribed
and their rules have silently stopped working.

#### Scenario: Revocation at Akahu notifies the user

- **WHEN** a user revokes this application from their Akahu account
- **THEN** a push notification is sent and the app surfaces the connection as
  needing reauthorisation

#### Scenario: Notification does not depend on a stored email address

- **WHEN** the user must be told and no request context exists to read claims
  from
- **THEN** push is used as the primary channel, and any email address is resolved
  through the admin API rather than from a stored column

#### Scenario: A dead connection does not silently keep billing

- **WHEN** a connection has been disconnected and not restored within the
  configured window
- **THEN** the subscription is paused rather than left charging for a service
  that cannot run
