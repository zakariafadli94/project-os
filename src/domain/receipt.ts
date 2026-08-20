export type ReceiptStatus = "committed" | "rejected" | "conflict";

export interface Receipt {
  schema_version: "1.0";
  transaction_id: string;
  status: ReceiptStatus;
  project_id: string;
  previous_revision: number;
  new_revision: number;
  event_id?: string;
  code?: string;
  message?: string;
  committed_at?: string;
}
