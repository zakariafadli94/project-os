# RECTIFY001 — Baseline d'intégrité (lecture seule)

Date d'observation : 2026-09-08. Cette note ne constitue ni une réparation ni une mutation du canonique. Chaque constat ci-dessous provient d'une lecture directe de Dropbox ; toute surface non encore relevée reste `pending`, jamais présumée saine.

## Registre

Le registre canonique `PROJECT_REGISTRY.json` énumère sept projets : PRJ-0001 à PRJ-0007. PRJ-0001, PRJ-0004, PRJ-0005 et PRJ-0006 sont archivés ; PRJ-0002, PRJ-0003 et PRJ-0007 sont actifs. Les archives restent dans le périmètre du futur inventaire complet.

Les sept racines machine correspondantes existent également sous `PROJECT_OS/.project-os/projects/`. Cette vérification ne classe pas encore toutes leurs surfaces : elle prouve seulement qu'aucun projet du registre n'a été omis du périmètre d'audit.

## PRJ-0003 — anomalie réellement observée

| Surface | Observation | État |
| --- | --- | --- |
| Commit 263 | `commits/REV-000263.json` existe ; transaction `TXN-PRJ0003-RESEARCH-COMMROUTE-20260908T075003-H3K8`, base 262, révision 263. | `current` |
| Transaction committed 263 | `transactions/committed/TXN-PRJ0003-RESEARCH-COMMROUTE-20260908T075003-H3K8.json` existe. | `current` |
| Événement 263 | `projects/PRJ-0003/events/EVT-000263.json` est introuvable. | `missing` |
| Reçu autonome 263 | `receipts/TXN-PRJ0003-RESEARCH-COMMROUTE-20260908T075003-H3K8.json` est introuvable. | `missing` |
| Génération 264 | `materializations/REV-000264-PV-0003.json` existe, parent 262, et contient `coalesced_revisions: [263]`. | `intentionally_unchanged` pour la génération 263 |
| Head | `materialization-head.json` pointe sur révision 264 / projection 3. | `current` |

Conclusion : la coalescence de la génération humaine 263 dans 264 est légitime. Elle ne rend pas facultatifs l'événement et le reçu immuables de 263. PRJ-0003 est donc la première cible réelle après le canary synthétique, exclusivement pour ses dérivés mécaniques.

## Protocole de suite

L'inventaire programmatique est strictement read-only et conserve toute erreur de lecture sous la forme `unknown` avec son code. Il doit relever toutes les surfaces du contrat pour les sept projets avant toute réparation. Aucune égalité brute de révision entre un document humain et un commit ne suffit à déclarer une vue périmée : une vue peut être sémantiquement carried-forward.
