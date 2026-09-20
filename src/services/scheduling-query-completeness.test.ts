// Regression tests for the scheduling query completeness fix.
//
// plantingScheduleRepository and scheduleTaskRepository previously read with
// localDB.find({ selector: { docType } }), which pouchdb-find caps at 25 docs
// by default — getAll() and every filtered read silently truncated at 25
// documents, so backups of a garden with >25 schedules/tasks lost data. The
// fix switches reads to prefix-bounded allDocs. These tests seed 30 schedules
// and 150 tasks and FAIL against the find()-based implementation (25-doc cap).
//
// Mocking pattern mirrors exportScheduling.test.ts: memory-adapter PouchDB as
// localDB, real repositories, real exporter/importer.
import { describe, it, expect, beforeAll, vi } from "vitest";
import JSZip from "jszip";
import PouchDB from "pouchdb";
import PouchDBFind from "pouchdb-find";
import PouchDBAdapterMemory from "pouchdb-adapter-memory";

PouchDB.plugin(PouchDBFind);
PouchDB.plugin(PouchDBAdapterMemory);

let testDB: PouchDB.Database;

vi.mock("../db/pouchdb/client.ts", () => ({
  get localDB() {
    return testDB;
  },
  async destroyAndRecreate() {
    testDB = new PouchDB(`query-completeness-${crypto.randomUUID()}`, {
      adapter: "memory",
    });
  },
  setupSync: vi.fn(),
  stopSync: vi.fn(),
  getSyncStatus: () => "disabled" as const,
  subscribeSyncStatus: () => () => {},
  getLastSyncedAt: () => null,
  testConnection: vi.fn(),
}));

vi.mock("../db/pouchdb/originalsStore.ts", () => ({
  saveOriginal: vi.fn(),
  getOriginal: vi.fn(),
  removeOriginal: vi.fn(),
  destroyAndRecreateOriginals: vi.fn(),
}));

vi.mock("../db/pouchdb/search.ts", () => ({
  rebuildIndex: vi.fn().mockResolvedValue(0),
  startListening: vi.fn(),
  stopListening: vi.fn(),
  handleChange: vi.fn(),
  addToIndex: vi.fn(),
  removeFromIndex: vi.fn(),
  search: vi.fn().mockReturnValue([]),
  serializeIndex: vi.fn(),
  loadIndex: vi.fn().mockResolvedValue(false),
  _resetIndex: vi.fn(),
}));

vi.mock("./syncConfigStore.ts", () => ({
  getSyncConfig: vi.fn().mockReturnValue(null),
  saveSyncConfig: vi.fn(),
  clearSyncConfig: vi.fn(),
}));

import {
  settingsRepository,
  seasonRepository,
  gardenBedRepository,
  plantingScheduleRepository,
  scheduleTaskRepository,
} from "../db/index.ts";
import { localDB, destroyAndRecreate } from "../db/pouchdb/client.ts";
import { exportAll } from "./exporter.ts";
import { parseZip, executeImportReplace } from "./importer.ts";
import type { PlantingSchedule } from "../validation/plantingSchedule.schema.ts";
import type { ScheduleTask } from "../validation/scheduleTask.schema.ts";

const SCHED_COUNT = 30;
const TASK_TYPES = [
  "seed_start",
  "bed_prep",
  "transplant",
  "cultivate",
  "harvest",
] as const;
const TASK_DATES: Record<(typeof TASK_TYPES)[number], string> = {
  seed_start: "2026-04-01",
  bed_prep: "2026-03-25",
  transplant: "2026-05-01",
  cultivate: "2026-05-08",
  harvest: "2026-08-01",
};

const byId = (a: { id: string }, b: { id: string }) =>
  a.id.localeCompare(b.id);

let createdSchedules: PlantingSchedule[] = [];
let createdTasks: ScheduleTask[] = [];
let seasonId = "";
let bedId = "";

async function seedSchedulingData(): Promise<void> {
  const season = await seasonRepository.create({
    name: "2026 Season",
    year: 2026,
    startDate: "2026-03-01",
    endDate: "2026-11-30",
    isActive: true,
  });
  const bed = await gardenBedRepository.create({
    name: "Bed A",
    type: "vegetable_bed",
    gridX: 0,
    gridY: 0,
    gridWidth: 2,
    gridHeight: 2,
    shape: "rectangle",
    color: "#2D5016",
  });
  seasonId = season.id;
  bedId = bed.id;

  createdSchedules = [];
  createdTasks = [];
  for (let i = 0; i < SCHED_COUNT; i++) {
    const s = await plantingScheduleRepository.create({
      cropId: "tomato",
      varietyId: "builtin-solanum-lycopersicum",
      cropSource: "builtin",
      cropName: `Tomato ${i + 1}`,
      varietyName: `Variety ${i + 1}`,
      anchorDate: "2026-04-15",
      direction: "forward",
      bedId: bed.id,
      bedName: bed.name,
      seasonId: season.id,
      harvestStartDate: "2026-08-01",
      harvestEndDate: "2026-09-30",
      status: "active",
    });
    createdSchedules.push(s);
  }
  for (const s of createdSchedules) {
    const batch = await scheduleTaskRepository.createBatch(
      TASK_TYPES.map((taskType, i) => ({
        plantingScheduleId: s.id,
        taskType,
        title: `${taskType} — ${s.cropName}`,
        cropName: s.cropName,
        varietyName: s.varietyName,
        scheduledDate: TASK_DATES[taskType],
        originalDate: TASK_DATES[taskType],
        isCompleted: false,
        sequenceOrder: i,
      })),
    );
    createdTasks.push(...batch);
  }
}

// ── Query completeness: >25 docs per type, filtered reads, isolation ──
describe("scheduling repository query completeness (find 25-doc limit)", () => {
  const deletedScheduleIds: string[] = [];
  const deletedTaskIds: string[] = [];

  beforeAll(async () => {
    await destroyAndRecreate();
    await seedSchedulingData();

    // Soft-deleted decoys must never appear in reads.
    for (let i = 0; i < 3; i++) {
      const d = await plantingScheduleRepository.create({
        cropId: "radish",
        varietyId: "builtin-raphanus-sativus",
        cropSource: "builtin",
        cropName: `Deleted Radish ${i + 1}`,
        varietyName: `Deleted Radish ${i + 1}`,
        anchorDate: "2026-01-01",
        direction: "forward",
        harvestStartDate: "2026-02-01",
        harvestEndDate: "2026-03-01",
        status: "cancelled",
      });
      await plantingScheduleRepository.softDelete(d.id);
      deletedScheduleIds.push(d.id);
    }
    for (let i = 0; i < 5; i++) {
      const t = await scheduleTaskRepository.create({
        plantingScheduleId: deletedScheduleIds[0]!,
        taskType: "seed_start",
        title: `Deleted task ${i + 1}`,
        cropName: "Radish",
        varietyName: "Radish",
        scheduledDate: "2026-04-02",
        originalDate: "2026-04-02",
        isCompleted: false,
        sequenceOrder: 0,
      });
      await scheduleTaskRepository.softDelete(t.id);
      deletedTaskIds.push(t.id);
    }

    // Unrelated docType must never leak into scheduling reads.
    await localDB.put({
      _id: "journalEntry::decoy-ns",
      docType: "journalEntry",
      title: "unrelated",
    });
  });

  it("getAll returns all 30 active schedules (deep-equal to created fixtures)", async () => {
    const all = await plantingScheduleRepository.getAll();
    expect(all).toHaveLength(SCHED_COUNT);
    expect([...all].sort(byId)).toEqual([...createdSchedules].sort(byId));
  });

  it("getAll returns all 150 active tasks (deep-equal to created fixtures)", async () => {
    const all = await scheduleTaskRepository.getAll();
    expect(all).toHaveLength(SCHED_COUNT * TASK_TYPES.length);
    expect([...all].sort(byId)).toEqual([...createdTasks].sort(byId));
  });

  it("soft-deleted schedules and tasks are excluded", async () => {
    const scheds = await plantingScheduleRepository.getAll();
    for (const id of deletedScheduleIds) {
      expect(scheds.some((s) => s.id === id)).toBe(false);
    }
    const tasks = await scheduleTaskRepository.getAll();
    for (const id of deletedTaskIds) {
      expect(tasks.some((t) => t.id === id)).toBe(false);
    }
  });

  it("unrelated docType docs are excluded from scheduling reads", async () => {
    const everything = await localDB.allDocs({ include_docs: true });
    expect(
      everything.rows.some(
        (r) =>
          (r.doc as unknown as Record<string, unknown>)?.docType ===
          "journalEntry",
      ),
    ).toBe(true); // decoy really is in the DB
    // Returned entities must all be ones we created for these doc types —
    // a leaked decoy (no business id) would fail the membership check.
    const schedIds = new Set(createdSchedules.map((s) => s.id));
    const scheds = await plantingScheduleRepository.getAll();
    expect(scheds.every((s) => schedIds.has(s.id))).toBe(true);
    const taskIds = new Set(createdTasks.map((t) => t.id));
    const tasks = await scheduleTaskRepository.getAll();
    expect(tasks.every((t) => taskIds.has(t.id))).toBe(true);
  });

  it("getBySeasonId and getByBedId see all 30 schedules", async () => {
    expect(
      await plantingScheduleRepository.getBySeasonId(seasonId),
    ).toHaveLength(SCHED_COUNT);
    expect(await plantingScheduleRepository.getByBedId(bedId)).toHaveLength(
      SCHED_COUNT,
    );
  });

  it("getByScheduleId returns the 5 tasks of a late schedule in order", async () => {
    const tasks = await scheduleTaskRepository.getByScheduleId(
      createdSchedules[10]!.id,
    );
    expect(tasks.map((t) => t.sequenceOrder)).toEqual([0, 1, 2, 3, 4]);
  });

  it("getByScheduleId returns nothing for a fully soft-deleted schedule", async () => {
    const tasks = await scheduleTaskRepository.getByScheduleId(
      deletedScheduleIds[0]!,
    );
    expect(tasks).toHaveLength(0);
  });

  it("getByDateRange returns all 90 in-range tasks without the cap", async () => {
    const tasks = await scheduleTaskRepository.getByDateRange(
      "2026-04-01",
      "2026-05-31",
    );
    // 3 task types per schedule fall in range (seed_start, transplant,
    // cultivate); the 5 soft-deleted decoys (2026-04-02) are excluded.
    expect(tasks).toHaveLength(SCHED_COUNT * 3);
    expect(tasks.every((t) => !t.isCompleted)).toBe(true);
  });
});

// ── Backup round trip through the real exporter/importer ──
describe("scheduling backup export/import completeness", () => {
  let editedTaskId = "";
  let completedTaskId = "";
  let exportedBlob: Blob;

  const asFile = (blob: Blob): File =>
    new File([blob], "jninty-backup.zip", { type: "application/zip" });

  beforeAll(async () => {
    await destroyAndRecreate();
    await settingsRepository.update({
      growingZone: "7b",
      lastFrostDate: "2026-04-15",
      firstFrostDate: "2026-10-20",
      gridUnit: "feet",
      temperatureUnit: "fahrenheit",
      theme: "auto",
      keepOriginalPhotos: false,
      dbSchemaVersion: 1,
      exportVersion: 1,
    });
    await seedSchedulingData();

    // User edits after creation must survive the round trip.
    editedTaskId = createdTasks[2]!.id;
    completedTaskId = createdTasks[4]!.id;
    await scheduleTaskRepository.update(editedTaskId, {
      scheduledDate: "2026-05-10",
    });
    await scheduleTaskRepository.complete(completedTaskId, "2026-08-05");

    exportedBlob = await exportAll();
    // The failure this guards against: the ZIP (and the restore below)
    // silently contained only the first 25 docs of each type.
    await destroyAndRecreate();
    const parsed = await parseZip(asFile(exportedBlob));
    expect(parsed.valid).toBe(true);
    const result = await executeImportReplace(parsed);
    expect(result.errors).toEqual([]);
  });

  it("ZIP contains all 30 schedules and 150 tasks", async () => {
    const zip = await JSZip.loadAsync(exportedBlob);
    const schedules = JSON.parse(
      (await zip.file("data/plantingSchedules.json")!.async("string")) ?? "[]",
    );
    const tasks = JSON.parse(
      (await zip.file("data/scheduleTasks.json")!.async("string")) ?? "[]",
    );
    expect(schedules).toHaveLength(SCHED_COUNT);
    expect(tasks).toHaveLength(SCHED_COUNT * TASK_TYPES.length);
  });

  it("restores all 30 schedules with original ids", async () => {
    const restored = await plantingScheduleRepository.getAll();
    expect(restored).toHaveLength(SCHED_COUNT);
    const restoredIds = new Set(restored.map((s) => s.id));
    for (const original of createdSchedules) {
      expect(restoredIds.has(original.id)).toBe(true);
    }
  });

  it("restores all 150 tasks with original ids and schedule relationships", async () => {
    const restored = await scheduleTaskRepository.getAll();
    expect(restored).toHaveLength(SCHED_COUNT * TASK_TYPES.length);
    const scheduleIds = new Set(createdSchedules.map((s) => s.id));
    for (const original of createdTasks) {
      const task = restored.find((t) => t.id === original.id);
      expect(task, `task ${original.id} missing`).toBeDefined();
      expect(scheduleIds.has(task!.plantingScheduleId)).toBe(true);
    }
  });

  it("preserves post-creation edits (reschedule + completion)", async () => {
    const restored = await scheduleTaskRepository.getAll();
    const edited = restored.find((t) => t.id === editedTaskId)!;
    expect(edited.scheduledDate).toBe("2026-05-10");
    const completed = restored.find((t) => t.id === completedTaskId)!;
    expect(completed.isCompleted).toBe(true);
    expect(completed.completedDate).toBe("2026-08-05");
  });

  it("fixed filtered reads work on restored data", async () => {
    const tasks = await scheduleTaskRepository.getByScheduleId(
      createdSchedules[7]!.id,
    );
    expect(tasks.map((t) => t.sequenceOrder)).toEqual([0, 1, 2, 3, 4]);
  });
});
