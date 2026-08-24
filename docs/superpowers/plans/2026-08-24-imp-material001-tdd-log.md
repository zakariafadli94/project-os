# IMP-MATERIAL001 TDD Execution Log

This file records implementation-stage RED/GREEN evidence for the approved Projection Engine plan.

## Task 1 — durable materialization evidence

RED commit: `2c1c9bfece617a64838d2ddf3602d39fb589418d`

Expected RED reason: `test/materialization-repository.spec.ts` imports materialization domain/path/repository APIs that intentionally do not exist yet.
