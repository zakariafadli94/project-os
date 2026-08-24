# IMP-MATERIAL001 TDD Execution Log

This file records implementation-stage RED/GREEN evidence for the approved Projection Engine plan.

## Task 1 — durable materialization evidence

RED commit: `2c1c9bfece617a64838d2ddf3602d39fb589418d`

Expected RED reason: `test/materialization-repository.spec.ts` imports materialization domain/path/repository APIs that intentionally do not exist yet.

GREEN candidate head before CI trigger: `fe9f8bebb17bc5e5b56fc7a93a8f8ec08a4e3a43`.

Implemented: validated materialization contracts, deterministic machine paths, immutable completed-generation records, validated head publication, record listing, and canonical-derivatives materialization without human-view writes.
