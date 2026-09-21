import { localDB } from "../client.ts";
import { getAllDocsByType } from "../getAllDocsByType.ts";
import { type PouchDoc, stripPouchFields, toPouchDoc } from "../utils.ts";
import {
  seasonSchema,
  type Season,
} from "../../../validation/season.schema.ts";

const DOC_TYPE = "season";

type CreateSeasonInput = Omit<
  Season,
  "id" | "version" | "createdAt" | "updatedAt" | "deletedAt"
>;

type UpdateSeasonInput = Partial<CreateSeasonInput>;

function now(): string {
  return new Date().toISOString();
}

export async function create(input: CreateSeasonInput): Promise<Season> {
  const timestamp = now();
  const record: Season = {
    ...input,
    id: crypto.randomUUID(),
    version: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  const parsed = seasonSchema.parse(record);
  const doc = toPouchDoc(parsed, DOC_TYPE);
  await localDB.put(doc);
  return parsed;
}

export async function update(
  id: string,
  changes: UpdateSeasonInput,
): Promise<Season> {
  const docId = `${DOC_TYPE}:${id}`;
  let existing: PouchDoc<Season>;
  try {
    existing = await localDB.get<PouchDoc<Season>>(docId);
  } catch {
    throw new Error(`Season not found: ${id}`);
  }

  const entity = stripPouchFields(existing);
  if (entity.deletedAt != null) {
    throw new Error(`Season not found: ${id}`);
  }

  // If activating this season, deactivate all others first
  if (changes.isActive === true && !entity.isActive) {
    await deactivateAllExcept(id);
  }

  const updated: Season = {
    ...entity,
    ...changes,
    id: entity.id,
    version: entity.version + 1,
    createdAt: entity.createdAt,
    updatedAt: now(),
  };

  const parsed = seasonSchema.parse(updated);
  const doc = toPouchDoc(parsed, DOC_TYPE);
  doc._rev = existing._rev;
  await localDB.put(doc);
  return parsed;
}

export async function softDelete(id: string): Promise<void> {
  const docId = `${DOC_TYPE}:${id}`;
  let existing: PouchDoc<Season>;
  try {
    existing = await localDB.get<PouchDoc<Season>>(docId);
  } catch {
    throw new Error(`Season not found: ${id}`);
  }

  const entity = stripPouchFields(existing);
  if (entity.deletedAt != null) {
    throw new Error(`Season not found: ${id}`);
  }

  const timestamp = now();
  const deleted = seasonSchema.parse({
    ...entity,
    deletedAt: timestamp,
    updatedAt: timestamp,
    version: entity.version + 1,
  });

  const doc = toPouchDoc(deleted, DOC_TYPE);
  doc._rev = existing._rev;
  await localDB.put(doc);
}

export async function getById(id: string): Promise<Season | undefined> {
  const docId = `${DOC_TYPE}:${id}`;
  try {
    const doc = await localDB.get<PouchDoc<Season>>(docId);
    const entity = stripPouchFields(doc);
    if (entity.deletedAt != null) return undefined;
    return entity;
  } catch {
    return undefined;
  }
}

/** Prefix-bounded allDocs retrieval: returns ALL raw docs of this docType
 *  (including soft-deleted) without the pouchdb-find 25-doc default limit.
 *  Callers filter. Used by getActive and deactivateAllExcept; getAll is a
 *  separate concern handled elsewhere. */
async function getRawSeasonDocs(): Promise<Array<PouchDoc<Season>>> {
  const result = await localDB.allDocs({
    startkey: DOC_TYPE + ":",
    endkey: DOC_TYPE + ":\ufff0",
    include_docs: true,
  });
  return result.rows.map((r) => r.doc).filter(Boolean) as Array<
    PouchDoc<Season>
  >;
}

export async function getActive(): Promise<Season | undefined> {
  const seasons = (await getRawSeasonDocs())
    .map(stripPouchFields)
    .filter((r) => r.isActive && r.deletedAt == null);
  return seasons[0];
}

export async function getAll(): Promise<Season[]> {
  return (await getAllDocsByType<Season>(DOC_TYPE))
    .map(stripPouchFields)
    .filter((r) => r.deletedAt == null)
    .sort((a, b) => b.year - a.year);
}

/** Deactivate all active seasons except the one with the given id. */
async function deactivateAllExcept(exceptId: string): Promise<void> {
  const timestamp = now();

  for (const doc of await getRawSeasonDocs()) {
    const entity = stripPouchFields(doc);
    if (entity.isActive && entity.id !== exceptId && entity.deletedAt == null) {
      const deactivated = seasonSchema.parse({
        ...entity,
        isActive: false,
        version: entity.version + 1,
        updatedAt: timestamp,
      });
      const deactivatedDoc = toPouchDoc(deactivated, DOC_TYPE);
      deactivatedDoc._rev = doc._rev;
      await localDB.put(deactivatedDoc);
    }
  }
}

/**
 * Sets a season as active, deactivating all others.
 * PouchDB doesn't have transactions, so we update sequentially.
 * Conflict resolution relies on _rev optimistic concurrency.
 */
export async function setActive(id: string): Promise<Season> {
  const docId = `${DOC_TYPE}:${id}`;
  let targetDoc: PouchDoc<Season>;
  try {
    targetDoc = await localDB.get<PouchDoc<Season>>(docId);
  } catch {
    throw new Error(`Season not found: ${id}`);
  }

  const target = stripPouchFields(targetDoc);
  if (target.deletedAt != null) {
    throw new Error(`Season not found: ${id}`);
  }

  await deactivateAllExcept(id);

  // Activate the target
  const timestamp = now();
  const activated = seasonSchema.parse({
    ...target,
    isActive: true,
    version: target.version + 1,
    updatedAt: timestamp,
  });

  const activatedDoc = toPouchDoc(activated, DOC_TYPE);
  activatedDoc._rev = targetDoc._rev;
  await localDB.put(activatedDoc);
  return activated;
}
