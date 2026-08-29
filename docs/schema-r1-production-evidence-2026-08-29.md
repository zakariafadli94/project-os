# IMP-SCHEMA001 R1 production evidence — 2026-08-29

## Release identity

R1 merged to `main` as Git commit `30507813372aae5bc805a131b07914caf4f49f73`.

The authoritative GitHub Actions deployment succeeded for that exact commit and verified production identity:

- Worker: `project-os-guard`
- Worker version: `c5eee64e-6310-4086-b0df-b101fd48e27f`
- Worker tag: `git-30507813372aae5bc805a131b07914caf4f49f73`
- health: `status=ok`

The exact release passed 116 test files / 522 tests plus the deployment identity gate. No Cloudflare Workers Builds check existed for the R1 commit.

## R1 writer proof

`wrangler.jsonc` did not set `PROJECT_OS_SCHEMA_WRITER_STAGE` in R1, so the tested runtime default remained `v1_only`.

Post-deployment production durable evidence confirmed no accidental V2 frontier:

- PRJ-0002 current `state.json` remained `schema_version=1.0` at revision 108.
- PRJ-0002 latest canonical commit REV-000108 remained envelope 1.0 with nested ProjectState 1.0.
- PRJ-0003 continued normal real project work after R1 through revision 184; its current `state.json` and REV-000184 canonical commit both remained schema 1.0.
- PRJ-0002 materialization remained projection version 2 at revision 108.
- PRJ-0003 materialization converged to projection version 2 at revision 184.

Therefore R1 demonstrated compatibility software in production without intentionally or accidentally producing a durable Schema V2 object. The pre-SCHEMA rollback set remains valid until the first controlled R2 V2 write.

## R2 gate

R2 may configure `PROJECT_OS_SCHEMA_WRITER_STAGE=core_v2`, but the first durable V2 write must be performed on an isolated production canary project before broad validation. The first V2 write permanently closes the V1-only rollback frontier; no V2-to-V1 down-migration is allowed.
