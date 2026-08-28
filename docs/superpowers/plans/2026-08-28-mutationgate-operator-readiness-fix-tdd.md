# TDD evidence — MutationGate operator readiness

RED commit: `2148dad6040b53d324402f362949b7dfeb6c1f57` changes only the workflow contract checker to require an authenticated, non-mutating readiness probe and to forbid the old health-only readiness step. On the unchanged workflow this contract is expected to fail before the implementation commit.
