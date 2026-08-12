## ADDED Requirements

### Requirement: A transfer this service initiated never produces a proposal

Ingestion SHALL identify transactions arising from payments this service
initiated, by the reference it places in the payer's particulars, and MUST NOT
create a pending execution for them.

A user-authored priority-0 `ignore` rule is not sufficient. An allocating rule on
an account that another rule pays into is a payment loop, bounded only by the
consent limits, and it must not depend on the user having written the right rule.
The user-authored `ignore` remains useful for genuinely manual internal transfers.

#### Scenario: A settled internal transfer does not re-trigger

- **WHEN** a transfer initiated by an approved execution settles and returns as a
  credit webhook on the destination account
- **THEN** it is acknowledged and no pending execution is created for it

#### Scenario: The guard does not depend on a user rule

- **WHEN** the user has written no `ignore` rule at all
- **THEN** the returning transfer is still not proposed against

#### Scenario: A manual transfer between the user's own accounts is unaffected

- **WHEN** the user moves money between their own accounts outside this service
- **THEN** the transaction is evaluated normally, and suppressing it remains the
  job of a user-authored `ignore` rule
