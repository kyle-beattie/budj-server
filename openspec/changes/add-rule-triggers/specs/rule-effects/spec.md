## ADDED Requirements

### Requirement: Rule effects replace transaction annotations

Rules SHALL express `notify`, `transfer` and `ignore` effects only. The
`set_category`, `add_tags`, `set_note` and `set_account` actions MUST be removed
outright, having annotated a transaction row this product never stores.

#### Scenario: Removed actions are rejected

- **WHEN** a rule is created with an action of type `set_category`, `add_tags`,
  `set_note` or `set_account`
- **THEN** the request is rejected with 400

#### Scenario: A transfer effect names a destination and an amount

- **WHEN** a rule is created with a `transfer` effect
- **THEN** it carries a destination account and an amount that is either a fixed
  decimal string or a percentage of the triggering transaction

#### Scenario: A percentage states what it is a percentage of

- **WHEN** a `transfer` effect uses a percentage
- **THEN** the stored effect names its base explicitly as `original`, rather than
  leaving it implied, so that a base meaning anything else cannot later be
  retrofitted onto rules already written

#### Scenario: An ignore effect suppresses the proposal entirely

- **WHEN** a matching rule carries an `ignore` effect
- **THEN** no pending execution is created for that transaction and no
  notification is sent

### Requirement: Direction is a first-class condition field

Conditions SHALL support a `direction` field with values `credit` and `debit`.
Rules MUST NOT be required to infer direction from the sign of an amount.

#### Scenario: A rule matches money received

- **WHEN** a rule specifies `direction equals credit` and a credit transaction
  arrives
- **THEN** the rule matches

#### Scenario: A credit rule ignores a debit

- **WHEN** the same rule is evaluated against a debit transaction
- **THEN** the rule does not match, regardless of the amount's sign

### Requirement: Money is computed in integer cents and never as a float

Amounts SHALL be parsed from decimal strings into integer cents and computed in
`bigint`. No amount MUST ever be represented as a JavaScript `number`.

#### Scenario: Amount comparison is exact at the boundary

- **WHEN** a condition tests `amount gt 1000.00` against a transaction of exactly
  `1000.00`
- **THEN** the condition is false, with no floating-point tolerance involved

#### Scenario: Percentage transfers round down

- **WHEN** a rule transfers 7.5% of a credit of `1033.33`
- **THEN** the computed amount is `77.49`, rounded down to the cent

#### Scenario: The transaction candidate carries a decimal string

- **WHEN** the evaluation schema is inspected
- **THEN** `amount` is a decimal string matching the money format used by
  accounts, not a numeric type

### Requirement: Account identifiers are opaque strings

Both conditions and effects SHALL type account identifiers as opaque strings.
They MUST NOT be validated as UUIDs, because Akahu issues prefixed identifiers.

#### Scenario: An Akahu account id is accepted

- **WHEN** a rule is created referencing `acc_1a2b3c4d5e6f`
- **THEN** the rule is accepted

### Requirement: A rule referencing an account the user does not own is refused

Rule creation SHALL verify every referenced account against the local projection
under the caller's own client, so that row level security and the repository
filter both apply.

#### Scenario: A stranger's account is refused

- **WHEN** a user creates a rule referencing an account id that is not in their
  projection
- **THEN** the request is rejected with 404 and the rule is not stored

### Requirement: A rule that cannot yet fire declares itself

A rule requiring payment consent that is not yet in place SHALL be stored with
status `pending_consent` and MUST NOT fire. Silence is not an acceptable
representation of "not authorised".

#### Scenario: A transfer rule without consent is inert

- **WHEN** a transfer rule is created for a payer account with no consent
  covering the destination
- **THEN** the rule is stored with status `pending_consent`
- **AND** a matching transaction produces no proposal

#### Scenario: Consent activates the rule

- **WHEN** consent covering that payer and destination is subsequently granted
- **THEN** the rule's status becomes `active` and it fires on the next match

### Requirement: Regular expression conditions are bounded

The `matches` operator SHALL bound the patterns it accepts and the time it spends
evaluating them, because this change causes user-supplied patterns to run
automatically on a single-threaded event loop.

#### Scenario: An oversized pattern is refused at write time

- **WHEN** a rule is created with a regular expression exceeding the configured
  length limit
- **THEN** the request is rejected with 400

#### Scenario: A catastrophic pattern does not stall the service

- **WHEN** a stored pattern exhibits catastrophic backtracking during evaluation
- **THEN** evaluation of that condition is abandoned within the time budget, the
  condition is treated as not matching, and other rules continue to evaluate

### Requirement: A rule is checked against its consent limits at creation

Rule creation SHALL compare the largest transfer the rule could produce against
the consent's single-payment limit and warn when it could exceed it.

#### Scenario: A fixed transfer above the single limit warns

- **WHEN** a rule transferring a fixed `1000.00` is created against a consent
  whose single limit is `500.00`
- **THEN** the response includes a warning identifying the limit that would be
  breached
