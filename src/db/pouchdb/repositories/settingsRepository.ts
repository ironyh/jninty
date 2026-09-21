import { localDB } from "../client.ts";
import {
  settingsSchema,
  type Settings,
} from "../../../validation/settings.schema.ts";

const DOC_TYPE = "settings";
const DOC_ID = `${DOC_TYPE}:singleton`;

/** PouchDB NotFoundError: the document does not exist. */
function isNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "status" in err &&
    (err as { status?: unknown }).status === 404
  );
}

/** PouchDB ConflictError: a rev-less/rev-stale put lost the race. */
function isConflict(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "status" in err &&
    (err as { status?: unknown }).status === 409
  );
}

export async function get(): Promise<Settings | undefined> {
  try {
    const doc = await localDB.get<Record<string, unknown>>(DOC_ID);
    // Strip PouchDB and wrapper fields
    const { _id, _rev, docType, ...rest } = doc;
    void _id;
    void _rev;
    void docType;
    // Parse through Zod so .default() fills in newly-added fields for migrated docs
    return settingsSchema.parse(rest);
  } catch {
    return undefined;
  }
}

export async function update(
  changes: Partial<Settings>,
): Promise<Settings> {
  // Pin the database instance for this whole read/write sequence: if the
  // database is reset or replaced mid-flight (test boundary or replace
  // import), this operation keeps operating on its own instance instead of
  // writing into the freshly created one.
  const db = localDB;

  let existing: Record<string, unknown> | undefined;
  let rev: string | undefined;

  try {
    const doc = await db.get<Record<string, unknown>>(DOC_ID);
    rev = doc._rev;
    const { _id, _rev: _, docType, ...rest } = doc;
    void _id;
    void _;
    void docType;
    existing = rest;
  } catch {
    // Document doesn't exist yet
  }

  let merged: Settings;
  if (existing) {
    merged = { ...(existing as Settings), ...changes };
  } else {
    merged = settingsSchema.parse(changes);
  }

  const parsed = settingsSchema.parse(merged);

  const pouchDoc: Record<string, unknown> = {
    _id: DOC_ID,
    docType: DOC_TYPE,
    ...parsed,
  };

  if (rev) {
    pouchDoc["_rev"] = rev;
  }

  await db.put(pouchDoc);
  return parsed;
}

/**
 * First-run initialization — distinct from `update`:
 *
 * - Creates the singleton only when it does not exist yet. If settings are
 *   already stored (another concurrent initializer won, or a previous run
 *   stored real data), the STORED record wins and is returned verbatim —
 *   including values that differ from the defaults. Defaults are never
 *   written over existing data.
 * - A lost initialization race (409 from the rev-less put) is recovered by
 *   returning the stored record: a losing initializer must not surface an
 *   error for a state that is correct. PouchDB signals this conflict with
 *   `status: 409` (pouchdb-errors ConflictError).
 * - Every other error is rethrown: a failure is never reported as a
 *   successful initialization.
 * - The database instance is pinned for the whole sequence (see `update`),
 *   so a database reset or replacement mid-flight cannot receive this
 *   operation's write.
 *
 * Ordinary user edits must use `update`, which still applies the user's
 * changes and lets genuine conflicts propagate instead of discarding them.
 */
export async function initialize(defaults: Settings): Promise<Settings> {
  const db = localDB;

  let stored: Settings | undefined;
  try {
    const doc = await db.get<Record<string, unknown>>(DOC_ID);
    const { _id, _rev, docType, ...rest } = doc;
    void _id;
    void _rev;
    void docType;
    stored = settingsSchema.parse(rest);
  } catch (err) {
    // ONLY a missing document (status 404, pouchdb-errors NotFoundError) may
    // enter creation. Any other failure — a transient read error, a
    // destroyed/discarded database, or a corrupt stored document (schema
    // parse) — must propagate: treating it as "absent" would write defaults
    // over data we could not read or that we failed to parse.
    if (!isNotFound(err)) {
      throw err;
    }
  }

  if (stored) {
    // Already initialized (concurrent initializer or prior data): stored wins.
    return stored;
  }

  try {
    const doc: Record<string, unknown> = {
      _id: DOC_ID,
      docType: DOC_TYPE,
      ...settingsSchema.parse(defaults),
    };
    await db.put(doc);
    return settingsSchema.parse(defaults);
  } catch (err) {
    if (isConflict(err)) {
      // Lost the initialization race: return the winner's stored settings.
      const doc = await db.get<Record<string, unknown>>(DOC_ID);
      const { _id, _rev, docType, ...rest } = doc;
      void _id;
      void _rev;
      void docType;
      return settingsSchema.parse(rest);
    }
    throw err;
  }
}

export async function clearLocation(): Promise<Settings> {
  let doc: Record<string, unknown>;
  try {
    doc = await localDB.get<Record<string, unknown>>(DOC_ID);
  } catch {
    throw new Error("Settings not initialized");
  }

  const { _id, _rev, docType, ...rest } = doc;
  void _id;
  void docType;

  const settings = rest as Record<string, unknown>;
  delete settings["latitude"];
  delete settings["longitude"];

  const parsed = settingsSchema.parse(settings);

  const pouchDoc: Record<string, unknown> = {
    _id: DOC_ID,
    _rev,
    docType: DOC_TYPE,
    ...parsed,
  };

  await localDB.put(pouchDoc);
  return parsed;
}
