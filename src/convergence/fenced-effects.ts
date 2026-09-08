import { sha256Text } from "../materialization/hash";
import type { ProjectOsPersistenceRuntime } from "../persistence/provider/capabilities";
import type { EffectIntent, Progress, SliceBudget } from "./contract";
import { ConvergenceJournal } from "./journal";

export interface ObservedText {
  content: string;
  hash: string;
  object_id: string;
  token: string;
}

/**
 * Obtains a byte-level observation that can safely be used as a provider
 * precondition. Metadata is read on both sides of the bytes so a concurrent
 * replacement can never be mistaken for evidence about the old object.
 */
export async function observeText(
  runtime: ProjectOsPersistenceRuntime,
  path: string
): Promise<ObservedText | null> {
  const first = await runtime.objects.getMetadata(path);
  const content = await runtime.objects.readText(path);
  const last = await runtime.objects.getMetadata(path);
  if (!first && content === null && !last) return null;
  if (
    content === null
    || !first?.objectId
    || !first.revisionToken
    || first.objectId !== last?.objectId
    || first.revisionToken !== last?.revisionToken
  ) {
    throw new Error("observation_unstable");
  }
  return {
    content,
    hash: await sha256Text(content),
    object_id: first.objectId,
    token: first.revisionToken
  };
}

/**
 * Gives every mutable derived write a journal-backed provider precondition.
 * An effect can start only from the checkpoint token produced by prepare;
 * any newer checkpoint fences the old worker before it reaches Dropbox.
 */
export class FencedEffects {
  private readonly prepared = new Map<string, { token: string; incarnation: string }>();

  constructor(
    private readonly runtime: ProjectOsPersistenceRuntime,
    private readonly journal: ConvergenceJournal,
    private readonly budget: SliceBudget
  ) {}

  async prepare(progress: Progress, token: string, intent: EffectIntent): Promise<string> {
    const preparedIntent = { ...intent, state: "prepared" as const };
    // The caller keeps this same progress object for the rest of its slice.
    progress.effects[intent.id] = preparedIntent;
    const saved = await this.journal.save({ ...progress, effects: { ...progress.effects } }, token);
    this.prepared.set(intent.id, { token: saved, incarnation: progress.incarnation });
    return saved;
  }

  async replace(intent: EffectIntent, content: string): Promise<ObservedText> {
    await this.assertPrepared(intent);
    if (intent.desired_hash && intent.desired_hash !== await sha256Text(content)) {
      throw new Error("effect_desired_hash_mismatch");
    }
    this.requireEffectBudget();
    if (intent.expected_token) {
      await this.runtime.conditionalWrite.writeTextConditional(intent.path, content, intent.expected_token);
    } else {
      try {
        await this.runtime.objects.createText(intent.path, content);
      } catch {
        const observed = await observeText(this.runtime, intent.path);
        if (!observed || observed.hash !== await sha256Text(content)) throw new Error("effect_create_not_proven");
        return observed;
      }
    }
    const observed = await observeText(this.runtime, intent.path);
    if (!observed || observed.hash !== await sha256Text(content)) throw new Error("effect_postcondition_failed");
    return observed;
  }

  async neutralize(intent: EffectIntent, authorizedContent: string): Promise<ObservedText> {
    const current = await observeText(this.runtime, intent.path);
    if (!current) throw new Error("effect_neutralization_missing");
    if (current.hash === await sha256Text(authorizedContent)) return current;
    this.requireEffectBudget();
    await this.runtime.conditionalWrite.writeTextConditional(intent.path, authorizedContent, current.token);
    const observed = await observeText(this.runtime, intent.path);
    if (!observed || observed.hash !== await sha256Text(authorizedContent)) {
      throw new Error("effect_neutralization_unproven");
    }
    return observed;
  }

  async observe(path: string): Promise<ObservedText | null> {
    return observeText(this.runtime, path);
  }

  private async assertPrepared(intent: EffectIntent): Promise<void> {
    const prepared = this.prepared.get(intent.id);
    if (!prepared) throw new Error("effect_not_prepared");
    const current = await this.journal.load();
    if (
      !current
      || current.token !== prepared.token
      || current.progress.incarnation !== prepared.incarnation
      || current.progress.effects[intent.id]?.state !== "prepared"
    ) {
      throw new Error("fencing_checkpoint_changed");
    }
  }

  private requireEffectBudget(): void {
    if (!this.budget.canStartEffect(1)) throw new Error("slice_budget_exhausted");
  }
}
