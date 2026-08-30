import type { ReferralTransportReceipt } from "../domain/referral";
import { machineReferralReceiptPath } from "../persistence/layout";
import type { ProjectOsPersistenceRuntime } from "../persistence/provider/capabilities";
import { ProviderConflictError } from "../persistence/provider/errors";
import { asProjectOsPersistence, type PersistenceInput } from "../persistence/provider/runtime";

export class ReferralRepository {
  private readonly runtime: ProjectOsPersistenceRuntime;

  constructor(input: PersistenceInput) {
    this.runtime = asProjectOsPersistence(input);
  }

  async readReceipt(referralId: string): Promise<ReferralTransportReceipt | null> {
    const raw = await this.runtime.objects.readText(machineReferralReceiptPath(referralId));
    if (raw === null) return null;
    const receipt = JSON.parse(raw) as ReferralTransportReceipt;
    if (receipt.referral_id !== referralId) {
      throw new Error(`Referral receipt binding mismatch: expected ${referralId}, got ${receipt.referral_id}`);
    }
    return receipt;
  }

  async writeReceipt(receipt: ReferralTransportReceipt): Promise<void> {
    const path = machineReferralReceiptPath(receipt.referral_id);
    const content = pretty(receipt);
    try {
      await this.runtime.objects.createText(path, content);
    } catch (error) {
      if (!(error instanceof ProviderConflictError)) throw error;
      const existing = await this.runtime.objects.readText(path);
      if (existing !== content) throw new Error(`Immutable referral receipt conflict: ${path}`);
    }
  }
}

function pretty(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
