## ADDED Requirements

### Requirement: A proposal carries the whole waterfall, not a list of payments

A pending execution SHALL record, in step order, each step's resolved amount and
destination, the remaining balance after each step, every skipped step with its
reason, and the unallocated tail — so that the approval screen shows the same
picture the authoring canvas showed.

#### Scenario: The approval screen reproduces the canvas

- **WHEN** the owner opens a pending execution produced by a three-step rule
- **THEN** the steps, their amounts, the running remainder and the tail are all
  available to display, in order

#### Scenario: A skipped step is visible before the tap

- **WHEN** a step was skipped for insufficient remainder
- **THEN** the proposal shows it as skipped with the amount required and the
  amount available, and the owner can decline on that basis

#### Scenario: The rule that was pre-empted is shown

- **WHEN** a second matching rule's transfer steps were skipped because an
  earlier rule allocated
- **THEN** the proposal names both rules and the approval screen can say which
  one ran

#### Scenario: Amounts remain the ones resolved at proposal time

- **WHEN** the owner approves
- **THEN** the stored per-step amounts execute, unrecomputed, as the existing
  approval requirements already demand

### Requirement: A partly failed waterfall is presented as a sequence

Where some steps succeed and others fail, the outcome SHALL be presented in step
order with each step's own status, because "the GST went out and the tax did not"
is only intelligible as a sequence.

#### Scenario: Partial failure keeps its order

- **WHEN** the first and third steps succeed and the second is declined for
  insufficient funds
- **THEN** each step reports its own outcome in position, and the execution is
  not reported as wholly successful

#### Scenario: Invalidation applies to the whole sequence

- **WHEN** consent is revoked while a multi-step execution is pending
- **THEN** the entire execution is invalidated rather than partly approvable,
  because a half-executed waterfall is worse than one that never ran
