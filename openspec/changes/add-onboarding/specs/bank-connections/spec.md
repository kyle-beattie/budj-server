## ADDED Requirements

### Requirement: The Akahu authorisation flow is server-mediated

The server SHALL construct the Akahu authorisation URL, receive the redirect, and
exchange the authorisation code. The iOS app SHALL never receive an Akahu token
and SHALL never call Akahu directly.

#### Scenario: Authorisation is started

- **WHEN** a subscribed user requests a bank connection
- **THEN** the response contains an Akahu authorisation URL carrying a
  single-use, expiring `state` value bound to that user

#### Scenario: Code exchange happens on the server

- **WHEN** Akahu redirects back with an authorisation code and a valid `state`
- **THEN** the server exchanges the code for a user access token
- **AND** no response to the client contains the token

#### Scenario: An unrecognised or reused state is refused

- **WHEN** the redirect carries a `state` that is unknown, expired, or already
  consumed
- **THEN** the exchange is refused and no token is stored

### Requirement: The requested scopes are fixed and exclude payments

The authorisation request SHALL ask for exactly `accounts:basic`,
`accounts:owner`, `transactions:credits`, `transactions:debits` and `user:basic`.
It SHALL NOT request `payments` or `accounts:balance`.

#### Scenario: Scope set is exact

- **WHEN** an authorisation URL is generated
- **THEN** its scope parameter contains those five scopes and no others

### Requirement: The Akahu token is unreadable by user-scoped clients

The token SHALL be stored encrypted, in a table with row level security enabled
and no policies, so that the anon and user clients cannot read it under any
circumstances. Only the service-role client may read it, through a single
accessor that returns a credential and never a row.

#### Scenario: A user cannot read their own token row

- **WHEN** a client holding a valid user JWT selects from the token table
- **THEN** zero rows are returned

#### Scenario: Stored token is not plaintext

- **WHEN** the token row is inspected directly in the database
- **THEN** the token value is ciphertext carrying a key-version prefix

#### Scenario: Accessor is keyed by user

- **WHEN** the server needs a token to call Akahu on behalf of a request
- **THEN** it resolves the token from the `userId` on the verified JWT, never
  from any value supplied in the request

### Requirement: A user may connect multiple banks

Connecting an additional institution SHALL re-enter the same authorisation flow
and add a connection under the user's existing Akahu identity, subject to the
plan's connection limit.

#### Scenario: Second connection is added

- **WHEN** a user with one existing connection completes the flow for a second
  institution
- **THEN** both connections are listed and the accounts of both appear in the
  projection

#### Scenario: Connection limit is enforced

- **WHEN** a user on a plan permitting two connections starts a third
- **THEN** the request is rejected with the error code `plan_limit_exceeded`

### Requirement: Accounts are a read-only projection of Akahu

`public.accounts` SHALL hold only `akahu_account_id`, `connection_id`, `name`,
`type`, `payment_eligible` and lifecycle timestamps. It SHALL NOT hold a balance
or an account number. The API SHALL expose no route that creates, updates or
deletes an account.

#### Scenario: Write routes no longer exist

- **WHEN** an authenticated user sends `POST`, `PATCH` or `DELETE` to
  `/api/accounts` or `/api/accounts/:id`
- **THEN** the response is 404 because no such route is registered

#### Scenario: Projection carries no financial data

- **WHEN** an account is returned by the API
- **THEN** the payload contains no balance and no account number

#### Scenario: Duplicate names from Akahu are permitted

- **WHEN** Akahu reports two accounts for the same user with identical names
- **THEN** both are stored, distinguished by their Akahu account ids

### Requirement: Payment capability is recorded in both directions at sync time

Each account SHALL record separately whether it can pay out and whether it can
receive a payment, so that a rule editor can restrict payers and destinations
without calling Akahu. Akahu governs the two with different mechanisms.

#### Scenario: Paying out follows the Akahu attribute

- **WHEN** the projection syncs an account whose attributes include
  `PAYMENT_FROM`
- **THEN** that account is stored as capable of being a payer

#### Scenario: A credit card cannot receive a payment

- **WHEN** the projection syncs an account that is not a BECS-identifiable New
  Zealand bank account
- **THEN** that account is stored as not capable of receiving a payment

### Requirement: An unknown account type degrades rather than fails

An unrecognised Akahu account type SHALL map to a fallback value and MUST NOT
abort the sync. Akahu's type vocabulary differs from the local enum and may grow
without notice.

#### Scenario: Unmapped type is tolerated

- **WHEN** Akahu returns an account whose type has no local mapping
- **THEN** the account is stored with the fallback type and the sync completes
  for every other account

### Requirement: Disconnection is recorded, not deleted

Account rows SHALL be marked disconnected and retained, never deleted, when a
connection is removed or its accounts stop being reported — so that anything
referencing them can still explain itself.

#### Scenario: Removed connection marks its accounts

- **WHEN** a user revokes a connection
- **THEN** every account belonging to that connection has `disconnected_at` set
- **AND** the rows are not deleted
