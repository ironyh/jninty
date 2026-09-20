import { localDB } from "../client.ts";
import { type PouchDoc, stripPouchFields, toPouchDoc } from "../utils.ts";
import {
  scheduleTaskSchema,
  type ScheduleTask,
} from "../../../validation/scheduleTask.schema.ts";

const DOC_TYPE = "scheduleTask";

type CreateInput = Omit<
  ScheduleTask,
  "id" | "version" | "createdAt" | "updatedAt" | "deletedAt"
>;

type UpdateInput = Partial<CreateInput>;

function now(): string {
  return new Date().toISOString();
}

export async function create(input: CreateInput): Promise<ScheduleTask> {
  const timestamp = now();
  const record: ScheduleTask = {
    ...input,
    id: crypto.randomUUID(),
    version: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  const parsed = scheduleTaskSchema.parse(record);
  const doc = toPouchDoc(parsed, DOC_TYPE);
  await localDB.put(doc);
  return parsed;
}

export async function createBatch(
  inputs: CreateInput[],
): Promise<ScheduleTask[]> {
  const timestamp = now();
  const tasks: ScheduleTask[] = [];
  const docs: PouchDoc<ScheduleTask>[] = [];

  for (const input of inputs) {
    const record: ScheduleTask = {
      ...input,
      id: crypto.randomUUID(),
      version: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    const parsed = scheduleTaskSchema.parse(record);
    tasks.push(parsed);
    docs.push(toPouchDoc(parsed, DOC_TYPE));
  }

  await localDB.bulkDocs(docs);
  return tasks;
}

export async function update(
  id: string,
  changes: UpdateInput,
): Promise<ScheduleTask> {
  const docId = `${DOC_TYPE}:${id}`;
  let existing: PouchDoc<ScheduleTask>;
  try {
    existing = await localDB.get<PouchDoc<ScheduleTask>>(docId);
  } catch {
    throw new Error(`ScheduleTask not found: ${id}`);
  }

  const entity = stripPouchFields(existing);
  if (entity.deletedAt != null) {
    throw new Error(`ScheduleTask not found: ${id}`);
  }

  const updated: ScheduleTask = {
    ...entity,
    ...changes,
    id: entity.id,
    version: entity.version + 1,
    createdAt: entity.createdAt,
    updatedAt: now(),
  };

  const parsed = scheduleTaskSchema.parse(updated);
  const doc = toPouchDoc(parsed, DOC_TYPE);
  doc._rev = existing._rev;
  await localDB.put(doc);
  return parsed;
}

export async function complete(
  id: string,
  completedDate: string,
): Promise<ScheduleTask> {
  const docId = `${DOC_TYPE}:${id}`;
  let existing: PouchDoc<ScheduleTask>;
  try {
    existing = await localDB.get<PouchDoc<ScheduleTask>>(docId);
  } catch {
    throw new Error(`ScheduleTask not found: ${id}`);
  }

  const entity = stripPouchFields(existing);
  if (entity.deletedAt != null) {
    throw new Error(`ScheduleTask not found: ${id}`);
  }

  const timestamp = now();
  const updated: ScheduleTask = {
    ...entity,
    isCompleted: true,
    completedDate,
    completedAt: timestamp,
    version: entity.version + 1,
    updatedAt: timestamp,
  };

  const parsed = scheduleTaskSchema.parse(updated);
  const doc = toPouchDoc(parsed, DOC_TYPE);
  doc._rev = existing._rev;
  await localDB.put(doc);
  return parsed;
}

export async function uncomplete(id: string): Promise<ScheduleTask> {
  const docId = `${DOC_TYPE}:${id}`;
  let existing: PouchDoc<ScheduleTask>;
  try {
    existing = await localDB.get<PouchDoc<ScheduleTask>>(docId);
  } catch {
    throw new Error(`ScheduleTask not found: ${id}`);
  }

  const entity = stripPouchFields(existing);
  if (entity.deletedAt != null) {
    throw new Error(`ScheduleTask not found: ${id}`);
  }

  const updated = scheduleTaskSchema.parse({
    ...entity,
    isCompleted: false,
    completedDate: undefined,
    completedAt: undefined,
    version: entity.version + 1,
    updatedAt: now(),
  });

  const doc = toPouchDoc(updated, DOC_TYPE);
  doc._rev = existing._rev;
  await localDB.put(doc);
  return updated;
}

export async function softDelete(id: string): Promise<void> {
  const docId = `${DOC_TYPE}:${id}`;
  let existing: PouchDoc<ScheduleTask>;
  try {
    existing = await localDB.get<PouchDoc<ScheduleTask>>(docId);
  } catch {
    throw new Error(`ScheduleTask not found: ${id}`);
  }

  const entity = stripPouchFields(existing);
  if (entity.deletedAt != null) {
    throw new Error(`ScheduleTask not found: ${id}`);
  }

  const timestamp = now();
  const deleted = scheduleTaskSchema.parse({
    ...entity,
    deletedAt: timestamp,
    updatedAt: timestamp,
    version: entity.version + 1,
  });

  const doc = toPouchDoc(deleted, DOC_TYPE);
  doc._rev = existing._rev;
  await localDB.put(doc);
}

export async function softDeleteByScheduleId(
  plantingScheduleId: string,
): Promise<void> {
  const tasks = await getByScheduleId(plantingScheduleId);
  if (tasks.length === 0) return;

  const timestamp = now();
  const docs: PouchDoc<ScheduleTask>[] = [];

  for (const task of tasks) {
    const docId = `${DOC_TYPE}:${task.id}`;
    const existing = await localDB.get<PouchDoc<ScheduleTask>>(docId);
    const deleted = scheduleTaskSchema.parse({
      ...task,
      deletedAt: timestamp,
      updatedAt: timestamp,
      version: task.version + 1,
    });
    const doc = toPouchDoc(deleted, DOC_TYPE);
    doc._rev = existing._rev;
    docs.push(doc);
  }

  await localDB.bulkDocs(docs);
}

export async function getById(
  id: string,
): Promise<ScheduleTask | undefined> {
  const docId = `${DOC_TYPE}:${id}`;
  try {
    const doc = await localDB.get<PouchDoc<ScheduleTask>>(docId);
    const entity = stripPouchFields(doc);
    if (entity.deletedAt != null) return undefined;
    return entity;
  } catch {
    return undefined;
  }
}

/** Prefix-bounded allDocs retrieval: returns ALL docs of this docType (including
 *  soft-deleted) without the pouchdb-find 25-doc default limit. Callers filter. */
async function getAllDocsByType(): Promise<ScheduleTask[]> {
  const result = await localDB.allDocs({
    startkey: DOC_TYPE + ":",
    endkey: DOC_TYPE + ":\ufff0",
    include_docs: true,
  });
  return (result.rows
    .map((r) => r.doc)
    .filter(Boolean) as unknown as PouchDoc<ScheduleTask>[]).map(
    stripPouchFields,
  );
}

export async function getAll(): Promise<ScheduleTask[]> {
  return (await getAllDocsByType()).filter((r) => r.deletedAt == null);
}

export async function getByScheduleId(
  plantingScheduleId: string,
): Promise<ScheduleTask[]> {
  return (await getAllDocsByType())
    .filter(
      (r) =>
        r.deletedAt == null &&
        r.plantingScheduleId === plantingScheduleId,
    )
    .sort((a, b) => a.sequenceOrder - b.sequenceOrder);
}

export async function getByDateRange(
  start: string,
  end: string,
): Promise<ScheduleTask[]> {
  return (await getAllDocsByType())
    .filter(
      (r) =>
        r.deletedAt == null &&
        r.scheduledDate >= start &&
        r.scheduledDate <= end,
    );
}

export async function getIncompleteDownstream(
  plantingScheduleId: string,
  sequenceOrder: number,
): Promise<ScheduleTask[]> {
  const tasks = await getByScheduleId(plantingScheduleId);
  return tasks.filter(
    (t) => t.sequenceOrder > sequenceOrder && !t.isCompleted,
  );
}

export async function updateBatch(
  updates: Array<{ id: string; changes: UpdateInput }>,
): Promise<ScheduleTask[]> {
  const timestamp = now();
  const tasks: ScheduleTask[] = [];
  const docs: PouchDoc<ScheduleTask>[] = [];

  for (const { id, changes } of updates) {
    const docId = `${DOC_TYPE}:${id}`;
    let existing: PouchDoc<ScheduleTask>;
    try {
      existing = await localDB.get<PouchDoc<ScheduleTask>>(docId);
    } catch {
      throw new Error(`ScheduleTask not found: ${id}`);
    }

    const entity = stripPouchFields(existing);
    if (entity.deletedAt != null) {
      throw new Error(`ScheduleTask not found: ${id}`);
    }

    const updated: ScheduleTask = {
      ...entity,
      ...changes,
      id: entity.id,
      version: entity.version + 1,
      createdAt: entity.createdAt,
      updatedAt: timestamp,
    };

    const parsed = scheduleTaskSchema.parse(updated);
    const doc = toPouchDoc(parsed, DOC_TYPE);
    doc._rev = existing._rev;
    docs.push(doc);
    tasks.push(parsed);
  }

  await localDB.bulkDocs(docs);
  return tasks;
}
