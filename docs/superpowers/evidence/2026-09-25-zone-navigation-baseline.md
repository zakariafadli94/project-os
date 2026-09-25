# Zone navigation baseline — PRJ-0003

Read-only observation on 2026-09-25. Not a mutation receipt or production repair claim. Fresh metadata came from Dropbox; body hashes below came from the synced local files and must be reverified by the governed server before adoption.

Root: `/Applications/project-os/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-0003-agence-growth-externalise`.

| Zone/index | Object ID | Revision | Bytes | Modified UTC | Local body SHA-256 |
|---|---|---|---:|---|---|
| WORKING/00-CURRENT-INDEX.md | id:VI4Cv070g6AAAAAAAAA9TQ | 0165b702c3bbdff000000037a835733 | 1685 | 2026-09-14T11:59:56Z | 193ebfe3b77a0d7e888c30e8cea91016113bb36fd98f0b58cc6911950e7a0ce6 |
| REVIEW/00-CURRENT-INDEX.md | id:VI4Cv070g6AAAAAAAAA9Tg | 0165b702c5b9a66000000037a835733 | 1087 | 2026-09-14T11:59:58Z | 3c65f7790e5ceb69af60d68a94491b85c9f04ae8b2bdc83e2a8372ae454a45b5 |
| DELIVERABLES/00-CURRENT-INDEX.md | id:VI4Cv070g6AAAAAAAAA9Qw | 0165b702c5b9a63000000037a835733 | 949 | 2026-09-14T11:59:58Z | ba188bb39b1670a9027d9c6e93868997863d846d6e41f6a8d7f107532eb275f3 |

All three still describe revision281 and the former D1 gate; preserve this prose historically, not as current business direction. Navigation should derive canonical active references and explicitly distinguish stage presence from Founder acceptance.

A local synchronized scan of PRJ3 `documents/heads` found no reference to either `00-CURRENT-INDEX.md` or `00-CURRENT.md`. This is a local observation, not proof of absence in the live provider; adoption must still check canonical bindings and the exact current bytes on the server.

Confirmed integration gaps:

- `ManagedDocumentChangeCoordinator.bootstrapCandidate` and stable work-product reconciliation can adopt these basenames as ordinary business documents. Reserve both supported zone-index names before either path.
- `DocumentLedgerRepository.writeHead` is the shared invalidation seam for ordinary writes, working supersession/fork, external reconciliation, bootstrap and managed inline artifacts.
- Package replacement and staged artifact references need separate invalidation hooks.
- Working-head requests currently use `serializeRecovery`, whereas base document/reconcile routes use `serialize`; source generation alone does not protect an in-flight asynchronous writer. Coordinate mutation serialization or persist in-flight markers.
- Managed-document replay can return a stored version before regenerating navigation. Receipt settlement/recovery must perform navigation completion checks too.

PRJ3 publications are owned by task `01a0814e-301e-7dc3-8b4c-029d81c56d24`. Do not replay DOCREQ015, Sujet0 or unknown publication requests from this index lot. Coordinate a real authorized document change for post-deployment automatic-refresh reception.
