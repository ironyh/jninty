import { addDays, formatISO, startOfDay } from "date-fns";
import { localDB } from "../client.ts";
import { getAllDocsByType } from "../getAllDocsByType.ts";
import { type PouchDoc, stripPouchFields, toPouchDoc } from "../utils.ts";
import { taskSchema, type Task } from "../../../validation/task.schema.ts";
import { ensureAllIndexes } from "../indexes.ts";

const DOC_TYPE = "task";

type CreateTaskInput = Omit<
  Task,
  "id" | "version" | "createdAt" | "updatedAt" | "deletedAt"
>;

type UpdateTaskInput = Partial<CreateTaskInput>;

function now(): string {
  return new Date().toISOString();
}

function todayDate(): string {
  return formatISO(startOfDay(new Date()), { representation: "date" });
}

export async function create(input: CreateTaskInput): Promise<Task> {
  const timestamp = now();
  const record: Task = {
    ...input,
    id: crypto.randomUUID(),
    version: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  const parsed = taskSchema.parse(record);
  const doc = toPouchDoc(parsed, DOC_TYPE);
  await localDB.put(doc);
  return parsed;
}

export async function update(
  id: string,
  changes: UpdateTaskInput,
): Promise<Task> {
  const docId = `${DOC_TYPE}:${id}`;
  let existing: PouchDoc<Task>;
  try {
    existing = await localDB.get<PouchDoc<Task>>(docId);
  } catch {
    throw new Error(`Task not found: ${id}`);
  }

  const entity = stripPouchFields(existing);
  if (entity.deletedAt != null) {
    throw new Error(`Task not found: ${id}`);
  }

  const updated: Task = {
    ...entity,
    ...changes,
    id: entity.id,
    version: entity.version + 1,
    createdAt: entity.createdAt,
    updatedAt: now(),
  };

  const parsed = taskSchema.parse(updated);
  const doc = toPouchDoc(parsed, DOC_TYPE);
  doc._rev = existing._rev;
  await localDB.put(doc);
  return parsed;
}

export async function complete(id: string): Promise<Task> {
  const docId = `${DOC_TYPE}:${id}`;
  let existing: PouchDoc<Task>;
  try {
    existing = await localDB.get<PouchDoc<Task>>(docId);
  } catch {
    throw new Error(`Task not found: ${id}`);
  }

  const entity = stripPouchFields(existing);
  if (entity.deletedAt != null) {
    throw new Error(`Task not found: ${id}`);
  }

  const timestamp = now();
  const updated: Task = {
    ...entity,
    isCompleted: true,
    completedAt: timestamp,
    version: entity.version + 1,
    updatedAt: timestamp,
  };

  const parsed = taskSchema.parse(updated);
  const doc = toPouchDoc(parsed, DOC_TYPE);
  doc._rev = existing._rev;
  await localDB.put(doc);
  return parsed;
}

export async function uncomplete(id: string): Promise<Task> {
  const docId = `${DOC_TYPE}:${id}`;
  let existing: PouchDoc<Task>;
  try {
    existing = await localDB.get<PouchDoc<Task>>(docId);
  } catch {
    throw new Error(`Task not found: ${id}`);
  }

  const entity = stripPouchFields(existing);
  if (entity.deletedAt != null) {
    throw new Error(`Task not found: ${id}`);
  }

  const updated = taskSchema.parse({
    ...entity,
    isCompleted: false,
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
  let existing: PouchDoc<Task>;
  try {
    existing = await localDB.get<PouchDoc<Task>>(docId);
  } catch {
    throw new Error(`Task not found: ${id}`);
  }

  const entity = stripPouchFields(existing);
  if (entity.deletedAt != null) {
    throw new Error(`Task not found: ${id}`);
  }

  const timestamp = now();
  const deleted = taskSchema.parse({
    ...entity,
    deletedAt: timestamp,
    updatedAt: timestamp,
    version: entity.version + 1,
  });

  const doc = toPouchDoc(deleted, DOC_TYPE);
  doc._rev = existing._rev;
  await localDB.put(doc);
}

export async function getById(id: string): Promise<Task | undefined> {
  const docId = `${DOC_TYPE}:${id}`;
  try {
    const doc = await localDB.get<PouchDoc<Task>>(docId);
    const entity = stripPouchFields(doc);
    if (entity.deletedAt != null) return undefined;
    return entity;
  } catch {
    return undefined;
  }
}

export async function getUpcoming(days: number): Promise<Task[]> {
  await ensureAllIndexes();
  const today = todayDate();
  const future = formatISO(addDays(new Date(), days), {
    representation: "date",
  });

  return (await getAllDocsByType<Task>(DOC_TYPE))
    .map(stripPouchFields)
    .filter(
      (r) =>
        r.deletedAt == null &&
        !r.isCompleted &&
        r.dueDate >= today &&
        r.dueDate <= future,
    );
}

export async function getOverdue(): Promise<Task[]> {
  await ensureAllIndexes();
  const today = todayDate();

  return (await getAllDocsByType<Task>(DOC_TYPE))
    .map(stripPouchFields)
    .filter((r) => r.deletedAt == null && !r.isCompleted && r.dueDate < today);
}

export async function getAll(): Promise<Task[]> {
  return (await getAllDocsByType<Task>(DOC_TYPE))
    .map(stripPouchFields)
    .filter((r) => r.deletedAt == null);
}

export async function getByDateRange(
  start: string,
  end: string,
): Promise<Task[]> {
  // complete read with inclusive date boundaries preserved: pouchdb-find's
  // implicit limit 25 would silently drop matching tasks beyond the first
  // 25 (see getAllDocsByType).
  return (await getAllDocsByType<Task>(DOC_TYPE))
    .map(stripPouchFields)
    .filter(
      (r) =>
        r.deletedAt == null &&
        !r.isCompleted &&
        r.dueDate >= start &&
        r.dueDate <= end,
    );
}

export async function getByPlantId(
  plantInstanceId: string,
): Promise<Task[]> {
  // complete read BEFORE the plant filter: the previous docType-only find
  // was capped at 25 by pouchdb-find's implicit default limit, so matching
  // tasks could be lost before this method's own filter ran (see
  // getAllDocsByType). Completed tasks remain included, as before.
  return (await getAllDocsByType<Task>(DOC_TYPE))
    .map(stripPouchFields)
    .filter(
      (r) => r.deletedAt == null && r.plantInstanceId === plantInstanceId,
    );
}

export async function getBySeasonId(seasonId: string): Promise<Task[]> {
  await ensureAllIndexes();
  const result = await localDB.find({
    selector: {
      docType: DOC_TYPE,
      seasonId,
    },
  });
  return (result.docs as PouchDoc<Task>[])
    .map(stripPouchFields)
    .filter((r) => r.deletedAt == null);
}
