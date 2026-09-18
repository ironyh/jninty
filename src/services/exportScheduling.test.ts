// Regression tests for the backup/restore round trip of PlantingSchedule
// and ScheduleTask — these entity types were previously omitted from
// export/import entirely (see exporter.getTableValidations).
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
    testDB = new PouchDB(`test-export-scheduling-${crypto.randomUUID()}`, {
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
  plantRepository,
  seedRepository,
  plantingScheduleRepository,
  scheduleTaskRepository,
} from "../db/index.ts";
import { exportAll } from "./exporter.ts";
import { parseZip, executeImportReplace } from "./importer.ts";
import { destroyAndRecreate } from "../db/pouchdb/client.ts";

// State captured before the round trip, for ID/field comparisons.
let originalScheduleId: string;
let originalTasks: Array<Record<string, unknown>>;
let exportedBlob: Blob;

const asFile = (blob: Blob): File =>
  new File([blob], "jninty-backup.zip", { type: "application/zip" });

async function seedData() {
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
  await plantRepository.create({
    species: "Solanum lycopersicum",
    type: "vegetable",
    isPerennial: false,
    source: "seed",
    status: "active",
    tags: [],
  });
  await seedRepository.create({
    name: "Brandywine Tomato seeds",
    species: "Solanum lycopersicum",
    variety: "Brandywine",
    quantityRemaining: 10,
    quantityUnit: "packets",
  });
  const schedule = await plantingScheduleRepository.create({
    cropId: "tomato",
    varietyId: "builtin-solanum-lycopersicum-brandywine",
    cropSource: "builtin",
    cropName: "Tomato",
    varietyName: "Brandywine",
    anchorDate: "2026-04-01",
    direction: "forward",
    bedId: bed.id,
    bedName: bed.name,
    seasonId: season.id,
    harvestStartDate: "2026-08-01",
    harvestEndDate: "2026-09-30",
    status: "active",
  });
  const tasks = await scheduleTaskRepository.createBatch(
    (
      [
        ["seed_start", "2026-04-01"],
        ["bed_prep", "2026-03-25"],
        ["transplant", "2026-05-01"],
        ["cultivate", "2026-05-08"],
        ["harvest", "2026-08-01"],
      ] as const
    ).map(([taskType, date], i) => ({
      taskType,
      title: `Task ${taskType}`,
      scheduledDate: date,
      originalDate: date,
      sequenceOrder: i,
      cropName: "Tomato",
      varietyName: "Brandywine",
      plantingScheduleId: schedule.id,
      isCompleted: false,
      bedId: bed.id,
      bedName: bed.name,
    })),
  );
  // Simulate user edits, as the app allows after creation:
  // reschedule the transplant task, complete the harvest task.
  await scheduleTaskRepository.update(tasks[2]!.id, {
    scheduledDate: "2026-05-10",
  });
  await scheduleTaskRepository.complete(tasks[4]!.id, "2026-08-05");
  originalScheduleId = schedule.id;
  originalTasks = (await scheduleTaskRepository.getByScheduleId(schedule.id))
    .map((t) => ({ ...t }))
    .sort((a, b) => a.sequenceOrder - b.sequenceOrder);
}

describe("scheduling backup round trip", () => {
  beforeAll(async () => {
    await destroyAndRecreate();
    await seedData();
    exportedBlob = await exportAll();
    // The failure this guards against: schedules/tasks vanished here.
    await destroyAndRecreate();
    const parsed = await parseZip(asFile(exportedBlob));
    expect(parsed.valid).toBe(true);
    const result = await executeImportReplace(parsed);
    expect(result.errors).toEqual([]);
  });

  it("exports plantingSchedules.json and scheduleTasks.json", async () => {
    const zip = await JSZip.loadAsync(exportedBlob);
    const schedules = JSON.parse(
      (await zip.file("data/plantingSchedules.json")!.async("string")) ?? "[]",
    );
    const tasks = JSON.parse(
      (await zip.file("data/scheduleTasks.json")!.async("string")) ?? "[]",
    );
    expect(schedules).toHaveLength(1);
    expect(tasks).toHaveLength(5);
  });

  it("restores the schedule with its original id and fields", async () => {
    const schedules = await plantingScheduleRepository.getAll();
    expect(schedules).toHaveLength(1);
    const s = schedules[0]!;
    expect(s.id).toBe(originalScheduleId);
    expect(s.cropId).toBe("tomato");
    expect(s.varietyId).toBe("builtin-solanum-lycopersicum-brandywine");
    expect(s.cropName).toBe("Tomato");
    expect(s.varietyName).toBe("Brandywine");
    expect(s.anchorDate).toBe("2026-04-01");
    expect(s.harvestStartDate).toBe("2026-08-01");
    expect(s.harvestEndDate).toBe("2026-09-30");
    expect(s.status).toBe("active");
  });

  it("restores all tasks with original ids and their schedule relationship", async () => {
    const tasks = await scheduleTaskRepository.getAll();
    expect(tasks).toHaveLength(originalTasks.length);
    for (const original of originalTasks) {
      const restored = tasks.find((t) => t.id === original.id);
      expect(restored, `task ${original.id} missing`).toBeDefined();
      expect(restored!.plantingScheduleId).toBe(originalScheduleId);
    }
  });

  it("preserves rescheduled dates (scheduledDate vs originalDate)", async () => {
    const original = originalTasks.find((t) => t.taskType === "transplant")!;
    expect(original.scheduledDate).toBe("2026-05-10");
    expect(original.originalDate).toBe("2026-05-01");
    // Read back through the repository so a broken importer cannot pass.
    const tasks = await scheduleTaskRepository.getAll();
    const restored = tasks.find((t) => t.id === original.id);
    expect(restored, `task ${original.id} missing`).toBeDefined();
    expect(restored!.scheduledDate).toBe(original.scheduledDate);
    expect(restored!.originalDate).toBe(original.originalDate);
  });

  it("preserves completion state and timestamps", async () => {
    const tasks = await scheduleTaskRepository.getAll();
    const originalHarvest = originalTasks.find((t) => t.taskType === "harvest")!;
    const harvest = tasks.find((t) => t.id === originalHarvest.id);
    expect(harvest, `task ${originalHarvest.id} missing`).toBeDefined();
    expect(harvest!.isCompleted).toBe(originalHarvest.isCompleted);
    expect(harvest!.isCompleted).toBe(true);
    expect(harvest!.completedDate).toBe(originalHarvest.completedDate);
    // Timestamp must survive serialization/import byte-for-byte, not just exist.
    expect(harvest!.completedAt).toBe(originalHarvest.completedAt);
    const originalSeedStart = originalTasks.find(
      (t) => t.taskType === "seed_start",
    )!;
    const seedStart = tasks.find((t) => t.id === originalSeedStart.id);
    expect(seedStart, `task ${originalSeedStart.id} missing`).toBeDefined();
    expect(seedStart!.isCompleted).toBe(originalSeedStart.isCompleted);
    expect(seedStart!.isCompleted).toBe(false);
    expect(seedStart!.completedDate).toBeUndefined();
  });

  it("leaves other exported entity types intact", async () => {
    expect((await plantRepository.getAll())).toHaveLength(1);
    expect((await gardenBedRepository.getAll())).toHaveLength(1);
    expect((await seedRepository.getAll())).toHaveLength(1);
    expect((await seasonRepository.getAll())).toHaveLength(1);
    const settings = await settingsRepository.get();
    expect(settings?.growingZone).toBe("7b");
  });

  it("imports an old backup without schedule files (counts 0, no errors)", async () => {
    await destroyAndRecreate();
    const zip = new JSZip();
    zip.file(
      "manifest.json",
      JSON.stringify({
        exportVersion: 1,
        schemaVersion: 5,
        exportedAt: "2026-01-01T00:00:00.000Z",
        appVersion: "0.1.0",
      }),
    );
    zip.file("data/plantInstances.json", "[]");
    const parsed = await parseZip(asFile(await zip.generateAsync({ type: "blob" })));
    expect(parsed.valid).toBe(true);
    expect(parsed.errors).toEqual([]);
    expect(parsed.counts.plantingSchedules).toBe(0);
    expect(parsed.counts.scheduleTasks).toBe(0);
    const result = await executeImportReplace(parsed);
    expect(result.errors).toEqual([]);
    expect(await plantingScheduleRepository.getAll()).toHaveLength(0);
    expect(await scheduleTaskRepository.getAll()).toHaveLength(0);
  });
});
