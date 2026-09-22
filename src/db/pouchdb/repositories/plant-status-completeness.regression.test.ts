/**
 * Regression tests — query completeness for plantRepository.getByStatus.
 *
 * The previous implementation went through localDB.find, whose installed
 * pouchdb-find plugin caps every query at 25 docs when `limit` is omitted
 * (guard: node_modules/pouchdb-find/lib/index.js:1350). A garden with more
 * than 25 active plants therefore silently lost plants 26+ from the journal
 * entry (JournalEntryFormPage.tsx:85) and quick-log (QuickLogPage.tsx:63)
 * pickers. These tests assert CORRECT expected id SETS (sorted comparison,
 * deterministic regardless of random create() ids): all matching rows are
 * returned, and dormant, soft-deleted and cross-docType rows are excluded.
 *
 * Same harness as query-completeness.regression.test.ts: real PouchDB
 * (memory adapter) + the real pouchdb-find plugin; only the DB instance is
 * injected. Each test DB is closed after use.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import PouchDB from "pouchdb";
import PouchDBFind from "pouchdb-find";
import PouchDBAdapterMemory from "pouchdb-adapter-memory";

PouchDB.plugin(PouchDBFind);
PouchDB.plugin(PouchDBAdapterMemory);

let testDB: PouchDB.Database;

vi.mock("../client.ts", () => ({
  get localDB() {
    return testDB;
  },
}));

const plantRepo = await import("./plantRepository.ts");
const taskRepo = await import("./taskRepository.ts");

const ACTIVE = 37;

let dbCounter = 0;

beforeEach(async () => {
  dbCounter += 1;
  testDB = new PouchDB(`test-plant-status-completeness-${dbCounter}`, {
    adapter: "memory",
  });
});

afterEach(async () => {
  await testDB.close();
});

async function seedActivePlant(n: number): Promise<string> {
  const p = await plantRepo.create({
    species: `Activeus rowus ${String(n).padStart(3, "0")}`,
    type: "vegetable",
    isPerennial: false,
    source: "seed",
    status: "active",
    tags: [],
  });
  return p.id;
}

describe("plantRepository.getByStatus — query completeness", () => {
  it("returns ALL 37 active plants with their exact id set, excluding dormant, soft-deleted and cross-docType rows", async () => {
    const expectedIds: string[] = [];
    for (let i = 1; i <= ACTIVE; i++) expectedIds.push(await seedActivePlant(i));

    // Irrelevant noise 1 — same docType, non-matching status.
    const dormantIds: string[] = [];
    for (let i = 1; i <= 5; i++) {
      const d = await plantRepo.create({
        species: `Dormantus control ${i}`,
        type: "vegetable",
        isPerennial: false,
        source: "seed",
        status: "dormant",
        tags: [],
      });
      dormantIds.push(d.id);
    }
    // Irrelevant noise 2 — matching status but soft-deleted.
    const softDeleted = await seedActivePlant(ACTIVE + 1);
    await plantRepo.softDelete(softDeleted);
    // Irrelevant noise 3 — different docType entirely.
    for (let i = 1; i <= 3; i++) {
      await taskRepo.create({
        title: `cross-docType noise ${i}`,
        dueDate: "2026-09-22",
        priority: "low",
        isCompleted: false,
      });
    }

    const result = await plantRepo.getByStatus("active");
    const returnedIds = result.map((r) => r.id).sort();

    // Exact id sets: every active plant present, nothing extra, nothing lost.
    expect(returnedIds).toEqual([...expectedIds].sort());
    expect(result).toHaveLength(ACTIVE);
    expect(result.every((r) => r.status === "active" && r.deletedAt == null)).toBe(true);
    for (const id of dormantIds) {
      expect(returnedIds).not.toContain(id);
    }
    expect(returnedIds).not.toContain(softDeleted);
  });

  it("returns the exact small set when under the old 25-doc cap (positive control)", async () => {
    const expectedIds: string[] = [];
    for (let i = 1; i <= 10; i++) expectedIds.push(await seedActivePlant(i));
    for (let i = 1; i <= 3; i++) {
      await plantRepo.create({
        species: `Dormantus control ${i}`,
        type: "vegetable",
        isPerennial: false,
        source: "seed",
        status: "dormant",
        tags: [],
      });
    }

    const result = await plantRepo.getByStatus("active");
    expect(result.map((r) => r.id).sort()).toEqual([...expectedIds].sort());
  });

  it("returns [] for a status with no records", async () => {
    await seedActivePlant(1);
    expect(await plantRepo.getByStatus("removed")).toEqual([]);
  });
});
