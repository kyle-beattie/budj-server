## ADDED Requirements

### Requirement: A rule is an ordered sequence of steps

A rule's effects SHALL be an ordered list of steps executed in written order.
Order MUST be the position in the list and nothing else — no per-step priority,
sort key or tie-break — so that the order displayed is provably the order
executed.

#### Scenario: Steps execute in written order

- **WHEN** a rule carries a GST step followed by a tax step followed by a savings
  step
- **THEN** they are evaluated in that order, and the second sees what the first
  left

#### Scenario: Reordering changes the outcome and says so

- **WHEN** a percentage step and a fixed step are swapped
- **THEN** the resolved amounts change accordingly, because a percentage of the
  remainder depends on what preceded it

#### Scenario: Rules still order among themselves unchanged

- **WHEN** several rules match one transaction
- **THEN** they are considered by `priority` then `createdAt` as before, and
  `stopProcessing` behaves as before

### Requirement: Steps consume a running remainder while the trigger amount stays immutable

Evaluation SHALL carry an `allocated` and a `remaining` register in integer
cents, initialised to zero and to the trigger amount. A `transfer` step
decrements `remaining` by its resolved amount. The trigger transaction's `amount`
MUST NOT be overwritten.

#### Scenario: The remainder is the trigger amount minus everything allocated

- **WHEN** a `1150.00` credit has `150.00` allocated by the first step
- **THEN** `remaining` is `1000.00`, arrived at by subtraction

#### Scenario: The original amount remains matchable after a step runs

- **WHEN** a rule condition tests `amount gte 1150.00` and an earlier step has
  already allocated `150.00`
- **THEN** the condition still evaluates against `1150.00`

#### Scenario: Non-allocating steps leave the registers untouched

- **WHEN** a `notify` step sits between two `transfer` steps
- **THEN** `remaining` is unchanged by it

### Requirement: A step's amount is one of four closed forms

A `transfer` step's amount SHALL be `fixed`, `percent`, `fraction` or
`remainder`. There MUST NOT be a user-supplied expression language.

#### Scenario: A fraction resolves GST exactly

- **WHEN** a step takes `3/23` of an original amount of `1150.00`
- **THEN** the resolved amount is exactly `150.00`

#### Scenario: A percentage names its base

- **WHEN** a `percent` step is created without a base of `original` or
  `remaining`
- **THEN** the request is rejected, because a bare percentage is ambiguous once
  remainders exist

#### Scenario: The two bases give different answers

- **WHEN** a 33% step follows a step that reduced `1150.00` to `1000.00`
- **THEN** `of: remaining` resolves to `330.00` and `of: original` resolves to
  `379.50`

#### Scenario: A remainder step takes exactly what is left

- **WHEN** a `remainder` step runs with `1000.00` remaining
- **THEN** it resolves to `1000.00` and `remaining` becomes zero

#### Scenario: A remainder of nothing is not an error

- **WHEN** a `remainder` step runs with nothing left
- **THEN** it resolves to zero, produces no payment, and the sequence is not
  treated as failed

### Requirement: Rounding is down, per step, with the dust falling to the tail

Each step's resolved amount SHALL round down to the cent. Cents lost to rounding
MUST accumulate in `remaining` and land in the unallocated tail, or in a final
`remainder` step where one exists. Dust MUST NOT be redistributed across steps.

#### Scenario: A sequence conserves exactly

- **WHEN** `1000.00` is divided by `3/23`, then 33% of remaining, then a fixed
  `200.00`
- **THEN** the steps resolve to `130.43`, `286.95` and `200.00`, the tail is
  `382.62`, and the four figures sum to exactly `1000.00`

#### Scenario: Dust is not spread to make figures tidy

- **WHEN** rounding leaves a cent unallocated
- **THEN** it remains in the tail rather than being added to any step, because
  the amount displayed is the amount that moves

### Requirement: A step that does not fit is skipped, never shrunk

A `transfer` step whose resolved amount exceeds `remaining` SHALL be skipped and
recorded with its reason. It MUST NOT be reduced to fit.

#### Scenario: A fixed step larger than the remainder is skipped

- **WHEN** a fixed `200.00` step runs with `150.00` remaining
- **THEN** the step is skipped, no payment is initiated for it, and the reason
  records the amount required and the amount available

#### Scenario: A skipped step does not stop the sequence

- **WHEN** a step is skipped and a further step fits
- **THEN** the later step still runs against the unchanged remainder

#### Scenario: Percentages of the original can fail to fit

- **WHEN** two steps each take 60% of the original amount
- **THEN** the first resolves and the second is skipped

### Requirement: No sequence can allocate more than the transaction brought in

The sum of a proposal's resolved step amounts SHALL never exceed the trigger
amount. This holds by construction and MUST be asserted as a property, not left
to the bank to reject, because a transfer debits the account rather than the
transaction and an over-allocation would quietly consume the account's existing
balance.

#### Scenario: Allocations plus tail equal the trigger amount

- **WHEN** any sequence of steps is evaluated against any trigger amount
- **THEN** the resolved amounts plus the unallocated tail equal the trigger
  amount exactly

#### Scenario: An over-allocating sequence cannot be constructed

- **WHEN** a rule is written whose steps would together demand more than arrives
- **THEN** the steps that do not fit are skipped, and the proposal's total never
  exceeds the trigger amount

### Requirement: The first matching rule with transfer steps owns the transaction

Where several rules match one transaction, allocation SHALL be performed by the
first rule in priority order that carries transfer steps. Transfer steps in later
matching rules MUST be skipped and recorded. Non-allocating effects continue to
fold across all matching rules.

#### Scenario: A second allocating rule does not also run

- **WHEN** two enabled rules with transfer steps match one transaction
- **THEN** only the first in priority order allocates

#### Scenario: The skipped rule is recorded, not silent

- **WHEN** a rule's transfer steps are skipped because another rule claimed the
  transaction
- **THEN** the proposal records which rule allocated and which was skipped, and
  the approval screen shows it

#### Scenario: Notifications and ignore still fold across rules

- **WHEN** a priority-0 rule carries `ignore` and a later rule carries transfer
  steps
- **THEN** no proposal is created at all, as before

### Requirement: The unallocated tail is a stated outcome

Evaluation SHALL report the amount left unallocated. It MUST NOT be left implicit.

#### Scenario: The tail is reported with the steps

- **WHEN** a sequence allocates `680.00` of a `1150.00` credit
- **THEN** the result states `470.00` remains in the triggering account
