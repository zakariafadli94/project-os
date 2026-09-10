# Post-commit Convergence Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Faire converger automatiquement chaque couche dérivée d’un commit durable, y compris après perte de handoff ou de SQLite, et empêcher une mutation fondée sur un contexte périmé.

**Architecture:** Le commit record reste l’unique autorité métier. MaterializationGuard conserve la sérialisation et reprend des obligations indépendantes depuis un journal technique externe, avec tranches bornées, fencing provider et preuves par couche ; le cron assure une découverte équitable indépendante de l’inbox. ProjectGuard vérifie un contexte canonique signé avant tout nouvel effet et conserve le replay exact.

**Tech Stack:** TypeScript, Zod 4, Cloudflare Workers et Durable Objects SQLite existants, ports provider et adaptateur Dropbox existants, Web Crypto, Vitest avec `@cloudflare/vitest-pool-workers` ; aucune dépendance nouvelle prévue.

**Spec:** [Spécification v1.1 récupérée et amendée, en attente de revue](../specs/2026-09-07-post-commit-convergence-reliability-design.md), origine `97684d3e164d690bd7e54cf1aa50be41cab6cf10`, base de reprise runtime `a7b927499265c625ab3f5827f34d94235ea19d0b`.

## Amendement d’exécution — reprise du plan RECTIFY

Le présent document demeure le plan technique détaillé de la convergence post-commit et ne doit pas être remplacé par un correctif ponctuel PRJ-0003. Il s’exécute sous le grand plan canonique PRJ-0002 révision 169 : intégrité/audit dans RECTIFY001, runtime de convergence et gouvernance dans RECTIFY002, continuité/Project Pulse dans RECTIFY003, rattrapage global et preuve dans RECTIFY004. RECTIFY005 reste hors périmètre jusqu’à clôture de la rectification.

Le code de `main` contient désormais une implémentation partielle issue de certaines étapes ci-dessous. Toutes les cases restent volontairement non cochées : la présence du code et le passage de tests unitaires étroits ne prouvent pas les invariants. Chaque tâche commence par comparer son oracle à l’état actuel; un test qui passe sans couvrir l’oracle doit être renforcé jusqu’au rouge comportemental attendu avant correction.

### Tâche 0 — Baseline globale et première cible réelle

**Files:** Create `src/convergence/integrity-contract.ts`, `src/convergence/inventory.ts`, `test/convergence-inventory.spec.ts`. Create an execution evidence report under `docs/superpowers/evidence/` only from verified observations. Modify no business schema and no canonical Dropbox file.

- [ ] Définir pour chaque surface — commit, transaction committed, event, receipt, state, manifest, génération/head, PROJECT, PLAN, ROADMAP, STATE, HANDOFF, artifacts, managed-document heads, index/search watermarks et checkpoints — ses identités, obligation de mise à jour, règle de carry-forward, preuve de fraîcheur et états `current`, `intentionally_unchanged`, `pending`, `unknown`, `blocked`.
- [ ] Construire un inventaire paginé et borné qui couvre PRJ-0001 à PRJ-0007, archives comprises; une erreur de lecture/extraction reste une ligne `unknown` avec chemin et code, jamais une disparition du rapport.
- [ ] Reproduire synthétiquement puis détecter l’anomalie PRJ-0003 263–264 : commit/transaction 263 présents, génération 263 légitimement coalescée dans 264, event/receipt 263 illégitimement absents.
- [ ] Vérifier que le rapport distingue un PLAN sémantiquement carried-forward d’une vue réellement stale; aucune égalité globale de numéros ne sert d’oracle unique.
- [ ] Produire un mode strictement read-only par défaut et un plan de réparation séparé; aucune réparation ne démarre depuis l’inventaire seul.
- [ ] Gate : rapport déterministe relisible, toutes les surfaces classées, aucune écriture provider, aucun projet omis, PRJ-0003 identifié comme première cible réelle après canary synthétique.

### Ordre de reprise des lots existants

1. Exécuter la tâche 0 et compléter les tests rouges manquants des tâches 1–3.
2. Reprendre les tâches 4–10 pour achever le moteur et le fleet scheduler; ne jamais activer le `ConvergenceEngine` partiel actuel.
3. Exécuter les tâches 11–14 pour la fraîcheur d’admission, l’observabilité, l’administration bornée et le rollout compatible.
4. Exécuter les tâches 15–16 sur canary synthétique, puis obtenir les gates de production.
5. Activer PRJ-0003 comme premier projet réel, réparer uniquement ses dérivés mécaniques et prouver l’absence de révision métier nouvelle.
6. Étendre audit et réparation aux autres projets, puis enchaîner les livrables SOP/runtime, continuité et Project Pulse prévus par RECTIFY002–RECTIFY004.

## Global Constraints

Les phrases suivantes reproduisent les contraintes de la spec ; les nombres sont des exigences à qualifier, pas des performances acquises.

- « La solution retenue n’ajoute ni second commit métier, ni broker, ni nouveau Durable Object. »
- « Le commit log est la source exhaustive du travail ; les journaux techniques accélèrent et expliquent l’exécution, sans remplacer sa vérité. »
- « Chaque commit conserve son événement et son receipt autonomes. »
- « State et manifest courants peuvent sauter des révisions intermédiaires et convergent vers la dernière révision validée. »
- « Une cible nouvelle ne réinitialise pas l’âge de la divergence ancienne. »
- « ProjectGuard ne rend aucun Markdown et ne réintroduit pas d’alarme de projection. »
- « Des bytes externes inexpliqués ne sont pas écrasés. »
- « Aucune atomicité de visibilité entre deux fichiers Dropbox n’est promise. »
- « Une tranche dure au plus 10 secondes et consomme au plus 32 appels provider, retries transport inclus ; le premier plafond atteint déclenche une continuation durable et un réveil à +1 seconde. »
- « La concurrence provider demeure configurable de 1 à 4 ; la concurrence fleet reste à 4. »
- « Le cron conserve son intervalle de cinq minutes, mais lance inbox, convergence et recherche comme jobs indépendants, chacun avec timeout, résultat et continuation. »
- « Les générations snapshot/delta restent bornées à 128 records. »
- « Par couche et épisode : une tentative initiale puis au plus **cinq retries rapides**, espacés de 2, 4, 8, 16 et 32 secondes, avec jitter déterministe de 0 à 20 %. »
- « Après la sixième tentative échouée : état `exhausted`, arrêt du burst, création d’une alerte dédupliquée, sonde de dépendance/progression toutes les cinq minutes. »
- « Pas de suppression automatique de ces preuves dans ce périmètre. »
- « Aucun payload métier, Markdown, jeton, secret ou URL signée dans les logs. »
- « Aucun test réel ne doit injecter une panne dans PRJ-0003. »
- « Conserver le contexte strict une fois qu’il protège le projet. »
- « Ne jamais baisser la projection/version ou restaurer un snapshot historique pour revenir en arrière. »

Valeurs complémentaires : projection active **3**, profondeur delta maximale **127** ; contexte valable **300 000 ms** ; visite fleet **≤300 s** ; audit historique complet **≤24 h** ; notification **≤60 s** ; watchdog après **2 cycles / 10 min**. Enveloppe : **10 projets**, **5 commits/minute/projet**, **200 outputs/projet**, **20 outputs modifiés** et **1 MiB/commit**. SLI sur **30 jours** : machine **99,9 % ≤120 s**, humain **99 % ≤120 s et 99,9 % ≤600 s**. Aucune exclusion cachée des pannes provider dans les SLIs.

---

## Mandat, ordre des lots et gates d’intégration

Ce document était le seul fichier modifié par la mission de planification initiale. Le mandat de reprise autorise son exécution après revue de la spécification v1.1; aucune case cochée ne constitue à elle seule une preuve ou un gate de canary, déploiement, fusion ou mutation canonique. Ne pas refaire le design. Le système forme une chaîne de sûreté commune : un plan unique, découpé en lots, évite que journaux, fencing et admission divergent entre sous-projets.

| Lot | Tâches | Livrable révisable / gate de sortie |
|---|---|---|
| A — Preuves | 1–3 | Harness vérifié, contrats et journal v1 lisibles sans activation writer |
| B — Effets machine | 4–6 | Budget au niveau HTTP, CAS/fencing et réparation indépendante des quatre dérivés |
| C — Continuations humaines | 7–9 | Retries persistants, paire vérifiée, coalescence et audit sans starvation |
| D — Réveil fleet | 10 | Jobs indépendants, cursor durable, archive et finalisation owner vérifiées |
| E — Admission | 11–12 | Contexte signé et transport complet, replay sûr, couverture de toutes les routes |
| F — Exploitabilité | 13–14 | Alertes acquittées, SLO mesurables, lecteurs et rollback compatibles |
| G — Acceptation | 15–16 | Matrice complète, qualification synthétique, CI et dry-run sur SHA exact |

Avant la tâche 1, relever le main courant et les changements depuis la base ci-dessus dans le dossier de preuve de la future exécution. Le worktree source de ce plan est déjà isolé, branche `design/post-commit-convergence-reliability`. Une implémentation utilisera son propre checkout isolé et ne mélangera pas ses commits avec la PR documentaire.

**Précondition #147 :** [PR draft de promotion](https://github.com/zakariafadli94/project-os/pull/147), ouverte et non fusionnée lors de la lecture du 2026-09-08, head `fcedf969e7d7e3e0de18ed258eb151f3f9699e75`. Revalider son état, son SHA et ses interfaces sur le main retenu avant E, puis avant intégration. Elle conserve `review_candidate.promote`, `accepted: true`, l’expected project revision, les expected versions, le journal et la preuve de publication, l’identité/provider/hash des candidats. Aucune de ces responsabilités n’est implémentée ou redéfinie ici. Si l’API de promotion n’est pas encore intégrée, la matrice d’admission la marque non migrée et bloque le strict pour le projet concerné ; ne pas inventer un faux handler pour faire passer le gate. Appliquer la même vérification de transport à #139 et préserver #115/#116, #93/#94 et le writer-schema gate #79.

**Précondition RegistryGuard :** le code lu possède `requests`, `finishAllocatedCreate(original, projectId)` et la finalisation registre puis receipt, mais cette lecture seule ne prouve pas une continuation externe survivant à la perte SQLite avant énumération. La tâche 10 ajoute le test de cette précondition. S’il échoue, l’intégration reste bloquée sur le propriétaire RegistryGuard ; ne pas transférer son autorité ou masquer l’échec avec une inscription fictive dans le registre.

**Commandes de préflight (lecture seule) :**

```bash
git status --short
git log -1 --format='%H %s'
git diff --name-only 696714deea50e83d6c459bc8901e0d6408841eb3..HEAD
git ls-remote origin refs/heads/main refs/heads/fix/review-candidate-promotion
node --version
npm --version
```

Attendu : checkout d’exécution propre, SHA enregistré, Node/npm disponibles. Utiliser le runtime configuré de la machine si absent du PATH ; ne pas changer le lockfile pour installer un autre outillage. Les commandes `gh` du processus de revue peuvent être remplacées par le connecteur GitHub ; `gh` n’est pas installé sur la machine de planification.

## Carte des fichiers et signatures existantes vérifiées

Les positions sont des repères à la base, les noms de symboles sont les ancres stables. `src/persistence/repository.ts` est la façade active et surcharge le commit, les snapshots et les dérivés ; les méthodes de base vivent dans `repository-core.ts`. Les corrections doivent atteindre les deux niveaux sans contourner les codecs de la façade. Ne pas importer un module Dropbox dans les modules de convergence.

| Fichier existant / ancre | Contrat actuel et changement nécessaire |
|---|---|
| `src/domain/commit-record.ts` | `parseCanonicalCommitRecord(value: unknown): CanonicalCommitRecord` vérifie les bindings ; ne pas changer le JSON métier |
| `src/materialization/hash.ts` | `canonicalJson(value: unknown): string`, `sha256Canonical(value: unknown): Promise<string>`, `sha256Text(value: string): Promise<string>` ; les hashes texte ne sont pas le Dropbox content hash |
| `src/materialization/ledger.ts` | `initializeMaterializationSchema(storage: DurableObjectStorage): void`, `MaterializationLedger(storage)`, `requestTarget`, `beginNextTarget`, `recordVerifiedOutput`, `restoreExternalBaseline`, `status` ; ajouter des tables, ne pas effacer les existantes |
| `src/materialization/coordinator.ts` | `MaterializationCoordinator(options: MaterializationCoordinatorOptions)`, `runNext(retryCount = 0): Promise<MaterializationRunResult>`, `runUntilIdle(maxRuns = 128)`, `reconcile(canonicalRevision: number)` ; les handlers passent au nouveau moteur borné, jamais à `runUntilIdle` |
| `src/materialization/coordinator.ts` | `rebuildProjectionBaseline(repository: Pick<MaterializationRepositoryPort, "readMaterializationRecord">, head: MaterializationHead): Promise<ProjectionBaseline>` ; conserver le calcul root/count/parent, offrir une continuation pour ses lectures |
| `src/materialization/planner.ts` | `planProjection(record: CanonicalCommitRecord, baseline: ProjectionBaseline \| null, projectionVersion: number): Promise<ProjectionPlan>` ; clés critiques `global:STATE`, `global:HANDOFF` |
| `src/materialization/writer.ts` | `WorkspaceProjectionWriter(input: ObjectPersistence \| PersistenceInput, concurrency: number)`, `materialize(plan, options): Promise<Map<string, ProjectionOutputEvidence>>`, `verifyCritical(plan, workspaceRoot): Promise<void>` ; ne plus accepter un port sans CAS pour le writer v1 |
| `src/persistence/repository-core.ts:178` | `writeCommitRecord(record: CanonicalCommitRecord): Promise<void>` ; résultat ambigu relu au chemin déterministe |
| `src/persistence/repository-core.ts:251` | `materializeCanonicalDerivatives(record: CanonicalCommitRecord, options: CommitWriteOptions = {}): Promise<void>` ; options du core = `publishReceipt?: boolean` ; la façade surcharge avec `ActivationDerivativeOptions` qui ajoute bien `projectionVersion?: number` pour les répertoires managés |
| `src/persistence/repository-core.ts:387` | `writeMachineState(state: ProjectState, event: DomainEvent)`, `writeMachineSnapshot(state: ProjectState)`, `writeReceipt(receipt: Receipt)` retournent `Promise<void>` ; l’agrégat n’est plus appelé par le nouveau moteur |
| `src/persistence/provider/contract.ts` | `ConditionalWritePort.writeTextConditional(path: string, content: string, expectedRevisionToken: string): Promise<ProviderObjectMetadata>` ; metadata = `objectId?`, `revisionToken?`, `modifiedAt?`, `integrityHash?` |
| `src/persistence/provider/contract.ts` | `deleteIfUnchanged?(path, expected: { objectId: string; revisionToken: string }): Promise<"deleted" \| "missing" \| "changed">` ; aucun move conditionnel actuel |
| `src/persistence/providers/dropbox/client.ts:342` | `listFolder(path)` et `listFolderChanges(root?, cursor?)` drainent aujourd’hui toutes les pages : ne pas les présenter comme des appels bornés |
| `src/persistence/production-factory.ts` | `createProductionPersistence(env: Env, projectId?: string \| null): ProjectOsPersistenceRuntime` enveloppe resilience puis schema policy ; préserver les deux |
| `src/durable/materialization-guard.ts` | `/request-target`, `/status`, `/reconcile`, `/materialize`, `alarm(alarmInfo?: AlarmInvocationInfo): Promise<void>` ; unique file sérialisée |
| `src/materialization/handoff.ts` | `requestMaterializationTargetSafely(env: Env, projectId: string, revision: number, projectionVersion: number): Promise<void>` ; signature conservée, délai et logs expurgés |
| `src/index-neutral.ts:497` | `executeTransactionWithContinuity(env: Env, transaction: Transaction, candidate?: TransactionExecutor): Promise<Receipt>` ; ajouter un argument optionnel de contexte sans modifier Transaction |
| `src/continuity/rollback.ts` | `TransactionExecutor = (transaction: Transaction) => Promise<unknown>` ; closure de contexte ou second paramètre optionnel cohérent dans tous les transports |
| `src/inbox/processor.ts:34` | `ExecuteTransaction = (transaction: Transaction) => Promise<Receipt>` ; enveloppe décodée avant `parseTransaction`, contexte séparé |
| `src/durable/project-guard-neutral.ts:160` | `/transaction` sérialise, replay, recovery, domaine, record, cache, handoff ; l’admission ne doit pas produire un terminal receipt |
| `src/durable/project-guard-subrequest-resilient.ts` | chemins working-head contournant le parser de base ; le contrôle doit aussi précéder `workingHeadRequests.ensureIntent` |
| `src/index.ts:72`, `src/index-neutral.ts:583` | `scheduled(controller, env, ctx)`, `reconcileMaterializations(env: Env): Promise<MaterializationReconcileSummary>` ; supprimer dépendance inbox puis head-only current |

Nouveaux modules de production : `src/convergence/{contract,health,journal,budget,fenced-effects,discovery,derivatives,retry,engine,human,audit,fleet,observability,rollout}.ts`, `src/admission/{mutation-context,transport}.ts`. Chacun porte une responsabilité ; les DO existants sont des adaptateurs de sérialisation, pas un nouveau monolithe. Tests nouveaux sous `test/convergence-*.spec.ts` et `test/mutation-context-*.spec.ts`, helpers sous `test/helpers/`.

## Contrats communs à créer (référence exacte des tâches)

Ces déclarations sont **des interfaces à ajouter**, pas des exports prétendument existants. Les schémas Zod stricts du journal v1 reflètent exactement ces propriétés ; aucune propriété nouvelle dans Transaction, Receipt, CanonicalCommitRecord ou CompletedMaterializationRecord. Les champs temporels persistés sont UTC ISO ; l’horloge interne est en millisecondes.

```ts
// src/convergence/contract.ts
import type { CanonicalCommitRecord } from "../domain/commit-record";
import type { ProjectState } from "../domain/project-state";
import type { ProjectionOutputEvidence } from "../domain/materialization";

export const LAYERS = ["canonical", "event", "state", "manifest", "receipt",
  "human_state", "human_handoff", "generation", "head", "scheduler"] as const;
export type Layer = typeof LAYERS[number];
export type HealthState = "current" | "pending" | "retry_wait" | "exhausted" | "blocked" | "unknown";
export type ObligationState = "pending" | "running" | "retry_wait" | "exhausted" | "blocked" | "verified";
export interface Evidence {
  revision: number | null;
  identity: string | null;
  hash: string | null;
  projection_version: number | null;
  root_hash: string | null;
}
export interface LayerHealth {
  state: HealthState;
  applicable: boolean;
  expected: Evidence;
  observed: Evidence;
  last_verified_at: string | null;
  first_pending_at: string | null;
  next_attempt_at: string | null;
  failure_count: number;
  code: string | null;
  verified_through: number | null;
  missing_count: number;
  first_missing_id: string | null;
  observation_complete: boolean;
}
export interface ConvergenceHealth {
  schema_version: "1.0";
  project_id: string;
  layers: Record<Layer, LayerHealth>;
  converged: boolean;
  due_without_alarm: boolean;
  first_observed_at: string;
  commit_accepted_at: string | null;
  commit_time_code: "commit_time_unknown" | null;
}
export interface Target { revision: number; projection_version: number }
export interface Obligation {
  id: string;
  layer: Layer;
  from_revision: number;
  target: Target;
  incident: number;
  state: ObligationState;
  first_pending_at: string;
  next_attempt_at: string | null;
  failure_count: number;
  last_attempt_number: number;
  last_closed_attempt_number: number;
  last_verified_at: string | null;
  code: string | null;
  lease_until: string | null;
  continuation: string | null;
}
export interface EffectIntent {
  id: string;
  path: string;
  destination: string | null;
  kind: "create" | "replace" | "delete" | "move";
  object_id: string | null;
  expected_token: string | null;
  desired_hash: string | null;
  authorized_previous_hash: string | null;
  state: "prepared" | "uncertain" | "verified" | "neutralized" | "blocked";
  verified_token: string | null;
}
export interface AttemptReservation {
  schema_version: "1.0";
  project_id: string;
  obligation_id: string;
  layer: Layer;
  from_revision: number;
  target: Target;
  attempt_number: number;
  incident: number;
  incarnation: string;
  reserved_at: string;
  lease_until: string;
}
export interface Progress {
  schema_version: "1.0";
  project_id: string;
  incarnation: string;
  lease_until: string;
  canonical_observed_revision: number;
  baseline_revision: number;
  baseline_kind: "commit" | "pre_commit001";
  event_verified_through: number;
  receipt_verified_through: number;
  missing_event_ids: string[];
  missing_receipt_ids: string[];
  active: Target | null;
  requested: Target | null;
  parked: Target[];
  obligations: Record<string, Obligation>;
  effects: Record<string, EffectIntent>;
  partial_outputs: Record<string, ProjectionOutputEvidence>;
  cursors: Record<string, string | null>;
  last_queue: "machine" | "human";
  next_alarm_at: string | null;
  alerts: Record<string, { notification_pending: boolean; delivered_at: string | null;
    resolved_at: string | null; next_attempt_at: string | null; failure_count: number }>;
  first_observed_at: string;
  commit_accepted_at: string | null;
  last_error_code: string | null;
}
export interface VerifiedCanonical {
  project_id: string;
  state: ProjectState;
  record: CanonicalCommitRecord | null;
  baseline_kind: "commit" | "pre_commit001";
  complete: boolean;
}
export interface SliceBudget {
  deadline_ms: number;
  calls_left: number;
  now(): number;
  signal: AbortSignal;
  beforeHttp(): void;
  canStartEffect(requiredCalls: number): boolean;
}
export interface SliceResult {
  health: ConvergenceHealth;
  more_work: boolean;
  next_alarm_at: string | null;
  provider_calls: number;
}
```

Un `continuation`/curseur est un JSON technique typé par son module, jamais un body métier. `partial_outputs` est indexé par `revision:projection:key` pour éviter collision entre cibles garées. `effects` conserve les destinations de toutes les opérations incertaines tant qu’elles ne sont pas neutralisées. Les listes de manques et les preuves partielles restent dans `progress.json` en v1 ; sa taille compte dans le budget et la qualification, et un dépassement empêche l’activation de l’enveloppe concernée. Aucun fichier technique annexe implicite ni Markdown dupliqué. L’absence totale de preuves après un incident ne doit pas être assimilée à un projet neuf.

## Rythme d’exécution

Chaque sous-étape ci-dessous vise 2–5 minutes. Les blocs de code fixent les contrats ; pour une étape regroupant plusieurs symboles, appliquer la micro-boucle suivante à chaque symbole avant de passer au suivant, sans reporter tous les tests à la fin du lot :

- [ ] Écrire une assertion comportementale ciblée avec les fixtures indiquées.
- [ ] Exécuter le test nommé et constater le rouge attendu.
- [ ] Ajouter une seule fonction, branche ou migration additive décrite dans la tâche.
- [ ] Exécuter à nouveau le test et le contrôle de types.
- [ ] Examiner le diff de cette unité avant la suivante ; le commit ferme la tâche révisable.

Les cas de panne d’une ligne de matrice deviennent autant de cycles indépendants, pas une étape monolithique. La rédaction et l’auto-revue restent séparées de l’exécution des cycles rouges/verts.

## Tâche 1 — Harness des effets ambigus et fixture canonique synthétique

**Files:** Modify `test/helpers/mock-dropbox.ts`, `test/fault-injection-harness.spec.ts`. Create `test/helpers/convergence-fixture.ts`. Aucun failpoint dans `src/`.

**Interfaces:** Consomme `installDropboxMock(options?: DropboxMockOptions)`, `applyTransaction(state, tx)` et `parseCanonicalCommitRecord`. Produit `DropboxMockFault.phase?: "before" | "after"`, `pause?: Promise<void>`, `responseHeaders?: Record<string, string>` ; conserver tous les champs obligatoires actuels. `after` signifie appliquer le vrai effet puis substituer la réponse ; `pause` suspend avant l’effet et permet une réponse tardive. Produit `commitFixture(projectId: string, through: number): CanonicalCommitRecord[]`.

- [ ] **1. Ajouter le test rouge de réponse perdue après effet** dans `test/fault-injection-harness.spec.ts` (imports Vitest et helper existants).

```ts
it("retains a successful upload when its response is lost", async () => {
  const path = "/PROJECT_OS/.project-os/projects/PRJ-9258/convergence/progress.json";
  const mock = installDropboxMock({ faults: [{ endpoint: "/2/files/upload",
    occurrence: 1, path, status: 503, error_summary: "injected/lost_ack", phase: "after" }] });
  const response = await fetch("https://content.dropboxapi.com/2/files/upload", {
    method: "POST", headers: { "Dropbox-API-Arg": JSON.stringify({ path, mode: "add" }) },
    body: "durable"
  });
  expect(response.status).toBe(503);
  expect(mock.files.get(path)).toBe("durable");
});
```

- [ ] **2. Exécuter** `npx vitest run test/fault-injection-harness.spec.ts`. Attendu rouge : propriété `phase` absente ou contenu non persisté, pas une erreur de configuration.
- [ ] **3. Extraire le dispatch normal de la closure mock dans une fonction locale `dispatch(request: Request): Promise<Response>`** ; garder le comptage des occurrences en dehors du dispatch. Utiliser ce branchement, puis étendre le même mécanisme aux créations, CAS, suppressions et moves déjà simulés :

```ts
async function dispatchWithFault(request: Request, selectedFault: DropboxMockFault | undefined,
  dispatch: (request: Request) => Promise<Response>): Promise<Response> {
if (selectedFault?.pause) await selectedFault.pause;
if (selectedFault && (selectedFault.phase ?? "before") === "before") {
  return new Response(JSON.stringify({ error_summary: selectedFault.error_summary }), {
    status: selectedFault.status, headers: selectedFault.responseHeaders
  });
}
const response = await dispatch(request);
if (selectedFault?.phase === "after" && response.ok) {
  await response.arrayBuffer();
  return new Response(JSON.stringify({ error_summary: selectedFault.error_summary }), {
    status: selectedFault.status, headers: selectedFault.responseHeaders
  });
}
return response;
}
```

- [ ] **4. Ajouter la fixture canonique**, sans utiliser PRJ-0003, sans modifier manuellement un `state.revision` pour fabriquer sa validité.

```ts
// test/helpers/convergence-fixture.ts
import { applyTransaction } from "../../src/domain/transitions";
import { parseTransaction } from "../../src/domain/transaction";
import { parseCanonicalCommitRecord, type CanonicalCommitRecord } from "../../src/domain/commit-record";
export function commitFixture(projectId: string, through: number): CanonicalCommitRecord[] {
  const records: CanonicalCommitRecord[] = [];
  for (let revision = 1; revision <= through; revision++) {
    const transaction = parseTransaction({ schema_version: "1.0",
      transaction_id: `TXN-CONVERGENCE-${projectId}-${revision}`, project_id: projectId,
      base_revision: revision - 1, created_at: "2026-09-08T00:00:00.000Z",
      operation: revision === 1 ? "project.create" : "research.add",
      payload: revision === 1
        ? { name: "Synthetic convergence", slug: "synthetic-convergence", aliases: [], objective: "Fault proof" }
        : { research_id: `RES-CONV${revision}`, title: `Observation ${revision}`, body: "Synthetic" }
    });
    const result = applyTransaction(records.at(-1)?.state ?? null, transaction);
    if (result.kind !== "commit") throw new Error(`Fixture transition failed: ${result.kind}`);
    records.push(parseCanonicalCommitRecord({ schema_version: "1.0", project_id: projectId,
      previous_revision: revision - 1, new_revision: revision, transaction,
      state: result.state, event: result.event,
      receipt: { schema_version: "1.0", transaction_id: transaction.transaction_id,
        project_id: projectId, status: "committed", previous_revision: revision - 1,
        new_revision: revision, event_id: result.event.event_id, committed_at: transaction.created_at }
    }));
  }
  return records;
}
```

- [ ] **5. Vérifier** `npx vitest run test/fault-injection-harness.spec.ts test/commit-record.spec.ts` puis `npm run typecheck`. Ajouter dans le premier fichier les assertions avant effet = aucun write, après effet = un write, deux sélecteurs indépendants, CAS tardif rejeté après changement de token, et réponse ambiguë suivie d’une lecture elle-même indisponible. Attendu : tous verts, aucun spy restant après `vi.restoreAllMocks()`.
- [ ] **6. Commit :** `git add test/helpers/mock-dropbox.ts test/helpers/convergence-fixture.ts test/fault-injection-harness.spec.ts` puis `git commit -m "test: model persisted effects with lost provider responses"`.

## Tâche 2 — Contrat v1 et vecteur de santé honnête

**Files:** Create `src/convergence/contract.ts`, `src/convergence/health.ts`, `test/convergence-health.spec.ts`. Modify `src/durable/materialization-guard.ts` (`statusResponse`), `src/index-neutral.ts` (`MaterializationStatusResponse`).

**Interfaces:** Consomme les déclarations communes. Produit `unknownHealth(projectId: string, now: string): ConvergenceHealth`, `isConverged(health: ConvergenceHealth): boolean`, `publicState(state: ObligationState): HealthState`. Ajouter `convergence: ConvergenceHealth` au status existant, garder `canonical_revision`, `materialized_head`, `requested`, `active`, compteurs et `blocked_error`.

- [ ] **1. Écrire le test rouge** (imports des trois fonctions et de `LAYERS`).

```ts
it("does not close incident 258 when only machine layers are current", () => {
  const h = unknownHealth("PRJ-9258", "2026-09-08T00:10:40.000Z");
  for (const layer of LAYERS) {
    h.layers[layer].expected.revision = 258;
    h.layers[layer].observed.revision = 257;
  }
  for (const layer of ["canonical", "event", "state", "manifest", "receipt"] as const) {
    Object.assign(h.layers[layer], { state: "current", observation_complete: true });
    h.layers[layer].observed.revision = 258;
  }
  expect(isConverged(h)).toBe(false);
  expect(publicState("running")).toBe("pending");
  expect(h.layers.human_handoff.state).toBe("unknown");
});
```

- [ ] **2. Exécuter** `npx vitest run test/convergence-health.spec.ts`. Attendu : imports absents, puis test rouge jusqu’à implémentation.
- [ ] **3. Ajouter les types et les fonctions**, avec valeurs inconnues explicites :

```ts
export function publicState(state: ObligationState): HealthState {
  return state === "verified" ? "current" : state === "running" ? "pending" : state;
}
export function isConverged(h: ConvergenceHealth): boolean {
  return !h.due_without_alarm && LAYERS.every(key => {
    const layer = h.layers[key];
    return !layer.applicable || (layer.state === "current" && layer.observation_complete
      && layer.missing_count === 0 && layer.first_missing_id === null
      && layer.last_verified_at !== null);
  });
}
export function unknownHealth(projectId: string, now: string): ConvergenceHealth {
  const evidence = (): Evidence => ({ revision: null, identity: null, hash: null,
    projection_version: null, root_hash: null });
  const layers = Object.fromEntries(LAYERS.map(layer => [layer, {
    state: "unknown", applicable: true, expected: evidence(), observed: evidence(),
    last_verified_at: null, first_pending_at: null, next_attempt_at: null,
    failure_count: 0, code: null, verified_through: null, missing_count: 0,
    first_missing_id: null, observation_complete: false
  }])) as Record<Layer, LayerHealth>;
  return { schema_version: "1.0", project_id: projectId, layers, converged: false,
    due_without_alarm: false, first_observed_at: now, commit_accepted_at: null,
    commit_time_code: "commit_time_unknown" };
}
```

- [ ] **4. Ajouter les cas** trou event historique avec observed=258, head258 mais HANDOFF modifié, lecture transport failed = unknown, scheduler due sans alarme, baseline sans historique non applicable explicitement justifiée. Aucun `current` ne vient seulement d’une égalité de révision ; l’observateur ne l’émet qu’après binding/hash vérifiés. Le champ ajouté initialement reste unknown jusqu’au passage des tâches d’observation.
- [ ] **5. Vérifier** `npx vitest run test/convergence-health.spec.ts test/materialization-reconcile.spec.ts test/schema/materialization-compat.spec.ts` puis `npm run typecheck`. Attendu : lecture additive compatible, aucun schéma métier/génération modifié.
- [ ] **6. Commit :** `git add src/convergence/contract.ts src/convergence/health.ts src/durable/materialization-guard.ts src/index-neutral.ts test/convergence-health.spec.ts` puis `git commit -m "feat: expose additive per-layer convergence health"`.

## Tâche 3 — Journal externe, réservations et reprise SQLite

**Files:** Create `src/convergence/journal.ts`, `test/convergence-journal.spec.ts`. Modify `src/materialization/ledger.ts`, `src/persistence/layout.ts`, `test/materialization-ledger.spec.ts`.

**Interfaces:** Produit `convergenceProgressPath(projectId: string): string`, `convergenceAttemptPath(projectId: string, obligationId: string, attempt: number): string`, `convergenceAlertPath(projectId: string, incidentId: string): string` dans layout. IDs de fichiers = SHA-256 hex sur identité canonique, pas du texte libre. Produit `ConvergenceJournal(runtime: ProjectOsPersistenceRuntime, projectId: string)` avec `load(): Promise<{ progress: Progress; token: string } | null>`, `save(progress: Progress, expectedToken: string | null): Promise<string>`, `reserve(attempt: AttemptReservation): Promise<void>`, `listAttempts(obligationId: string, cursor: string | null, budget: SliceBudget): Promise<{ attempts: AttemptReservation[]; cursor: string | null }>`. Avant le port paginé de tâche4, le test utilise une unique page en mémoire ; aucun listing non borné n’est autorisé en activation.

- [ ] **1. Ajouter le test rouge**, avec `commitFixture` pour les bindings et `createProductionPersistence(testEnv, projectId)` utilisant le mock provider. `progress` et `attempt` sont des fixtures complètes respectant le contrat commun ; construire `progress` avec `initialProgress` ci-dessous.

```ts
it("consumes an immutable reservation across local loss", async () => {
  installDropboxMock();
  const journal = new ConvergenceJournal(createProductionPersistence(testEnv, "PRJ-9258"), "PRJ-9258");
  const id = await sha256Canonical({ project: "PRJ-9258", layer: "head", from: 258, pv: 3, incident: 1 });
  const attempt: AttemptReservation = { schema_version: "1.0", project_id: "PRJ-9258",
    obligation_id: id, layer: "head", from_revision: 258, target: { revision: 258, projection_version: 3 },
    attempt_number: 1, incident: 1, incarnation: "writer-1",
    reserved_at: "2026-09-08T00:00:00.000Z", lease_until: "2026-09-08T00:00:10.000Z" };
  await journal.reserve(attempt);
  const cold = new ConvergenceJournal(createProductionPersistence(testEnv, "PRJ-9258"), "PRJ-9258");
  await cold.reserve(attempt);
  const budget: SliceBudget = { deadline_ms: Date.now() + 10000, calls_left: 32,
    now: Date.now, signal: new AbortController().signal, beforeHttp() { this.calls_left--; },
    canStartEffect(requiredCalls) { return this.calls_left >= requiredCalls + 4; } };
  expect((await cold.listAttempts(id, null, budget)).attempts).toEqual([attempt]);
  await expect(cold.reserve({ ...attempt, incarnation: "writer-2" })).rejects.toThrow();
});
```

- [ ] **2. Exécuter** `npx vitest run test/convergence-journal.spec.ts`. Attendu rouge sur exports absents.
- [ ] **3. Implémenter parse strict, safe-add et CAS**, avec la réservation immuable avant toute réparation. Pour `reserve`, le catch de création relit **aussi** en cas de réponse transport perdue ; contenu différent = `journal_integrity_conflict`, lecture impossible = `progress_store_unavailable`. Comparer les JSON normalisés, vérifier project/obligation/attempt et le chemin. Pour `save`, aucune fusion aveugle de checkpoints : échec CAS oblige à relire et revalider incarnation ; l’ancien writer s’arrête.

```ts
// Export de journal.ts, utilisé pour le premier checkpoint seulement après audit d'absence.
export function initialProgress(projectId: string, now: string, incarnation: string): Progress {
  return { schema_version: "1.0", project_id: projectId, incarnation, lease_until: now,
    canonical_observed_revision: 0, baseline_revision: 0, baseline_kind: "commit",
    event_verified_through: 0, receipt_verified_through: 0,
    missing_event_ids: [], missing_receipt_ids: [], active: null, requested: null, parked: [],
    obligations: {}, effects: {}, partial_outputs: {}, cursors: {}, last_queue: "human",
    next_alarm_at: null, alerts: {}, first_observed_at: now, commit_accepted_at: null,
    last_error_code: null };
}
const content = canonicalJson(attempt) + "\n";
const path = convergenceAttemptPath(attempt.project_id, attempt.obligation_id, attempt.attempt_number);
try { await runtime.objects.createText(path, content); }
catch (error) {
  const existing = await runtime.objects.readText(path);
  if (existing !== content) throw error;
}
```

- [ ] **4. Étendre SQLite de façon additive**, une transaction locale pour installer le checkpoint validé et conserver le token ; ne pas écraser les tables de projection existantes.

```sql
CREATE TABLE IF NOT EXISTS convergence_checkpoint (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  progress_json TEXT NOT NULL, provider_token TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS convergence_attempts (
  obligation_id TEXT NOT NULL, attempt_number INTEGER NOT NULL,
  reservation_json TEXT NOT NULL,
  PRIMARY KEY(obligation_id, attempt_number)
);
```

Produire dans `MaterializationLedger` `readConvergenceCheckpoint(): { progress: Progress; token: string } | null` et `restoreConvergenceCheckpoint(progress: Progress, token: string): void`. Reprise = lire externe, valider, paginer réservations, max numéro réservé, réconcilier `last_closed_attempt_number`, vérifier effets incertains, puis restaurer local. Un checkpoint invalide est ignoré pour l’autorité canonique mais ouvre `journal_integrity_conflict`. Si toutes les preuves ont disparu après un incident connu, blocked, jamais compteur neuf. Le premier bootstrap sans journal inspecte aussi les preuves de génération et l’absence de réservations avant d’initialiser l’épisode. Le cutover contrôlé initialise le checkpoint avant d’autoriser repair ; un projet déjà activé dont toutes les preuves externes ont disparu reste blocked, même si sa liste attempts est vide. Cette absence ne prouve jamais qu’aucun budget n’a été consommé.
- [ ] **5. Vérifier** `npx vitest run test/convergence-journal.spec.ts test/materialization-ledger.spec.ts test/schema/materialization-compat.spec.ts`. Couvrir save avant/après effet, CAS concurrent, reservation avant/après effet, perte SQLite, checkpoint ancien, compteur monotone, JSON wrong-project, répertoire attempts corrompu. Attendu : aucune réparation lorsque reserve est indisponible.
- [ ] **6. Commit :** `git add src/convergence/journal.ts src/materialization/ledger.ts src/persistence/layout.ts test/convergence-journal.spec.ts test/materialization-ledger.spec.ts` puis `git commit -m "feat: persist reconstructible convergence attempts and progress"`.

## Tâche 4 — Budget physique, pagination et deadlines provider

**Files:** Create `src/convergence/budget.ts`, `test/convergence-budget.spec.ts`. Modify `src/persistence/provider/contract.ts`, `src/persistence/provider/capabilities.ts`, `src/persistence/provider/resilience.ts`, `src/persistence/provider/errors.ts`, `src/persistence/providers/dropbox/client.ts`, `src/persistence/providers/dropbox/adapter.ts`, `src/persistence/providers/dropbox/error-mapping.ts`, `src/persistence/production-factory.ts`, `src/schema/runtime-policy.ts`, `test/helpers/persistence-runtime.ts`, `src/convergence/journal.ts`.

**Interfaces:** Produit `createSliceBudget(now: () => number, signal: AbortSignal): SliceBudget`. Ajouter `ProviderRequestScope { beforeHttp(): void; signal: AbortSignal; deadlineMs: number }` et `ProviderListPage { entries: ProviderEntry[]; cursor: string | null }`, port optionnel `pagedListing.listPage(input: { path: string; cursor: string | null; limit: number }): Promise<ProviderListPage>`. Le runtime convergence exige ce port ; les autres clients restent compatibles. `createProductionPersistence(env, projectId?, scope?: ProviderRequestScope)` garde ses paramètres actuels. `DropboxClient` reçoit le scope optionnel au constructeur et le vérifie à **chaque HTTP**, y compris OAuth, création de parents, pages et transport retry. Ajouter `retryAfterMs?: number` à `ProviderDiagnostics` ; parsing secondes/date HTTP dans le client, mapping expurgé.

- [ ] **1. Test rouge :**

```ts
it("reserves checkpoint capacity and never starts a 33rd HTTP call", () => {
  let now = 0;
  const budget = createSliceBudget(() => now, new AbortController().signal);
  for (let i = 0; i < 28; i++) budget.beforeHttp();
  expect(budget.canStartEffect(1)).toBe(false);
  for (let i = 0; i < 4; i++) budget.beforeHttp();
  expect(() => budget.beforeHttp()).toThrow("slice_budget_exhausted");
  now = 10_000;
  expect(budget.canStartEffect(1)).toBe(false);
});
```

- [ ] **2. Exécuter** `npx vitest run test/convergence-budget.spec.ts`. Attendu rouge sur module absent.
- [ ] **3. Implémenter le budget** : réserver quatre appels et 1 000 ms pour checkpoint/réarmement (réserve de travail interne à la borne 32/10 s, à mesurer). Si la persistance prend plus longtemps, conserver l’ancienne réservation et récupérer l’effet incertain ; ne jamais dépasser la deadline pour prétendre avoir checkpointé.

```ts
export function createSliceBudget(now: () => number, signal: AbortSignal): SliceBudget {
  const budget: SliceBudget = { deadline_ms: now() + 10_000, calls_left: 32, now, signal,
    beforeHttp() {
      if (signal.aborted || now() >= budget.deadline_ms || budget.calls_left <= 0)
        throw new Error("slice_budget_exhausted");
      budget.calls_left--;
    },
    canStartEffect(requiredCalls) {
      return !signal.aborted && budget.calls_left >= requiredCalls + 4
        && now() < budget.deadline_ms - 1_000;
    }
  };
  return budget;
}
```

- [ ] **4. Ajouter une page HTTP par appel** au client (`listFolderPage(path: string, cursor: string | null, limit: number): Promise<{ entries: DropboxEntry[]; cursor: string | null }>`). Ne pas appeler `listFolder` ou `listFolderChanges` depuis cette méthode : réutiliser les deux endpoints déjà présents, retourner le cursor seulement quand `has_more`. Propager le port dans adapter/resilience/schema policy, compter chaque tentative physique et borner chaque fetch/body par le temps restant. Retry-After dépassant le temps restant remonte au moteur sans sleep. Brancher `ConvergenceJournal.listAttempts(obligationId, cursor, budget)` sur ce port paginé, conserver la signature et les assertions de tâche3 ; tester aussi cursor non null. Ne conserver aucun appel ancien non borné sur le chemin activé.
- [ ] **5. Vérifier** `npx vitest run test/convergence-budget.spec.ts test/convergence-journal.spec.ts test/provider-resilience.spec.ts test/dropbox-provider-adapter.spec.ts test/dropbox-read-resilience.spec.ts test/schema/runtime-policy-repositories.spec.ts`. Ajouter une chaîne de 129 refs, 429 Retry-After=60, OAuth cold, parent absent, timeout de body et reprise à page 2 ; oracle ≤32 HTTP et ≤10 s par tranche, aucune répétition de page validée. Une lecture de metadata et une lecture des bytes comptent deux appels.
- [ ] **6. Commit** explicite de tous les fichiers de cette tâche après `git diff --check`, message `feat: bound convergence HTTP work and persist listing cursors`.

```bash
git add src/convergence/budget.ts test/convergence-budget.spec.ts src/persistence/provider/contract.ts src/persistence/provider/capabilities.ts src/persistence/provider/resilience.ts src/persistence/provider/errors.ts src/persistence/providers/dropbox/client.ts src/persistence/providers/dropbox/adapter.ts src/persistence/providers/dropbox/error-mapping.ts src/persistence/production-factory.ts src/schema/runtime-policy.ts test/helpers/persistence-runtime.ts src/convergence/journal.ts
git commit -m "feat: bound convergence HTTP work and persist listing cursors"
```
## Tâche 5 — Effets conditionnels, fencing et ambiguïté du commit

**Files:** Create `src/convergence/fenced-effects.ts`, `test/convergence-fencing.spec.ts`. Modify `src/persistence/repository-core.ts` (`safeAdd`, `writeCommitRecord`), `src/persistence/repository.ts` (override `writeCommitRecord`), `test/commit-repository.spec.ts`, `test/project-guard-commit-recovery.spec.ts`.

**Interfaces:** Produit `ObservedText { content: string; hash: string; object_id: string; token: string }`, `observeText(runtime: ProjectOsPersistenceRuntime, path: string): Promise<ObservedText | null>`, `FencedEffects(runtime, journal, budget)` avec `prepare(progress: Progress, token: string, intent: EffectIntent): Promise<string>`, `replace(intent: EffectIntent, content: string): Promise<ObservedText>`, `neutralize(intent: EffectIntent, authorizedContent: string): Promise<ObservedText>`. Les méthodes vérifient l’incarnation via le journal avant effet ; la chaîne d’appel transmet le nouveau token de checkpoint. Constructor exact : `constructor(runtime: ProjectOsPersistenceRuntime, journal: ConvergenceJournal, budget: SliceBudget)`. Aucune entrée `content` n’est persistée dans le journal, seulement son SHA-256. Ajouter `CommitOutcomeUnknownError` exportée de repository-core, transport HTTP 503 code `commit_outcome_unknown`, jamais terminal receipt.

- [ ] **1. Écrire le test rouge de CAS tardif** (imports mock, runtime, `observeText`, `sha256Text`).

```ts
it("invalidates the old provider precondition even for identical replacement bytes", async () => {
  const mock = installDropboxMock();
  const path = "/PROJECT_OS/WORKSPACE/PROJECTS/PRJ-9258-synthetic-convergence/STATE.md";
  await mock.writeExternal(path, "authorized-258");
  const runtime = createProductionPersistence(testEnv, "PRJ-9258");
  const before = await observeText(runtime, path);
  if (!before) throw new Error("missing fixture");
  await runtime.conditionalWrite.writeTextConditional(path, "authorized-258", before.token);
  const after = await observeText(runtime, path);
  expect(after?.token).not.toBe(before.token);
  await expect(runtime.conditionalWrite.writeTextConditional(path, "old-257", before.token)).rejects.toThrow();
  expect(mock.files.get(path)).toBe("authorized-258");
});
```

- [ ] **2. Exécuter** `npx vitest run test/convergence-fencing.spec.ts test/commit-repository.spec.ts`. Attendu rouge sur observateur absent ; ajouter réponse commit perdue pour obtenir un rouge comportemental dans repository.
- [ ] **3. Implémenter une observation liée aux bytes**, metadata avant/texte/metadata après ; si objectId/token changent ou manquent, `observation_unstable`, pas de preuve current. Faire un seul cycle de lecture par continuation, pas de boucle infinie. SHA-256 calculé sur les bytes texte, jamais comparé directement à `dropbox-content-hash`.

```ts
export async function observeText(runtime: ProjectOsPersistenceRuntime, path: string): Promise<ObservedText | null> {
  const first = await runtime.objects.getMetadata(path);
  const content = await runtime.objects.readText(path);
  const last = await runtime.objects.getMetadata(path);
  if (!first && content === null && !last) return null;
  if (content === null || !first?.objectId || !first.revisionToken
    || first.objectId !== last?.objectId || first.revisionToken !== last?.revisionToken)
    throw new Error("observation_unstable");
  return { content, hash: await sha256Text(content), object_id: first.objectId, token: first.revisionToken };
}
```

- [ ] **4. Implémenter la séquence prepare → write → relecture**, l’intent persistant contient destination, token, hash avant/après. Si l’incarnation a changé, interdire l’ancien write. Une expiration n’annule pas le provider : avant finalisation, neutraliser chaque remplacement incertain avec CAS vers les bytes autorisés courants, vérifier token neuf puis rejeter le résultat tardif de l’ancien token. CAS échoué = réobservation ; bytes inexpliqués = blocked et récupération de preuve existante du writer. Pour création incertaine à destination absente, une création conditionnelle des bytes autorisés courants empêche l’ancien add de réussir ; si la destination est déjà autorisée, observer son identité. Pour delete, exiger `deleteIfUnchanged` et les preuves source ; pour move, conserver l’ancienne racine interdite de réutilisation et prouver source/destination par identités avant reprise. **Aucun move mutable non conditionnel n’est autorisé si un effet concurrent ne peut être neutralisé** : `provider_fencing_unavailable`, génération/head bloqués. Ce cas n’invente pas une capacité Dropbox absente ; la tâche 9 prouve les moves sûrs ou laisse l’archive bloquée explicitement.

Dans les deux implémentations de `writeCommitRecord` (core et façade qui encode `state` avec `encodeProjectState`), relire le chemin déterministe après toute erreur potentiellement post-effet. Record relu identique/valide = succès ; autre record = conflit d’intégrité ; not-found prouvé = erreur initiale ; relecture indisponible = `CommitOutcomeUnknownError`. Ne pas étendre cette règle à une recréation à une autre révision.
- [ ] **5. Vérifier** `npx vitest run test/convergence-fencing.spec.ts test/commit-repository.spec.ts test/project-guard-commit-recovery.spec.ts test/dropbox-document-concurrency.spec.ts`. Ajouter les fenêtres ancien write entre paire vérifiée et nouveau head, ancien create tardif, delete tardif, move incertain, metadata instable, perte de réponse à la neutralisation, provider ne changeant pas le token. Attendu : aucun vieux byte ne peut être déclaré courant ; si neutralisation non prouvée, blocked.
- [ ] **6. Commit :** `git add src/convergence/fenced-effects.ts src/persistence/repository-core.ts src/persistence/repository.ts test/convergence-fencing.spec.ts test/commit-repository.spec.ts test/project-guard-commit-recovery.spec.ts` puis `git commit -m "fix: fence uncertain derived effects and verify ambiguous commits"`.

## Tâche 6 — Découverte canonique et quatre files de dérivés

**Files:** Create `src/convergence/discovery.ts`, `src/convergence/derivatives.ts`, `test/convergence-derivatives.spec.ts`. Modify `src/persistence/repository-core.ts`, `src/persistence/repository.ts` (codecs et override snapshot), `src/durable/materialization-guard.ts` (`canonicalState`), `src/materialization/coordinator.ts` (port dérivés).

**Interfaces:** Produit `discoverCanonical(repository: ProjectRepository, runtime: ProjectOsPersistenceRuntime, progress: Progress, budget: SliceBudget): Promise<VerifiedCanonical | null>` et `repairDerivative(layer: "event" | "receipt" | "state" | "manifest", record: CanonicalCommitRecord, progress: Progress, effects: FencedEffects): Promise<LayerHealth>`. `advanceVerifiedThrough(previous: number, verified: ReadonlySet<number>): number` est pur. Ajouter à repository `writeCanonicalEvent(record: CanonicalCommitRecord): Promise<void>` et `canonicalDerivativeText(layer: "event" | "receipt" | "state" | "manifest", record: CanonicalCommitRecord): string` comme méthode du core surchargée dans la façade avec `encodeProjectState` et `encodeManifest` ; la transformation writer-schema reste celle de la façade existante, les comparaisons s’effectuent après readers normalisés. Conserver `projectionVersion` dans le port de compatibilité : la façade `ProjectRepository` accepte réellement `ActivationDerivativeOptions`. Le nouveau moteur traite le provisioning des zones managées dans sa continuation humaine et ne perd pas cet effet technique en supprimant l’agrégat.

- [ ] **1. Test rouge** :

```ts
it("keeps a contiguous cursor at the gap while later revisions remain verifiable", () => {
  expect(advanceVerifiedThrough(257, new Set([259, 260, 261]))).toBe(257);
  expect(advanceVerifiedThrough(257, new Set([258, 259, 260, 261]))).toBe(261);
});
```

Ajouter dans le même fichier une fixture `commitFixture("PRJ-9258", 259)`, déposer les records par `machineCommitRecordPath`, bloquer uniquement `machineEventPath(project, records[257].event.event_id)` via mock, puis appeler séparément les quatre `repairDerivative` avec une réservation par couche. Vérifier event258 blocked, receipt258 current, state259/manifest259 current, absence de seconde création d’event259.
- [ ] **2. Exécuter** `npx vitest run test/convergence-derivatives.spec.ts`. Attendu rouge sur exports absents.
- [ ] **3. Implémenter la découverte bornée**, valider le record de baseline s’il existe puis chaque suivant. Le snapshot sert à trouver une base, jamais à justifier un futur sans record. Distinguer pre-COMMIT001 explicitement ; si snapshot plus récent mais non justifié dans une chaîne COMMIT001 connue, blocked. Persister révision de découverte/page et retourner `complete: false` au plafond. Audit listing signale un record au-delà d’un trou sans avancer l’autorité. Transport error = unknown ; seul not-found prouvé termine la découverte contiguë.

```ts
export function advanceVerifiedThrough(previous: number, verified: ReadonlySet<number>): number {
  let cursor = previous;
  while (verified.has(cursor + 1)) cursor++;
  return cursor;
}
// Helper de la façade ; sa méthode canonicalDerivativeText appelle ce helper avec this.writerStage().
export function encodeCanonicalDerivative(layer: "event" | "receipt" | "state" | "manifest",
  record: CanonicalCommitRecord, stage: SchemaWriterStage): string {
  const value = layer === "event" ? record.event : layer === "receipt" ? record.receipt
    : layer === "state" ? encodeProjectState(record.state, stage) : encodeManifest(record.state, stage);
  return `${JSON.stringify(value, null, 2)}\n`;
}
```

- [ ] **4. Séparer les réparations** : event/receipt = create conditional + comparaison complète au record, conflit immuable préservé ; ne pas s’arrêter aux premières révisions bloquées pour visiter les suivantes. State/manifest = observation, validation canonique de la révision observée, CAS non régressif et postcondition. Préserver toute version incohérente dans le chemin existant de recovery avant réparation autorisée. Le receipt `project.create` renvoie pending code `awaiting_registry_finalization` jusqu’à preuve du propriétaire ; ne jamais le publier ici. Une génération existante ne saute aucune de ces quatre files. Les vues consomment le record validé indépendamment d’un receipt historique manquant.
- [ ] **5. Vérifier** `npx vitest run test/convergence-derivatives.spec.ts test/commit-repository.spec.ts test/project-guard-snapshot-fast-forward.spec.ts test/project-guard-commit-compat.spec.ts test/materialization-coordinator.spec.ts`. Cas supplémentaires : suppression après head complet, corruption immuable, state futur, snapshot same-revision divergent, wrong-project, event/transaction binding, chain gap, pre-COMMIT001. Attendu : compteur et âge propres à chaque couche ; aucun write métier.
- [ ] **6. Commit :** `git add src/convergence/discovery.ts src/convergence/derivatives.ts src/persistence/repository-core.ts src/persistence/repository.ts src/durable/materialization-guard.ts src/materialization/coordinator.ts test/convergence-derivatives.spec.ts` puis `git commit -m "feat: reconcile all canonical derivatives independently"`.

## Tâche 7 — Retries persistants et alarme au minimum des échéances

**Files:** Create `src/convergence/retry.ts`, `src/convergence/engine.ts`, `test/convergence-retry.spec.ts`. Modify `src/durable/materialization-guard.ts`, `src/materialization/handoff.ts`, `test/materialization-guard-isolation.spec.ts`, `test/project-guard-alarm-serialization.spec.ts`.

**Interfaces:** Produit `nextRetryAt(input: { nowMs: number; failureCount: number; jitter: number; retryAfterMs: number }): { state: "retry_wait" | "exhausted"; at: string }`, `minimumWake(times: readonly (string | null)[]): string | null`. Produit `ConvergenceEngine` avec constructor `({ projectId, repository, runtime, journal, ledger, now }: { projectId: string; repository: ProjectRepository; runtime: ProjectOsPersistenceRuntime; journal: ConvergenceJournal; ledger: MaterializationLedger; now: () => number })`, `requestTarget(target: Target): Promise<void>`, `runSlice(budget: SliceBudget): Promise<SliceResult>`, `observe(budget: SliceBudget): Promise<ConvergenceHealth>`. Le moteur reste désactivé pour les projets non sélectionnés avant tâche 14. Créer un runtime scoped, repository, journal et moteur pour chaque tranche/observation dans la file sérialisée du DO ; ne pas réutiliser un scope dont la deadline a expiré. Seul le ledger SQLite et la sérialisation vivent pendant toute l’incarnation du DO.

- [ ] **1. Test rouge de bornes exactes**, sans horloge réelle :

```ts
it("exhausts six failures without restarting the burst", () => {
  for (const [failureCount, delay] of [[1, 2000], [2, 4000], [3, 8000], [4, 16000], [5, 32000], [6, 300000]]) {
    const next = nextRetryAt({ nowMs: 0, failureCount, jitter: 0, retryAfterMs: 0 });
    expect(Date.parse(next.at)).toBe(delay);
    expect(next.state).toBe(failureCount < 6 ? "retry_wait" : "exhausted");
  }
  expect(Date.parse(nextRetryAt({ nowMs: 0, failureCount: 2, jitter: 0.2, retryAfterMs: 60000 }).at)).toBe(60000);
});
```

- [ ] **2. Exécuter** `npx vitest run test/convergence-retry.spec.ts`. Attendu rouge sur module absent.
- [ ] **3. Ajouter les fonctions pures** et le journal des transitions :

```ts
export function nextRetryAt(input: { nowMs: number; failureCount: number; jitter: number; retryAfterMs: number }) {
  if (!Number.isInteger(input.failureCount) || input.failureCount < 1
    || input.jitter < 0 || input.jitter > 0.2) throw new Error("invalid_retry_input");
  const exhausted = input.failureCount >= 6;
  const base = exhausted ? 300_000 : 1000 * 2 ** input.failureCount;
  const delay = Math.max(input.retryAfterMs, exhausted ? base : Math.ceil(base * (1 + input.jitter)));
  return { state: exhausted ? "exhausted" as const : "retry_wait" as const,
    at: new Date(input.nowMs + delay).toISOString() };
}
export function minimumWake(times: readonly (string | null)[]): string | null {
  const values = times.filter((value): value is string => value !== null);
  return values.length ? new Date(Math.min(...values.map(Date.parse))).toISOString() : null;
}
```

Jitter = `parseInt(sha256Canonical({ obligation_id, attempt_number }).slice(0, 8), 16) / 0xffffffff * 0.2` ; calculer le hash avec `await` avant `slice`. Le numéro de réservation et le failure count sont distincts. `last_closed_attempt_number` empêche un double comptage après alarm duplicate. Une continuation qui progresse conserve la réservation ; six tranches réussies ne signifient pas six échecs. Une sonde exhausted commence par une lecture, puis au plus une réservation de réparation par couche/créneau 300 000 ms ; failure_count reste ≥6. Permanent = blocked immédiatement.
- [ ] **4. Brancher les handlers sur `runSlice` et `minimumWake`** : constructor ne reporte jamais l’alarme existante ; setAlarm = min(existante, échéances pending/retry/probe/notification/audit). Stocker l’échéance externe avant de tenter le réveil local. `/request-target` valide binding, coalesce sans effacer les compteurs, ACK après journal local et tentative de réveil ; ACK perdu est idempotent. `/status` observe borné, ne lance aucun effet de réparation ni ne réduit next_attempt_at ; `/reconcile` découvre et réarme. `alarmInfo.retryCount` sert seulement aux logs ; erreurs attendues capturées et alarme persistée, pas de troisième retry natif applicatif. Handoff : AbortSignal timeout 1 000 ms, consommer la réponse comme aujourd’hui, code expurgé et jamais modifier le receipt.
- [ ] **5. Vérifier** `npx vitest run test/convergence-retry.spec.ts test/materialization-guard-isolation.spec.ts test/project-guard-alarm-serialization.spec.ts`. Couvrir constructor→alarm, duplicate/tardif, setAlarm failed, polling fréquent, crash après réservation puis lease expiré, 20 minutes de panne et retour sans nouveau commit, minimum de deux couches dues. Attendu : exactement six échecs burst et pas plus d’une tentative lente/5 min/couche.
- [ ] **6. Commit** des fichiers listés, message `feat: resume bounded convergence with durable retry budgets`.

```bash
git add src/convergence/retry.ts src/convergence/engine.ts test/convergence-retry.spec.ts src/durable/materialization-guard.ts src/materialization/handoff.ts test/materialization-guard-isolation.spec.ts test/project-guard-alarm-serialization.spec.ts
git commit -m "feat: resume bounded convergence with durable retry budgets"
```

## Tâche 8 — Paire critique, finalisation et réparation du head

**Files:** Create `src/convergence/human.ts`, `test/convergence-human.spec.ts`. Modify `src/materialization/writer.ts`, `src/materialization/coordinator.ts`, `src/persistence/repository-core.ts`, `src/convergence/engine.ts`, `test/materialization-writer.spec.ts`, `test/materialization-faults.spec.ts`.

**Interfaces:** `runHumanSlice(input: { record: CanonicalCommitRecord; progress: Progress; budget: SliceBudget; effects: FencedEffects; repository: ProjectRepository; ledger: MaterializationLedger }): Promise<{ progress: Progress; complete: boolean }>` dans human. Ajouter `materializeSlice(plan: ProjectionPlan, options: WorkspaceProjectionWriterOptions, budget: SliceBudget, effects: FencedEffects): Promise<{ verified: Map<string, ProjectionOutputEvidence>; nextKey: string | null }>` au writer. Le chemin activé requiert `ProjectOsPersistenceRuntime` au constructeur ; conserver le constructor legacy pour tests/chemins non activés, mais interdire `materializeSlice` sans capabilities. `verifyCritical` devient obligatoire dans le port de finalisation.

- [ ] **1. Ajouter le test rouge** directement sur le plan et les hashes de la paire :

```ts
it("renders both critical outputs from the same canonical record", async () => {
  const record = commitFixture("PRJ-9258", 258)[257];
  const plan = await planProjection(record, null, 3);
  expect(plan.changed_outputs.get("global:STATE")?.source_revision).toBe(258);
  expect(plan.changed_outputs.get("global:HANDOFF")?.source_revision).toBe(258);
  const critical = [...plan.changed_outputs.values()].filter(output => output.critical);
  expect(critical.map(output => output.key).sort()).toEqual(["global:HANDOFF", "global:STATE"]);
});
```

Ce test de contrat peut déjà passer. Le rouge obligatoire supplémentaire dans `test/materialization-writer.spec.ts` modifie le mock pour refuser tout upload non critique et constate que STATE/HANDOFF sont écrits **avant** ce refus ; à la base l’ordre est inverse. Dans `test/materialization-faults.spec.ts`, supprimer HANDOFF après génération complète puis demander reconcile : head existant ne doit pas produire `converged: true`.
- [ ] **2. Exécuter** `npx vitest run test/convergence-human.spec.ts test/materialization-writer.spec.ts test/materialization-faults.spec.ts`. Attendu : rouges d’ordre et de drift, pas seulement ajout d’un test déjà vert.
- [ ] **3. Inverser les stages et reprendre output par output**, avec `EffectIntent` avant write et relecture des résultats incertains ; `alreadyVerified` n’autorise pas un skip sans preuve encore liée au provider. L’ordre du plan actif est stable et son `nextKey` persistant ; les suppressions permises sont aussi des effets journalisés.

```ts
// Ordre dans materializeSlice ; le curseur porte la clé, pas un index de Map implicite.
const ordered = [...plan.changed_outputs.values()].sort((a, b) =>
  Number(b.critical) - Number(a.critical) || a.key.localeCompare(b.key));
const criticalPaths = ["STATE.md", "HANDOFF.md"] as const;
// Les deux paths sont toujours relus avant record, même si aucun upload n'a été nécessaire.
for (const relativePath of criticalPaths) {
  const expected = [...plan.changed_outputs.values()].find(value => value.relative_path === relativePath);
  if (!expected) throw new Error("critical_pair_missing_from_plan");
  const observed = await observeText(runtime, `${workspaceRoot}/${relativePath}`);
  if (observed?.hash !== expected.content_hash) throw new Error("critical_pair_drift");
}
```

- [ ] **4. Finaliser dans l’ordre** : tous outputs/suppressions requis vérifiés → aucune opération incertaine non neutralisée → paire physique à destination finale → root/count/parent validés → record immuable → head CAS non régressif → relecture head et paire. Les quatre lectures finales peuvent traverser une continuation de la même tentative, mais la paire doit être relue dans la tranche qui publie le record/head ; réserver l’I/O correspondante. Record existant/head stale : reconstruire chaîne/root et relire paire avant CAS, zéro upload si bytes déjà bons. Record complet avec drift reste historique immuable ; restaurer uniquement les bytes autorisés selon fencing, sans changer `completed_at` ou root pour masquer un conflit. Projection inconnue rejetée, jamais candidate baseline ; snapshot après profondeur127, jamais chaîne129.
- [ ] **5. Vérifier** `npx vitest run test/convergence-human.spec.ts test/materialization-writer.spec.ts test/materialization-faults.spec.ts test/materialization-coordinator.spec.ts test/schema/materialization-compat.spec.ts`. Ajouter STATE seul écrit, échec relecture, edit externe entre lecture/CAS, edit après génération, root/parent/cycle, 128/129, record réussi/head failed. Attendu : `materialized` vrai seulement avec postconditions, aucune régression humaine ou head.
- [ ] **6. Commit** des fichiers listés, message `fix: verify and fence the critical pair before advancing head`.

```bash
git add src/convergence/human.ts test/convergence-human.spec.ts src/materialization/writer.ts src/materialization/coordinator.ts src/persistence/repository-core.ts src/convergence/engine.ts test/materialization-writer.spec.ts test/materialization-faults.spec.ts
git commit -m "fix: verify and fence the critical pair before advancing head"
```

## Tâche 9 — Coalescence équitable, cibles garées, audit et archive

**Files:** Create `src/convergence/audit.ts`, `test/convergence-coalescence.spec.ts`, `test/convergence-audit.spec.ts`. Modify `src/convergence/engine.ts`, `src/convergence/human.ts`, `src/materialization/ledger.ts`, `src/materialization/planner.ts`, `test/materialization-archive.spec.ts`.

**Interfaces:** Produit `chooseQueue(last: "machine" | "human", machinePending: boolean, humanPending: boolean): "machine" | "human" | null`, `parkActive(progress: Progress): Progress`, `auditSlice(runtime: ProjectOsPersistenceRuntime, repository: ProjectRepository, progress: Progress, budget: SliceBudget): Promise<Progress>`. `parkActive` refuse tout effect prepared/uncertain non drainé ; conserve obligations/âge/hash, active=null, parked+=cible. Demanded devient active au prochain point sûr.

- [ ] **1. Test rouge de fairness :**

```ts
it("reserves at least every other eligible slice for humans", () => {
  let last: "machine" | "human" = "human";
  const seen: string[] = [];
  for (let i = 0; i < 6; i++) {
    const next = chooseQueue(last, true, true);
    if (!next) throw new Error("lost pending work");
    seen.push(next); last = next;
  }
  expect(seen).toEqual(["machine", "human", "machine", "human", "machine", "human"]);
});
```

- [ ] **2. Exécuter** `npx vitest run test/convergence-coalescence.spec.ts`. Attendu rouge sur fonction absente.
- [ ] **3. Implémenter** :

```ts
export function chooseQueue(last: "machine" | "human", machinePending: boolean, humanPending: boolean) {
  if (machinePending && humanPending) return last === "machine" ? "human" as const : "machine" as const;
  return machinePending ? "machine" as const : humanPending ? "human" as const : null;
}
export function parkActive(progress: Progress): Progress {
  if (Object.values(progress.effects).some(effect => effect.state === "prepared" || effect.state === "uncertain"))
    throw new Error("inflight_effects_not_drained");
  return progress.active ? { ...progress, active: null, parked: [...progress.parked, progress.active] } : progress;
}
```

La file machine tourne entre event/receipt/state/manifest, y compris après erreur d’une couche. L’actif258 termine avant demandé261 ; si output non critique bloqué, drainer/fencer, garer258 et rendre261, sans record258 complet. Lorsque261 couvre258, clôturer la cible garée comme coalescée ; ne jamais réactiver ses anciens intents. L’âge et le budget du conflit applicable restent ceux de258. Tous les event/receipt258..261 sont toujours visités.
- [ ] **4. Ajouter l’audit paginé**, curseurs séparés `commit_audit`, `event_audit`, `receipt_audit`, `output_audit`, `generation_chain`, avec début/dernière complétion dans leur JSON typé. À chaque visite : paire critique et state/manifest/event/receipt courants, même sans nouvelle cible. Historique et outputs carried-forward en rotation finissant ≤24 h ; ne pas réécrire une note parce que sa source_revision est ancienne. Archive : destination `archiveProjectRoot`, pas de réactivation active ; roots doubles incohérents = blocked. Un move incertain n’est fini que si l’inventaire source/destination, IDs et tokens prouvent la terminaison ; tant qu’un move ne peut être neutralisé, ne réutiliser aucune source et ne finaliser aucun head. Tester la reprise normale et le blocage honnête d’une capability absente.
- [ ] **5. Vérifier** `npx vitest run test/convergence-coalescence.spec.ts test/convergence-audit.spec.ts test/materialization-archive.spec.ts test/materialization-planner.spec.ts`. Fixture flux continu 258..261 puis 5 commits/min pendant une heure virtuelle : cible active non affamée ; au moins une tranche humaine/2 ; aucune répétition du préfixe ; noncritique bloqué n’immobilise pas la nouvelle paire ; ancien job ne régresse pas state/manifest/head. Inclure carried-forward d’une entité modifiée dans une révision coalescée : recalculer son semantic hash plutôt que se fier uniquement à l’opération du dernier record.
- [ ] **6. Commit** des fichiers listés, message `feat: coalesce safely and audit derived evidence without starvation`.

```bash
git add src/convergence/audit.ts test/convergence-coalescence.spec.ts test/convergence-audit.spec.ts src/convergence/engine.ts src/convergence/human.ts src/materialization/ledger.ts src/materialization/planner.ts test/materialization-archive.spec.ts
git commit -m "feat: coalesce safely and audit derived evidence without starvation"
```
## Tâche 10 — Scheduler indépendant, cursor fleet et ownership RegistryGuard

**Files:** Create `src/convergence/fleet.ts`, `test/convergence-fleet.spec.ts`. Modify `src/index.ts`, `src/index-neutral.ts`, `src/durable/registry-guard-neutral.ts` (routes techniques fleet seulement), `test/scheduled-business-priority.spec.ts`, `test/registry-guard-recovery.spec.ts`, `test/materialization-reconcile.spec.ts`.

**Interfaces:** Produit `MaintenanceJob = { name: "inbox" | "convergence" | "search"; run: (signal: AbortSignal) => Promise<unknown> }`, `runMaintenanceJobs(jobs: readonly MaintenanceJob[], timeoutMs: number): Promise<PromiseSettledResult<unknown>[]>`. Produit `FleetCursor { schema_version: "1.0"; after_project_id: string | null; pending_project_ids: string[]; turn_started_at: string; last_success_at: string | null }`. RegistryGuard garde ce cursor dans une table technique et checkpoint externe `/PROJECT_OS/.project-os/convergence/fleet.json` par CAS, distinct du registre métier. Routes internes nouvelles `GET /convergence-fleet` et `POST /convergence-fleet` : body `{ expected_token: string | null, cursor: FleetCursor }`, résultat `{ cursor: FleetCursor, token: string }`, 409 sur CAS. Aucun nouveau DO.

- [ ] **1. Test rouge :**

```ts
it("starts convergence and search while inbox is unresolved", async () => {
  const started: string[] = [];
  let release!: () => void;
  const inbox = new Promise<void>(resolve => { release = resolve; });
  const running = runMaintenanceJobs([
    { name: "inbox", run: async () => { started.push("inbox"); await inbox; } },
    { name: "convergence", run: async () => { started.push("convergence"); } },
    { name: "search", run: async () => { started.push("search"); } }
  ], 10_000);
  await Promise.resolve();
  expect(started).toEqual(["inbox", "convergence", "search"]);
  release();
  expect((await running).every(value => value.status === "fulfilled")).toBe(true);
});
```

- [ ] **2. Exécuter** `npx vitest run test/convergence-fleet.spec.ts test/scheduled-business-priority.spec.ts`. Ajouter le rouge de scheduler public dans le second test en inversant **uniquement** l’assertion scheduled qui imposait `maintenanceCallsWhileInboxBlocked` vide ; garder les assertions de commit/replay/cleanup et le comportement webhook autorisé.
- [ ] **3. Lancer les trois jobs immédiatement**, timeout et résultat indépendants ; pas de catch commun supprimant les résultats réussis.

```ts
export async function runMaintenanceJobs(jobs: readonly MaintenanceJob[], timeoutMs: number) {
  return Promise.allSettled(jobs.map(async job => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error(`${job.name}_timeout`)); }, timeoutMs);
    });
    try { return await Promise.race([job.run(controller.signal), timeout]); }
    finally { clearTimeout(timer!); }
  }));
}
```

Un timeout de job ne prouve pas l’annulation de ses effets ; ses owners gardent leurs continuations. Propager le signal aux appels internes, consommer les corps et persister les résultats/heartbeats par job. Budget job initial 240 s, chaque réveil projet 10 s, fleet concurrency4 ; valider une visite ≤300 s, sans loop retry cron. Recherche désactivée rapporte explicitement `disabled` et ne bloque pas convergence. Garder le job documents du worker neutral dans son domaine séparé.
- [ ] **4. Implémenter le cursor durable équitable** : trier par project_id, commencer après `after_project_id`, persister la page avec `pending_project_ids` avant livraison, retirer seulement les ACK de réveils enregistrés. Projet lent/failed reste pending pour le tour suivant mais ne remet pas le départ aux premiers IDs ; doubles cron CAS-safe. Si cursor perdu, rotation déterministe par numéro de cycle UTC, réaudit du registre complet, jamais sauter les archives. Registry indisponible = job failed et heartbeat failed, pas fleet current. `/reconcile` ne fait aucune projection inline et n’appelle pas `/recover-inputs`.

Test de précondition création : interrompre après allocation puis après commit avant registry publication, perdre SQLite, faire un cycle sans requête utilisateur et vérifier qu’un owner durable termine le registre puis le receipt. Si l’owner préexistant n’a pas cette capacité, test rouge d’intégration documenté, lot D non validé ; aucune extension opportuniste de la finalisation dans cette tâche. Pour projet déjà énumérable avec receipt création manquant, demander une reprise idempotente à RegistryGuard via une route owner dédiée `POST /resume-create` body `{ project_id: string; transaction_id: string }` ; elle recharge sa preuve d’allocation et appelle son finaliseur existant, jamais une création libre. L’introduire seulement après satisfaction du gate owner.
- [ ] **5. Vérifier** `npx vitest run test/convergence-fleet.spec.ts test/scheduled-business-priority.spec.ts test/registry-guard-recovery.spec.ts test/materialization-reconcile.spec.ts test/search-worker.spec.ts`. Oracles : un projet lent parmi10 ne bloque pas9, inbox throw/pending et search throw isolés, page ACK perdu, cursor CAS conflict, archives visitées sans workspace recréé, alarme absente découverte ≤300 s.
- [ ] **6. Commit** des fichiers listés, message `feat: schedule independent maintenance with durable fleet fairness`. Gate bloqué si test de continuation RegistryGuard non prouvé ; ne pas le marquer skip vert.

```bash
git add src/convergence/fleet.ts test/convergence-fleet.spec.ts src/index.ts src/index-neutral.ts src/durable/registry-guard-neutral.ts test/scheduled-business-priority.spec.ts test/registry-guard-recovery.spec.ts test/materialization-reconcile.spec.ts
git commit -m "feat: schedule independent maintenance with durable fleet fairness"
```

## Tâche 11 — Mutation-context signé, lecture canonique et admission ProjectGuard

**Files:** Create `src/admission/mutation-context.ts`, `test/mutation-context-contract.spec.ts`, `test/mutation-context-admission.spec.ts`. Modify `src/env.ts`, `src/index-neutral.ts`, `src/durable/project-guard-neutral.ts`, `src/durable/project-guard-subrequest-resilient.ts`, `test/project-guard-commit-recovery.spec.ts`.

**Interfaces:**

```ts
// src/admission/mutation-context.ts
export interface MutationContext {
  project_id: string;
  canonical_revision: number;
  state_hash: string;
  observed_at: string;
  expiry: string;
  token: string;
}
export interface MutationContextResponse {
  context: MutationContext;
  canonical_state: ProjectState;
  views: { state: string; handoff: string; status: "current" | "updating" | "unknown";
    verified_at: string | null };
}
export type AdmissionCode = "mutation_context_missing" | "mutation_context_expired"
  | "mutation_context_invalid" | "mutation_context_stale" | "canonical_unavailable"
  | "idempotency_payload_mismatch" | "convergence_capacity_exceeded";
export class AdmissionError extends Error {
  constructor(public readonly code: AdmissionCode, public readonly status: 409 | 428 | 503) {
    super(code); this.name = "AdmissionError";
  }
}
export interface ContextClaims {
  project_id: string; canonical_revision: number; state_hash: string; observed_at: string; expiry: string;
}
// Exports exacts à implémenter :
// issueMutationContext(state: ProjectState, secret: string, nowMs: number): Promise<MutationContext>
// verifyMutationContext(context: MutationContext | null, state: ProjectState,
//   baseRevision: number, secret: string, nowMs: number): Promise<void>
```

Ajouter `parseMutationContextOrNull(value: unknown): MutationContext | null`, parser Zod strict du contrat ci-dessus. Ajouter `MUTATION_CONTEXT_SIGNING_KEY?: string` dans Env, clé dédiée, jamais l’INGRESS_TOKEN. HMAC SHA-256 Web Crypto, token `base64url(UTF8(canonicalJson(claims))).base64url(signature)` ; comparer les claims de l’enveloppe à ceux signés, vérifier avec `crypto.subtle.verify`. Schéma strict, project regex, hash64, dates UTC, expiry=observed+300000, rejet de issued-in-future.

- [ ] **1. Test rouge**, sans endpoint ni secret réel :

```ts
it("binds the token to normalized state, project and submitted base", async () => {
  const state = commitFixture("PRJ-9258", 258)[257].state;
  const secret = "synthetic-context-secret-for-vitest-only";
  const now = Date.parse("2026-09-08T00:00:00.000Z");
  const context = await issueMutationContext(state, secret, now);
  expect(Date.parse(context.expiry) - Date.parse(context.observed_at)).toBe(300_000);
  await expect(verifyMutationContext(context, state, 258, secret, now + 1)).resolves.toBeUndefined();
  await expect(verifyMutationContext(context, state, 257, secret, now + 1)).rejects.toMatchObject({ code: "mutation_context_stale" });
  await expect(verifyMutationContext(context, state, 258, secret, now + 300_000)).rejects.toMatchObject({ code: "mutation_context_expired" });
});
```

- [ ] **2. Exécuter** `npx vitest run test/mutation-context-contract.spec.ts`. Attendu rouge sur exports absents.
- [ ] **3. Implémenter les claims exacts**, empreinte `await sha256Canonical(normalizeProjectState(state))` ; signature et vérification sont sans I/O provider.

```ts
const claims: ContextClaims = { project_id: state.project_id, canonical_revision: state.revision,
  state_hash: await sha256Canonical(normalizeProjectState(state)),
  observed_at: new Date(nowMs).toISOString(), expiry: new Date(nowMs + 300_000).toISOString() };
const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret),
  { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
const bytes = new TextEncoder().encode(canonicalJson(claims));
const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, bytes));
export function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const value of bytes) binary += String.fromCharCode(value);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
export function unbase64url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new AdmissionError("mutation_context_invalid", 428);
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), char => char.charCodeAt(0));
}
// Construction : token = `${base64url(bytes)}.${base64url(signature)}`.
// Vérification : crypto.subtle.verify("HMAC", key, unbase64url(signaturePart), claimsBytes).
```

- [ ] **4. Ajouter `GET /v1/projects/<project_id>/mutation-context` authentifié** ; le Worker lit le canonique validé via route interne read-only ProjectGuard `/mutation-context`, sans appel MaterializationGuard synchrone ni projection provider. Cette route utilise `discoverCanonical` sans `reconcileCanonicalCommits` (celui-ci absorbe localement et peut demander un handoff) : lecture bornée seule, sans inscription de cible. ProjectGuard renvoie `{ context, canonical_state }` ; **le Worker** rend `renderState` et `renderHandoff` depuis cet état pour la réponse, respectant l’interdiction de rendu dans ProjectGuard. `views.status` vaut `unknown` sans preuve de santé déjà observée et validée, jamais current d’après le seul head ; texte humain « vues en cours d’actualisation » dans la présentation du client lorsque pertinent. Si découverte incomplète, retourner 503 `canonical_unavailable`, pas de contexte partiel.

Admission `/transaction`, à l’intérieur de la sérialisation : parser transaction/enveloppe → vérifier identité payload déjà connue → recovery du commit exact → replay original si déjà committed → vérifier claims/base → réconcilier et revalider révision/hash courant → capacity gate → `applyTransaction` → commit. Pas de `persistReceipt`, `writeTerminalTransaction` ni réservation métier avant validation du contexte. Ajouter table SQLite additive `transaction_intents(transaction_id TEXT PRIMARY KEY, payload_hash TEXT NOT NULL)` pour empêcher le rebind pendant un rejet d’admission ; conserver le hash de la transaction stricte normalisée, pas du jeton. Après perte locale, un commit est comparé à son `record.transaction` avant replay ; une identité non commise sans preuve restante ne donne jamais autorité métier. Une intention modifiée exige nouvel ID, y compris une modification de base_revision après réévaluation.
- [ ] **5. Vérifier** `npx vitest run test/mutation-context-contract.spec.ts test/mutation-context-admission.spec.ts test/project-guard-commit-recovery.spec.ts test/model-lifecycle-concurrency.spec.ts`. Cas head257/canon258, null/forgé/wrong-project, hash faux, advance après GET, quatre additives (`research.add`, `constraint.add`, `task.create`, `deliverable.add`) stale refusées en strict, exact replay token expiré → receipt original, même ID contexte rafraîchi/payload identique → autorisé, payload changé → refus. Vérifier aucun receipt terminal créé par erreur d’admission, vrais conflits domaine inchangés.
- [ ] **6. Commit** des fichiers listés, message `feat: validate signed canonical mutation context before admission`.

```bash
git add src/admission/mutation-context.ts test/mutation-context-contract.spec.ts test/mutation-context-admission.spec.ts src/env.ts src/index-neutral.ts src/durable/project-guard-neutral.ts src/durable/project-guard-subrequest-resilient.ts test/project-guard-commit-recovery.spec.ts
git commit -m "feat: validate signed canonical mutation context before admission"
```

## Tâche 12 — Transport API/incoming/fallback et routes à effets

**Files:** Create `src/admission/transport.ts`, `test/mutation-context-transport.spec.ts`. Modify `src/index-neutral.ts`, `src/index-mutation-gate.ts`, `src/inbox/processor.ts`, `src/inbox/runtime.ts`, `src/durable/project-guard-neutral.ts`, `src/durable/project-guard-mutation-gate.ts`, `src/durable/project-guard-subrequest-resilient.ts`, `src/durable/project-guard-diagnostics.ts`, `src/continuity/rollback.ts`, `test/rollback-routing.spec.ts`, `test/resilient-document-transport.spec.ts`. Les handlers introduits par #147/#139 ne s’ajoutent à cette liste qu’après lecture de leurs chemins effectivement intégrés.

**Interfaces:** `AdmissionEnvelope<T> { admission_version: "1.0"; request: T; mutation_context: MutationContext | null }`, `decodeAdmission<T>(raw: unknown, parse: (value: unknown) => T): AdmissionEnvelope<T>`, `encodeAdmission<T>(request: T, context: MutationContext | null): AdmissionEnvelope<T>`. Legacy input décodé en context=null, jamais jeton fabriqué. Étendre `ExecuteTransaction = (transaction: Transaction, context?: MutationContext | null) => Promise<Receipt>` et `TransactionExecutor = (transaction: Transaction, context?: MutationContext | null) => Promise<unknown>`. `executeTransactionWithContinuity(env, transaction, candidate?, context?: MutationContext | null)` conserve le troisième paramètre. `RollbackExecutionInput` ajoute `context?: MutationContext | null` ; forward identique à candidate et stable. Artifact/document gardent leurs types stricts et reçoivent l’enveloppe à l’admission.

- [ ] **1. Test rouge de round-trip** :

```ts
it("preserves context separately from the strict transaction", async () => {
  const record = commitFixture("PRJ-9258", 2)[1];
  const context = await issueMutationContext(record.state, "test-context-key", 0);
  const envelope = encodeAdmission(record.transaction, context);
  expect(decodeAdmission(JSON.parse(JSON.stringify(envelope)), parseTransaction)).toEqual(envelope);
  expect(parseTransaction(envelope.request)).toEqual(record.transaction);
  expect(decodeAdmission(record.transaction, parseTransaction).mutation_context).toBeNull();
});
```

- [ ] **2. Exécuter** `npx vitest run test/mutation-context-transport.spec.ts test/rollback-routing.spec.ts`. Ajouter un test qui capture les deux appels candidate/stable et compare enveloppe/ID/bytes après échec candidate ; rouge tant que le contexte est perdu.
- [ ] **3. Implémenter l’enveloppe**, extraire request avant les parsers stricts, rejeter enveloppe tronquée/extra claims plutôt que downgrader en legacy.

```ts
export function encodeAdmission<T>(request: T, context: MutationContext | null): AdmissionEnvelope<T> {
  return { admission_version: "1.0", request, mutation_context: context };
}
export function decodeAdmission<T>(raw: unknown, parse: (value: unknown) => T): AdmissionEnvelope<T> {
  if (raw && typeof raw === "object" && "admission_version" in raw) {
    const input = raw as Record<string, unknown>;
    if (input.admission_version !== "1.0" || !("request" in input) || !("mutation_context" in input)
      || Object.keys(input).some(key => !["admission_version", "request", "mutation_context"].includes(key)))
      throw new AdmissionError("mutation_context_invalid", 428);
    return encodeAdmission(parse(input.request), parseMutationContextOrNull(input.mutation_context));
  }
  return encodeAdmission(parse(raw), null);
}
```

`parseMutationContextOrNull(value: unknown): MutationContext | null` est un export de mutation-context.ts à ajouter avec son schéma strict en tâche11 ; token manquant dans un objet ≠ null accepté. L’enveloppe n’entre jamais dans le commit record et n’est jamais loggée.
- [ ] **4. Transporter intégralement avant chaque effet** : API transactions/artifacts/documents, incoming dans `prepareTransactionInboxEntries` **et** exécution, intercepteurs MutationGate/working-head/diagnostics, candidate/stable. Une `AdmissionError` remonte telle quelle (HTTP428/409/503), n’est pas convertie en receipt ni en « technical » déclenchant fallback. Incoming garde l’entrée et diagnostic technique expurgé, sans compter vers l’archivage terminal après8 essais ; refresh requis côté client, pas de retouche automatique base_revision. Artifacts/documents vérifient `expected_revision` ou contexte.canonical_revision si la requête n’a pas ce champ, plus leurs expected_version/provider préconditions ; vérifier avant `prepare`, réservation métier, copie ou publication. Replay exact de leurs journaux précède freshness. La route promotion #147 doit atteindre cette même admission puis ses gates d’acceptation propres ; une route non migrée bloque le strict. `project.create` PRJ-AUTO reste sous RegistryGuard avec admission d’allocation propre : ne pas inventer un contexte d’un projet inexistant ni autoriser l’appel public direct à un PRJ alloué. La délégation interne RegistryGuard est liée à sa preuve d’allocation, pas à un header public de bypass.
- [ ] **5. Vérifier** `npx vitest run test/mutation-context-transport.spec.ts test/rollback-routing.spec.ts test/rollback-executor.spec.ts test/resilient-document-transport.spec.ts test/inbox-isolation.spec.ts test/mutation-gate-faults.spec.ts test/review-candidate-governance.spec.ts`. Rejouer transports legacy/strict, fallback absent/tronqué #139, promotion interrompue #147 si intégrée, publication interdite par MutationGate. Attendu : même transaction_id au plus un fallback, aucun effet stale et aucun downgrade admission ; limite MODEL001 conservée dans le domaine.
- [ ] **6. Commit** des fichiers listés, message `feat: preserve fresh admission across ingress and fallback paths`.

```bash
git add src/admission/transport.ts test/mutation-context-transport.spec.ts src/index-neutral.ts src/index-mutation-gate.ts src/inbox/processor.ts src/inbox/runtime.ts src/durable/project-guard-neutral.ts src/durable/project-guard-mutation-gate.ts src/durable/project-guard-subrequest-resilient.ts src/durable/project-guard-diagnostics.ts src/continuity/rollback.ts test/rollback-routing.spec.ts test/resilient-document-transport.spec.ts
git commit -m "feat: preserve fresh admission across ingress and fallback paths"
```

## Tâche 13 — Horloges, métriques, incidents durables et notification acquittée

**Files:** Create `src/convergence/observability.ts`, `test/convergence-observability.spec.ts`. Modify `src/convergence/engine.ts`, `src/convergence/fleet.ts`, `src/convergence/journal.ts`, `src/durable/project-guard-neutral.ts`, `src/deployment/identity.ts`, `docs/materialization.md`, `docs/deployment.md`.

**Interfaces:** Produit `commitClock(acceptedAt: string | null, immutableMetadata: ProviderObjectMetadata | null, firstObservedAt: string): { t0: string | null; first_observed_at: string; code: "commit_time_unknown" | null }`, `oldestPendingAgeMs(progress: Progress, nowMs: number): number`. `AlertRecord { schema_version: "1.0"; project_id: string; incident_id: string; layers: Layer[]; created_at: string; code: string; relative_path: string; expected: Evidence; observed: Evidence; last_success_at: string | null; owner: "MaterializationGuard"; diagnostic_path: string; deployment_sha: string }`. Notification port `deliver(alert: AlertRecord): Promise<{ acknowledged: boolean; delivery_id: string | null }>` fourni par l’adaptateur du monitoring de déploiement ; pas de nouveau backend imposé. Sans ACK réel le canal est non qualifié et rollout bloqué.

- [ ] **1. Test rouge :**

```ts
it("never uses transaction time as publication time", () => {
  expect(commitClock(null, null, "2026-09-08T00:20:00.000Z")).toEqual({
    t0: null, first_observed_at: "2026-09-08T00:20:00.000Z", code: "commit_time_unknown"
  });
  expect(commitClock(null, { path: "immutable", size: 1, modifiedAt: "2026-09-08T00:00:00.000Z" },
    "2026-09-08T00:20:00.000Z").t0).toBe("2026-09-08T00:00:00.000Z");
});
```

- [ ] **2. Exécuter** `npx vitest run test/convergence-observability.spec.ts`. Attendu rouge sur exports absents.
- [ ] **3. Implémenter les horloges**, n’utiliser `modifiedAt` que pour un record immuable validé dont la métadonnée représente la publication serveur, sinon unknown. Date post-retour du client seule ne prétend pas être l’acceptation serveur ; enregistrer l’événement structuré avec identité du commit et métadonnée fiable lorsque disponible, sans retarder le receipt pour une projection.

```ts
export function commitClock(acceptedAt: string | null, immutableMetadata: ProviderObjectMetadata | null,
  firstObservedAt: string) {
  const value = acceptedAt ?? immutableMetadata?.modifiedAt ?? null;
  const t0 = value && Number.isFinite(Date.parse(value)) ? value : null;
  return { t0, first_observed_at: firstObservedAt,
    code: t0 ? null : "commit_time_unknown" as const };
}
export function oldestPendingAgeMs(progress: Progress, nowMs: number): number {
  const pending = Object.values(progress.obligations).filter(value => value.state !== "verified");
  return pending.length ? Math.max(0, nowMs - Math.min(...pending.map(value => Date.parse(value.first_pending_at)))) : 0;
}
```

- [ ] **4. Émettre métriques et incidents** : compteurs `commit_observed`, `obligations_verified`, `retries`, `exhaustions`, `layer_conflicts`, `handoff_failures`, `freshness_rejections`, `conditional_write_conflicts` ; histogrammes `commit_to_layer_verified`, `tranche_duration` ; gauges `lag_revisions`, `oldest_pending_seconds`, `queue_depth`, `due_without_alarm`, `fleet_last_success_age`, `audit_cursor_age`. Labels métriques limités à couche/code/cause, IDs en logs authentifiés. Champs structurés exacts : `project_id`, `target_revision`, `observed_revision`, `layer`, `projection_version`, `generation_id`, `transaction_id`, `event_id`, `attempt_number`, `code`, `next_attempt_at`, `oldest_pending_at`, `deployment_sha`, `provider_calls`, `correlation_id`. Construire un objet whitelist, ne jamais spread Error/request/provider response.

Alert ID déterministe projet/couche/incident, create immutable avant delivery ; >600 s, exhausted ou blocked créent immédiatement l’incident à l’observation. Réserver et persister retries notification séparés ; ACK perdu = pending, même delivery ID au retry ; après burst limité sondes lentes. Rendre prochaine sonde UTC précise. Résolution uniquement si toutes `alert.layers` vérifiées et obligations liées fermées, conserver record et durée. Watchdog externe : deux cycles manqués=600s ; le Worker ne peut pas s’auto-détecter absent. Documenter l’adaptateur de monitoring effectivement choisi lors du déploiement futur et son test d’ACK ; aucun canal console-only ne satisfait le gate.
- [ ] **5. Vérifier** `npx vitest run test/convergence-observability.spec.ts test/inbox-observability.spec.ts test/deployment-identity.spec.ts`. Injecter notification perdue, erreur permanente, ACK puis crash checkpoint, monitoring absent, timestamp client faux, partial success, commit récent pendant divergence ancienne. Assertions texte alerte synthétique258 avec machine current/humain257, 640s/6 tentatives, deadline UTC ; logs sans canary secret/payload/Markdown/token/URL signée ; incident non fermé au succès machine seul.
- [ ] **6. Commit** des fichiers listés, message `feat: report durable convergence incidents and measured freshness SLOs`.

```bash
git add src/convergence/observability.ts test/convergence-observability.spec.ts src/convergence/engine.ts src/convergence/fleet.ts src/convergence/journal.ts src/durable/project-guard-neutral.ts src/deployment/identity.ts docs/materialization.md docs/deployment.md
git commit -m "feat: report durable convergence incidents and measured freshness SLOs"
```

## Tâche 14 — Lecteurs, activation progressive, backpressure et rollback compatible

**Files:** Create `src/convergence/rollout.ts`, `test/convergence-rollout.spec.ts`. Modify `src/env.ts`, `src/durable/materialization-guard.ts`, `src/persistence/repository-core.ts`, `src/persistence/repository.ts`, `src/index-neutral.ts`, `src/admission/mutation-context.ts`, `docs/commit-consistency.md`, `docs/materialization.md`, `docs/continuity.md`, `docs/deployment.md`, `docs/fault-injection.md`.

**Interfaces:** `ProjectConvergenceMode = "off" | "observe" | "repair"`, `AdmissionMode = "observe" | "strict"`. Configuration technique par projet parsée de `PROJECT_OS_CONVERGENCE_PROJECT_MODES?: string` et `PROJECT_OS_ADMISSION_PROJECT_MODES?: string` (JSON project→mode), defaults off/observe ; clé inconnue/version illisible=fail-closed sur le writer. `RolloutEvidence { reader_compatible: boolean; single_writer: boolean; fencing_proven: boolean; registry_continuation_proven: boolean; notification_ack_proven: boolean; transport_complete: boolean; capacity_qualified: boolean; recovery_qualified: boolean; compatible_stable_ready: boolean }`. `rolloutBlockers(e: RolloutEvidence): string[]`. `CapacityObservation { queued_outputs: number; oldest_pending_seconds: number; continuation_available: boolean; within_qualified_envelope: boolean }`, `assertCapacity(value: CapacityObservation): void` refuse avant nouveau commit si continuation indisponible ou enveloppe non qualifiée pour la charge observée ; réparations durables prioritaires et jamais rejetées pour ce motif.

- [ ] **1. Test rouge :**

```ts
it("blocks activation without full transport and a compatible rollback reader", () => {
  const e: RolloutEvidence = { reader_compatible: true, single_writer: true,
    fencing_proven: true, registry_continuation_proven: true, notification_ack_proven: true,
    transport_complete: false, capacity_qualified: true, recovery_qualified: true,
    compatible_stable_ready: false };
  expect(rolloutBlockers(e)).toEqual(["compatible_stable_ready", "transport_complete"]);
});
```

- [ ] **2. Exécuter** `npx vitest run test/convergence-rollout.spec.ts`. Attendu rouge sur exports absents.
- [ ] **3. Implémenter gate pur**, sans activer un projet de production :

```ts
export function rolloutBlockers(e: RolloutEvidence): string[] {
  return Object.entries(e).filter(([, proven]) => !proven).map(([name]) => name).sort();
}
export function assertCapacity(value: CapacityObservation): void {
  if (!value.continuation_available || !value.within_qualified_envelope)
    throw new AdmissionError("convergence_capacity_exceeded", 503);
}
```

Ajouter refus du downgrade après strict (checkpoint technique de floor lu par les runtimes compatibles), et refus d’un writer sans journal/fencing. Aucun ancien runtime ignorant les budgets ne peut être choisi comme stable. Ne pas changer ensemble continuity stable, MutationGate enforce, binary/promote activation ou writer schema.
- [ ] **4. Router tous les writers V2 activés vers MaterializationGuard** : admin `/materialize` devient une tranche bornée et renvoie HTTP202 `{ project_id, revision, materialized: false, status: "pending" }`, HTTP200 `materialized: true` seulement si health converged, 409 blocked explicite. Adapter `materializeExistingProjects` qui convertit aujourd’hui tout false en502. Baselines historiques suivent le même owner et leurs obligations applicables ; pas de retour à `repository.materializeV2` en concurrence. Garder les chemins legacy/shadow hors cutover, explicitement testés. L’ancien coordinator/runUntilIdle ne peut écrire un projet ayant le nouveau writer actif. Le drain/transfer d’activation exige aucun effet incertain et budgets/alarme repris avant writer switch.

Docs : corriger les références historiques ProjectGuard alarm/ledger et projection1 là où elles décrivent le courant, tout en conservant l’historique. Décrire la récupération automatique §13 : découverte → journaux → couches → humain → preuves → résolution ; admin authentifié est un diagnostic/reveil, pas une commande de réparation utilisateur. Conflits externes passent par gouvernance existante.
- [ ] **5. Vérifier** `npx vitest run test/convergence-rollout.spec.ts test/admin-workspace-v2-ledger.spec.ts test/project-guard-commit-compat.spec.ts test/schema/materialization-compat.spec.ts test/rollback-project-guard.spec.ts test/mutation-gate-faults.spec.ts`. Oracles : lecteurs d’abord, observe sans nouveau repair ni prétention strict, un writer/projet, données externes conservées, incompatible rollback refusé, strict conservé, archive intacte, admin202 honnête, overload avant commit sans consommation d’ID terminal.
- [ ] **6. Commit** des fichiers listés, message `feat: gate convergence rollout on compatible recovery and admission`.

```bash
git add src/convergence/rollout.ts test/convergence-rollout.spec.ts src/env.ts src/durable/materialization-guard.ts src/persistence/repository-core.ts src/persistence/repository.ts src/index-neutral.ts src/admission/mutation-context.ts docs/commit-consistency.md docs/materialization.md docs/continuity.md docs/deployment.md docs/fault-injection.md
git commit -m "feat: gate convergence rollout on compatible recovery and admission"
```

## Tâche 15 — Matrice exhaustive de fault injection et régression258

**Files:** Create `test/convergence-acceptance.spec.ts`, `test/convergence-capacity.spec.ts`. Modify `test/helpers/convergence-fixture.ts`, `test/convergence-journal.spec.ts`, `test/convergence-fencing.spec.ts`, `test/convergence-derivatives.spec.ts`, `test/convergence-human.spec.ts`, `test/convergence-retry.spec.ts`, `test/convergence-fleet.spec.ts`, `test/mutation-context-admission.spec.ts`, `test/mutation-context-transport.spec.ts`, `test/convergence-observability.spec.ts`, `test/convergence-rollout.spec.ts`, `test/registry-guard-recovery.spec.ts`, `docs/fault-injection.md`.

**Interfaces:** Consomme les exports exacts précédents et `installDropboxMock`. Exports test-only supplémentaires dans `test/helpers/convergence-fixture.ts` : `seedCommits(mock: ReturnType<typeof installDropboxMock>, records: readonly CanonicalCommitRecord[]): void` ; `readHealth(stub: DurableObjectStub): Promise<ConvergenceHealth>` ; `tick(stub: DurableObjectStub, nowMs: number): Promise<void>`. `tick` contrôle l’horloge via `vi.setSystemTime` et exécute `runDurableObjectAlarm` uniquement si l’alarme est due ; aucun nouveau hook runtime. Utiliser `runInDurableObject` pour effacer seulement les tables locales, et `evictDurableObject` pour relire le journal externe.

- [ ] **1. Ajouter le rouge intégral258** : seed records1..258 sous PRJ-9258, génération257 et paire257 depuis `planProjection(records[256], null, 3)` puis matérialisation de test ; seed258 sans handoff. Faire réparer event/state/manifest/receipt et refuser HANDOFF par failpoint. Plusieurs ticks jusqu’à640s : machine current, human/head257 ou paire mixte observée, `converged=false`, même first_pending_at, alerte ouverte. À20min, retirer fault et faire seulement cron/alarme : génération258/PV3, root et bytes corrects, aucun record259, même receipt original, incident résolu.

```ts
export function seedCommits(mock: ReturnType<typeof installDropboxMock>, records: readonly CanonicalCommitRecord[]): void {
  for (const record of records) mock.files.set(machineCommitRecordPath(record.project_id, record.new_revision),
    `${JSON.stringify(record, null, 2)}\n`);
}
export async function readHealth(stub: DurableObjectStub): Promise<ConvergenceHealth> {
  const response = await stub.fetch("https://materialization-guard.internal/status");
  if (!response.ok) throw new Error(`health_status_${response.status}`);
  return (await response.json<{ convergence: ConvergenceHealth }>()).convergence;
}
export async function tick(stub: DurableObjectStub, nowMs: number): Promise<void> {
  vi.setSystemTime(nowMs);
  const due = await runInDurableObject(stub, async (_instance, state) => state.storage.getAlarm());
  if (due !== null && due <= nowMs) await runDurableObjectAlarm(stub);
}
```

- [ ] **2. Exécuter** `npx vitest run test/convergence-acceptance.spec.ts`. Le test doit détecter la régression si l’on retire la vérification humaine, la découverte indépendante ou la persistance des compteurs dans un revert temporaire local ; restaurer immédiatement les modifications. Attendu rouge ciblé puis vert, pas un test qui ne lit que le head.
- [ ] **3. Paramétrer chaque frontière persistée** avec la matrice ci-dessous. Étendre les tests de leurs tâches d’origine, ne pas remplacer leurs assertions par des snapshots opaques.

```ts
const windows = ["before", "after_lost_response", "crash_before_checkpoint",
  "concurrent_replay", "local_ledger_loss", "ambiguity_read_failed"] as const;
const boundaries = ["commit_record", "local_commit", "handoff", "attempt_reservation",
  "progress_checkpoint", "event", "receipt", "state", "manifest", "human_state",
  "human_handoff", "noncritical_output", "conditional_delete", "archive_move",
  "generation_record", "head", "alert_record", "notification_ack", "fleet_cursor", "alarm"] as const;
```

`before/after` provider utilisent les phases du mock ; local_commit/alarme utilisent spy sur stockage et eviction ; notification un double ACK ; handoff un double fetch DO ; concurrent replay retient une promise puis libère après nouvelle incarnation. Chaque combinaison pertinente compare contenu et nombre de records/events/receipts, token/hash, revision, compteur, alarme et incident. Pour une frontière non provider, « after lost response » signifie succès du propriétaire puis ACK perdu. Relecture de levée d’ambiguïté indisponible doit rester unknown ; jamais transformer cette ligne en simple exception attendue sans vérifier l’absence d’effet supplémentaire.

| Famille spec §14 | Tests propriétaires | Scénarios et oracles requis |
|---|---|---|
| Commit | commit-repository, project-guard-commit-recovery | record unique, réponse perdue, autre payload même revision, crash avant persistCommit ; original receipt ou unknown explicite |
| Identité/recovery | convergence-derivatives, mutation-context-admission | wrong-project, payload rebinding, snapshot stale/futur, same-revision invalide, trou+record ultérieur, baseline historique ; aucun saut |
| Handoff | materialization-guard-isolation, convergence-acceptance | non livré, non2xx, timeout, ACK perdu, duplicate, mauvais binding, corps consommé ; aucune I/O humaine PG |
| Dérivés | convergence-derivatives | pannes indépendantes4 couches, suppression/corruption après génération, trous historiques, event258 bloqué et autres réparables |
| Régression258 | convergence-acceptance | machine seule ne clôt pas humain ; retour provider sans transaction ni commande |
| Coalescence | convergence-coalescence | rafale258..261, flux continu, reprise vieux job ; tous events/receipts, actif non affamé, snapshots/head monotones |
| Paire critique | convergence-human, convergence-fencing | un Markdown, vérification failed, edit avant CAS/après génération, write tardif après reprise, noncritique blocked puis261 ; pas de fausse paire |
| Génération | convergence-human | record complet/head failed, root/parent/cycle corrompu, 128/129, projection inconnue ; immuable préservé |
| Scheduler | convergence-retry | alarm absent/duplicate/late, constructor→alarm, setAlarm failed, polling, crash réservation ; dates persistantes |
| Backoff | convergence-retry | 429 Retry-After, 5xx, timeouts, six échecs, retour20min, permanent ; délais exacts et régime lent |
| Journaux | convergence-journal | chaque write réservation/progress/alert, perte SQLite, stale/CAS concurrent/corrupt ; pas reset budget |
| Fleet | convergence-fleet | inbox throw/pending, search failed, registry unavailable, 1 lent/10, cursor perdu, backlog ; fairness/archive |
| Capacité | convergence-capacity | enveloppe10×5/min×200 outputs, 20 modifiés/1MiB, budget épuisé, long chain, afflux ; continuation et overload explicite |
| Fraîcheur | mutation-context-admission | head257/canon258, absent/expired/forged/wrong-project, advance après GET, additive stale, replay committed expired |
| Transports | mutation-context-transport | API/incoming/legacy, fallback139 incomplet/tronqué, numéro Markdown seul ; strict fail-closed |
| Registry/archive | registry-guard-recovery, materialization-archive | avant finalisation/nonénumérable, create receipt missing, move ACK perdu, roots conflictuelles ; owner et aucune résurrection |
| Rollback | rollback-executor, convergence-rollout | candidate avant/après commit, stable failed, downgrade incompatible ; même ID, au plus1 fallback, pas rewind |
| Gouvernance | mutation-context-transport, mutation-gate-faults | promotion147 interrompue/rejouée, document externe divergent, gate bloque ; aucune nouvelle acceptation |
| Observabilité | convergence-observability | notification perdue, monitoring absent, faux timestamps, sanitation, succès partiel ; incident durable |

- [ ] **4. Ajouter qualification virtuelle de capacité** :24h, 10 projets, cadence5/min/projet,200 outputs et20 changés/commit,1MiB maximum, provider concurrency1 puis4, fleet4. Tracer calls/tranche, latence/couche/t0, oldest_pending, files depth et audit tour ; mesurer les percentiles99/99,9 aux seuils120/600s et visite300s. Tester au-delà de l’enveloppe pour obtenir admission backpressure explicite, priorité aux commits déjà durables. Un test virtuel ne qualifie pas la latence cloud : le canary24h autorisé séparément reste obligatoire. Aucune exception provider soustraite des SLI globaux.
- [ ] **5. Vérifier** `npx vitest run test/convergence-acceptance.spec.ts test/convergence-capacity.spec.ts` puis `npm run test:persistence-high-risk`. Attendu : toutes les lignes ont un test exécutable et une preuve, aucun test désactivé ou marqueur inachevé ni fixture PRJ-0003 réelle. Si un gate antérieur échoue, corriger le module propriétaire en cycle rouge/vert et commit dédié, sans affaiblir les oracles.
- [ ] **6. Commit** des tests et docs listés, message `test: prove post-commit recovery across all persisted boundaries`.

```bash
git add test/convergence-acceptance.spec.ts test/convergence-capacity.spec.ts test/helpers/convergence-fixture.ts test/convergence-journal.spec.ts test/convergence-fencing.spec.ts test/convergence-derivatives.spec.ts test/convergence-human.spec.ts test/convergence-retry.spec.ts test/convergence-fleet.spec.ts test/mutation-context-admission.spec.ts test/mutation-context-transport.spec.ts test/convergence-observability.spec.ts test/convergence-rollout.spec.ts test/registry-guard-recovery.spec.ts docs/fault-injection.md
git commit -m "test: prove post-commit recovery across all persisted boundaries"
```

## Tâche 16 — Vérification finale, dossier de revue et rollout séparé

**Files:** Modify `docs/deployment.md`, `docs/materialization.md`, `docs/fault-injection.md`, `docs/continuity.md` pour joindre les résultats de qualification de l’implémentation. Test : suites existantes et nouvelles. Aucun changement de la spécification revue dans cette tâche. Aucun changement de config production dans cette tâche.

**Interfaces:** Consomme toutes les preuves A–G et `RolloutEvidence`. Produit un dossier de preuve par SHA avec matrice test→invariant, jobs CI, dry-run, limites mesurées et blockers restant ; la complétion de production est séparée de la complétion du code.

- [ ] **1. Vérifier les préconditions d’intégration** sur le main retenu : #147 (SHA, API, acceptation, provider/version/journal), #139 (enveloppe exacte), RegistryGuard avant énumération, schema floors #79, recherche #115/#116 et gouvernance #93/#94. Toute collision modifie seulement les adaptateurs de ce plan, pas les scopes des PR propriétaires. Ne pas fusionner une PR ouverte implicitement. Vérifier `git diff --check` et revue par lot ; joindre les rouges/verts ciblés au dossier de preuve.
- [ ] **2. Exécuter les gates réellement présents** :

```bash
npm ci
npm run check
npm run test:persistence-high-risk
node scripts/check-index001-deployment-gates.mjs
npx vitest run test/commit-repository.spec.ts test/project-guard-commit-recovery.spec.ts test/materialization-faults.spec.ts test/materialization-guard-isolation.spec.ts test/rollback-executor.spec.ts test/rollback-project-guard.spec.ts test/rollback-routing.spec.ts test/registry-guard-recovery.spec.ts test/project-guard-direct-concurrency.spec.ts test/provider-resilience.spec.ts test/dropbox-document-concurrency.spec.ts test/schema/materialization-compat.spec.ts
```

Attendu : exit0, aucun test échoué/skippé pour les exigences. **INDEX001 vérifié à la base :** `check:index001-remediation` appelle bien `node scripts/check-index001-deployment-gates.mjs`, et high-risk passe par ce script. Une ancienne description de PR signalait un nom absent ; elle ne décrit pas ce checkout. Revalider les commandes sur le main choisi, ne pas recopier cette ancienne divergence et ne pas substituer silencieusement une commande verte à un gate échoué. Aucun changement package.json n’est prévu par ce plan.

- [ ] **3. Exécuter le build sans déploiement sur le SHA final** :

```bash
git rev-parse HEAD
npx wrangler deploy --dry-run
git status --short
```

Attendu : bundle généré, sortie0, aucun déploiement ; SHA et sortie conservés dans le dossier de preuve d’exécution. Utiliser le skill Cloudflare Wrangler avant cette commande dans la mission d’implémentation. Si `npm run types` génère un diff attendu, le revoir puis refaire les gates sur le nouveau SHA. Toute modification après les résultats exige refaire les gates affectés et le dry-run final.
- [ ] **4. Vérifier les sept phases du rollout** et ne lancer chacune qu’après satisfaction de son gate :

| Phase | Preuve exigée / arrêt |
|---|---|
| Lecteurs/diagnostic | convergence v1 lisible, schémas métier stricts inchangés, baseline historique explicite |
| Observe | aucune nouvelle réparation, vecteur confronté aux bytes, inventaire clients, canal d’alerte testé |
| Canary isolé | autorisation distincte, projet synthétique alloué normalement, writer unique, ancien retry désactivé, stable compatible préparé |
| Qualification ≥24h | récupération pré/postcommit, perte SQLite/handoff,258 synthétique, exhaustion puis retour, archive/sans trafic, enveloppe et SLO, exercice alerte/rollback |
| Migration admission | tous transports/handlers couverts puis strict par projet, routes non migrées bloquantes |
| Extension graduelle | sécurité violée arrête extension ; SLO hors budget suspend extension en conservant repair ; ne pas coupler d’autres activations |
| Production | SHA/CI/health exacts, convergence automatique et admission fraîche prouvées ; mission canonique PRJ-0002 distincte |

Rollback : runtime compatible avec journal/continuation/budget/freshness ; drain/transfer prouvé, pas d’effacement SQLite/externe, pas de révision ou projection diminuée ; à défaut rollback d’activation avec reader/recoverer conservés et nouvelles mutations bloquées lorsque sûreté non prouvée. Aucun canary ou exercice de panne sur PRJ-0003.
- [ ] **5. Commit documentaire final**, uniquement des preuves effectivement obtenues : `git add docs/deployment.md docs/materialization.md docs/fault-injection.md docs/continuity.md` puis `git commit -m "docs: record convergence verification and rollout gates"`. Exiger revue des lots puis CI/dry-run sur ce SHA aussi. Le dossier de PR décrit comportement, validation réelle et blockers, sans confondre CI et preuve production.

## Auto-revue du plan contre la spécification

Revue documentaire effectuée sur les16 sections ; cette matrice ne prétend pas que les tests futurs passent.

| Spec | Couverture du plan | Vérification de cohérence |
|---|---|---|
| §1 Objet | header, lots et16 | plan uniquement, commit unique conservé |
| §2 Sources/collisions | préflight, signatures,10/12/16 | #147 revalidée ouverte/draft, scope préservé ; #139 et schema gates explicites |
| §3 Incident258 |2/8/15 | état machine/humain distinct, fixture synthétique, aucune cause historique affirmée |
| §4 Approche | architecture,3/7/10 | pas de queue externe ni DO nouveau |
| §5 Invariants1–3 |5/6/11/15 | unicité, ambiguïté, bindings, chaîne et replay |
| §5 Invariants4–8 |2–9/15 | event/receipt exhaustifs, monotonicité, paire, progrès reconstruit |
| §5 Invariants9–12 |10–16 | owners, freshness, conflicts, limites honnêtes |
| §6 Responsabilités |5/7/10/11/14 | PG sans rendu, MG sans métier, Registry finalisation gate, cron indépendant |
| §7.1 Santé |2/6/8/13 |10 couches exactes, holes/current/unknown, generation vs bytes |
| §7.2 Journal |3/4/5 | progress/attempts/alerts, CAS/incarnation, reconstruction, aucune suppression |
| §7.3 Transitions |3/7/9 | running interne, compteurs/âge par épisode, pas reset nouveau commit |
| §8 Convergence |4/6/9/10 | budgets réels HTTP, continuations, alternance, targets garées, cron/archive |
| §9 CAS/finalisation |5/8/9/14 | neutralisation des effets tardifs sur chaque destination, chaîne128, writer unique |
| §10 Retries |3/4/7/13 | réservation vs tranche,6 échecs, Retry-After, sondes/alarme minimum |
| §11 Fraîcheur |11/12/14 | route auth,clé dédiée,5min,admission sans receipt,replay,4 additives,transports et promotion |
| §12 Observabilité |13/14/15/16 | t0 serveur ou unknown,30jours,SLI120/600,10projets,ACK/watchdog,qualification |
| §13 Recovery |6–10/13/14 | procédure runtime, exhaustion automatique, conflits owner,admin borné |
| §14 Fault matrix |15 + tests propriétaires |19 familles et20 frontières,6 fenêtres,oracles de contenu/compteur |
| §15 Compatibilité |12/14/16 |7 phases,stable compatible,strict conservé,production/canonique distincts |
| §16 Acceptation/limites |15/16 | convergence sans mutation,chaque couche injectable,SLO mesuré,pas de promesse offline |

Contrôle de types : distinction `Target.revision` / `MaterializationHead.target_revision`, `ProjectionBaseline` planner / coordinator, `result_root_hash` existant / `Evidence.root_hash` exposé, `CommitWriteOptions.publishReceipt` au core et `ActivationDerivativeOptions.projectionVersion` dans la façade, `TransitionResult.kind === "commit"`, `receipt.status === "committed"`, `MutationContext.expiry` unique, milliseconds internes/dates ISO externes. Les ajouts de ports optionnels traversent adapter/resilience/schema-policy/factory/tests avant d’être requis par repair. Aucun type du commit/génération n’est étendu par le journal.

La mission de rédaction initiale s’arrêtait au document et à la PR draft #148. Le mandat actuel reprend ce plan dans le même fil, sans nouveau chat : après revue de la spécification v1.1, l’exécution suit les lots dans l’ordre, avec TDD, revue par lot, gates de rollout et preuves de production distinctes.
