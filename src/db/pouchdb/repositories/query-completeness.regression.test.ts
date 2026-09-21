/**
 * Regression tests — query completeness for the eight user-facing repository
 * methods fixed on fix/query-completeness-user-flows-20260921 (base c8920f3).
 *
 * The previous implementations went through localDB.find, whose installed
 * pouchdb-find plugin caps every query at 25 docs when `limit` is omitted.
 * These tests assert CORRECT expected ids/counts (not the broken counts):
 * all matching rows are returned, non-matching controls and soft-deleted /
 * completed rows are handled per each method's contract, date boundaries are
 * inclusive, and empty queries return empty arrays.
 *
 * Real PouchDB (memory adapter) + the real pouchdb-find plugin; only the DB
 * instance is injected. Deterministic scenarios insert schema-validated
 * documents with fixed ids/timestamps (journalEntrySchema / taskSchema +
 * toPouchDoc). No filesystem writes; each test DB is closed after use.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import PouchDB from "pouchdb";
import PouchDBFind from "pouchdb-find";
import PouchDBAdapterMemory from "pouchdb-adapter-memory";
import { journalEntrySchema } from "../../../validation/journalEntry.schema.ts";
import { taskSchema } from "../../../validation/task.schema.ts";
import { toPouchDoc } from "../utils.ts";

PouchDB.plugin(PouchDBFind);
PouchDB.plugin(PouchDBAdapterMemory);

let testDB: PouchDB.Database;

vi.mock("../client.ts", () => ({
  get localDB() {
    return testDB;
  },
}));

const expenseRepo = await import("./expenseRepository.ts");
const journalRepo = await import("./journalRepository.ts");
const plantingRepo = await import("./plantingRepository.ts");
const taskRepo = await import("./taskRepository.ts");

function detUuid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

function fixedTimestamp(totalMinutes: number): string {
  const hour = String(Math.floor(totalMinutes / 60)).padStart(2, "0");
  const minute = String(totalMinutes % 60).padStart(2, "0");
  return `2026-09-20T${hour}:${minute}:00.000Z`;
}

const MATCHING = 37;

let dbCounter = 0;

beforeEach(async () => {
  dbCounter += 1;
  testDB = new PouchDB(`test-query-completeness-${dbCounter}`, {
    adapter: "memory",
  });
});

afterEach(async () => {
  await testDB.close();
});

describe("query completeness: repository methods return ALL matching rows", () => {
  it("expenseRepository.getBySeason returns all 37 matching expenses, excluding controls and soft-deleted", async () => {
    const S1 = detUuid(101);
    const S2 = detUuid(102);
    const expectedIds: string[] = [];
    for (let i = 1; i <= MATCHING; i++) {
      const e = await expenseRepo.create({
        name: `Expense Row ${String(i).padStart(3, "0")}`,
        category: "other",
        amount: i,
        date: "2026-09-01",
        seasonId: S1,
      });
      expectedIds.push(e.id);
    }
    for (let i = 1; i <= 5; i++) {
      await expenseRepo.create({
        name: `Control ${i}`,
        category: "other",
        amount: 1000 + i,
        date: "2026-09-02",
        seasonId: S2,
      });
    }
    // soft-deleted matching row must not appear
    const deleted = await expenseRepo.create({
      name: "Deleted expense",
      category: "other",
      amount: 999,
      date: "2026-09-01",
      seasonId: S1,
    });
    await expenseRepo.softDelete(deleted.id);

    const result = await expenseRepo.getBySeason(S1);
    const returnedIds = result.map((r) => r.id).sort();
    expect(returnedIds).toEqual([...expectedIds].sort());
    expect(result).toHaveLength(MATCHING);
    expect(result.every((r) => r.seasonId === S1 && r.deletedAt == null)).toBe(true);
  });

  it("expenseRepository.getBySeason returns [] for a season with no records", async () => {
    const result = await expenseRepo.getBySeason(detUuid(999));
    expect(result).toEqual([]);
  });

  it("journalRepository.getBySeasonId returns all 37 matching entries, excluding controls and soft-deleted", async () => {
    const S1 = detUuid(201);
    const S2 = detUuid(202);
    const expectedIds: string[] = [];
    for (let i = 1; i <= MATCHING; i++) {
      const j = await journalRepo.create({
        seasonId: S1,
        activityType: "watering",
        body: `Journal Row ${String(i).padStart(3, "0")}`,
        photoIds: [],
        isMilestone: false,
      });
      expectedIds.push(j.id);
    }
    for (let i = 1; i <= 5; i++) {
      await journalRepo.create({
        seasonId: S2,
        activityType: "watering",
        body: `Control ${i}`,
        photoIds: [],
        isMilestone: false,
      });
    }
    const deleted = await journalRepo.create({
      seasonId: S1,
      activityType: "watering",
      body: "Deleted entry",
      photoIds: [],
      isMilestone: false,
    });
    await journalRepo.softDelete(deleted.id);

    const result = await journalRepo.getBySeasonId(S1);
    expect(result.map((r) => r.id).sort()).toEqual([...expectedIds].sort());
    expect(result).toHaveLength(MATCHING);
  });

  it("journalRepository.getByPlantId returns all 37 matching entries, excluding controls and soft-deleted", async () => {
    const P1 = detUuid(401);
    const P2 = detUuid(402);
    const S1 = detUuid(403);
    const expectedIds: string[] = [];
    for (let i = 1; i <= MATCHING; i++) {
      const j = await journalRepo.create({
        seasonId: S1,
        plantInstanceId: P1,
        activityType: "watering",
        body: `Plant Journal Row ${String(i).padStart(3, "0")}`,
        photoIds: [],
        isMilestone: false,
      });
      expectedIds.push(j.id);
    }
    for (let i = 1; i <= 5; i++) {
      await journalRepo.create({
        seasonId: S1,
        plantInstanceId: P2,
        activityType: "watering",
        body: `Control ${i}`,
        photoIds: [],
        isMilestone: false,
      });
    }
    const deleted = await journalRepo.create({
      seasonId: S1,
      plantInstanceId: P1,
      activityType: "watering",
      body: "Deleted entry",
      photoIds: [],
      isMilestone: false,
    });
    await journalRepo.softDelete(deleted.id);

    const result = await journalRepo.getByPlantId(P1);
    expect(result.map((r) => r.id).sort()).toEqual([...expectedIds].sort());
    expect(result).toHaveLength(MATCHING);
  });

  it("plantingRepository.getBySeason returns all 37 matching plantings, excluding controls and soft-deleted", async () => {
    const S1 = detUuid(301);
    const S2 = detUuid(302);
    const P = detUuid(310);
    const expectedIds: string[] = [];
    for (let i = 1; i <= MATCHING; i++) {
      const p = await plantingRepo.create({
        plantInstanceId: P,
        seasonId: S1,
        notes: `Planting Row ${String(i).padStart(3, "0")}`,
      });
      expectedIds.push(p.id);
    }
    for (let i = 1; i <= 5; i++) {
      await plantingRepo.create({
        plantInstanceId: P,
        seasonId: S2,
        notes: `Control ${i}`,
      });
    }
    const deleted = await plantingRepo.create({
      plantInstanceId: P,
      seasonId: S1,
      notes: "Deleted planting",
    });
    await plantingRepo.softDelete(deleted.id);

    const result = await plantingRepo.getBySeason(S1);
    expect(result.map((r) => r.id).sort()).toEqual([...expectedIds].sort());
    expect(result).toHaveLength(MATCHING);
  });

  it("plantingRepository.getByPlant returns all 37 matching plantings, excluding controls and soft-deleted", async () => {
    const P1 = detUuid(501);
    const P2 = detUuid(502);
    const S1 = detUuid(503);
    const expectedIds: string[] = [];
    for (let i = 1; i <= MATCHING; i++) {
      const p = await plantingRepo.create({
        plantInstanceId: P1,
        seasonId: S1,
        notes: `Planting Row ${String(i).padStart(3, "0")}`,
      });
      expectedIds.push(p.id);
    }
    for (let i = 1; i <= 5; i++) {
      await plantingRepo.create({
        plantInstanceId: P2,
        seasonId: S1,
        notes: `Control ${i}`,
      });
    }
    const deleted = await plantingRepo.create({
      plantInstanceId: P1,
      seasonId: S1,
      notes: "Deleted planting",
    });
    await plantingRepo.softDelete(deleted.id);

    const result = await plantingRepo.getByPlant(P1);
    expect(result.map((r) => r.id).sort()).toEqual([...expectedIds].sort());
    expect(result).toHaveLength(MATCHING);
  });

  it("taskRepository.getByDateRange returns all 37 in-range tasks with inclusive boundaries, excluding controls, soft-deleted and completed", async () => {
    const expectedIds: string[] = [];
    const nameById = new Map<string, string>();
    for (let i = 1; i <= MATCHING; i++) {
      const t = await taskRepo.create({
        title: `Task Row ${String(i).padStart(3, "0")}`,
        dueDate: "2026-09-15",
        priority: "normal",
        isCompleted: false,
      });
      expectedIds.push(t.id);
      nameById.set(t.id, `Task Row ${String(i).padStart(3, "0")}`);
    }
    // inclusive boundaries: tasks due exactly on start and end dates
    const atStart = await taskRepo.create({
      title: "Boundary start",
      dueDate: "2026-09-01",
      priority: "normal",
      isCompleted: false,
    });
    const atEnd = await taskRepo.create({
      title: "Boundary end",
      dueDate: "2026-09-30",
      priority: "normal",
      isCompleted: false,
    });
    expectedIds.push(atStart.id, atEnd.id);
    nameById.set(atStart.id, "Boundary start");
    nameById.set(atEnd.id, "Boundary end");
    // completed in-range task: excluded by this method's contract
    await taskRepo.create({
      title: "Completed in range",
      dueDate: "2026-09-15",
      priority: "normal",
      isCompleted: true,
    });
    // soft-deleted in-range task: excluded
    const deleted = await taskRepo.create({
      title: "Deleted in range",
      dueDate: "2026-09-15",
      priority: "normal",
      isCompleted: false,
    });
    await taskRepo.softDelete(deleted.id);
    // out-of-range controls: excluded
    const controlIds: string[] = [];
    for (let i = 1; i <= 5; i++) {
      const c = await taskRepo.create({
        title: `Control ${i}`,
        dueDate: "2026-11-01",
        priority: "normal",
        isCompleted: false,
      });
      controlIds.push(c.id);
    }

    const result = await taskRepo.getByDateRange("2026-09-01", "2026-09-30");
    const returnedIds = result.map((r) => r.id).sort();
    expect(returnedIds).toEqual([...expectedIds].sort());
    expect(result).toHaveLength(MATCHING + 2);
    expect(result.every((r) => !r.isCompleted && r.deletedAt == null)).toBe(true);
    const controlTitles = result.filter((r) => controlIds.length > 0 && (r.title ?? "").startsWith("Control"));
    expect(controlTitles).toEqual([]);
    expect(nameById.size).toBeGreaterThan(0);
  });

  it("taskRepository.getByPlantId returns all matching tasks INCLUDING completed ones, excluding controls and soft-deleted", async () => {
    const P1 = detUuid(601);
    const P2 = detUuid(602);
    const expectedIds: string[] = [];
    const completedIds: string[] = [];
    for (let i = 1; i <= MATCHING; i++) {
      const t = await taskRepo.create({
        title: `Plant Task Row ${String(i).padStart(3, "0")}`,
        dueDate: "2026-09-15",
        priority: "normal",
        isCompleted: false,
        plantInstanceId: P1,
      });
      expectedIds.push(t.id);
    }
    // completed tasks for the plant stay included (previous contract)
    for (let i = 1; i <= 4; i++) {
      const t = await taskRepo.create({
        title: `Completed Plant Task ${i}`,
        dueDate: "2026-09-15",
        priority: "normal",
        isCompleted: true,
        plantInstanceId: P1,
      });
      expectedIds.push(t.id);
      completedIds.push(t.id);
    }
    for (let i = 1; i <= 5; i++) {
      await taskRepo.create({
        title: `Control ${i}`,
        dueDate: "2026-09-15",
        priority: "normal",
        isCompleted: false,
        plantInstanceId: P2,
      });
    }
    const deleted = await taskRepo.create({
      title: "Deleted plant task",
      dueDate: "2026-09-15",
      priority: "normal",
      isCompleted: false,
      plantInstanceId: P1,
    });
    await taskRepo.softDelete(deleted.id);

    const result = await taskRepo.getByPlantId(P1);
    const returnedIds = result.map((r) => r.id).sort();
    expect(returnedIds).toEqual([...expectedIds].sort());
    expect(result).toHaveLength(MATCHING + 4);
    expect(completedIds.every((id) => returnedIds.includes(id))).toBe(true);
  });

  it("taskRepository.getByPlantId returns 3 target tasks even after 30 unrelated tasks (deterministic adversarial id order)", async () => {
    const P_TARGET = detUuid(7000);
    const P_OTHER = detUuid(7001);
    const targetIds: string[] = [];
    // 30 unrelated tasks FIRST, ids sorting before the targets
    for (let i = 1; i <= 30; i++) {
      const rec = taskSchema.parse({
        id: detUuid(9010 + i),
        version: 1,
        createdAt: fixedTimestamp(i),
        updatedAt: fixedTimestamp(i),
        title: `Unrelated Task ${String(i).padStart(2, "0")}`,
        dueDate: "2026-09-15",
        priority: "normal",
        isCompleted: false,
        plantInstanceId: P_OTHER,
      });
      await testDB.put(toPouchDoc(rec, "task"));
    }
    for (let i = 1; i <= 3; i++) {
      const rec = taskSchema.parse({
        id: detUuid(9100 + i),
        version: 1,
        createdAt: fixedTimestamp(50 + i),
        updatedAt: fixedTimestamp(50 + i),
        title: `Target Task ${i}`,
        dueDate: "2026-09-15",
        priority: "normal",
        isCompleted: false,
        plantInstanceId: P_TARGET,
      });
      await testDB.put(toPouchDoc(rec, "task"));
      targetIds.push(rec.id);
    }

    const result = await taskRepo.getByPlantId(P_TARGET);
    expect(result.map((r) => r.id).sort()).toEqual([...targetIds].sort());
    expect(result).toHaveLength(3);
  });

  it("journalRepository.getRecent returns the globally newest entries before applying the requested count (adversarial id order)", async () => {
    const total = 40;
    // rows 1..10 are the OLDEST and have the LOWEST ids; rows 31..40 are the
    // NEWEST with the HIGHEST ids — a capped id-ordered read would return
    // rows 1..25 and miss every one of the true newest 10.
    const created: { id: string; createdAt: string }[] = [];
    for (let i = 1; i <= total; i++) {
      const minute = i <= 10 ? i : 100 + (i - 10);
      const rec = journalEntrySchema.parse({
        id: detUuid(8000 + i),
        version: 1,
        createdAt: fixedTimestamp(minute),
        updatedAt: fixedTimestamp(minute),
        seasonId: detUuid(8001),
        activityType: "watering",
        body: `Journal Row ${String(i).padStart(3, "0")}`,
        photoIds: [],
        isMilestone: false,
      });
      await testDB.put(toPouchDoc(rec, "journal"));
      created.push({ id: rec.id, createdAt: rec.createdAt });
    }
    const expectedNewest10 = [...created]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 10)
      .map((c) => c.id);

    const result = await journalRepo.getRecent(10);
    expect(result.map((r) => r.id)).toEqual(expectedNewest10);
    expect(result).toHaveLength(10);
    // ordering contract: descending createdAt
    const sorted = [...result].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    expect(result.map((r) => r.id)).toEqual(sorted.map((r) => r.id));
  });

  it("journalRepository.getRecent returns fewer rows when fewer exist than the requested count", async () => {
    const j = await journalRepo.create({
      seasonId: detUuid(8101),
      activityType: "watering",
      body: "Only entry",
      photoIds: [],
      isMilestone: false,
    });
    const result = await journalRepo.getRecent(10);
    expect(result.map((r) => r.id)).toEqual([j.id]);
  });
});
