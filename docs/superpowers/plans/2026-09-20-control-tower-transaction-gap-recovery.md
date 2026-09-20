# Correction du blocage Control Tower et des transactions admises sans reçu — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Do not create another chat, worktree or automation.

**Goal:** Rétablir l'accès gouverné à Project OS, résoudre sans doublon la validation du module 10 de PRJ-0007 et empêcher qu'une transaction admise mais non committée soit présentée comme enregistrée ou reste sans reprise.

**Architecture:** Conserver Control Tower, ProjectGuard, RegistryGuard, Dropbox canonique et la file de reprise existante. D'abord localiser le composant qui ne répond pas, puis corriger uniquement cette frontière. Pour les nouvelles transactions, conserver l'intention exacte avant tout effet métier, reprendre idempotemment après interruption et distinguer admission, commit et finalisation dans les statuts exposés.

**Tech Stack:** TypeScript, Cloudflare Workers/Durable Objects, MCP, Vitest, Dropbox, Wrangler existants.

**Spec:** Signalement canonique `PRJ-0002/INPUTS/INCIDENT-PRJ0007-MODULE10-20260920.md` ; contraintes Project OS de transactions typées, reçus `committed` et absence d'écriture directe des vues canoniques.

## Global Constraints

- Dropbox demeure la source canonique ; aucun fichier machine-managed n'est modifié directement.
- Aucun nouveau service, worktree, projet test, secret ou abonnement.
- Ne pas créer une deuxième validation du module 10 ; conserver l'identifiant `TXN-PRJ0007-REFM10VALID-1789886219869-CIBOCW` tant que son statut n'est pas prouvé.
- Une admission `allow` ou un progrès interne `committed` sans reçu ne prouvent pas une décision canonique.
- Ne pas bloquer les projets indépendants ; ne pas inventer le contenu d'une demande historique à partir de sa seule empreinte.
- Ne pas publier les cinq documents de PRJ-0007 avant reçu métier `committed` et révision canonique vérifiée.

## Review Focus

1. Appel MCP qui n'atteint jamais Control Tower : erreur bornée et diagnostic de frontière, pas attente infinie (Task 1).
2. Appel qui atteint Control Tower mais reste dans ProjectGuard/Dropbox : même diagnostic avec identifiant de corrélation, sans fuite de secret (Task 1).
3. Admission écrite, processus interrompu avant le commit : reprise de l'intention exacte, zéro révision en double (Task 2).
4. Même identifiant avec contenu différent ou règle/base devenue obsolète : conflit/refus, jamais adaptation silencieuse (Task 2).
5. Ancien progrès `status: committed` sans `receipt_ref` : affichage `admitted_uncommitted`, sans falsifier l'historique ni fabriquer un reçu (Task 3).

---

### Task 1: Localiser et borner la panne de lecture

**Files:**
- Modify, seulement si la frontière fautive est dans le dépôt : `src/control-tower/mcp.ts`, `src/durable/project-guard-neutral.ts` ou le client Dropbox concerné.
- Test: `test/control-tower-artifact.spec.ts`, `test/execution-guard.spec.ts` et un test ciblé du composant identifié.

**Interfaces:**
- Consumes: les routes existantes `project_os_get_context`, `project_os_get_receipt`, `/mutation-context`, `/request-status`.
- Produces: une lecture qui retourne une réponse ou un code d'indisponibilité structuré dans un délai borné ; un identifiant de corrélation commun aux journaux des frontières traversées.

- [ ] Relever le SHA réellement déployé de Control Tower et Project Guard, puis rafraîchir le statut PRJ-0007 : révision canonique, tête matérialisée, reçu exact et journal d'exécution. Ne pas inférer une absence de reçu d'une seule vue Markdown.
- [ ] Lancer un seul appel de lecture de reçu avec un identifiant de corrélation non sensible. Observer son arrivée et sa sortie aux frontières **connecteur → Control Tower → ProjectGuard → Dropbox**. Capturer statut, durée, erreur et dernier composant atteint ; ne journaliser ni jeton OAuth ni corps documentaire.
- [ ] Tester séparément la lecture de contexte de PRJ-0007 et celle d'un autre projet. Si l'appel n'atteint pas Control Tower, classer le blocage comme transport/connexion de plateforme et ouvrir le diagnostic de cette connexion ; ne pas déployer une modification du Guard à l'aveugle. S'il atteint Control Tower, traiter uniquement la frontière démontrée fautive.
- [ ] Écrire le test rouge de cette frontière : dépendance qui ne répond pas, puis vérifier que l'appel reste bloqué ou retourne une erreur imprécise avec le code actuel.
- [ ] Implémenter le plus petit correctif : budget de lecture partagé et propagation d'un code `PROJECT_OS_READ_UNAVAILABLE` avec `failed_boundary` et `correlation_id`. Une lecture canonique incomplète doit échouer explicitement, jamais retourner une révision présumée fraîche.
- [ ] Rejouer le test ciblé et trois lectures indépendantes ; vérifier réponse bornée, absence de secret et absence de mutation. Commit du correctif de lecture séparément.

**Gate:** on sait précisément quelle frontière échouait ; le reçu et le contexte répondent normalement ou signalent une indisponibilité exploitable, sans attente indéfinie. Une panne du connecteur externe demeure un blocage externe explicite, pas une « réparation » de code revendiquée.

### Task 2: Rendre les transactions reprenables avant leur commit

**Files:**
- Create: `src/transactions/request-ledger.ts` — intention immuable contenant le JSON exact et son empreinte, sur le modèle de `src/documents/request-ledger.ts`.
- Modify: `src/persistence/layout.ts` — chemin de l'intention transactionnelle sous le projet machine-managed.
- Modify: `src/durable/project-guard-neutral.ts` — stage, réveil, reprise et vérification d'identité.
- Test: `test/project-guard-commit-recovery.spec.ts`, `test/project-guard-recovery.spec.ts`.

**Interfaces:**
- Produces: `ensureTransactionRequest(projectId: string, tx: Transaction): Promise<IntentRecord>` et `readRecoverableTransaction(projectId: string, transactionId: string): Promise<Transaction | null>`. L'enregistrement inclut `transaction_id`, `project_id`, `request_sha256` et le JSON exact ; création conditionnelle et immuable.
- Produces: une entrée `request_recovery` de kind `transaction` traitée par l'alarme ProjectGuard existante.

- [ ] Écrire trois tests rouges de panne injectée : avant la preuve d'admission, après la preuve mais avant le commit record, et après le commit record mais avant la réponse au client. Dans chaque cas, redémarrer l'acteur et vérifier l'absence de nouvelle révision ou d'un second reçu.
- [ ] Ajouter le test rouge « même identifiant, empreinte différente » ; attendre `idempotency_payload_mismatch` sans effet canonique.
- [ ] Ajouter le test rouge « base/règles devenues incompatibles avant reprise » ; attendre conflit ou refus explicite, jamais auto-merge métier.
- [ ] Après validation syntaxique, persister l'intention exacte avant la première étape dont l'interruption laisserait une admission orpheline. La reprise lit le JSON depuis l'intention, le reparse, vérifie l'empreinte, le projet, l'identifiant et la preuve d'admission existante ; en l'absence de preuve, elle réévalue l'admission actuelle.
- [ ] Brancher le kind `transaction` sur la file et l'alarme existantes. Chercher d'abord un commit/receipt déjà présent ; si présent, compléter seulement le suivi manquant. Sinon, exécuter une unique tentative sous la sérialisation du projet. Respecter le plafond existant de six échecs identiques et exposer l'incident.
- [ ] Rejouer les tests ciblés, puis commit indépendant. Ne pas modifier les règles de décision métier ni les routes d'autres opérations.

**Gate:** toute **nouvelle** transaction interrompue est soit reprise avec ses octets exacts, soit refusée/diagnostiquée ; jamais perdue dans un état d'admission non terminale ni rejouée sous un nouveau contenu.

### Task 3: Corriger le sens des statuts et la lecture de reprise

**Files:**
- Modify: `src/execution/contract.ts`, `src/execution/journal.ts`.
- Modify: `src/durable/project-guard-neutral.ts` (`handleRequestStatus`).
- Test: `test/execution-guard.spec.ts`, `test/control-tower-artifact.spec.ts`.

**Interfaces:**
- Produces: `request-status` avec états distincts `admitted_uncommitted`, `committed`, `finalizing`, `finalized`, `recovery_scheduled`, `recovery_blocked`, `unknown` selon preuves réellement présentes.
- Consumes: l'intention exacte de Task 2 et les preuves historiques déjà persistées.

- [ ] Écrire le test rouge pour le cas exact PRJ-0007 : `admission.json` + progrès historique `committed`, `receipt_ref: null`, aucun commit record. La réponse publique doit être `admitted_uncommitted`, jamais `committed` ou `not_received`.
- [ ] Écrire les tests de commit record présent/receipt dérivé manquant, de finalisation en attente et de progrès historique sans intention récupérable.
- [ ] Pour les nouveaux journaux, enregistrer l'étape initiale comme `admitted` ; conserver la lecture des anciens `schema_version: 1.0` marqués `committed` sans reçu et les traduire **en lecture** sans réécrire leurs preuves. N'annoncer `committed` publiquement qu'après preuve du commit canonique et de son reçu.
- [ ] Retourner `recovery_unavailable` si l'ancien journal ne contient qu'une empreinte et qu'aucun JSON exact n'est disponible ; ne jamais fabriquer ce JSON depuis le titre de la décision.
- [ ] Exécuter les tests ciblés et commit indépendant.

**Gate:** un fondateur ou un autre chat peut distinguer immédiatement « admise mais non sauvée », « sauvée mais vues en cours » et « finalisée ».

### Task 4: Qualification, déploiement et résolution de PRJ-0007

**Files:** aucun fichier canonique modifié manuellement ; seuls les commits applicatifs qualifiés et les transactions typées existantes sont autorisés.

- [ ] Mettre la branche existante à jour avec `origin/main` sans écraser les changements locaux ; examiner le diff net et les migrations de lecture nécessaires.
- [ ] Exécuter les tests ciblés des Tasks 1–3, `npm run typecheck`, `npm test`, les contrôles de persistance pertinents et le build Wrangler à blanc. Vérifier zéro test en échec, zéro nouveau secret/dépendance et zéro écriture directe des vues canoniques.
- [ ] Faire relire le diff et corriger les défauts bloquants. Fusionner puis déployer exactement le SHA de `main` ; vérifier la version de Control Tower et Project Guard, `/health` **et** les vraies lectures authentifiées.
- [ ] Lire à nouveau la demande historique `TXN-PRJ0007-REFM10VALID-1789886219869-CIBOCW` et chercher commit record, reçu, état canonique et journal. Si elle est committée, ne faire que reprendre matérialisation/finalisation. Si elle ne l'est pas mais que son JSON exact peut être récupéré de la conversation source ou d'une intention durable, le soumettre sous **le même identifiant**, après contrôle d'empreinte et de révision. Si le JSON exact est introuvable, déclarer cette limite : aucune reconstruction supposée, aucune seconde validation inventée.
- [ ] Après reçu `committed`, vérifier la décision `DEC-REFM10VALID001` et la nouvelle révision. Publier les cinq fichiers par le cycle documentaire gouverné, puis vérifier chaque reçu, la présence dans `DELIVERABLES`, la navigation et la finalisation. Aucune publication anticipée.
- [ ] Vérifier qu'un autre projet peut lire, soumettre et suivre une transaction indépendamment. Informer le chat PRJ-0007 du reçu et de la reprise possible ; ne pas lui demander de réapprouver le module.

**Gate final:** le module 10 est enregistré une seule fois, les cinq publications sont vérifiées, les statuts sont honnêtes, et une interruption reproduite en test reprend sans intervention humaine ni doublon. Si la connexion MCP ne transmet toujours pas les appels après correction du code, consigner le blocage externe séparément ; ne pas déclarer le plan terminé.

## Séquence et limites

Task 1 précède toute réparation de production. Tasks 2 et 3 corrigent le défaut durable de reprise et de statut ; Task 4 ne peut commencer qu'après leurs gates. Ce plan ne généralise pas REVIEW, ne réorganise pas les archives et ne refond pas toutes les SOP. Les anciens cas sans requête exacte ne peuvent pas être récupérés automatiquement à partir d'un simple hash : cette limite doit rester visible.
