import { localDB } from "../db/pouchdb/client.ts";

interface ConflictDoc {
  _id: string;
  _rev: string;
  _conflicts?: string[];
}

type ConflictCandidate = {
  _rev?: string;
  updatedAt?: string;
  deletedAt?: string;
};

/**
 * Whether a conflict candidate is a tombstone. Only a non-empty string
 * `deletedAt` represents a soft delete; Jninty's soft-delete semantics are
 * entirely represented by this field, so anything else is treated as live.
 */
function isTombstone(candidate: ConflictCandidate): boolean {
  return (
    typeof candidate.deletedAt === "string" && candidate.deletedAt.length > 0
  );
}

/**
 * Total deterministic ordering over the conflicting leaves of one document.
 * Tombstone-dominant policy:
 *   1. a tombstone (valid `deletedAt`) beats every live leaf;
 *   2. tombstone vs tombstone: latest `deletedAt` wins;
 *   3. live vs live: latest `updatedAt` wins (missing `updatedAt` counts as
 *      the earliest possible time);
 *   4. any remaining tie is broken by lexical `_rev`, so the same set of
 *      leaves yields the same winner on every device, independent of
 *      enumeration order.
 *
 * Deletion dominance is deliberate: Jninty's delete UI presents deletion as
 * permanent ("cannot be undone") and there is no undelete or conflict-
 * resolution UI, so a competing live edit must not silently resurrect a
 * deleted entity. The losing leaf's fields are discarded (documented
 * tradeoff) — no merged revision is ever constructed.
 *
 * Returns < 0 if `a` loses to `b`, > 0 if `a` beats `b`, 0 if identical.
 */
export function compareConflictCandidates(
  a: ConflictCandidate,
  b: ConflictCandidate,
): number {
  const aTombstone = isTombstone(a);
  const bTombstone = isTombstone(b);
  if (aTombstone !== bTombstone) return aTombstone ? 1 : -1;

  const timeKey = (candidate: ConflictCandidate): string => {
    if (aTombstone && bTombstone) {
      return typeof candidate.deletedAt === "string" &&
        candidate.deletedAt.length > 0
        ? candidate.deletedAt
        : "";
    }
    return typeof candidate.updatedAt === "string" &&
      candidate.updatedAt.length > 0
      ? candidate.updatedAt
      : "";
  };

  const aKey = timeKey(a);
  const bKey = timeKey(b);
  if (aKey !== bKey) return aKey < bKey ? -1 : 1;

  const aRev = a._rev ?? "";
  const bRev = b._rev ?? "";
  if (aRev !== bRev) return aRev < bRev ? -1 : 1;
  return 0;
}

export async function getConflicts(): Promise<ConflictDoc[]> {
  const result = await localDB.allDocs({
    conflicts: true,
    include_docs: true,
  });

  const conflicts: ConflictDoc[] = [];
  for (const row of result.rows) {
    const doc = row.doc as ConflictDoc | undefined;
    if (doc?._conflicts && doc._conflicts.length > 0) {
      conflicts.push(doc);
    }
  }
  return conflicts;
}

export async function resolveConflict(
  docId: string,
  winningRev: string,
): Promise<void> {
  const doc = await localDB.get(docId, { conflicts: true });
  const allConflicts = (doc as ConflictDoc)._conflicts ?? [];

  // Delete all revisions that are not the winner
  for (const rev of allConflicts) {
    if (rev !== winningRev) {
      await localDB.remove(docId, rev);
    }
  }

  // If the current rev is not the winner, we need to swap them
  if (doc._rev !== winningRev) {
    const winner = await localDB.get(docId, { rev: winningRev });
    // Remove the current (losing) rev
    await localDB.remove(docId, doc._rev);
    // Put the winner back
    await localDB.put(winner);
  }
}

export async function autoResolveByLastWrite(): Promise<number> {
  const conflictDocs = await getConflicts();
  let resolved = 0;

  for (const doc of conflictDocs) {
    try {
      const allRevs = [doc._rev, ...(doc._conflicts ?? [])];

      // Tombstone-dominant winner selection (see compareConflictCandidates).
      // Fetching every conflicting leaf up front keeps the result independent
      // of enumeration order.
      let winner: ConflictCandidate = doc;
      for (const rev of doc._conflicts ?? []) {
        const candidate = (await localDB.get(doc._id, {
          rev,
        })) as ConflictCandidate;
        if (compareConflictCandidates(winner, candidate) < 0) winner = candidate;
      }
      const winningRev = winner._rev ?? doc._rev;

      // Delete all losing revisions
      for (const rev of allRevs) {
        if (rev !== winningRev) {
          await localDB.remove(doc._id, rev);
        }
      }

      resolved++;
      console.log(
        `[sync] Auto-resolved conflict on ${doc._id}: kept rev ${winningRev}`,
      );
    } catch (err) {
      console.warn(`[sync] Failed to resolve conflict on ${doc._id}:`, err);
    }
  }

  return resolved;
}
