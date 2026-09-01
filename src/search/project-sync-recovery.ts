interface SearchSyncEpochRow {
  [key: string]: SqlStorageValue;
  document_epoch_started_at: string;
}

export function restartSearchDocumentEpoch(storage: DurableObjectStorage): void {
  storage.transactionSync(() => {
    const rows = storage.sql.exec<SearchSyncEpochRow>(
      `SELECT document_epoch_started_at
       FROM search_sync_control
       WHERE singleton = 1`
    ).toArray();
    if (rows.length !== 1) {
      throw new Error("Search synchronization control row is missing or duplicated");
    }

    const previousStartedAt = Date.parse(rows[0].document_epoch_started_at);
    if (!Number.isFinite(previousStartedAt)) {
      throw new Error("Search document synchronization epoch start is invalid");
    }

    const epoch = crypto.randomUUID();
    const epochStartedAt = new Date(Math.max(Date.now(), previousStartedAt + 1)).toISOString();

    // A new document epoch supersedes every pending/completed batch from the
    // prior epoch. Source-deduplication evidence is deliberately preserved so
    // replayed authoritative document/artifact receipts cannot create duplicate
    // work after a read-model rebuild.
    storage.sql.exec("DELETE FROM search_document_batches");
    storage.sql.exec(
      `UPDATE search_sync_control
       SET document_epoch = ?,
           document_epoch_started_at = ?,
           document_generation_requested = 1,
           document_generation_indexed = 0,
           last_error = NULL
       WHERE singleton = 1`,
      epoch,
      epochStartedAt
    );
    storage.sql.exec(
      `INSERT INTO search_document_batches (
         generation, full_snapshot, document_ids_json, status, attempts, last_error
       ) VALUES (1, 1, '[]', 'pending', 0, NULL)`
    );
  });
}
