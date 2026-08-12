## MODIFIED Requirements

### Requirement: Rule effects replace transaction annotations

Rules SHALL express `notify`, `transfer` and `ignore` effects only. The
`set_category`, `add_tags`, `set_note` and `set_account` actions MUST be removed
outright, having annotated a transaction row this product never stores.

Effects are an **ordered list of steps** rather than an unordered set. A
`transfer` step carries a destination account and an amount in one of the four
closed forms — `fixed`, `percent` with an explicit base, `fraction`, or
`remainder`. A bare percentage with no stated base MUST be rejected.

#### Scenario: Removed actions are rejected

- **WHEN** a rule is created with an action of type `set_category`, `add_tags`,
  `set_note` or `set_account`
- **THEN** the request is rejected with 400

#### Scenario: A transfer step names a destination and an amount form

- **WHEN** a rule is created with a `transfer` step
- **THEN** it carries a destination account and an amount that is `fixed`,
  `percent` with a base of `original` or `remaining`, `fraction`, or `remainder`

#### Scenario: A percentage without a base is refused

- **WHEN** a rule is created with a `percent` amount and no base
- **THEN** the request is rejected with 400

#### Scenario: An ignore effect suppresses the proposal entirely

- **WHEN** a matching rule carries an `ignore` effect
- **THEN** no pending execution is created for that transaction and no
  notification is sent

### Requirement: A rule is checked against its consent limits at creation

Rule creation SHALL compare the largest transfer the rule could produce against
the consent's single-payment limit and warn when it could exceed it.

Because a rule now produces several payments per trigger, creation SHALL bound
**both** limits from the step list: the single-payment limit against the largest
amount any one step could resolve to, and the periodic limit against the sum the
sequence could produce. A step taking a percentage of the remainder is bounded by
the trigger amount, so a bound always exists even when it is loose.

#### Scenario: A fixed transfer above the single limit warns

- **WHEN** a rule transferring a fixed `1000.00` is created against a consent
  whose single limit is `500.00`
- **THEN** the response includes a warning identifying the limit that would be
  breached

#### Scenario: A sequence is bounded step-wise and in total

- **WHEN** a rule with four transfer steps is created
- **THEN** the largest single step is checked against the single-payment limit
  and the sequence total against the periodic limit

#### Scenario: A percentage step is bounded by the trigger amount

- **WHEN** a step takes a percentage of the remainder and no fixed ceiling exists
- **THEN** the bound used is the trigger amount, and the warning says so rather
  than claiming certainty it does not have
