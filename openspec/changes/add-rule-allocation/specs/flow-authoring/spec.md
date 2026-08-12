## ADDED Requirements

### Requirement: A draft rule can be resolved against a hypothetical amount

`POST /api/rules/evaluate` SHALL accept an unsaved rule body and a trigger amount
and return each step's resolved amount, the remaining balance after each step,
the unallocated tail, and any step that would be skipped with its reason.

The user MUST NOT have to compute any of these figures themselves. This is the
problem the capability exists to solve.

#### Scenario: A draft resolves before it is stored

- **WHEN** an unsaved rule with three steps is previewed against `1150.00`
- **THEN** the response gives `150.00`, `330.00` and `200.00`, a running
  remainder of `1000.00`, `670.00` and `470.00`, and a tail of `470.00`

#### Scenario: The preview amount is editable

- **WHEN** the same draft is previewed against `500.00`
- **THEN** the figures resolve for `500.00`, so the author can see what a smaller
  month does before saving

#### Scenario: A step that would be skipped is shown as skipped

- **WHEN** a draft has two steps each taking 60% of the original
- **THEN** the second is returned as skipped, with the amount it needed and the
  amount available

#### Scenario: Preview requires authentication and the caller's own accounts

- **WHEN** a draft references an account the caller does not own
- **THEN** the request is refused, exactly as rule creation would refuse it

### Requirement: Preview and execution come from one evaluator

The figures returned by preview SHALL be produced by the same pure evaluator that
produces a pending execution. A second implementation of allocation arithmetic
MUST NOT exist, on the server or in a client.

#### Scenario: Preview equals proposal for the same inputs

- **WHEN** a rule is previewed against an amount and then a real transaction of
  that amount triggers it
- **THEN** the resolved step amounts, skips and tail are identical

#### Scenario: The equivalence is asserted as a property

- **WHEN** the test suite runs
- **THEN** a property test compares preview output against proposal output across
  generated sequences and amounts

### Requirement: The preview amount is never defaulted from transaction history

The preview SHALL default its amount from the rule's own amount condition where
one exists, and otherwise require the author to supply one. It MUST NOT be
defaulted from any past transaction, because no transaction amount is stored.

#### Scenario: The amount condition seeds the preview

- **WHEN** a draft rule contains `amount gte 1150.00` and no preview amount is
  supplied
- **THEN** `1150.00` is used

#### Scenario: No history is consulted

- **WHEN** a draft rule has no amount condition
- **THEN** the author is asked for a figure, and no stored transaction is read,
  because none exists

### Requirement: A rule that another rule could pre-empt warns at authoring time

Rule creation and preview SHALL warn when another enabled rule carrying transfer
steps could also match the same transaction, because only the first will
allocate.

#### Scenario: An overlapping allocating rule is flagged

- **WHEN** a rule is saved whose conditions overlap an existing enabled rule that
  also transfers
- **THEN** the response warns that one of them will not allocate, and identifies
  which rule takes precedence
