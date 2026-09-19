// Regression tests for tombstone-dominant conflict resolution
// (conflictResolver.autoResolveByLastWrite / compareConflictCandidates).
// Conflicts are injected as real PouchDB revision branches (new_edits:false)
// off a genuine repository-created document.
import PouchDB from "pouchdb";
import PouchDBFind from "pouchdb-find";
import PouchDBAdapterMemory from "pouchdb-adapter-memory";
import { beforeEach, describe, expect, it, vi } from "vitest";

PouchDB.plugin(PouchDBFind);
PouchDB.plugin(PouchDBAdapterMemory);

let testDB: PouchDB.Database;

vi.mock("../db/pouchdb/client.ts", () => ({
  get localDB() {
    return testDB;
  },
  async destroyAndRecreate() {
    testDB = new PouchDB(`conflict-${crypto.randomUUID()}`, { adapter: "memory" });
  },
  setupSync: vi.fn(),
  stopSync: vi.fn(),
  getSyncStatus: () => "disabled" as const,
  subscribeSyncStatus: () => () => {},
  getLastSyncedAt: () => null,
  testConnection: vi.fn(),
}));

import {
  autoResolveByLastWrite,
  compareConflictCandidates,
} from "./conflictResolver.ts";
import { plantRepository } from "../db/index.ts";
import { destroyAndRecreate } from "../db/pouchdb/client.ts";

const T02 = "2026-06-01T12:02:00.000Z";
const T05 = "2026-06-01T12:05:00.000Z";
const T10 = "2026-06-01T12:10:00.000Z";
const T20 = "2026-06-01T12:20:00.000Z";

interface Leaf {
  _id?: string;
  _rev?: string;
  updatedAt?: string;
  deletedAt?: string;
  nickname?: string;
  species?: string;
  _conflicts?: string[];
}

async function createConflictedDoc(
  branches: Array<{
    suffix: string;
    updatedAt?: string;
    deletedAt?: string;
    nickname?: string;
  }>,
): Promise<string> {
  const plant = await plantRepository.create({
    species: "Solanum lycopersicum",
    type: "vegetable",
    isPerennial: false,
    source: "seed",
    status: "active",
    tags: [],
  });
  const docId = `plant:${plant.id}`;
  const base = await testDB.get<Record<string, unknown>>(docId);
  const parentHash = (base as { _rev: string })._rev.split("-")[1]!;
  const parent = await testDB.get<Record<string, unknown>>(docId, {
    rev: (base as { _rev: string })._rev,
  });

  for (const branch of branches) {
    const suffix = branch.suffix;
    const body = {
      ...parent,
      ...branch,
      _id: docId,
      _rev: `2-${suffix}`,
      _revisions: { start: 2, ids: [suffix, parentHash] },
    };
    await testDB.bulkDocs([body], { new_edits: false });
  }
  return docId;
}

async function readWinner(docId: string) {
  const doc = (await testDB.get(docId)) as Record<
    string,
    unknown
  > as Leaf & { deletedAt?: string };
  return doc;
}

async function readConflicts(docId: string): Promise<string[]> {
  const doc = (await testDB.get(docId, { conflicts: true })) as {
    _conflicts?: string[];
  };
  return doc._conflicts ?? [];
}

beforeEach(async () => {
  await destroyAndRecreate();
});

describe("compareConflictCandidates (pure ordering)", () => {
  it("a tombstone beats a live leaf regardless of timestamps", () => {
    const live = { _rev: "2-zzz", updatedAt: T20 };
    const tombstone = { _rev: "2-aaa", updatedAt: T10, deletedAt: T10 };
    expect(compareConflictCandidates(live, tombstone)).toBeLessThan(0);
    expect(compareConflictCandidates(tombstone, live)).toBeGreaterThan(0);
  });

  it("treats a live leaf without updatedAt as the earliest possible time", () => {
    const noTime = { _rev: "2-aaa" };
    const timed = { _rev: "2-bbb", updatedAt: T10 };
    expect(compareConflictCandidates(noTime, timed)).toBeLessThan(0);
    expect(compareConflictCandidates(timed, noTime)).toBeGreaterThan(0);
  });

  it("treats a deleted leaf without deletedAt as live (deletedAt must be a non-empty string)", () => {
    const notReallyDeleted = { _rev: "2-aaa", updatedAt: T10 };
    const tombstone = { _rev: "2-bbb", deletedAt: T10, updatedAt: T10 };
    expect(compareConflictCandidates(notReallyDeleted, tombstone)).toBeLessThan(0);
  });
});

describe("tombstone-dominant conflict resolution (real PouchDB conflicts)", () => {
  it("delete t10 vs update t20: the deleted leaf wins (resurrection prevented)", async () => {
    const docId = await createConflictedDoc([
      { suffix: "del", updatedAt: T10, deletedAt: T10 },
      { suffix: "upd", updatedAt: T20 },
    ]);
    await autoResolveByLastWrite();
    const winner = await readWinner(docId);
    expect(winner.deletedAt).toBe(T10);
    expect(winner.nickname).toBeUndefined();
  });

  it("delete t20 vs update t10: the deleted leaf still wins", async () => {
    const docId = await createConflictedDoc([
      { suffix: "upd", updatedAt: T10 },
      { suffix: "del", updatedAt: T20, deletedAt: T20 },
    ]);
    await autoResolveByLastWrite();
    const winner = await readWinner(docId);
    expect(winner.deletedAt).toBe(T20);
  });

  it("clock skew: delete recorded t02 (skewed clock) beats live update t05", async () => {
    const docId = await createConflictedDoc([
      { suffix: "live", updatedAt: T05 },
      { suffix: "del", updatedAt: T02, deletedAt: T02 },
    ]);
    await autoResolveByLastWrite();
    const winner = await readWinner(docId);
    expect(winner.deletedAt).toBe(T02);
  });

  it("delete t10 vs delete t20: the newest deletedAt wins", async () => {
    const docId = await createConflictedDoc([
      { suffix: "d1", updatedAt: T10, deletedAt: T10 },
      { suffix: "d2", updatedAt: T20, deletedAt: T20 },
    ]);
    await autoResolveByLastWrite();
    expect((await readWinner(docId)).deletedAt).toBe(T20);
  });

  it("equal deletedAt values resolve by deterministic _rev tie-break", async () => {
    const docId = await createConflictedDoc([
      { suffix: "dddd", updatedAt: T10, deletedAt: T10 },
      { suffix: "cccc", updatedAt: T10, deletedAt: T10 },
    ]);
    await autoResolveByLastWrite();
    const winner = await readWinner(docId);
    expect(winner._rev).toBe("2-dddd"); // lexical _rev winner
    expect(winner.deletedAt).toBe(T10);
  });

  it("update t10 vs update t20 keeps today's live semantics", async () => {
    const docId = await createConflictedDoc([
      { suffix: "u1", updatedAt: T10, nickname: "Old name" },
      { suffix: "u2", updatedAt: T20, nickname: "New name" },
    ]);
    await autoResolveByLastWrite();
    const winner = await readWinner(docId);
    expect(winner.nickname).toBe("New name");
    expect(winner.updatedAt).toBe(T20);
  });

  it("equal updatedAt values resolve by deterministic _rev tie-break", async () => {
    const docId = await createConflictedDoc([
      { suffix: "zzzz", updatedAt: T10, nickname: "Z" },
      { suffix: "yyyy", updatedAt: T10, nickname: "Y" },
    ]);
    await autoResolveByLastWrite();
    expect((await readWinner(docId))._rev).toBe("2-zzzz");
  });

  it("multi-leaf: a delete beats two newer live updates", async () => {
    const docId = await createConflictedDoc([
      { suffix: "del", updatedAt: T02, deletedAt: T02 },
      { suffix: "u1", updatedAt: T10 },
      { suffix: "u2", updatedAt: T20 },
    ]);
    await autoResolveByLastWrite();
    expect((await readWinner(docId)).deletedAt).toBe(T02);
  });

  it("multi-leaf: two deleted leaves plus one live leaf resolve to the newest deleted leaf", async () => {
    const docId = await createConflictedDoc([
      { suffix: "d1", updatedAt: T02, deletedAt: T02 },
      { suffix: "d2", updatedAt: T20, deletedAt: T20 },
      { suffix: "live", updatedAt: T10 },
    ]);
    await autoResolveByLastWrite();
    const winner = await readWinner(docId);
    expect(winner.deletedAt).toBe(T20);
  });

  it("resolves identically for every permutation of the same leaf set", async () => {
    const leaves = [
      { suffix: "del", updatedAt: T02, deletedAt: T02 },
      { suffix: "u1", updatedAt: T10 },
      { suffix: "u2", updatedAt: T20 },
    ];
    const outcomes = new Set<string>();
    const orders: number[][] = [
      [0, 1, 2],
      [0, 2, 1],
      [1, 0, 2],
      [1, 2, 0],
      [2, 0, 1],
      [2, 1, 0],
    ];
    for (const order of orders) {
      await destroyAndRecreate();
      const docId = await createConflictedDoc(order.map((i) => leaves[i]!));
      await autoResolveByLastWrite();
      const winner = await readWinner(docId);
      outcomes.add(`${winner.deletedAt ?? "live"}|${winner.updatedAt ?? ""}`);
    }
    expect(outcomes.size).toBe(1);
  });

  it("removes losing revisions and clears _conflicts", async () => {
    const docId = await createConflictedDoc([
      { suffix: "del", updatedAt: T10, deletedAt: T10 },
      { suffix: "upd", updatedAt: T20 },
    ]);
    await autoResolveByLastWrite();

    expect(await readConflicts(docId)).toEqual([]);
    const winner = await readWinner(docId);
    expect(winner.deletedAt).toBe(T10);
  });

  it("leaves documents without conflicts untouched", async () => {
    const plant = await plantRepository.create({
      species: "Ocimum basilicum",
      type: "herb",
      isPerennial: false,
      source: "seed",
      status: "active",
      tags: [],
    });
    const docId = `plant:${plant.id}`;
    const resolved = await autoResolveByLastWrite();
    expect(resolved).toBe(0);
    const doc = await readWinner(docId);
    expect(doc.species).toBe("Ocimum basilicum");
    expect(await readConflicts(docId)).toEqual([]);
  });
});

describe("normal single-device behavior unchanged", () => {
  beforeEach(async () => {
    await destroyAndRecreate();
  });

  it("create / update / softDelete still work through the repository", async () => {
    const plant = await plantRepository.create({
      species: "Ocimum basilicum",
      type: "herb",
      isPerennial: false,
      source: "seed",
      status: "active",
      tags: [],
    });
    const updated = await plantRepository.update(plant.id, { nickname: "Basil" });
    expect(updated.nickname).toBe("Basil");
    await plantRepository.softDelete(plant.id);
    const all = await plantRepository.getAll();
    expect(all).toHaveLength(0); // soft-deleted rows stay filtered
  });
});
