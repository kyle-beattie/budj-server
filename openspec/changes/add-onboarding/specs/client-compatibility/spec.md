## ADDED Requirements

### Requirement: The API contract is published as a versioned artifact

The server SHALL publish its OpenAPI document and its conformance vectors as a
tagged release artifact, because the client is built in a separate repository and
cannot be verified against source it does not have.

#### Scenario: The contract is generated, not maintained by hand

- **WHEN** the contract artifact is produced
- **THEN** the OpenAPI document is generated from the Zod schemas that serve the
  routes, not written separately

#### Scenario: Money vectors accompany the document

- **WHEN** the contract artifact is inspected
- **THEN** it contains vectors mapping decimal money strings to integer cents,
  including the rounding cases, so a client cannot silently parse money as a
  floating-point number

#### Scenario: The server verifies its own vectors

- **WHEN** the test suite runs
- **THEN** the published vectors are asserted against the server's own
  implementation, so drift fails here rather than in the client

### Requirement: Every request identifies the client build

Clients SHALL send a build identifier with every request. A request that omits it
MUST be treated as an unsupported client rather than as an exempt one.

#### Scenario: A missing build identifier is not a bypass

- **WHEN** a request arrives with no client build identifier
- **THEN** it is treated as unsupported, because a client that cannot be
  identified cannot be gated

#### Scenario: Server-to-server callers are unaffected

- **WHEN** an App Store notification or Akahu webhook arrives without a client
  build identifier
- **THEN** it is processed normally, since it is not a client request

### Requirement: A minimum supported build is enforced by the server

The server SHALL refuse requests from clients below a configured minimum build,
with a response the app can recognise as "you must update". Configuration MUST be
environment-driven so it can change during an incident without a migration.

#### Scenario: An outdated client is refused with a distinguishable error

- **WHEN** a request arrives from a build below the configured minimum
- **THEN** the response carries an error code the app can act on to prompt an
  update, distinct from an authentication or subscription failure

#### Scenario: A supported client is unaffected

- **WHEN** a request arrives from a build at or above the minimum
- **THEN** it proceeds normally

### Requirement: Money-moving operations can be disabled independently of the client version

The server SHALL be able to refuse money-moving operations for a range of client
builds while leaving every other operation available, so that a defect in one
client's amount handling does not require disabling the whole application.

#### Scenario: A suspect build loses only the dangerous operations

- **WHEN** a build is listed as blocked for money-moving operations
- **THEN** requests from it that would initiate a payment are refused, and its
  other requests succeed

#### Scenario: The block is independent of the minimum supported build

- **WHEN** a build is above the minimum but listed as blocked for money movement
- **THEN** it is refused only for those operations
