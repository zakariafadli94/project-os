# Project OS — Plan d’exécution V2 de fiabilisation persistante

> **Statut : VALIDÉ par le Founder dans cette conversation le 24 septembre 2026 — EXÉCUTION AUTORISÉE.** Ce document remplace le plan trop sommaire `2026-09-24-end-to-end-persistence-reliability.md`. Les gates de qualification restent obligatoires avant fusion, déploiement et réception.
>
> **Pour les exécutants :** après validation explicite, utiliser `superpowers:subagent-driven-development` avec les responsabilités et les gates ci-dessous. Les cases sont les opérations à exécuter ; une case n’est cochée qu’avec sa preuve. Ne pas remplacer ce plan par un résumé.

**Objectif :** une demande approuvée, effectivement reçue durablement, continue jusqu’à sa finalisation vérifiée ou jusqu’à un conflit explicite, sans nouveau lancement de revue par le Founder. Une réponse perdue reste retrouvable. Les lectures utiles restent bornées pendant les travaux longs. Les chats classiques doivent être qualifiés avant de déclarer la livraison terminée.

**Architecture :** conserver Dropbox comme autorité canonique et ProjectGuard, MaterializationGuard, RegistryGuard, Control Tower, les alarmes et journaux existants. Ajouter des contrats de reprise, des curseurs et des preuves dans ces composants ; ne pas ajouter de service. Les caches SQL accélèrent la lecture, mais ne constituent pas une seconde autorité métier.

**Stack :** TypeScript, Cloudflare Workers/Durable Objects, SQLite local aux DO, adaptateur Dropbox, MCP/OAuth existants, Vitest.

**Spécification :** sections 1 à 8 de ce document. Sources de contraintes : demandes validées du Founder ; plans `2026-09-19-autonomous-request-recovery.md`, `2026-09-20-productivity-first-sop-completion.md`, `2026-09-12-sop-enforcement-runtime.md` ; matrice `docs/superpowers/specs/2026-09-12-sop-runtime-coverage-matrix.md`.

## 1. Périmètre, résultats et limites

### 1.1 Ce que cette livraison doit changer

1. Une lecture de reçu connu fonctionne pendant une matérialisation longue.
2. Le contexte frais se calcule depuis une base prouvée et les changements récents, sans relire systématiquement tout l’état historique depuis Dropbox.
3. Une requête interrompue indique si elle n’a pas été envoyée, si son issue est inconnue ou si elle a été reçue durablement. Ces états ne sont jamais confondus.
4. Après réception durable, la reprise est exécutée par le système, sans lecture de statut ou message du Founder pour la déclencher.
5. Les validations restent attachées aux mêmes contenus et versions pendant la reprise technique.
6. La finalisation, les scans et les travaux documentaires ont des limites de temps, d’appels et d’éléments ; leur progression est enregistrée.
7. Une dette ancienne couverte ne maintient pas la capacité artificiellement occupée.
8. Les quatre vues PROJECT/PLAN/STATE/HANDOFF sont contrôlées avant la publication de la tête.
9. Les réponses aux chats sont bornées, paginées et permettent de retrouver le contenu intégral.
10. La qualification inclut réellement les chats classiques anciens/nouveaux, Work local et Codex. Une liste de tools côté serveur n’est pas la preuve de leur disponibilité dans une conversation.
11. Le statut expose la prochaine action du système, le prochain réveil et l’éventuelle action humaine nécessaire.
12. Les preuves de livraison et les travaux SOP restants sont persistés et retrouvables sans relire cette conversation.

### 1.2 Garanties réalistes

- La garantie de reprise serveur commence après l’enregistrement de l’intention exacte. Un serveur ne peut pas récupérer un document qu’aucune voie ne lui a transmis.
- Un timeout de POST n’est pas une preuve d’absence de commit. Une vérification d’identité précède toute répétition.
- Une panne du fournisseur peut retarder le résultat ; le système doit préserver la demande, exposer le retard et reprendre automatiquement après rétablissement.
- Une absence d’outil dans une conversation est distincte d’une panne du Worker. Le dépôt ne peut pas à lui seul forcer la plateforme à monter un outil absent.
- Les fichiers Dropbox visibles ne changent pas atomiquement en groupe. La tête vérifiée reste la référence officielle pendant une publication partielle ; les lectures indiquent cette situation.
- Une indisponibilité technique ne réclame pas une nouvelle validation du même contenu. Une modification du contenu, de sa version ou une décision contradictoire exige une résolution métier réelle.
- Le terme « terminé » n’est pas utilisé si un gate obligatoire de ce document reste sans preuve.

### 1.3 Contraintes globales

- Work local existant ; aucun lancement cloud. Worktree : `/Users/zakariafadli/Documents/Codex/2026-09-06/project-os-input-retry-remediation/project-os/.worktrees/permanent-convergence-rectification` ; branche `fix/permanent-convergence-rectification`.
- Préserver `worker-configuration.d.ts` et les modifications étrangères. Aucun reset destructif.
- Aucun nouveau service, abonnement, base, secret manuel, worktree ou projet test de production.
- Les écritures métier canoniques passent par les opérations typées, l’admission et un reçu ; les réparations techniques passent par les moteurs existants, jamais par l’édition manuelle de Dropbox.
- Les projets indépendants et les chats où le Founder travaille restent disponibles. Aucune injection de message ou changement de leurs outils pendant les tests sans désignation explicite du chat de qualification.
- Alertes humaines facultatives ; incidents et reprise autonomes obligatoires.
- Aucun élargissement de REVIEW_CANDIDATE ou des droits binaires par défaut.
- Aucun secret dans les prompts, rapports, logs, réponses MCP ou pièces de test.
- Aucun engagement de disponibilité à 100 % ni d’achèvement en deux heures non démontré.

## 2. État de départ et traitement des travaux prématurés

Observation locale du 24 septembre 2026, à rafraîchir au démarrage après validation :

| Élément | État | Traitement prescrit |
|---|---|---|
| Base avant cette intervention | `91c34301b46e742d7baffc98d63c83fa80efe8a9` | Point de comparaison local ; ne pas le confondre avec main/production |
| Reçu séparé du statut | commit `6abfe29` | Candidat au lot E2, à compléter et revoir |
| Ancien plan et baseline | commit `f006006` | Historique ; ne prouve pas une validation du Founder |
| Contexte paginé | commit `53b394f` | Candidat E4 ; incomplet sur récupération des champs tronqués et borne en octets |
| Compteur de finalisation | commit `59a042c` | Candidat E7 ; 16 tests ciblés passés, budgets et reprise à compléter |
| Registry/fallback | modifications non commitées dans `registry-guard-neutral.ts`, `index-mutation-gate.ts`, `fallback-ingress.spec.ts`, nouveau `registry-create-status.spec.ts` | Candidats E6 ; aucune présomption de validité |
| Tests transport MCP | modifications non commitées dans `control-tower-artifact.spec.ts` | Deux tests rouges attendus E5, pas une régression déjà corrigée |
| PRJ-0003 | Dernière observation : rev. 353, SOP `TXN-PRJ0003-RESEARCHSOP-20260924T064940Z-Q7M4` committed/finalized | Observation historique ; nouvelle lecture obligatoire avant intervention, jamais rejouer cette transaction sur cette seule base |
| Production | Dernière baseline : SHA `fe1eb15a49ee5baac855d49f5580335ac5f07ae1` | À relire ; les commits locaux ci-dessus n’ont pas été déployés dans cette intervention |

Les agents sont interrompus. Aucun résultat local ne compte comme livré avant revue, qualification, déploiement et réception.

## 3. Contrats publics obligatoires

### 3.1 Identité et preuve

La clé logique est `(project_id, kind, request_id)`. Le digest est le SHA-256 de la sérialisation canonique de la demande métier validée par son schéma. Le contexte d’admission, l’identifiant de corrélation et l’enveloppe de chiffrement ne font pas partie de ce digest.

- Même clé et même digest : retourner le reçu ou l’état existant ; reprendre seulement les étapes manquantes déjà autorisées.
- Même clé et autre digest : `idempotency_payload_mismatch`, aucun effet.
- Rafraîchir le contexte signé ne crée ni une nouvelle décision ni une nouvelle identité de demande.
- Ne pas changer `base_revision`, le contenu ou les versions attendues sous le même identifiant pour faire passer un conflit.
- `project.create` conserve `PRJ-AUTO` dans la requête d’origine ; l’allocation réelle est retrouvable par son transaction_id.

### 3.2 Statut de transport distinct du reçu métier

Les types existants de Receipt restent compatibles. Ajouter une enveloppe d’observation, sans réécrire l’historique :

```ts
type PersistenceObservation = {
  project_id: string;
  kind: "transaction" | "document" | "artifact";
  request_id: string;
  status: "not_submitted" | "unknown" | "not_received"
    | "admitted_uncommitted" | "committed" | "finalizing"
    | "finalized" | "rejected" | "conflict" | "failed";
  observed_at: string;
  receipt: unknown | null;
  receipt_status: "committed" | "rejected" | "conflict" | null;
  execution_status: string | null;
  terminal: boolean;
  code: string | null;
  correlation_id: string;
  recovery: {
    durable_intent: boolean | null;
    state: "none" | "scheduled" | "running" | "blocked" | "complete";
    next_attempt_at: string | null;
    action: "check_status" | "retry_same_request" | "resume_execution"
      | "wait_for_dependency" | "resolve_conflict" | "none";
    owner: "client" | "system" | "operator" | "founder" | "none";
    requires_new_approval: boolean;
  };
};
```

Les réponses historiques restent disponibles ; ces champs sont additifs. `terminal` de l’enveloppe signifie fin de l’exécution complète, pas seulement fin de l’admission. `committed` peut donc être associé à `terminal:false`.

| Situation | Réponse imposée | Action automatique |
|---|---|---|
| Lecture de contexte échoue avant POST | `not_submitted`, code de dépendance | Préserver demande ; prochaine tentative même ID/contenu, contexte frais |
| POST lancé, réponse perdue | `unknown` | Lire receipt puis request-status ; aucun nouvel ID |
| Intention prouvée, pas de commit | `admitted_uncommitted`, recovery scheduled/running | Alarme reprend l’intention exacte |
| Reçu prouvé, vues en cours | `committed` ou `finalizing`, reçu présent | Matérialisation/finalisation autonome |
| Toutes les preuves vérifiées | `finalized`, terminal true | Action none |
| Cache local vide, fournisseur indisponible | `unknown`, jamais `not_received` | Réessayer la lecture bornée |
| Absence prouvée dans les sources autorisées, aucune admission concurrente | `not_received` | Même demande admissible à un nouvel essai |
| Conflit de version/contenu | `conflict` | Résolution explicite ; pas de rebase silencieux |
| Six mêmes échecs internes sans progression | recovery blocked, incident | Arrêt de cette boucle ; autres demandes indépendantes continuent |

### 3.3 Budgets prescrits

Ce sont des limites d’implémentation et des cibles de qualification, pas une promesse de latence Dropbox.

| Travail | Limite |
|---|---|
| Appel externe Control Tower : lecture ou soumission | 10 000 ms, couvrant fetch ET lecture JSON ; AbortController partagé |
| Fraîcheur interne de contexte | 5 000 ms et 32 appels provider maximum pour la requête, sans remise à zéro par page |
| Lecture chaude inchangée | 0 téléchargement state.json et au plus 2 lectures de commit si provenance déjà prouvée dans l’instance |
| Réponse de contexte opérationnel | 24 KiB UTF-8 sérialisés maximum ; maximum 50 tâches, maximum réel réduit pour respecter les octets |
| Détail paginé | 16 KiB UTF-8 maximum, chunk de texte jusqu’à 4 KiB UTF-8 |
| Taille d’un curseur entrant | 1 024 octets maximum ; nombres entiers sûrs et positifs |
| Tranche de convergence existante | 25 s, 32 appels, réserve de checkpoint existante de 4 appels/3 s conservée |
| Callback de finalisation | 4 candidats examinés maximum, 4 générations de lignée maximum ; arrêt anticipé selon budget partagé |
| Reprise des demandes | Lot existant de 4, curseur circulaire persistant par projet |
| Vérification de fichiers | 8 au départ, réduction par budget restant, progression enregistrée après chaque fichier |
| Suite d’erreurs identiques internes | 6 sans progression ; signature erreur + empreinte progression |
| Retry technique temporaire | 5/15/30/60/120 s, plafond 120 s ; respecter un Retry-After fournisseur supérieur |
| Reprise après tranche utile incomplète | Continuer dans le budget courant ou programmer l’alarme avant retour ; cible de réveil +1 s, sans garantir l’heure d’exécution de la plateforme |

Une requête froide trop volumineuse retourne `unknown/unavailable` et programme le travail technique de préparation dans le mécanisme existant. Elle ne signe pas une fraîcheur partielle. Les lectures de receipt/status restent sans effets ; elles n’enclenchent pas de réparation.

### 3.4 Frontière d’acceptation durable et classification des échecs

Le serveur n’annonce `admitted_uncommitted` qu’après avoir conservé l’intention exacte et une continuation récupérable. L’ordre est : valider l’identité et l’admission, conserver l’intention immuable et sa preuve, enregistrer le travail de reprise, armer le réveil, puis répondre. Si une interruption sépare ces écritures, le scan borné existant doit retrouver l’intention orpheline après éviction. Aucun acquittement « reçu durablement » ne repose seulement sur une Promise en mémoire ou `waitUntil`.

| Erreur observée | Classe | Comportement obligatoire |
|---|---|---|
| Timeout, 429, panne réseau, 5xx du fournisseur | Dépendance temporaire | Backoff borné, même intention, préserver l’approbation ; aucun rejet métier |
| `slice_budget_exhausted` avec progression | Découpage normal | Checkpoint puis prochaine tranche ; ne pas incrémenter la série d’échec interne |
| Capacité avant admission | Backpressure | Aucune revision/receipt artificielle ; le client conserve l’original ; ne pas créer d’inbox de secours |
| Authentification absente, scope insuffisant | Accès | Diagnostic explicite ; pas de retry métier jusqu’au rétablissement de l’accès |
| Version/hash/précondition divergente | Conflit réel | Préserver les preuves et les deux états ; action de résolution ciblée |
| Même défaut de code six fois sans changement de progression | Défaut interne | Incident persistant et arrêt de la boucle concernée ; aucune remise en revue automatique |
| Effet déjà présent, certificat absent | Finalisation | Vérifier identité/version/hash puis certifier ; ne pas recopier le contenu |

Les erreurs fournisseur temporaires ne sont pas confondues avec un bug interne répété : après plusieurs pannes identiques, diminuer la fréquence selon le backoff et les réveils existants, sans invalider le travail accepté. Le compteur de progression est remis à zéro seulement par une étape durable réellement nouvelle.

## 4. Garanties de productivité et conservation des validations

Pour chaque demande durable, conserver l’identité exacte du contenu, ses versions de ressource, sa référence d’acceptation si requise, le résultat d’admission, le digest et les étapes déjà effectuées.

```text
Validation métier de V
→ admission de la demande D portant V
→ panne technique
→ reprise de D et V avec leur preuve originale
→ contrôle des effets existants
→ finalisation
```

La reprise ne remet pas la revue à zéro, ne repasse pas un document de validé à brouillon, ne réécrit pas la décision d’acceptation et ne réclame pas un nouvel accord du Founder. Si les octets/version ont changé, le système expose le conflit exact au lieu de réutiliser une validation sur un autre contenu.

Avant admission durable, un refus de capacité ne peut pas être transformé en reçu d’acceptation. Le client garde l’intention exacte lorsqu’il dispose d’un stockage autorisé. Un chat sans voie d’écriture reçoit la capacité manquante et une voie opérationnelle réellement disponible ; le système ne prétend pas disposer d’une reprise serveur avant réception.

## 5. Agents et ordre d’exécution

Principal (rôle Astra demandé par le Founder ; le modèle effectif reste celui sélectionné dans l’application) : orchestration, contrats partagés, intégration, revue de qualification, seule autorité de fusion/déploiement/réparation de production. Trois agents maximum : **A, B et C en `gpt-6-luna`, effort `high`**. Ils travaillent exclusivement dans le Work local et le worktree indiqués.

| Vague | Principal | Agent A | Agent B | Agent C |
|---|---|---|---|---|
| 0 | E0 inventaire puis E1 contrats ; tous les contrats gelés avant code parallèle | Arrêté | Arrêté | Arrêté |
| 1 | Revue des livraisons, ledger ; aucune édition des fichiers délégués | E2 puis E3 : ProjectGuard/read-trace | E4 : contexte MCP | E6 : Registry/fallback |
| 2 | Intègre E2–E6 dans l’ordre des contrats | E7 : finalisation ProjectGuard | E5 : transport MCP et façade create-status | E8 : capacité et jobs documentaires |
| 3 | E11 qualification de bout en bout et vérification des capacités | Revue indépendante E4–E6 | E9 : quatre vues et scans | E10 : non-régression des validations/reprises |
| 4 | E12 qualification globale | Revue E8–E9 | Revue E2–E3/E7 | Revue entrées et exigences |
| 5 | E13 production, E14 réception réelle, E15 clôture persistante | Lecture/revue seulement | Lecture/revue seulement | Lecture/revue seulement |

Les tests E10 ne modifient pas les fichiers des agents A/B ; si une correction touche un fichier réservé, C transmet un défaut reproductible à son propriétaire et attend son commit.

Chaque tâche suit : test discriminant rouge → changement minimal → test vert → revue par quelqu’un d’autre que l’auteur → commit ciblé → preuve dans le ledger. Un mécanisme déjà correct n’est pas réécrit : sa preuve est enregistrée et le gap est clos.

## 6. Discipline d’orchestration persistante

Créer, après validation, `docs/superpowers/evidence/2026-09-24-persistence-execution-ledger.md` avec une ligne par E0–E15 : owner, dépendance, état, prochain geste exact, SHA, test, défaut ouvert, preuve de production. États permis : `not_started`, `active`, `blocked_external`, `implemented`, `reviewed`, `qualified`, `deployed`, `verified`.

- Une anomalie entrante est reliée à une tâche et une classe de panne. Elle ne remplace pas le programme complet.
- Un blocage urgent de production peut préempter la tâche courante : checkpoint, récupération autorisée, vérification, puis reprise de la tâche interrompue.
- Un échec de test implique analyse de cause et correction du propriétaire, pas l’ajout de retries au test sans justification.
- Un agent ne reçoit pas une deuxième tâche dépendante avant revue de la première ; pas d’édition concurrente du même fichier.
- Les défauts qui changent une décision métier, nécessitent un nouveau service ou un droit indisponible sont de vrais points d’arrêt pour la branche dépendante. Les travaux indépendants se poursuivent.
- Aucun résultat intermédiaire ne termine l’exécution autorisée. Une fin de tour n’est pas présentée comme un processus continu.
- Cette discipline prend effet uniquement après validation de ce document.

## 7. Carte des fichiers et interfaces

| Domaine | Fichiers existants à modifier seulement si requis | Livrable |
|---|---|---|
| Contrat public | nouveau `src/persistence/observation.ts` ; `src/execution/contract.ts` | Enveloppe additive, mapping des états |
| Lecture rapide et fraîcheur | `src/durable/project-guard-neutral.ts`, `project-guard-diagnostics.ts`, `project-guard-subrequest-resilient.ts`, `src/convergence/discovery.ts` | Receipt sans attente longue ; cache prouvé monotone |
| Réponses aux chats | `src/control-tower/mcp.ts` ; nouveau `src/control-tower/context.ts` | Pagination et détails, limites d’octets |
| Délais de soumission | nouveau `src/control-tower/transport.ts`, `src/control-tower/mcp.ts` | Corrélation, budget, statut inconnu récupérable |
| Create/fallback | `src/durable/registry-guard-neutral.ts`, `src/index-mutation-gate.ts`, `src/fallback/contract.ts`, `crypto.ts` | Allocation retrouvable et statut d’échange protégé |
| Finalisation/reprise | `src/durable/project-guard-neutral.ts`, `src/execution/journal.ts`, `src/durable/materialization-guard.ts` | Travail borné et prochain réveil durable |
| Capacité | `src/convergence/capacity.ts`, `rollout.ts`, `journal.ts`, `src/durable/materialization-guard.ts` | Charge exécutable, causes structurées |
| Jobs fichiers | `src/documents/change-coordinator.ts`, `change-job-store.ts` | Quarantaine sans perte historique |
| Publication | `src/materialization/planner.ts`, `coordinator.ts`, `ledger.ts` | Groupe de quatre vues, réparation bornée |
| Entrées | `src/admission/governed-submit.ts`, `transport.ts`, `src/inbox/processor.ts`, `runtime.ts`, `src/index-neutral.ts` | Même identité/admission, pas de duplication incoming |
| Surface utilisateur | `src/control-tower/index.ts`, `auth.ts`, `src/index-neutral.ts` | Capacités effectives, identité de déploiement |
| Déploiement | `.github/workflows/deploy.yml`, `deploy-control-tower.yml` | Utiliser les workflows existants ; changements seulement si nécessaires à une identité/gate manquante |

Les nouveaux petits modules ci-dessus servent seulement à isoler des contrats et formateurs purs de fichiers déjà volumineux. Aucun framework de workflow ou second registre de requêtes métier.

## 8. Cinq risques transversaux à tester explicitement

1. Lecture ancienne qui finit après un commit plus récent : pas de régression de cache, pas de signature incohérente — E3.
2. Même requête, contexte signé renouvelé ou clés JSON réordonnées : même identité métier ; contenu modifié refusé — E5/E6/E10.
3. Titres/actions en Unicode et champs immenses : borne UTF-8 réelle et récupération intégrale — E4.
4. Nouveau déploiement entre réception et finalisation : intention/validation historique lisible et reprise compatible — E7/E10/E12.
5. Plugin visible mais outils absents dans un ancien chat : pas de succès annoncé et scénario réel obligatoire avant clôture — E11/E14.

## 9. Tâches d’implémentation détaillées

### E0 — Établir une base exacte et conserver les travaux locaux

**Responsable :** principal. **Dépendance :** validation explicite du plan.

- [ ] Relire AGENTS du dépôt et les quatre sources de spécification mentionnées en tête ; consigner les contraintes applicables.
- [ ] Exécuter `git status --short`, `git diff --stat`, `git log -10 --oneline`, puis comparer au SHA de main distant après fetch. Garder un inventaire des commits/diffs locaux et de leurs propriétaires.
- [ ] Lire l’identité des deux Workers déployés et les résultats CI associés ; noter les SHA effectivement en production séparément des SHA locaux.
- [ ] Résoudre PRJ-0003, PRJ-0007 et les projets actifs via le registre. Charger STATE/HANDOFF puis seulement les statuts nécessaires : tête, demandes en cours, obligations, réveils.
- [ ] Relire le reçu et l’exécution de la transaction SOP signalée ; si finalized, enregistrer la preuve et ne pas la soumettre.
- [ ] Créer le ledger d’exécution et la matrice de réception. Assigner chaque diff prématuré à E2/E4/E5/E6/E7.
- [ ] Exécuter les tests ciblés de la base une fois. Distinguer échecs préexistants, tests rouges intentionnels et défauts d’infrastructure de test.

**Sortie :** baseline horodatée, diff net connu, aucune mutation métier. **Gate :** chaque dette possède un request_id connu ou est explicitement classée « identité à récupérer », jamais reconstruite de mémoire.

### E1 — Fixer les contrats et leurs adaptateurs

**Responsable :** principal. **Dépendance :** E0.

- [ ] Créer `src/persistence/observation.ts` avec `PersistenceObservation` de §3 et un mapping pur des états existants ; ne changer aucun statut stocké historique.
- [ ] Ajouter `test/persistence-observation.spec.ts` avec le tableau §3 : un reçu committed et exécution pending donne terminal false ; absence locale+provider down donne unknown ; aucune requête envoyée donne not_submitted.
- [ ] Définir les signatures communes : `requestDigest(request): Promise<string>`, `observeRequest(projectId, kind, requestId): Promise<PersistenceObservation>`. Réutiliser la primitive SHA canonique existante pour requestDigest.
- [ ] Rendre `recovery.action`, owner et next_attempt_at cohérents : scheduled implique réveil présent ; blocked implique incident/code ; finalized implique action none et preuve de finalisation.
- [ ] Publier dans le ledger la version des contrats consommés par A/B/C, puis lancer la vague 1.

**Test discriminant :**
```ts
expect(observeFixture({ receipt: committed, execution: pending })).toMatchObject({
  receipt_status: "committed", terminal: false,
  recovery: { owner: "system", requires_new_approval: false }
});
expect(observeFixture({ local: null, provider: "unavailable" }).status).toBe("unknown");
```
`observeFixture` est un helper de ce nouveau test qui appelle le mapping pur avec les fixtures du tableau ; aucune dépendance réseau.

**Vérification :** `pnpm exec vitest run test/persistence-observation.spec.ts` ; typecheck. **Commit :** `feat: define recoverable persistence observations`.

### E2 — Lecture de reçu courte, indépendante de la finalisation

**Responsable :** A. **Dépendance :** E1. **Fichiers :** ProjectGuard neutral/diagnostics, `test/project-guard-read-trace.spec.ts`, `test/execution-guard.spec.ts`. Le branchement MCP existant de `6abfe29` est revu par B à E5.

- [ ] Bloquer artificiellement une réconciliation fournisseur dans le test ; précharger un reçu committed dans le journal local. Appeler `/receipt` et exiger ce reçu sans attendre la réconciliation.
- [ ] Lire d’abord le reçu local immuable de la bonne famille et du bon projet, avant le refus global READ_BUSY. Ne pas lancer de reprise depuis cette lecture.
- [ ] Sans reçu local, tenter une lecture canonique directe bornée des preuves existantes ; contrôler projet, ID et digest lorsqu’il est disponible.
- [ ] Si le journal distant ou la file concurrente empêche de prouver l’absence, retourner unknown/read-busy avec identité et prochaine action. Ne jamais convertir 503 en 404.
- [ ] Garder `/request-status` comme observation détaillée et `/execution-status` comme observation des étapes. Vérifier par spies que les trois GET ne produisent ni certificat ni effet métier.
- [ ] Ajouter un cas de cache vidé après commit : reçu retrouvé depuis la preuve canonique sans rejouer la transaction.

**Assertions :** le reçu connu est retourné avant la libération du faux provider ; zéro appel au moteur de finalisation ; autre project_id refusé ; lookup inconcluant = unknown.

**Vérification :** `pnpm exec vitest run test/project-guard-read-trace.spec.ts test/execution-guard.spec.ts test/project-guard-recovery.spec.ts`. **Commit :** `fix: keep committed receipts readable during background work`.

### E3 — Contexte frais avec cache prouvé et concurrence monotone

**Responsable :** A. **Dépendance :** E2. **Fichiers :** ProjectGuard neutral/subrequest-resilient, discovery, read-trace et mutation-context-admission tests.

- [ ] Ajouter un RED : deux lectures inchangées ne retéléchargent pas deux fois state.json. Compter les appels de l’adaptateur, pas seulement le nombre de méthodes.
- [ ] Ajouter un RED concurrent : lecture revision N suspendue, commit N+1, fin de lecture N ; cache final N+1 et réponse jamais issue d’un cache régressé.
- [ ] Au démarrage froid, vérifier le snapshot contre le commit exact : projet, revision, event_id, état canonique/digest. Avec données legacy sans commit, utiliser uniquement le chemin de migration déjà qualifié ; aucune déduction « local donc fiable ».
- [ ] Marquer en mémoire la provenance du cache après commit vérifié/reconstruction ; après éviction refaire cette vérification. Une ligne SQL arbitraire ne suffit pas.
- [ ] Vérifier le suffixe immutable par accès direct séquentiel jusqu’à absence autoritative du commit suivant. Partager un seul budget de 5 s/32 appels entre toutes les pages.
- [ ] Après awaits, comparer à nouveau la revision locale dans une courte section sérialisée. Si elle est plus récente, reprendre la vérification depuis cette base prouvée ; si le budget ne le permet pas, unavailable.
- [ ] Ne jamais laisser un Promise tardif issu d’un timeout écrire un état ni signer un contexte. Signer uniquement après la vérification complète du suffixe ; le point d’admission revérifie ensuite la concurrence.
- [ ] Sur reconstruction trop longue, conserver son curseur technique dans la reprise existante et rendre unavailable ; les GET receipt/status ne deviennent pas réparateurs.
- [ ] Tester snapshot altéré, mauvais projet, trou de chaîne, cache absent, provider timeout et commit pendant signature. Une nouvelle mutation concurrente après émission du contexte reste détectée à l’admission.

**Assertions :**
```ts
expect(provider.downloadsOfState).toBe(0); // lecture chaude prouvée
expect(after.revision).toBeGreaterThanOrEqual(before.revision);
expect(responseWithIncompleteSuffix.status).toBe(503);
expect(signedPartialContext).toBeUndefined();
```
Les compteurs sont installés dans les helpers mock Dropbox existants ; les révisions du test sont 353 et 354, sans production.

**Vérification :** `pnpm exec vitest run test/project-guard-read-trace.spec.ts test/mutation-context-admission.spec.ts test/project-guard-direct-concurrency.spec.ts test/project-guard-commit-recovery.spec.ts`. **Commit :** `fix: verify fresh context from monotone canonical checkpoints`.

### E4 — Contexte compact et détails intégralement récupérables

**Responsable :** B. **Dépendance :** E1 ; intégration E3 avant qualification finale. **Fichiers :** MCP, nouveau context.ts, `test/control-tower-artifact.spec.ts`, nouveau `test/control-tower-context.spec.ts`.

- [ ] Réutiliser `53b394f` comme point de départ et remplacer la troncature irréversible à 256 caractères.
- [ ] Lire `plan_phases`, jamais `phases`. Trier les tâches par task_id selon un ordre déterministe indépendant de locale.
- [ ] Conserver `project_os_get_context({project_id,cursor?})` : résumé du projet/phase, tâches, totals, returned_count, truncated_fields, next_cursor, revision et octets de la réponse.
- [ ] Ajouter `project_os_get_context_detail({project_id,revision,entity_type,entity_id,field,cursor?})`. Types permis : project, phase, task ; champs autorisés par type, accès arbitraire à un chemin interdit. Fournir la liste des champs autorisés dans le schéma/déclaration MCP.
- [ ] Liste exacte des champs de détail : project = `name`, `slug`, `objective` ; phase = `title`, `objective`, `next_actions` ; task = `title`, `description`, `blocked_reason`, `result`. L’identité et les dates courtes restent entières dans les résumés. `next_actions` est paginé par index puis par offset de texte ; l’ordre des éléments est conservé. Un champ optionnel absent retourne `value:null`, pas un texte inventé.
- [ ] Chaque champ résumé tronqué porte un detail_ref (identité, champ, revision). Les next_actions longs, blocked_reason et titres ne sont pas perdus.
- [ ] Construire la page avec mesure TextEncoder du JSON final : ne pas scinder une paire Unicode ; réduire le nombre de tâches si nécessaire ; le contexte signé ne doit jamais être tronqué.
- [ ] Curseur = version de format, projet, revision, collection/champ et offset. Le parser impose la taille et des entiers sûrs ; révision changée = `CONTEXT_CURSOR_STALE`, aucun mélange de pages.
- [ ] Tester une phase de 200 KiB, 55 puis 1 000 tâches, titres et actions de 20 KiB, emojis/accents, curseur falsifié/hors bornes et changement de révision entre pages.
- [ ] Reconstituer le texte intégral et toutes les tâches dans le test à partir des pages ; comparer au digest original.

**Assertions :** chaque réponse <=24 KiB (détail <=16 KiB), aucune omission non signalée, concaténation des détails exacte. **Vérification :** tests MCP/context ciblés. **Commit :** `fix: bound chat context without losing retrievable details`.

### E5 — Soumission bornée, corrélée et récupérable

**Responsable :** B. **Dépendances :** E2/E3/E4 et contrat create-status E6. **Fichiers :** MCP, nouveau transport.ts, tests control-tower-artifact/transport/operator.

- [ ] Conserver les deux tests rouges déjà écrits : panne avant POST -> not_submitted ; panne après POST -> unknown avec même request_id.
- [ ] Implémenter une unique deadline de 10 s incluant lecture du contexte, soumission et parsing de réponse. Le reste du budget accompagne les appels, avec un seul AbortSignal et correlation_id.
- [ ] Logger uniquement ID, famille, frontière, durée, résultat. La réponse ne reprend pas les messages bruts d’exception fournisseur.
- [ ] Une fois le POST lancé, toute erreur de transport/parsing retourne unknown et `check_status_before_retry:true`. L’annulation du transport ne prétend pas annuler un commit serveur.
- [ ] Avant POST, contexte indisponible retourne not_submitted ; la demande originale n’est ni modifiée ni déposée automatiquement dans incoming.
- [ ] API, outil opérateur et MCP conservent l’identité métier. Réutiliser executeGovernedSubmission lorsque compatible ; conserver les vérifications serveur de règles et d’autorité.
- [ ] Adapter les outils get_receipt/get_request_status pour PRJ-AUTO/kind transaction vers le contrat Registry d’E6. Refuser PRJ-AUTO avec document/artifact.
- [ ] Ajouter tests fake timers : fetch bloqué, JSON bloqué, timeout après commit simulé, réponse invalide, requête exacte répétée et mauvaise liaison projet.

**Assertion déterminante :** un seul POST lors d’un timeout ; la lecture ultérieure retrouve le même reçu ; aucun appel incoming. **Vérification :** `pnpm exec vitest run test/control-tower-artifact.spec.ts test/control-tower-operator.spec.ts test/control-tower-transport.spec.ts test/mutation-context-transport.spec.ts`. **Commit :** `fix: preserve submission identity across transport deadlines`.

### E6 — Statut récupérable des créations et échanges fallback

**Responsable :** C. **Dépendance :** E1. **Fichiers :** RegistryGuard, index-mutation-gate, fallback contract/crypto, registry-create-status/fallback-ingress tests.

- [ ] Relire et qualifier les modifications partielles avant de les conserver ; ne pas les traiter comme contrat accepté.
- [ ] Registry expose en interne `GET /create-status?transaction_id=...`, sans allocation ni mutation : ligne requests existante, ID alloué, reçu, reprise connue. Sur cache perdu, vérifier le journal canonique Registry ; indisponibilité = unknown.
- [ ] Façade authentifiée : `GET /v1/project-creates/{transaction_id}/request-status`. Réutiliser la validation stricte transaction_id existante et empêcher toute divulgation sans autorité de lecture.
- [ ] Fallback : enregistrer, avant appel métier, liaison échange ↔ identité logique ↔ digest métier ↔ identité autorisée du client. Réutiliser stockage Registry existant ; aucune file globale d’exécution longue.
- [ ] Le statut d’un échange n’est accessible qu’à son autorité d’origine. Le lookup protégé renvoie le minimum ; tout contenu métier/receipt sensible reste sous le contrat chiffré existant. Une route publique non authentifiée de recherche est interdite.
- [ ] Une enveloppe rechiffrée avec nouvelle clé/contexte et même demande reste la même identité métier ; ne pas hasher admission_json pour décider si la demande a changé.
- [ ] Après perte de réponse, rechercher la liaison puis le receipt/statut de l’owner. Si la liaison manque, retourner unknown et vérifier par l’ID métier original ; ne pas conclure absence.
- [ ] Tester perte de réponse après allocation, après commit, après rotation de clé ; cache Registry perdu ; accès avec autre identité ; même ID métier/contexte renouvelé ; même ID/contenu modifié ; timeout du lookup.

**Gate :** récupération sans seconde allocation/transaction ; zéro contenu sensible dans réponse publique/log. **Vérification :** tests registry-create-status, registry-guard-recovery, fallback-ingress, plus `pnpm run check:fallback-ingress-boundaries`. **Commit :** `fix: recover create and fallback outcomes by original identity`.

### E7 — Finalisation autonome bornée et persistante

**Responsable :** A. **Dépendance :** E3 ; contrats E1/E5 intégrés avant E10. **Fichiers :** ProjectGuard, MaterializationGuard (réservé à A jusqu’au commit E7), execution journal, execution-guard tests.

- [ ] Garder le RED/GREEN de `59a042c` : cinq candidats manquants, quatre examinés au premier callback, un restant. Ajouter candidats déjà terminalisés et mix éligible/inéligible.
- [ ] Compter chaque candidat dès sa prise en charge, avant tout continue. Partager le budget provider/temps entre lecture tête, lignée, journal et certificat ; réserver le checkpoint.
- [ ] Persister le curseur après progression, avant de perdre le budget. Sur crash avant checkpoint, la reprise peut relire mais ne produit aucun second effet/certificat contradictoire.
- [ ] Un callback incomplet assure un prochain réveil durable via le mécanisme existant ; l’appelant MaterializationGuard ne doit pas être l’unique détenteur volatile de la prochaine action.
- [ ] Injecter une interruption après chacune des étapes de §3.4 : écriture d’intention, enregistrement de reprise, armement, réponse. Après éviction, retrouver toute intention acceptée par le scan borné ; zéro acquittement durable si sa preuve manque.
- [ ] Vérifier transaction/digest, receipt committed, liaison projet/event/génération, ascendance et couverture explicite. La comparaison arithmétique `revision <= head` seule n’est pas une preuve.
- [ ] Ne pas élargir l’inférence historique de coalescence : l’exception legacy existante n’est utilisable que dans son contrat déjà qualifié ; les nouveaux records énumèrent la couverture.
- [ ] Préserver les demandes committées pendant nouvelle activation de règle : finaliser sous leur admission persistante, pas sous une nouvelle interprétation de la règle.
- [ ] Tester trois commits successifs avec coalescence, interruption entre certificat et checkpoint, perte d’appel retour, éviction DO et reprise seulement par alarme, sans GET de statut.
- [ ] Séparer les compteurs de panne fournisseur, tranche épuisée et bug interne suivant §3.4. L’incident contient la dernière progression vérifiée, le request_id et le prochain geste technique ; une erreur transitoire ne rouvre pas la revue.

**Gate :** toutes les exécutions effectivement couvertes terminent ; au plus quatre candidats par callback ; progression/alarme persistées avant retour incomplet. **Vérification :** execution-guard, project-guard-alarm-serialization, materialization-guard-isolation. **Commit :** `fix: checkpoint and reschedule bounded finalization work`.

### E8 — Capacité réelle, obsolescence prouvée et quarantaine

**Responsable :** C. **Dépendance :** E7 pour libérer materialization-guard.ts. **Fichiers :** capacity/rollout/journal, MaterializationGuard, change-coordinator/change-job-store ; tests existants associés.

- [ ] Rafraîchir les tests existants : les 39 tests ciblés précédemment verts ne couvrent pas forcément tous les cas suivants.
- [ ] Fixture 309/310/312 : clore 309 uniquement si la lignée vérifiée de 310 la couvre ; continuer 312. Cas jumeau sans couverture : aucune clôture.
- [ ] Filtrer les obligations vérifiées, continuations vides et jobs quarantined du nombre de travaux exécutables. Un incident terminal peut arrêter sa ressource dépendante, sans bloquer arbitrairement les ressources indépendantes.
- [ ] Garder `convergence_capacity_exceeded` et ajouter reason, canonical_revision, materialized_revision, queued_outputs, oldest_pending_seconds, blocking_obligation, retry_after_seconds. Retourner repair_required sans faux délai lorsqu’aucun retry ne peut réussir.
- [ ] Ne pas augmenter les seuils 200 sorties/600 s pour masquer la dette. Si charge supérieure, refuser clairement avant commit et exposer le périmètre qualifié.
- [ ] Vérifier metadata générique avant metadata fichier : folder -> réconciliation structure ; missing -> écart diagnostiqué ; vraie erreur transitoire fichier -> retry.
- [ ] Ancien job visant dossier : état terminal quarantined, incident directory_used_as_file_target, compteur gelé, historique gardé. Reprise uniquement après preuve d’une nouvelle cible fichier valide.
- [ ] Tester deux projets : un fournisseur bloqué sur A et progression sur B. Ajouter 30 projets simulés dont cinq écrivent ; chaque alarme/fleet utilise curseur et limite existants, aucun scan global à chaque admission.

**Gate :** pas de capacité occupée par travail inexécutable sans dépendance ; aucune obligation certifiée sans couverture ; absence de famine des projets indépendants. **Commit :** `fix: account for executable convergence debt only`.

### E9 — Quatre vues cohérentes et scans récupérables

**Responsable :** B. **Dépendances :** E7/E8. **Fichiers :** planner/coordinator/ledger, MaterializationGuard ; tests materialization-planner/faults/repository/guard-isolation.

- [ ] Ajouter la revision cible à l’input de PROJECT, PLAN, STATE et HANDOFF ; rendre leur preuve obligatoire dans le groupe de publication.
- [ ] Étendre la vérification critique actuellement limitée à STATE/HANDOFF : les quatre chemins, hashes, provider revisions et revision de rendu correspondent à la même génération.
- [ ] Réutiliser les documents métier inchangés par référence ; ne pas régénérer recherches/décisions/archives pour actualiser seulement la revision des vues.
- [ ] Préparer puis vérifier les quatre fichiers avant publication de la tête conditionnelle. Crash après deux fichiers : ancienne tête officielle conservée, mixed views signalées, reprise des deux étapes restantes.
- [ ] Ne pas marquer conforme un ancien record qui ne porte pas les nouvelles preuves. Le lire de façon compatible ; générer une nouvelle projection technique avec la version adéquate selon la convention existante, sans revision métier artificielle.
- [ ] Borner `MaterializationGuard.canonicalState` par le budget et un curseur de reconstruction vérifié. Ne jamais utiliser une reconstruction incomplète comme état courant.
- [ ] Borner `repairHeadFromCompletedRecords` : chemin normal = pointeur/record directs ; récupération historique = listing paginé et checkpoint. La réparation de tête exige les mêmes preuves de publication.
- [ ] Tester PROJECT absent/périmé, HEAD périmé, interruption, delta réutilisé, ascendance invalide et 1 000 records historiques avec appels bornés.

**Gate :** aucune nouvelle tête publiée sans les quatre preuves ; scan interrompu reprend ; aucune révision métier créée pour le rattrapage. **Commit :** `fix: verify current view group before publishing materialization head`.

### E10 — Continuité des validations et identité sur toutes les entrées

**Responsable :** C pour tests/revue ; propriétaires pour corrections. **Dépendances :** E5–E9. **Fichiers :** nouveaux tests `test/persistence-entry-parity.spec.ts`, `test/persistence-approval-continuity.spec.ts` ; réutiliser inbox/admission/execution fixtures.

- [ ] Exécuter la même demande logique par API, MCP, inbox et fallback lorsque la famille est supportée. Comparer identity/digest, refus métier et reçu. Une famille non supportée reste explicitement non disponible, jamais une route implicite.
- [ ] Injection aux quatre frontières : avant intention ; après intention ; après commit ; après effet physique et avant certificat. Attendre seulement les alarmes, puis contrôler le résultat.
- [ ] Vérifier même ID/JSON réordonné, même ID/contenu modifié, enveloppe d’admission renouvelée et deux admissions simultanées.
- [ ] Refus direct de capacité : zéro dépôt automatique incoming. Demande arrivée par inbox : une enveloppe unique, retry/backoff visible, pas de nouveau transaction_id.
- [ ] Approver une version V en fixture, provoquer trois timeouts puis reprise ; aucune nouvelle décision ni demande de revue, statut d’approbation intact, même digest V finalisé.
- [ ] Modifier V en V+1 pendant la panne ; la validation de V n’autorise pas V+1. Le conflit indique les deux versions et la seule action métier requise.
- [ ] Contrôler REVIEW managé séparément de REVIEW_CANDIDATE, binaires et opérations admin : aucune suppression de garde pour réussir les tests.

**Assertions communes :** `canonicalCommitsFor(id) <= 1`, même receipt au replay, zéro effet après refus, approval_ref inchangée, aucune dépendance d’un GET pour progresser. **Commit :** `test: prove persistence and approval continuity across entry paths`.

### E11 — Capacités utilisables et erreurs actionnables dans les chats

**Responsable :** principal. **Dépendances :** E4/E5/E6/E10.

- [ ] Vérifier le handler MCP réellement déployable, sa découverte de tools et ses scopes. L’identité serveur utilise les secrets existants ; le modèle n’en reçoit aucun.
- [ ] Adapter `/v1/capabilities` et un outil MCP read-only `project_os_get_capabilities` pour décrire les capacités serveur effectives : lecture, transaction/document/artifact, receipts, status, fallback, versions de protocole et SHA.
- [ ] Séparer `server_supported` de `callable_in_this_session`. Le serveur ne déclare pas connaître les outils montés dans le client ; ce second champ vient uniquement de l’observation du client.
- [ ] Afficher en cas d’outil absent `PROJECT_OS_CONNECTOR_UNAVAILABLE`, capability manquante, requête non soumise et voies effectivement disponibles. Pas de conseil vague « demander un chat dédié ».
- [ ] Fallback n’est utilisé que si le chat possède un transport autorisé et peut préserver la demande intégrale/chiffrement requis. Si aucun transport n’existe, exposer cette limite avant de laisser croire qu’une canonisation est en cours.
- [ ] Ajouter preuve/texte d’erreur actionnable : request_id, étape, propriétaire de prochaine action, next_attempt_at, dépendance précise, aucune revalidation métier pour simple incident technique.
- [ ] Créer une fiche de qualification unique pour les quatre surfaces d’E14 ; ne modifier aucun chat actif du Founder.

**Gate :** capacités honnêtes, mêmes noms/schémas d’outils, absence de secret et voie de statut utilisable depuis chaque surface effectivement équipée. **Commit :** `feat: expose actionable persistence capabilities and recovery status`.

### E12 — Qualification intégrée, charge et revue indépendante

**Responsable :** principal + revue croisée A/B/C. **Dépendance :** E2–E11 reviewed.

- [ ] Finir les tests ciblés de chaque lot. Aucun RED intentionnel ne doit rester dans le diff livré.
- [ ] Exécuter une fois sur le SHA candidat : typecheck, suite complète, gates du dépôt et les tests search-sync-off requis. Les avertissements/exceptions non attendus sont classés ; exit 0 seul n’efface pas une exception réelle.
- [ ] Simuler 30 projets dont cinq actifs, 200 sorties/projet, 20 sorties modifiées/commit, au plus cinq commits/minute/projet actif. Provider fixture 100 ms puis panne transitoire 30 s sur un projet ; mesurer appels/tranche, délais et backlog.
- [ ] Enregistrer aussi le volume d’état lu/écrit par commit et le nombre de lignes SQLite écrites, sur 50 puis 1 000 commits. Les snapshots complets inhérents au format existant sont rapportés séparément du coût évitable du chemin chaud ; aucune revendication de coût constant si le format canonical duplique encore l’état complet.
- [ ] Acceptance fixture : <=32 appels/tranche, curseurs persistés, aucune duplication, progression de tous les projets indépendants, projection de 200 sorties terminée en <=128 réveils dans le profil qualifié ; reprise après panne sans statut manuel.
- [ ] Comparer état de 50 vs 1 000 commits historiques : lecture chaude inchangée sans lecture proportionnelle à l’historique, réponse context bornée, finalisation jamais plus de quatre candidats/callback.
- [ ] Faire les dry-runs Guard et Control Tower, vérifier absence de dépendance/secrets/nouvelle ressource Cloudflare non prévue et compatibilité des schémas persistés.
- [ ] Revue croisée sur diff net : auteur différent ; mapper chaque constat à une exigence et chaque gate à un test/trace. Aucun blocant ouvert avant E13.

Commandes de qualification, depuis le worktree existant, après mise à disposition du Node bundled si nécessaire :
```sh
pnpm run typecheck
pnpm run check:persistence-boundary
pnpm run check:production-promotion-authority
pnpm run check:mutation-gate-repair-workflow
pnpm run check:index001-remediation
pnpm run check:binary-artifact-ingress
pnpm run check:recover-inputs-workflow
pnpm run check:fallback-ingress-boundaries
pnpm run test:search-sync-off
pnpm test
pnpm exec wrangler deploy --dry-run --config wrangler.jsonc
pnpm exec wrangler deploy --dry-run --config wrangler.control-tower.jsonc
git diff --check
```
Lire le skill Wrangler avant les commandes Wrangler. Le fichier de types utilisateur reste préservé ; si génération requise par CI, examiner son diff avant de l’inclure.

**Sortie :** rapport `docs/superpowers/evidence/2026-09-24-persistence-qualification.md`, SHA, compteurs, commandes/exits et défauts. Les durées mesurées en fixture ne sont pas présentées comme mesures Cloudflare réelles.

### E13 — Fusion, déploiement et rattrapage technique

**Responsable :** principal seul. **Dépendance :** E12 et autorisation de ce nouveau plan.

- [ ] Ouvrir/actualiser la PR avec diff net depuis main, SHA testé, preuves et risques résiduels. Attacher la PR à la tâche. Vérifier CI sur le head exact.
- [ ] Si main a changé, intégrer les changements puis requalifier le résultat ; ne pas déployer un SHA simplement parce qu’une ancienne suite était verte.
- [ ] Fusionner selon la politique existante. Relever le SHA main résultant ; vérifier les contrôles sur ce résultat.
- [ ] Déployer Guard d’abord, puis Control Tower, via `.github/workflows/deploy.yml` avec `expected_sha` exact, `confirm_production=DEPLOY`, `deployment_target=project_guard` puis `control_tower`. Pas de promoteur parallèle.
- [ ] Vérifier identité/version des deux composants, endpoint utile de contexte, reçu connu et état d’exécution ; `/health` seul n’est pas le gate.
- [ ] Relire l’inventaire des projets actifs. Sur divergence, reprendre seulement materialization/finalization avec les endpoints techniques existants et ressources diagnostiquées. Ne pas créer de transaction métier de rattrapage.
- [ ] Sur PRJ-0003/0007, vérifier la tête réelle courante, pas les nombres historiques 312/335/353. Sous activité concurrente, vérifier la couverture de chaque demande jusqu’au watermark observé et mesurer la nouvelle dette séparément.
- [ ] Établir pour chaque demande récupérée receipt, certificat, génération de couverture et quatre vues. Informer uniquement les tâches affectées désignées par le Founder, avec action « rechercher le reçu avant envoi ».

**Gate :** code déployé identifié, dettes techniques connues finalisées ou blocage externe prouvé ; aucune mutation métier rejouée. Une dette nécessitant un choix métier est référencée hors rattrapage automatique.

### E14 — Qualification réelle ChatGPT classique / Work local / Codex

**Responsable :** principal ; C vérifie les preuves. **Dépendance :** E13. Utiliser des conversations de qualification séparées autorisées par le Founder ; jamais les conversations où il travaille en parallèle.

Pour chacune des surfaces : ancien chat classique, nouveau chat classique, Work local, Codex :

- [ ] Enregistrer identité de la surface/conversation, heure, modèle et outils réellement callables. La présence visuelle du plugin ne coche pas cette case.
- [ ] Découvrir les capacités, résoudre le même projet, lire contexte frais et phase réelle ; vérifier les pages de détail au besoin.
- [ ] Lire un reçu connu et son statut/finalisation. Comparer request_id, revision et référence canonique.
- [ ] Pour le test d’écriture, utiliser une modification réelle approuvée non encore soumise, ou le rapport de qualification que la validation de ce plan autorisera à déposer par voie gouvernée dans PRJ-0002. Ne créer aucun projet test ni décision fictive.
- [ ] Utiliser une demande réelle distincte par surface pour prouver une nouvelle admission ; le replay d’un reçu existant prouve seulement l’idempotence. Conserver un ledger des quatre IDs/contenus avant soumission.
- [ ] Soumettre avec contexte serveur frais, attendre la reprise système et vérifier committed puis finalized et relire les octets. Aucun détour par écriture Dropbox générique.
- [ ] Qualifier en fixture la perte de réponse ; en production ne pas provoquer volontairement un incident. Un timeout réel éventuel est suivi par lookup du même ID.
- [ ] Si outil absent, examiner découverte/schema/auth/scopes et trace de la frontière. Corriger le côté applicatif démontré, puis retester la même surface. Ne pas effacer la preuve d’échec en passant seulement à Work.
- [ ] Si une interaction de plateforme exige le compte utilisateur ou ne peut être pilotée, conserver ce gate `blocked_external`, expliquer l’action exacte et son effet. Ne pas déclarer la surface qualifiée.

**Gate final de surface :** lecture, nouvelle soumission réelle, reçu, finalisation et relecture prouvés. Si aucune écriture réelle autorisée n’est possible, le test d’écriture reste non prouvé et la réception complète n’est pas signée.

Observation de production : une série bornée de 30 lectures réparties sur les projets concernés et les surfaces, avec une projection réellement en cours lorsqu’elle existe ; zéro régression canonique, résultats ou erreurs explicites en <=10 s côté handler applicatif. Relever séparément la latence de la plateforme. Ne pas fabriquer de charge métier pour obtenir cette condition.

### E15 — Clôture canonique et articulation avec le chantier SOP

**Responsable :** principal ; C contre-vérifie. **Dépendances :** E13/E14.

- [ ] Déposer le rapport complet de qualification dans PRJ-0002 via l’opération documentaire typée disponible ; vérifier receipt committed, finalisation et contenu relu.
- [ ] Mettre à jour par transactions typées les tâches/incidents correspondants déjà existants. Ne pas créer de doublons si le système possède déjà leur identité.
- [ ] Persister les règles de reprise et le contrat de capacité acceptés comme contraintes/SOP techniques selon les opérations existantes, sans prétendre convertir toutes les SOP textuelles en contrôles exécutables.
- [ ] Rafraîchir la matrice SOP G01–G14 : source acceptée, contrôle, entrées, version déployée, preuve et état `proven/partial/unequipped/external_dependency`.
- [ ] Pour les travaux historiques ci-dessous, relever le statut actuel et le prochain geste exact dans le plan canonique. Aucun lot ne disparaît parce que la livraison runtime est terminée.
- [ ] Fournir le certificat de réception avec critères ci-dessous et les IDs de receipts de clôture. Si un gate obligatoire échoue, livrer le statut incomplet et le blocage précis.

## 10. Chantier SOP conservé et frontière de cette livraison

Le programme global reste celui du 12 septembre complété le 20 septembre. Cette livraison fournit ses garanties techniques de persistance ; elle ne remplace pas sa réception métier/documentaire.

| Lot global | Vérification obligatoire à E15 | Prochaine opération s’il reste ouvert |
|---|---|---|
| G01/G02/G12 : admission commune | Parité API/MCP/inbox/fallback/admin et autorité serveur | Raccorder l’entrée manquante au contrôle commun avec un test de refus |
| G03/G04/G13 : gouvernance | Règles actives réellement qualifiées ; cumul global/local | Qualification puis activation typée de la version, jamais activation textuelle |
| G05/G06/G11 : preuves, validations, exceptions | Version exacte, expiration/portée, conservation historique | Compléter contrôle manquant, prouver refus d’une preuve périmée |
| G07/G08/G10 : finalisation/reprise/isolation | Gates E7–E10 et preuves production | Corriger le gap identifié avant de clôturer cette livraison |
| G09/G14 : drift/couverture | Modification externe retire conformité et gaps restent visibles | Compléter détection incrémentale existante, pas de scan complet quotidien des archives |
| Archives PRJ-0003, 17 éléments historiquement signalés | Identités, versions, éligibilité et statut actualisés | `document.archive` si supporté et disposition approuvée ; sinon gap package/binaire explicite |
| PRJ-0007 | Reprises obsolètes, dossiers/index, rôles des copies | Réconciliation technique prouvée ; archivage métier distinct et receipted |
| PRJ-0002 | Rapports d’anomalies et tâches reliés à leurs preuves | Mise à jour typée sans perte des rapports |
| PRJ-0008 | Conditions réelles de fin et tâches résiduelles | Clôture/archivage typés seulement avec preuves et décisions nécessaires |

Les corrections de rangement, l’extension de `document.archive` aux packages/binaires et les nouvelles décisions de clôture ne sont pas autorisées implicitement par ce plan de fiabilité. Leurs opérations restent dans le plan SOP accepté ; toute extension de schéma doit disposer d’un lot détaillé avant exécution. L’état global ne sera pas présenté « terminé » tant que ces lots n’ont pas leurs propres preuves.

## 11. Retour arrière et arrêt contrôlé

1. Enregistrer les versions précédentes des deux Workers avant E13 ; confirmer leur compatibilité de lecture des champs additifs par les fixtures E12.
2. Régression d’authentification, d’identité, double commit ou régression de revision : suspendre les nouvelles admissions affectées via le contrôle existant ; maintenir lectures et demandes indépendantes.
3. Revenir au Worker précédent uniquement s’il lit les données ajoutées sans ignorer les règles actives. Sinon appliquer une correction compatible ; ne pas déployer une version connue pour contourner l’admission.
4. Conserver receipts, intentions, exceptions, générations et certificats. Ne jamais restaurer une tête antérieure ni effacer l’historique.
5. Ne pas présumer que le rollback a annulé un POST : rechercher son identité et ses preuves avant reprise.
6. Rejouer les probes fonctionnelles après retour arrière. Le gate production repasse en échec tant que la régression n’est pas corrigée.

## 12. Matrice de réception finale

| Critère | Preuve exigée | Lots |
|---|---|---|
| Reçu connu accessible sous charge | Test provider suspendu + lecture réelle | E2/E14 |
| Contexte frais sans rollback | Test concurrence, corruption, timeout ; revision production | E3/E14 |
| Volume contexte maîtrisé | Bornes UTF-8 + reconstruction des détails | E4 |
| Réponse perdue résolue | Un seul commit et lookup du même ID | E5/E6/E10 |
| Reprise après réception durable | Alarmes seules jusqu’à terminal | E7/E10 |
| Validation préservée | Même approval_ref/version après panne | E10 |
| Capacité et indépendance | Couverture obsolète prouvée, quarantaine, projet lent isolé | E8/E12 |
| Quatre vues vérifiées | Hashes/revisions, crash au milieu, head publié ensuite | E9/E13 |
| Pas de contournement | Tests de violation sur toutes les entrées supportées | E10/E12 |
| Chats classiques opérationnels | Outils réellement callables, soumission et relecture | E14 |
| Production identifiée | SHA main/versions Guard et Tower + CI | E12/E13 |
| Clôture persistante | Rapport et tâches : committed + finalized | E15 |
| Programme SOP non oublié | Matrice G01–G14 et lots résiduels canoniques | E15 |

Trois états de livraison distincts : **code qualifié**, **production vérifiée**, **usage de bout en bout vérifié**. Seul le troisième, avec clôture canonique, permet de dire que ce plan est terminé.

## 13. Règle de validation du présent plan

Le Founder valide ce document avant toute reprise. Cette validation autorisera son exécution dans le Work local, les tâches Luna/high, les mutations de qualification réelles décrites à E14/E15, la fusion et les déploiements après leurs gates. Elle n’autorisera ni une nouvelle décision métier, ni une modification silencieuse des chats actifs, ni une extension du périmètre SOP.

Validation reçue : « je valide le plan donc lance ». La progression et les preuves sont suivies dans `docs/superpowers/evidence/2026-09-24-persistence-execution-ledger.md`.
