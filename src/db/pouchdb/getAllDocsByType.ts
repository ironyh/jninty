import { localDB } from "./client.ts";
import type { PouchDoc } from "./utils.ts";

/**
 * Prefix-bounded allDocs retrieval: returns ALL docs whose _id starts with
 * "docType:" (including soft-deleted) without the pouchdb-find 25-doc
 * default limit. Callers strip wrapper fields and apply soft-delete/other
 * filters. Rows are ordered by _id ascending, matching the [docType, _id]
 * order the find()-based reads returned.
 */
export async function getAllDocsByType<T = unknown>(
  docType: string,
): Promise<PouchDoc<T>[]> {
  const result = await localDB.allDocs({
    startkey: `${docType}:`,
    endkey: `${docType}:\ufff0`,
    include_docs: true,
  });
  return result.rows
    .map((r) => r.doc)
    .filter(Boolean) as unknown as PouchDoc<T>[];
}
