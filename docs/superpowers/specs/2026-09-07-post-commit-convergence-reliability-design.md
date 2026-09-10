# PRJ-0002 — Robustesse de la convergence post-commit

Statut : spécification architecturale v1.1 récupérée et amendée, soumise à revue avant reprise de l’implémentation.
Mandat initial : 2026-09-07 ; sources rafraîchies : 2026-09-08.
Base examinée : `main` à `696714deea50e83d6c459bc8901e0d6408841eb3`.
Branche : `design/post-commit-convergence-reliability`.

## Amendement normatif de reprise — 2026-09-08

Cet amendement préserve l’architecture et les invariants ci-dessous, mais remplace les informations de statut, de base et d’ordre de rollout qui sont devenues obsolètes. La base de reprise est `main` à `a7b927499265c625ab3f5827f34d94235ea19d0b`, complétée uniquement par le commit de protection `.worktrees/` `b4e0c3bef79d0449515eb4a70b5d20eee03e06ac`. Les deux anciens documents de conception et de planification ont été retrouvés dans les branches locales `design/post-commit-convergence-reliability` et `feat/post-commit-convergence-reliability`, puis récupérés dans le worktree `fix/permanent-convergence-rectification`. Cette récupération ne constitue ni une validation du code partiel, ni une autorisation de déploiement.

Le contexte canonique PRJ-0002 relu dans Dropbox est désormais à la révision 169. Le plan autoritaire reste la séquence `PHASE-RECTIFY001` à `PHASE-RECTIFY005`. Le présent package est le socle technique de `RECTIFY001` et `RECTIFY002`; il rend possibles, mais ne remplace pas, le runtime de gouvernance/SOP, la continuité de session et Project Pulse de `RECTIFY002`/`RECTIFY003`. La réconciliation et la preuve de production appartiennent à `RECTIFY004`. L’intégration externe reste différée à `RECTIFY005`.

L’inventaire historique doit couvrir **tous les projets enregistrés**, actifs ou archivés : PRJ-0001 à PRJ-0007 au registre observé. Les projets archivés sont audités et réparés sans recréer de workspace actif. PRJ-0003 est le **premier projet réel à débloquer et réparer**, après passage des tests synthétiques et des gates de sécurité; aucun failpoint n’est injecté dans PRJ-0003. PRJ-0002 reste le projet de contrôle du plan et reçoit ensuite l’audit complet du control plane. Cette priorité est un ordre d’exécution, pas une exception aux invariants globaux.

### Nouvelle preuve obligatoire : PRJ-0003, révisions 263–264

La vérification read-only la plus récente établit : état, manifest, head, HANDOFF et STATE à 264; PLAN à 250; le record de génération `REV-000264-PV-0003` a pour parent 262 et déclare `coalesced_revisions: [263]`; le commit 263 et sa transaction committed existent; `EVT-000263`, le receipt autonome de sa transaction et toute preuve de convergence externe sont absents. Les révisions 262 et 264 possèdent leurs dérivés. La coalescence explique l’absence légitime d’une génération 263, mais ne peut jamais justifier l’absence de son événement ou de son receipt immuables. Le PLAN à une ancienne source_revision n’est pas, à lui seul, une anomalie si son entrée sémantique est inchangée; sa fraîcheur doit être décidée par le contrat par surface, jamais par l’égalité naïve de toutes les révisions.

Le scénario 263–264 complète et ne remplace pas la fixture historique 258. La suite d’acceptation doit prouver simultanément : génération 264 valide et coalescence 263 explicable; événement et receipt 263 reconstruits exactement depuis le commit 263; aucune nouvelle transaction, aucun événement 265 et aucune réécriture sémantique; santé globale non convergée avant réparation puis convergée après vérification de toutes les couches.

### Écart entre le code livré et la spécification

Le commit `a7b9274` a livré une fondation partielle de convergence, mais la ligne de base actuelle ne satisfait pas cette spécification :

- `ConvergenceEngine` n’est instancié que dans les tests; aucun chemin runtime ne l’appelle;
- `ProjectGuard.alarm()` supprime seulement l’alarme et `MaterializationGuard.statusResponse()` retourne une santé entièrement `unknown`;
- `discoverCanonical()` parcourt jusqu’au dernier commit d’une tranche mais ne retourne que ce dernier record, ce qui permet de perdre les obligations event/receipt intermédiaires;
- `runSlice()` force `converged=false`, ne calcule aucun réveil et peut retourner `more_work=false` après ce traitement incomplet;
- les effets marqués `prepared` ne sont pas réarmés dans une nouvelle incarnation de `FencedEffects`, et aucun état `verified` n’est persisté après la postcondition;
- les réservations utilisent toujours `attempt_number=1` et `incident=1`; le `MaterializationLedger` injecté n’est pas consommé par le moteur;
- les tests actuels passent (6 fichiers, 9 tests ciblés) sans exercer l’intégration runtime, plusieurs commits coalescés ou une reprise à froid.

Ces écarts sont des tests rouges obligatoires avant toute nouvelle correction. Il est interdit de simplement brancher le moteur actuel : cela automatiserait un algorithme capable de masquer les trous historiques. L’implémentation reprend le plan de 16 tâches en reclassant chaque élément déjà présent comme `incomplet` jusqu’à preuve par les oracles normatifs, et non comme terminé d’après l’existence d’un fichier ou un ancien message de commit.

### Ordre de sortie amendé

1. Produire l’auditeur read-only et le contrat d’intégrité par surface sur les sept projets, avec rapport déterministe et erreurs d’extraction classées `unknown` plutôt qu’ignorées.
2. Corriger le moteur sous tests synthétiques : parcours commit par commit, journal/reprise, effets clôturés, tentatives monotones, santé honnête et réveils durables.
3. Qualifier le writer unique, le fencing, la paire critique, le fleet scheduler indépendant et la voie administrative bornée.
4. Déployer d’abord les lecteurs/diagnostics, puis un canary synthétique. Après gates verts, activer la réparation sur PRJ-0003 comme premier projet réel et vérifier le scénario 263–264 sans mutation métier.
5. Étendre l’audit/rattrapage aux six autres projets, archives incluses, puis exécuter les preuves de panne, reprise, concurrence, rollback et continuité exigées par RECTIFY004.
6. Enregistrer canoniquement les changements de plan et leurs preuves uniquement via transactions typées et receipts committed; ne jamais utiliser le correctif de convergence comme voie parallèle d’écriture métier.

## 1. Objet et décision proposée

Conserver le commit record immuable comme unique frontière de commit métier et faire de chaque record une obligation durable de convergence. Étendre le MaterializationGuard existant avec une réconciliation indépendante par couche, des continuations bornées, un budget de retries persistant et une escalade observable. Le cron découvre les obligations perdues indépendamment de l’inbox ; ProjectGuard conserve exclusivement l’autorité métier.

Le résultat attendu est une récupération automatique des pannes techniques ordinaires, y compris sans nouvelle transaction, sans replay utilisateur et après perte des caches locaux. Un commit réussi ne suffit jamais à déclarer les vues à jour. Une panne permanente conserve le commit, bloque les écritures dangereuses, expose la couche défaillante et déclenche une alerte exploitable.

Le mandat documentaire initial ne couvrait que cette spécification. Le mandat de reprise autorise désormais l’implémentation continue après revue de la v1.1, puis les gates distincts de fusion, canary et production. Aucun passage de ce document ne transforme toutefois une proposition en capacité livrée, n’autorise une mutation métier hors transaction typée, ou ne permet de contourner un gate de rollout.

## 2. Sources, contexte rafraîchi et collisions

Lecture intégrale de l’AGENTS.md du projet ChatGPT « Project OS » : canonique Dropbox, refresh avant travail significatif, transactions typées et receipt gate, vues générées non autoritaires, historique préservé. Aucun AGENTS.md n’est présent dans le dépôt à la base examinée. L’instruction explicite de limiter les écritures au document GitHub exclut toute création de tâche, décision ou livrable canonique pour cette mission.

Le registre Dropbox lie PRJ-0002 à Project OS / `project-os`. HANDOFF.md, STATE.md et OPERATING.md ont été relus via le connecteur Dropbox : tous portent la révision 150, contrat opératoire 3, projet actif, aucune tâche active ni blocage affiché. Il s’agit du contexte publié observé, pas d’une preuve déduite des seuls Markdown qu’aucun commit plus récent existe. Le mandat de design est l’autorisation de travail ; il ne vaut pas acceptation canonique de cette proposition.

Sources du dépôt lues avant rédaction :

- [Commit consistency](../../commit-consistency.md), [materialization](../../materialization.md), [fault injection](../../fault-injection.md), [deployment](../../deployment.md), [continuity](../../continuity.md).
- [Rollback](2026-08-24-imp-rollback001-design.md) et [isolation ProjectGuard / MaterializationGuard](2026-09-02-materialization-guard-isolation-design.md).
- [SOP globale](../../project-os-sop.md) et suite [index](../../project-os/sop/00-SOP-INDEX.md), [gestion](../../project-os/sop/01-PROJECT-MANAGEMENT-SOP.md), [connaissance](../../project-os/sop/02-KNOWLEDGE-DECISIONS-SOP.md), [livrables](../../project-os/sop/03-DELIVERABLES-SOP.md), [handoff](../../project-os/sop/04-HANDOFF-PORTABILITY-SOP.md).

Constats du code à cette base :

- `src/durable/project-guard-neutral.ts` publie le record, persiste le résultat local et appelle le handoff protégé ; son ancienne alarme ne projette plus.
- `src/materialization/handoff.ts` journalise l’échec de livraison et consomme la réponse interne ; il ne crée pas de continuation externe.
- `src/durable/materialization-guard.ts` découvre les commits contigus au-delà du snapshot, sérialise son I/O et possède les alarmes. Le retryCount de l’alarme déclenche actuellement une déférence de cinq minutes après plusieurs échecs.
- `src/materialization/coordinator.ts` matérialise les dérivés du record de la cible choisie, puis les vues ; une génération déjà complète suit un raccourci de réparation du head. Ce raccourci ne prouve pas séparément l’intégrité actuelle de chaque dérivé.
- `src/index.ts` attend le traitement inbox avant de lancer réconciliation de matérialisation et recherche. Un échec de cette première étape peut donc empêcher ces travaux d’être lancés.
- `src/domain/materialization.ts` fixe la projection courante à **3**. Certaines descriptions historiques mentionnent encore ProjectGuard comme propriétaire du ledger et une projection initiale à 1 ; l’isolation R0 et le code courant prévalent pour décrire l’existant.

PR ouvertes observées avant rédaction : #147, #139, #116, #115, #94, #93 et #79. Le nouveau chemin de spécification n’existe pas sur main. La [PR draft #147](https://github.com/zakariafadli94/project-os/pull/147), head `fcedf969e7d7e3e0de18ed258eb151f3f9699e75`, touche notamment ProjectGuard, repository layout et le service des documents. Elle ajoute `review_candidate.promote` et sa propre preuve de publication. Aucun de ses fichiers n’est modifié ici.

Frontières d’intégration : #147 conserve l’acceptation explicite, le journal de promotion et les contrôles provider/version ; #139 conserve le transport de contexte et les identités de requête ; #115/#116 conservent la recherche dérivée ; #93/#94 conservent gouvernance/identité ; #79 conserve son gate de writer schema. L’implémentation future devra revalider ces interfaces sur le main alors courant. Aucune PR ouverte n’est incorporée implicitement à ce design.

## 3. Cas obligatoire : PRJ-0003, révision 258

Incident fourni dans le mandat : record de commit créé pour 258, dérivés événement/state/manifest/receipt réparés après environ vingt minutes, mais HANDOFF.md, STATE.md et materialization head restés à 257 pendant plusieurs cycles. Cette séquence est le scénario de régression obligatoire. La durée approximative et les cycles sont une observation rapportée, pas une mesure reconstruite à partir de logs complets.

Vérification read-only du 2026-09-08 :

- `/PROJECT_OS/.project-os/projects/PRJ-0003/commits/REV-000258.json` contient previous_revision 257, new_revision 258, événement `EVT-000258`, transaction `TXN-PRJ0003-DECISION-FOUNDER-CONTROL3-20260907T1923-89FE` et receipt committed.
- Métadonnée provider du record : modification serveur `2026-09-07T18:40:20Z`. Le `receipt.committed_at` vaut `2026-09-07T19:23:30+01:00` ; le code le prend de `transaction.created_at`. Il ne constitue donc pas une horloge fiable de publication.
- Le head lu ensuite référence désormais `REV-000258-PV-0003.json`, completed_at `2026-09-07T21:00:41.791Z`, modification serveur `21:00:43Z`. Cela prouve la convergence du pointeur observé ultérieurement, pas sa ponctualité ni, à lui seul, l’état actuel des bytes des deux Markdown.

Le design ne présente pas le système comme encore bloqué à 257 et ne prétend pas identifier la cause exacte de l’incident. Il ferme les classes de défaillance compatibles avec ce symptôme : handoff perdu, succès machine confondu avec succès humain, retry remis à zéro, cible perdue, starvation, lecture d’un snapshot périmé, head trompeur ou conflit de destination.

Pour la fixture 258, le statut doit pouvoir dire simultanément : commit=258 valide ; événement=258 vérifié ; state=258 ; manifest=258 ; receipt vérifié ; STATE=257 ; HANDOFF=257 ; head=257 ; génération258 absente/incomplète ; âge humain dépassé. Le succès des quatre dérivés ne ferme pas l’incident humain.

## 4. Approches comparées

| Approche | Avantages | Risques/coût | Décision |
|---|---|---|---|
| Attendre tous les dérivés et les vues avant la réponse ProjectGuard | Chemin apparent simple, erreur immédiatement visible | Rétablit le couplage I/O supprimé par R0, réponse lente/ambiguë après commit, ne résout pas les crashes entre deux fichiers | Écartée |
| Commit log comme journal de travail + réconciliation par couches dans MaterializationGuard + cron indépendant | Réutilise autorité et isolation existantes ; récupérable sans livraison du handoff ; peu de composants | Nécessite un progrès durable et des sondes explicites ; discipline de budget et de fencing | **Retenue** |
| Queue externe dédiée avec workers et dead-letter queue | Distribution, backpressure et outils de livraison explicites | Nouveau service et double-write record/queue ; exige encore une réconciliation du commit log pour un crash avant enqueue | Écartée pour ce périmètre ; extension possible si capacité mesurée insuffisante |

La solution retenue n’ajoute ni second commit métier, ni broker, ni nouveau Durable Object. Le commit log est la source exhaustive du travail ; les journaux techniques accélèrent et expliquent l’exécution, sans remplacer sa vérité.

## 5. Invariants normatifs

1. **Unicité.** Pour un projet et une révision, un seul record valide à chemin déterministe, créé conditionnellement sans remplacement. Un conflit de contenu échoue fermé. Le même transaction_id et le même payload rendent le receipt original ; la réutilisation avec un payload différent est rejetée avant effet.
2. **Durabilité.** Seul un record publié et validé engage le métier. Si la réponse provider est perdue, relire le même chemin avant de décider ; indisponibilité de cette lecture signifie résultat inconnu, jamais « non commis ». Aucun timeout de projection n’annule un commit.
3. **Reconstitution.** Vérifier binding projet, transaction, événement, receipt, révisions et continuité de chaîne. Ne jamais prendre un cache plus récent non justifié ou sauter un trou comme autorité. Les baselines historiques pré-COMMIT001 restent explicitement distinguées.
4. **Exhaustivité des dérivés.** Chaque commit conserve son événement et son receipt autonomes. La coalescence des vues ne permet jamais de sauter ces dérivés immuables. State et manifest courants peuvent sauter des révisions intermédiaires et convergent vers la dernière révision validée.
5. **Monotonie.** Aucun retry ancien ne remplace un state, manifest ou head plus récent. Les préconditions provider et la vérification du record associé protègent les pointeurs mutables.
6. **Vérité par couche.** Un receipt committed ne prouve ni génération complète ni bytes humains actuels ; un head complet ne prouve pas la présence de tous les receipts historiques. Un échec d’observation est `unknown`, pas `current`.
7. **Génération cohérente.** STATE et HANDOFF sont rendus depuis le même état canonique, pour la même révision/projection ; leurs bytes sont vérifiés avant publication du record de génération, puis du head. Aucune atomicité de visibilité entre deux fichiers Dropbox n’est promise.
8. **Progrès récupérable.** Toute obligation non prouvée reste découvrable après crash, eviction, perte de SQLite ou handoff. Une cible nouvelle ne réinitialise pas l’âge de la divergence ancienne.
9. **Effets séparés.** MaterializationGuard écrit uniquement les dérivés permis ; il ne rejoue jamais une opération métier ou une promotion REVIEW. ProjectGuard ne rend aucun Markdown et ne réintroduit pas d’alarme de projection.
10. **Sécurité des vues périmées.** Une mutation ne peut silencieusement utiliser le numéro du dernier head humain comme preuve de contexte canonique courant. Le contrôle est serveur, avec revalidation à l’admission.
11. **Conflits préservés.** Des bytes externes inexpliqués ne sont pas écrasés. Un conflit permanent est alerté ; aucune nouvelle révision métier n’est fabriquée pour réparer une projection.
12. **Limites honnêtes.** La borne de convergence suppose des dépendances disponibles et une charge dans l’enveloppe validée. Une panne illimitée ne permet pas de garantir l’écriture ; elle doit garantir détection/escalade tant que l’observabilité indépendante fonctionne.

## 6. Responsabilités et séquence

| Composant | Propriétaire de | Interdit |
|---|---|---|
| ProjectGuard | Validation métier, sérialisation des mutations, record immuable, absorption locale, replay, handoff léger, précondition de contexte | Rendu humain ; attendre toutes les projections avant de reconnaître un commit |
| MaterializationGuard | Découverte read-only du canonique, dérivés machine, vues, ledger de progression, alarmes, preuves de convergence et alertes projet | Commit métier, nouvelle acceptation/publication, réécriture d’histoire |
| RegistryGuard | Allocation et finalisation de project.create, statut registre, receipt autonome de création | Déléguer implicitement la finalisation à MaterializationGuard |
| Cron Worker | Balayage équitable du registre, réveil/réconciliation de chaque projet, résultat par job et heartbeat de maintenance | Projection inline, dépendance séquentielle à inbox/recherche, scan INPUTS de récupération |
| Observabilité externe | SLO, détection heartbeat absent et routage de l’alerte opérateur | Autorité métier ou modification automatique de données |

Séquence normale :

```text
admission avec contexte vérifié
  → ProjectGuard réconcilie les commits et revalide la mutation
  → création conditionnelle du commit record R
  → absorption locale et receipt original
  → handoff borné (project_id, R, projection_version)
  → réponse métier committed, indépendamment de la projection
  → MaterializationGuard inscrit la cible et arme son alarme
  → découvre/valide le canonique dans des tranches bornées
  → répare événement/receipt de CHAQUE commit manquant
  → converge state/manifest courants
  → rend/reprend la cible humaine active, puis la dernière cible demandée
  → vérifie outputs et paire critique
  → record de génération immuable → head conditionnel → relecture
  → statut de chaque couche, puis résolution de l’alerte si tout est vérifié
```

L’échec du handoff est enregistré mais n’altère pas le receipt. Le cron reconstruit la cible à partir du commit log, même si aucune inscription locale n’existe. Un crash après commit avant absorption locale est récupéré par le même mécanisme et par la prochaine entrée ProjectGuard. Pas de RPC circulaire où MaterializationGuard attendrait un ProjectGuard qui attend son handoff.

`project.create` : la copie de receipt est `awaiting_registry_finalization` jusqu’à la preuve RegistryGuard. MaterializationGuard peut réparer ses autres couches, mais demande une reprise idempotente au propriétaire de finalisation ; il ne publie pas lui-même ce receipt. Le registre/finaliseur doit maintenir sa propre obligation durable tant que le projet n’est pas énumérable. Cette obligation préexistante est une précondition d’intégration à vérifier par test.

## 7. Modèle de progression et preuves

### 7.1 Vecteur de santé

Le statut projet expose séparément `canonical`, `event`, `state`, `manifest`, `receipt`, `human_state`, `human_handoff`, `generation`, `head`, `scheduler`. Chaque entrée contient état (`current`, `pending`, `retry_wait`, `exhausted`, `blocked`, `unknown`), révision attendue/observée quand pertinente, identité/hash attendus et observés, last_verified_at, first_pending_at, next_attempt_at, failure_count et code d’erreur expurgé.

Pour event/receipt, exposer un curseur contigu vérifié et le nombre/la première identité manquante ; un scalaire égal à R ne prouve pas l’absence d’un trou. Pour generation/head, inclure projection_version et root_hash. Pour la paire humaine, exposer les deux observations, y compris si le head est déjà à R. Le résumé `converged` exige toutes les obligations applicables vérifiées, aucun `unknown`, aucun trou et aucun réveil échu perdu. La santé de la recherche et celle des documents managés restent des domaines distincts.

### 7.2 Journal technique minimal

Étendre le ledger SQLite de MaterializationGuard et ajouter une famille technique externe sous `/PROJECT_OS/.project-os/projects/<PRJ>/convergence/`, sans modifier les schémas stricts des commit records ou des générations existants :

- `progress.json` : checkpoint reconstructible versionné, canonical_observed_revision, curseurs event/receipt, cible humaine active/demandée, incarnation de writer, état/compteurs/dates par obligation, progression des pages et dernière erreur expurgée ; mise à jour conditionnelle.
- `attempts/<obligation-id>/<attempt-number>.json` : réservation immuable avant I/O de réparation, issue et échéance persistées ensuite dans le checkpoint. Identité déterministe : projet + couche + révision (ou intervalle pour un snapshot courant) + projection_version si pertinente + numéro d’incident. Aucun contenu métier/Markdown n’y est dupliqué.
- `alerts/<incident-id>.json` : création idempotente de l’incident technique ; statut de livraison/résolution dans le checkpoint. Les alertes restent consultables après résolution.

Le journal ne donne aucune autorité d’écriture métier. Le record de commit est l’obligation initiale même si ces fichiers n’ont jamais été créés. Un checkpoint peut être ignoré s’il est invalide, mais ses preuves contradictoires doivent être signalées. Perte SQLite : relire checkpoint et réservations externes, valider leur binding puis reprendre. Un crash après réservation consomme une tentative ; avant un nouvel effet, vérifier si l’effet réservé a déjà réussi. Un résultat incertain ne justifie jamais une duplication aveugle.

Si la réservation externe est indisponible, ne pas lancer de nouvelle réparation provider : conserver le réveil local et signaler `progress_store_unavailable`. La reprise dès retour du provider reconstruit le compteur à partir des réservations. La perte/destruction de toutes les preuves techniques externes est une panne exceptionnelle d’intégrité, pas un prétexte à remettre silencieusement le budget à zéro. Pas de suppression automatique de ces preuves dans ce périmètre.

### 7.3 États et transitions

| État d’obligation | Transition normale | Crash / échec |
|---|---|---|
| `pending` | Réserver une tentative et un lease borné → `running` | Cron réarme si l’alarme manque |
| `running` | Vérifier postcondition → `verified` ; sinon enregistrer erreur | Lease expiré → vérifier l’effet, puis `retry_wait` avec réservation consommée |
| `retry_wait` | À next_attempt_at → tentative suivante | Une requête/status/cron ne réduit pas cette date |
| `exhausted` | Alerte durable, sondes lentes ; succès d’une sonde ouvre une tentative contrôlée | Aucun redémarrage du burst par simple nouveau commit |
| `blocked` | Préserver la preuve, alerter ; revalider après changement observable ou résolution autorisée | Pas de blind overwrite ni boucle d’écriture |
| `verified` | Reste vérifié tant que la preuve correspond ; nouvel écart → nouvel incident | Une corruption détectée rouvre la couche seule |

`running` est un état interne, présenté comme `pending` avec lease/attempt en cours dans l’API de santé. Un nouveau commit crée de nouvelles obligations event/receipt ; il étend la cible state/manifest/humaine, tout en conservant first_pending_at et le budget de l’épisode de divergence. Les compteurs par couche sont indépendants : réussir state n’efface pas les échecs HANDOFF.

## 8. Algorithme de convergence et absence de starvation

Découverte canonique : commencer au dernier baseline validé, vérifier le record de cette révision s’il existe, puis les chemins contigus suivants. Chaque tranche garde une continuation ; au plafond I/O, l’état est `discovery_incomplete`, jamais « current ». Une réponse not-found peut terminer une chaîne connue ; une erreur transport ne peut pas le faire. Un balayage paginé du répertoire de commits détecte périodiquement les records au-delà d’un trou et les historiques absents des curseurs. Il ne sert pas à sauter les trous.

Deux files logiques partagent le même MaterializationGuard sérialisé :

1. **Dérivés machine** : files d’exécution indépendantes pour event, receipt, state et manifest. Events et receipts sont visités en ordre de révision, mais un trou bloqué ne suspend ni les autres couches ni les obligations ultérieures vérifiables de la même couche. Le curseur contigu vérifié reste au trou, avec l’ensemble des manques exposé ; aucun saut du curseur ne masque cet échec. State et manifest ciblent le dernier canonique validé. Réparer un seul manque n’impose pas de réécrire les autres. Une génération humaine complète ne court-circuite jamais ce contrôle.
2. **Projection humaine** : une cible active immuable jusqu’à un point sûr, une cible demandée coalescible. Une série continue de commits ne peut empêcher la cible active de terminer. Chaque commit ignoré pour le rendu est explicitement couvert par une génération ultérieure ; son événement et son receipt restent obligatoires.

Alterner les tranches machine et humaines lorsque les deux ont du travail ; réserver au minimum une tranche humaine sur deux. Les vues peuvent être rendues depuis le record canonique même si un receipt autonome historique manque. Le résumé global reste dégradé, mais un conflit receipt ne bloque pas sans raison la paire critique. STATE et HANDOFF sont servis en priorité dans le plan ; le head complet attend toutefois tous les outputs requis et les suppressions autorisées. Un fichier non critique en conflit garde la génération incomplète et une alerte distincte. Pour éviter qu’une cible bloquée affame toutes les suivantes, après drainage de ses opérations en vol, la cible est garée dans le journal comme incomplète et la cible plus récente peut devenir active. Aucune génération complète n’est créée pour la cible garée. Ses hashes de sorties partielles restent des preuves techniques de writes autorisés, utilisables pour vérifier les préconditions de reprise, sans devenir un baseline de génération complète. La nouvelle cible régénère sa paire critique et garde les conflits applicables ; âge et budget des couches bloquées ne sont pas remis à zéro. Ce passage est un point sûr explicite, jamais une préemption au milieu d’un write.

Une tranche dure au plus 10 secondes et consomme au plus 32 appels provider, retries transport inclus ; le premier plafond atteint déclenche une continuation durable et un réveil à +1 seconde. Réserver dans ce budget de quoi persister progression et réveil avant de lancer un effet. Un appel porte un timeout borné par le temps restant. Les gros parcours ne repartent pas systématiquement de la première page. La concurrence provider demeure configurable de 1 à 4 ; la concurrence fleet reste à 4. Ces valeurs sont des budgets proposés à valider, pas une assertion sur les limites du fournisseur.

Le cron conserve son intervalle de cinq minutes, mais lance inbox, convergence et recherche comme jobs indépendants, chacun avec timeout, résultat et continuation. Il n’attend pas une réussite inbox avant convergence. Un curseur de tour durable et équitable assure qu’un projet lent ne fait pas reprendre toujours les premiers projets ; aucune page n’est dite traitée tant que ses réveils ne sont pas enregistrés. Les projets archivés sont inclus pour terminer leurs obligations, sans recréer le workspace actif. Il n’appelle pas `/recover-inputs` et ne restaure pas le polling de toutes les zones INPUTS.

## 9. Écritures conditionnelles et finalisation

MaterializationGuard est l’unique writer ordinaire des dérivés de projet après cutover. Les routes admin passent par sa sérialisation et la même politique ; aucun chemin legacy V2 ne doit concurrencer ses writes state/manifest/head. RegistryGuard conserve uniquement son exception de receipt de création.

Pour un objet mutable : lire identité/révision provider, vérifier le contenu contre son canonique/génération, refuser la régression, écrire avec précondition exacte, puis relire et vérifier. Une précondition qui échoue déclenche une nouvelle observation, pas un overwrite inconditionnel. Les instances utilisent une incarnation et des leases du checkpoint ; chaque opération vérifie qu’elle possède encore l’incarnation. Le CAS provider protège également les résultats de requêtes anciennes encore en vol après expiration du lease. L’expiration d’un lease ou d’un timeout local ne prouve jamais l’annulation côté provider. Avant chaque write mutable, persister l’identité de destination, la précondition provider et le hash désiré dans le progrès de tentative. Au changement d’incarnation, chaque effet incertain est soit prouvé terminé, soit neutralisé par une écriture conditionnelle de la destination vers les bytes autorisés courants, avec vérification d’un nouveau token provider non réutilisable. Cette neutralisation rend impossible le succès ultérieur de l’ancienne précondition. Si ancien et nouveau writes ont exactement les mêmes bytes autorisés, le résultat tardif est inoffensif mais doit rester observable. Si le provider ne permet pas de prouver cette neutralisation, la destination reste bloquée et aucune nouvelle génération/head n’est finalisée. La même règle s’applique aux outputs humains et aux suppressions/mouvements conditionnels ; un mouvement incertain doit être résolu par preuve source/destination avant reprise. Le CAS du head seul ne protège pas les Markdown. Une cible garée ne se réactive jamais avec ses anciens effets : elle est clôturée comme coalescée lorsque couverte ou replannée vers le canonique courant après drainage/neutralisation.

Pour événement/receipt : création conditionnelle ; s’il existe déjà, comparaison au record original. Toute différence est un conflit d’intégrité ; ne pas « corriger » en écrasant l’immuable. Les snapshots state/manifest injustifiés ou incohérents sont préservés comme preuve avant réparation autorisée par le canonique ; leur nouvelle version ne peut régresser un canonique ultérieur validé.

Pour une génération : réutiliser input_hash pour les notes sémantiquement inchangées, mais vérifier les preuves des outputs modifiés/incertains ; vérifier physiquement STATE et HANDOFF juste avant finalisation. Écrire le record complet immuable, puis avancer le head par CAS et le relire. Les générations snapshot/delta restent bornées à 128 records. Ne pas sélectionner une projection plus ancienne lors d’un rollback ni une projection inconnue comme baseline utilisable.

Un record de génération existant avec head stale autorise une réparation du head sans réupload humain **après** validation de chaîne/root et relecture de la paire critique. Si les bytes ont divergé depuis sa création, le record demeure une preuve historique ; le statut courant est dégradé et la réparation suit la protection des destinations. Ne pas réécrire une génération immuable pour masquer une dérive ultérieure.

Après finalisation, le cron vérifie la paire critique et chaque dérivé machine courant à chaque visite du projet ; une vérification paginée de tout l’index humain et des historiques event/receipt doit terminer en 24 heures. Un output carried-forward garde légitimement son ancienne source_revision. Les lectures cohérentes et le statut distinguent toujours preuve de génération et preuve récente des bytes.

## 10. Retries, limites et récupération après épuisement

Le compteur applicatif persistant fait foi, jamais le seul `alarmInfo.retryCount`. Les alarmes Cloudflare ont une livraison au moins une fois, une seule alarme programmée par objet et un retry natif borné ; cela ne fournit pas le budget métier de convergence. Référence : [Cloudflare Alarms](https://developers.cloudflare.com/durable-objects/api/alarms/) consultée le 2026-09-08.

Par couche et épisode : une tentative initiale puis au plus **cinq retries rapides**, espacés de 2, 4, 8, 16 et 32 secondes, avec jitter déterministe de 0 à 20 %. Le délai provider Retry-After prévaut s’il est supérieur, sans jamais effacer la deadline SLO. Les retries transport existants sont inclus dans le budget d’une tentative et dans la limite I/O ; aucune troisième boucle de retry ne s’ajoute dans cron ou les scripts.

Une tentative est une exécution logique d’une obligation, identifiée par une unique réservation, pouvant traverser plusieurs tranches. Les tranches qui progressent renouvellent la continuation de cette même tentative : elles ne créent pas de nouvelle réservation ni de retry. Une vérification finale clôt la tentative ; un échec clôt cette tentative et incrémente une seule fois son compteur d’échecs. Après crash, le lease expiré fait clôturer la tentative comme incertaine ; la relecture peut prouver son succès, sinon elle compte une fois comme échec avant réservation suivante. Le numéro de réservation est monotone et distinct du compteur d’échecs, tous deux persistés. Le temps de toutes les continuations compte dans le SLO. Les exceptions attendues sont capturées, leur prochain réveil persisté, puis le handler retourne. Les livraisons natives dupliquées relisent réservation, lease et next_attempt_at et n’exécutent pas une tentative additionnelle. Le réveil est toujours le minimum des échéances de travail, de sonde et d’alerte ; programmer une couche ne reporte jamais une autre déjà due.

Après la sixième tentative échouée : état `exhausted`, arrêt du burst, création d’une alerte dédupliquée, sonde de dépendance/progression toutes les cinq minutes. Chaque sonde est bornée et commence par une lecture. Si les préconditions sont satisfaites, une seule tentative de réparation est autorisée pour ce créneau ; son échec conserve exhausted et l’alerte. Ce régime lent peut durer pendant une panne, mais il est plafonné à une tentative par couche et par cinq minutes et ne réinitialise jamais le burst. Cela concilie un retry rapide limité avec la récupération automatique lorsque le service revient.

Codes permanents — binding, record corrompu, schéma non supporté, bytes externes inexpliqués — passent immédiatement à `blocked`. Un changement vérifié de dépendance, un déploiement compatible ou une résolution de conflit autorisée permet une reprise. Une panne technique transitoire ne demande pas à l’utilisateur de relancer ; un vrai conflit de contenu/direction peut exiger une décision explicite.

## 11. Fraîcheur de contexte et mutations

Le contrat existant exige déjà le refresh canonique, mais un contrôle par LLM seul ne suffit pas. Ajouter un contexte de mutation fourni par le serveur : project_id, canonical_revision, empreinte de l’état canonique normalisé, observed_at, expiry (+5 minutes) et jeton authentifié opaque. Le service construit ce contexte à partir du record validé, jamais en remplaçant seulement le numéro d’un vieux Markdown.

Le contexte est fourni par une nouvelle route authentifiée read-only `GET /v1/projects/<project_id>/mutation-context`, sans effet métier ni déclenchement de projection inline. Le jeton est signé côté serveur, lié au projet et au hash, avec une clé dédiée au contexte ; il ne constitue pas une autorisation de publication. Le transport est une enveloppe d’admission, séparée du JSON Transaction strict et du commit record. Elle doit fonctionner pour l’API directe et l’incoming, et être transportée intégralement par le fallback #139. Les receipts et transaction_id existants restent inchangés. Le client recharge et réévalue son intention si la révision a avancé ; il ne modifie pas silencieusement base_revision.

À l’admission ProjectGuard : vérifier binding, jeton/expiry, empreinte, égalité entre révision du contexte et base_revision soumise, puis réconcilier et vérifier la révision actuelle avant tout nouvel effet. Contexte manquant, expiré ou stale en mode strict produit une erreur d’admission sans nouveau receipt terminal ni consommation du transaction_id ; le même identifiant peut être renvoyé avec contexte rafraîchi tant que le payload métier n’a pas changé et qu’aucun commit n’existe. Un payload modifié exige une nouvelle identité. Un replay exact déjà committed rend d’abord son receipt original même si le jeton a expiré ; il ne devient pas une nouvelle mutation.

Les quatre opérations additives actuellement stale-rebasables ne sont pas supprimées du domaine MODEL001. Leur usage via l’admission stricte exige un contexte frais puis une réévaluation explicite ; aucun ancien client ne bénéficie silencieusement d’un stale rebase pour contourner la protection. C’est un resserrement intentionnel d’admission, à activer après migration des clients. Les véritables conflits métier gardent les receipts `conflict` existants.

Les routes artifact/document/promotion qui dépendent de l’état du projet appliquent la même admission fraîche avant effet, en plus de leurs propres expected_version_id/provider preconditions. Cela ne remplace pas les gates de #147. Un client incapable d’obtenir un contexte complet continue le travail non durable et signale l’indisponibilité ; il n’écrit pas depuis la dernière vue connue.

La lecture humaine indique « vues en cours d’actualisation » avec révision et date vérifiées si nécessaire. Un lecteur automatisé ne traite pas une paire mixte comme complète : il utilise le contexte canonique rendu à la volée ou échoue explicitement. Dropbox Desktop et Obsidian local restent hors de la borne serveur ; un fichier brut hors ligne ne peut afficher à lui seul une fraîcheur distante garantie.

## 12. Observabilité, SLO et alertes

### Horloges et enveloppe

Mesurer t0 avec l’instant serveur d’acceptation du record, journalisé avec l’identité de commit ; en recovery, utiliser la métadonnée serveur de création du record immuable. Si aucune horloge de publication fiable n’est disponible, signaler `commit_time_unknown` et compter séparément le délai depuis first_observed_at. Ne jamais remplacer t0 par transaction.created_at. Un commit plus récent ne rajeunit pas oldest_pending_age.

Objectifs proposés, fenêtre glissante de 30 jours, à qualifier avant activation :

| SLI | Objectif |
|---|---|
| Event et receipt de chaque commit, state/manifest couvrant au moins ce commit | 99,9 % en ≤120 s depuis t0 |
| Paire critique vérifiée et head d’une génération complète couvrant le commit | 99 % en ≤120 s ; 99,9 % en ≤600 s |
| Handoff/alarme perdus | Découverte à la prochaine visite cron ≤300 s, puis convergence totale ≤600 s |
| Dépassement de 600 s, exhaustion ou blocked | Incident créé immédiatement à observation ; notification ≤60 s si canal disponible |
| Byte drift critique hors commit | Détection à la prochaine visite ≤300 s |
| Intégrité historique/non critique | Tour complet ≤24 h |
| Maintenance absente | Alerte externe après 2 cycles manqués (10 min) |

« Couvre » signifie une génération ≥R pour la projection active, dont l’état inclut les effets de R ; chaque event/receipt de R doit toujours être vérifié séparément. Les délais ≤600 s sont une borne d’ingénierie sous disponibilité et charge qualifiées, pas une garantie absolue des services cloud. Toutes les violations restent dans les SLIs globaux ; leur cause (provider, runtime, capacité, conflit) est une dimension, jamais une exclusion cachée.

Enveloppe initiale à éprouver : 10 projets, au plus 5 commits/minute/projet, 200 outputs générés/projet, au plus 20 outputs modifiés et 1 MiB de bytes générés par commit ; dépendances répondant dans les budgets de tranche et visite fleet ≤300 s. En dehors de l’enveloppe, admission/backpressure explicite avant nouveau commit si la capacité de continuation est insuffisante, alerte capacité et mesure du retard ; pas de promesse de borne non démontrée. La réparation des commits déjà durables garde la priorité. La cadence qualifiée doit aussi permettre le tour d’intégrité de 24 h.

### Signaux

Émettre compteurs commit_observed, obligations_verified, retries/exhaustions, layer_conflicts, handoff_failures, freshness_rejections, conditional_write_conflicts ; histogrammes commit_to_layer_verified et tranche_duration ; gauges lag_revisions, oldest_pending_seconds, queue_depth, due_without_alarm, fleet_last_success_age et audit_cursor_age. Un statut HTTP réussi sans progrès ne remet aucun timer à zéro.

Chaque événement structuré inclut project_id, révision cible/observée, couche, génération/projection, transaction/event IDs, numéro de tentative, code, next_attempt_at, oldest_pending_at, deployment SHA, budget I/O consommé et correlation_id. Aucun payload métier, Markdown, jeton, secret ou URL signée dans les logs. Les métriques agrègent par couche/code ; les IDs à forte cardinalité restent dans les logs et le détail authentifié.

Alerte exemple 258 : « PRJ-0003 : commit 258 durable ; dérivés machine vérifiés ; STATE/HANDOFF/head 257 ; projection 3 ; human_handoff exhausted ; âge 640 s ; 6 tentatives ; prochaine sonde dans cinq minutes ». Le runtime fournit aussi une échéance UTC exacte. Inclure code précis, chemin relatif concerné, preuve attendue/observée, dernière réussite, propriétaire MaterializationGuard, lien authentifié vers diagnostic et procédure de §13. Cet exemple décrit un format, sans affirmer ces chiffres pour l’incident historique.

Le routage opérateur doit être configuré et testé avant activation : événement structuré vers le système de monitoring de déploiement, avec accusé de réception et déduplication par projet/couche/incident. Un échec de notification garde `notification_pending`, retries bornés puis sondes lentes ; le watchdog externe alerte aussi sur les heartbeats manquants. Aucun nouveau backend de métriques n’est imposé, mais l’absence d’un canal effectivement testé est un blocker de rollout. Fermer l’incident seulement après vérification de toutes ses couches, en conservant dates et durée de violation.

## 13. Procédure de récupération

Procédure normale exécutée par le runtime, sans commande utilisateur :

1. Découvrir le dernier commit contigu et vérifier les identités. En cas d’intégrité douteuse, conserver les preuves et bloquer les mutations dépendantes.
2. Reconstituer le progrès et les budgets depuis preuves externes ; réarmer les continuations manquantes, sans effacer l’alerte.
3. Vérifier chaque dérivé ; créer uniquement les events/receipts manquants, converger state/manifest par CAS, respecter le propriétaire RegistryGuard.
4. Reprendre le plan humain et ses seuls outputs manquants/incertains ; protéger les bytes externes ; finir la cible active puis la cible récente.
5. Vérifier chaîne, paire critique, génération et head. Un head stale après record complet se répare seul lorsque les bytes critiques correspondent.
6. Recalculer le vecteur complet ; publier les métriques et résoudre l’incident. Le receipt original est toujours disponible depuis le record, même si sa copie était retardée.

Après exhaustion technique, cette même procédure reprend à la première sonde réussie. Ni nouvelle transaction, ni suppression de commit, ni édition de HANDOFF/STATE, ni reset de ledger ne font partie du fonctionnement normal.

Exception opérateur : inspecter le diagnostic authentifié, vérifier l’identité du déploiement et la dépendance défaillante, restaurer le service/capacité ou résoudre le conflit via la gouvernance existante. L’endpoint admin de matérialisation reste disponible, authentifié, project-scoped, soumis aux mêmes budgets/CAS et sans révision métier ; il ne doit plus constituer une boucle synchrone sans borne. Sa réponse de complétion reste vraie uniquement si les postconditions le sont ; sinon réponse explicite de travail en cours ou d’échec, jamais `materialized: true` anticipé. Préserver les historiques et les projets archivés.

## 14. Matrice de tests de panne et critères de revue

Tests futurs déterministes avec horloge virtuelle et doubles provider/DO. La présente PR ne les implémente pas et ne prétend pas qu’ils passent. Étendre le harness existant (qui injecte surtout des erreurs avant mutation) pour couvrir réussite provider suivie de perte de réponse, crash/eviction et ordonnanceur contrôlé.

Pour **chaque frontière d’effet persisté** ci-dessous, tester avant effet, effet réussi/réponse perdue, crash avant checkpoint, replay concurrent et perte du ledger ; comparer nombre de commits/événements/receipts, hashes et états. Tester aussi l’échec de la relecture qui devait lever l’ambiguïté.

| Famille | Pannes/scénarios obligatoires | Oracle |
|---|---|---|
| Commit | Création record, réponse perdue, conflit même révision/autre payload, crash avant persistCommit | Un record ; même receipt exact ; résultat inconnu explicite tant que non vérifiable |
| Identité/recovery | Même transaction/autre payload, wrong-project, snapshot stale/futur injustifié, record même révision invalide, trou avec record ultérieur, baseline pré-COMMIT001 | Refus sûr ; aucun saut/faux current ; identité conservée |
| Handoff | Non livré, non-2xx, timeout, ACK perdu, doublon, mauvais binding, corps non consommé | Commit inchangé ; cible retrouvée sans requête utilisateur ; pas d’I/O humain ProjectGuard |
| Dérivés | Échec indépendant event, state, manifest, receipt ; suppression/corruption après génération complète ; trous historiques ; event258 bloqué avec receipt258/state259/manifest259 réparables | Chaque couche visible ; pas de court-circuit head ; pas de perte liée à coalescence |
| Régression 258 | Commit seul 258, quatre dérivés réparés, paire/head à257, plusieurs ticks sans progrès | Alerte et âge humain restent ouverts ; retour provider → 258/PV3 sans transaction |
| Coalescence | 258..261 rapides ; nouvelles révisions continues ; ancien job reprend après nouvelle cible | Tous events/receipts ; cible active non affamée ; aucune régression snapshots/head |
| Paire critique | Un seul Markdown écrit, vérification échoue, edit externe entre rendu et CAS, edit après génération ; write ancien réussit après timeout entre vérification et head du repreneur ; cible non critique bloquée puis259..261 | Pas de fausse paire/head complète ; drift distinct ; bytes externes conservés |
| Génération | Record terminé/head échoué ; root/parent/cycle absents ou corrompus ; 128/129 records ; projection inconnue | Reprise ciblée ; borne reconstruction ; pas d’écrasement d’immuable |
| Scheduler | Alarme absente/dupliquée/tardive, constructor puis alarm, setAlarm échoué, statut fréquent, crash après réservation | Compteur persistant ; échéance la plus proche ; aucun reset du budget par polling |
| Backoff | 429 + Retry-After, 5xx, timeouts, 6 échecs, retour service à20 min, erreur permanente | Délais exacts bornés ; alerte exhaustion ; une sonde/réparation lente ; reprise automatique |
| Journaux | Crash à chaque write réservation/progress/alerte, perte SQLite, checkpoint stale, CAS concurrent, corruption externe | Budget non remis à zéro ; reconstruction vérifiée ; fail-closed intégrité |
| Fleet | Inbox échoue/bloque, search échoue, registre indisponible, un projet lent parmi10, pagination/cursor perdu, backlog important | Jobs indépendants ; fairness ; heartbeat externe ; aucune réactivation archive |
| Capacité | Enveloppe §12, budget provider/tranche épuisé, chaîne longue, gros output, afflux continu | Continuation sans répétition du préfixe ; SLO mesuré ; overload explicite |
| Fraîcheur | Head257/canon258 ; token absent/expiré/falsifié/wrong-project ; révision avance après lecture ; additive stale ; replay committed token expiré | Pas de mutation silencieuse ; erreur d’admission sans consommer ID ; replay original |
| Transports | API, incoming, vieux client, fallback #139 incomplet/tronqué, contexte provenant du numéro Markdown seul | Contexte authentifié complet ; mode strict fail-closed ; pas de base remplacée en silence |
| Registry/archive | Création avant finalisation registre, receipt création manquant ; archive move/réponse perdue ; deux racines conflictuelles | Ownership respectée ; reprise owner ; aucun active workspace ressuscité |
| Rollback | Candidate échoue avant/après commit ; stable fallback échoue ; downgrade incompatible | Même transaction_id ; au plus un fallback ; aucun rewind ; reader compatible exigé |
| Gouvernance | Promotion #147 interrompue/rejouée, managed document divergent, MutationGate bloque | Convergence ne publie/accepte rien ; préconditions propres conservées |
| Observabilité | Notification perdue, monitoring absent, timestamps client faux, log sanitization, succès partiel | Incident persiste ; watchdog ; t0 fiable/inconnu explicite ; pas de fuite |

Gates d’implémentation : tests de fault injection ci-dessus, suites commit/recovery/materialization/rollback/registry/concurrency/provider, compatibilité schema et gouvernance, test fleet sans trafic, full CI et dry-run sur SHA exact. Exécuter les scripts du main retenu pour l’implémentation, notamment `npm run check`, `npm run test:persistence-high-risk` et le dry-run ; le gate INDEX001 à la base examinée est `scripts/check-index001-deployment-gates.mjs`. Aucun test réel ne doit injecter une panne dans PRJ-0003.

La revue de design doit vérifier particulièrement : toutes les fenêtres après commit, séparation event/receipt versus coalescence humaine, budgets persistants malgré crash, absence de régression sous CAS, admission des anciens clients, indépendance du cron et faisabilité mesurée des bornes. L’auto-revue du document couvre contradictions, liens, périmètre, définitions de complétion et absence de sections inachevées. La contre-revue documentaire a conduit à préciser la suspension des cibles bloquées, le fencing des effets provider incertains et les files indépendantes des dérivés ; ces corrections sont des exigences de design, sans preuve runtime à ce stade.

## 15. Compatibilité, rollout et retour arrière

1. **Lecteurs/diagnostic d’abord.** Ajouter la lecture de la famille convergence v1 et le vecteur de statut de façon additive. Préserver les enveloppes strictes existantes ; aucun upcast/downcast de record métier dans ce package. Anciennes baselines sans record supportées explicitement, sans inventer leur historique.
2. **Observation sans réparation nouvelle.** Comparer le vecteur aux preuves existantes, mesurer charge/latences, tester le canal d’alerte et inventorier les clients. Ne pas annoncer que le mode observe satisfait la protection de mutation stricte.
3. **Canary isolé, autorisé séparément.** Activer le nouveau writer technique dans MaterializationGuard pour un projet synthétique alloué normalement. Un seul writer actif par projet ; ancienne boucle de retry désactivée pour ce projet, leases et CAS prouvés. Pas de migration/destruction du stockage DO existant.
4. **Validation de récupération.** Prouver les scénarios pré/post-commit, handoff perdu, perte SQLite, incident synthétique258, retry épuisé puis retour dépendance, archive et absence de trafic. Qualifier l’enveloppe et les SLO sur 24 heures minimum, avec exercice d’alerte/retour arrière.
5. **Migration d’admission.** Clients API/incoming/fallback reçoivent l’enveloppe fraîche, contrôles en observation, puis strict par projet après preuve de compatibilité. Toute route non migrée est un blocker d’activation stricte. Aucun changement tacite de MODEL001.
6. **Extension graduelle.** Activer projet par projet, surveiller oldest_pending, erreurs et latency. Une violation de sûreté arrête immédiatement l’extension ; SLO hors budget suspend l’extension et conserve la réparation existante. Continuité reste stable ; ni MutationGate mode, ni activation binary/promote, ni schema writer stage ne sont changés conjointement.
7. **Preuve de production distincte.** SHA exact, CI, déploiement/health exacts, preuve de convergence automatique et preuve d’admission fraîche sont nécessaires. Une PR fusionnée n’est pas une preuve de production. La mise à jour canonique PRJ-0002 éventuelle appartient à une mission ultérieure autorisée.

Rollback : revenir au dernier runtime **compatible** avec les schémas déjà écrits et capable de lire/reprendre les continuations, budgets et préconditions d’admission. Désactiver le nouveau writer exige un drain/transfer vérifié ; un ancien binaire qui ignore ces preuves ne constitue pas un rollback sûr. Préparer une version stable compatible avant canary ; sinon rollback d’activation seulement, maintien du reader et du recoverer, nouvelles mutations bloquées si leur sûreté ne peut être prouvée. Conserver le contexte strict une fois qu’il protège le projet. Ne jamais baisser la projection/version ou restaurer un snapshot historique pour revenir en arrière.

Le rollback technique candidate→stable garde le même transaction_id, vérifie le commit existant et ne recrée pas ses effets. Une erreur de matérialisation après commit n’est pas un motif de réexécution métier. Les journaux de convergence et de promotion restent distincts et préservés.

## 16. Critères d’acceptation et limites

Le design est implémenté seulement lorsque les invariants et tests de §5/§14 sont prouvés, que le cas258 converge automatiquement sans nouvelle mutation, que chaque couche peut être volontairement mise en défaut et identifiée seule, que l’exhaustion alerte et récupère au retour du service, et que les SLO/admission stricte ont leur preuve de rollout.

Limites explicites : la cause racine historique et la durée exacte de chaque étape ne sont pas établies ici ; aucune garantie de sync Obsidian hors ligne ; aucun overwrite de conflit externe ; aucune borne d’écriture pendant une panne provider illimitée ; pas de refonte des documents, du registre, de la recherche, des schémas métier, de l’authentification globale ou du déploiement automatique. Les budgets et l’enveloppe sont des exigences à valider par mesure, pas des résultats de performance acquis.

Cette spécification v1.1 est le gate de conception de la reprise. Après sa revue, l’implémentation, les tests runtime, la fusion, le canary, le déploiement, la réparation PRJ-0003, le rattrapage global et l’enregistrement canonique restent des étapes distinctes avec preuves propres; le mandat continu permet de les enchaîner mais jamais de les confondre.
