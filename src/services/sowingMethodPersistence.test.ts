// Persistence tests for the per-schedule sowing method: creation through the
// real useScheduling hook (preview/save code path), repository read-back,
// succession propagation, unsupported-method rejection, and backup
// export/import round trip. Mocking pattern mirrors
// scheduling-query-completeness.test.ts (memory PouchDB as localDB).
import { describe, it, expect, beforeAll, vi } from "vitest";
import PouchDB from "pouchdb";
import PouchDBFind from "pouchdb-find";
import PouchDBAdapterMemory from "pouchdb-adapter-memory";
import { renderHook, act } from "@testing-library/react";

PouchDB.plugin(PouchDBFind);
PouchDB.plugin(PouchDBAdapterMemory);

let testDB: PouchDB.Database;

vi.mock("../db/pouchdb/client.ts", () => ({
  get localDB() {
    return testDB;
  },
  async destroyAndRecreate() {
    testDB = new PouchDB(`sowing-method-${crypto.randomUUID()}`, {
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

import { useScheduling } from "../hooks/useScheduling.ts";
import {
  plantingScheduleRepository,
  scheduleTaskRepository,
} from "../db/index.ts";
import { destroyAndRecreate } from "../db/pouchdb/client.ts";
import { exportAll } from "./exporter.ts";
import { parseZip, executeImportReplace } from "./importer.ts";

// Real built-in entries (cropGroup / builtInEntryId):
// Calabrese Broccoli — dual method; Cherry Tomato — indoor only;
// Nantes carrot — direct only.
const BROCCOLI = {
  cropId: "broccoli",
  varietyId: "builtin-brassica-oleracea-var-italica-calabrese",
  cropName: "Broccoli",
  varietyName: "Calabrese",
};
const CHERRY_TOMATO = {
  cropId: "tomato",
  varietyId: "builtin-solanum-lycopersicum-cherry",
  cropName: "Tomato",
  varietyName: "Cherry",
};
const NANTES = {
  cropId: "carrot",
  varietyId: "builtin-daucus-carota-nantes",
  cropName: "Carrot",
  varietyName: "Nantes",
};

function baseParams(crop: typeof BROCCOLI, anchorDate = "2026-04-15") {
  return {
    cropId: crop.cropId,
    varietyId: crop.varietyId,
    cropSource: "builtin" as const,
    cropName: crop.cropName,
    varietyName: crop.varietyName,
    anchorDate,
    direction: "forward" as const,
  };
}

describe("sowing method persistence", () => {
  beforeAll(async () => {
    await destroyAndRecreate();
  });

  it("createSchedule persists an explicit direct method and its dates", async () => {
    const { result } = renderHook(() => useScheduling());
    let created: Awaited<ReturnType<typeof result.current.createSchedule>>;
    await act(async () => {
      created = await result.current.createSchedule({
        ...baseParams(BROCCOLI),
        sowingMethod: "direct",
      });
    });

    expect(created!.schedule.sowingMethod).toBe("direct");
    // Direct branch: no indoor-only milestones.
    expect(created!.schedule.seedStartDate).toBeUndefined();
    expect(created!.schedule.transplantDate).toBeUndefined();
    expect(created!.schedule.harvestStartDate).toBe("2026-06-19"); // +65
    expect(created!.schedule.harvestEndDate).toBe("2026-07-10"); // +21
    const taskTypes = created!.tasks.map((t) => t.taskType).sort();
    expect(taskTypes).toEqual(["cultivate", "harvest"]);
    // Tasks carry the denormalized method snapshot for saved-plan display.
    for (const task of created!.tasks) {
      expect(task.sowingMethod).toBe("direct");
    }

    // Survives a fresh read from the repository.
    const reread = await plantingScheduleRepository.getById(
      created!.schedule.id,
    );
    expect(reread?.sowingMethod).toBe("direct");
  });

  it("createSchedule without a method keeps the exact legacy shape", async () => {
    const { result } = renderHook(() => useScheduling());
    let created: Awaited<ReturnType<typeof result.current.createSchedule>>;
    await act(async () => {
      created = await result.current.createSchedule(baseParams(BROCCOLI));
    });

    // Legacy branch selection for a dual variety = transplant branch,
    // and the schedule must NOT get a fabricated explicit method.
    expect(created!.schedule.sowingMethod).toBeUndefined();
    expect(created!.schedule.seedStartDate).toBe("2026-04-15");
    expect(created!.schedule.transplantDate).toBe("2026-05-20"); // +35
    const taskTypes = created!.tasks.map((t) => t.taskType).sort();
    expect(taskTypes).toEqual([
      "bed_prep",
      "cultivate",
      "harvest",
      "seed_start",
      "transplant",
    ]);
    // Legacy tasks carry no method snapshot either.
    for (const task of created!.tasks) {
      expect(task.sowingMethod).toBeUndefined();
    }
  });

  it("createSchedule rejects a method the variety does not support", async () => {
    const { result } = renderHook(() => useScheduling());
    const schedulesBefore = await plantingScheduleRepository.getAll();
    const tasksBefore = await scheduleTaskRepository.getAll();

    const attempt = async (params: Parameters<
      typeof result.current.createSchedule
    >[0]) => {
      let caught: unknown;
      await act(async () => {
        try {
          await result.current.createSchedule(params);
        } catch (err) {
          caught = err;
        }
      });
      return caught;
    };

    const directErr = await attempt({
      ...baseParams(CHERRY_TOMATO), // indoor-only
      sowingMethod: "direct",
    });
    expect(directErr).toBeInstanceOf(Error);
    expect((directErr as Error).message).toMatch(/not supported/);

    const indoorErr = await attempt({
      ...baseParams(NANTES), // direct-only
      sowingMethod: "indoor",
    });
    expect(indoorErr).toBeInstanceOf(Error);
    expect((indoorErr as Error).message).toMatch(/not supported/);

    // Nothing partially persisted.
    const schedulesAfter = await plantingScheduleRepository.getAll();
    expect(schedulesAfter).toHaveLength(schedulesBefore.length);
    const tasksAfter = await scheduleTaskRepository.getAll();
    expect(tasksAfter).toHaveLength(tasksBefore.length);
  });

  it("createSuccession propagates the method to every schedule", async () => {
    const { result } = renderHook(() => useScheduling());
    let created: Awaited<ReturnType<typeof result.current.createSuccession>>;
    await act(async () => {
      created = await result.current.createSuccession({
        ...baseParams(BROCCOLI),
        sowingMethod: "indoor",
        intervalDays: 14,
        count: 3,
      });
    });

    expect(created!).toHaveLength(3);
    // Succession metadata is attached via repository.update after each
    // createSchedule returns — assert it from persisted state.
    const persisted = await plantingScheduleRepository.getAll();
    const succession = persisted
        .filter((s) => s.successionGroupId != null)
        .sort((a, b) => a.successionIndex! - b.successionIndex!);
    expect(succession).toHaveLength(3);
    expect(
      new Set(succession.map((s) => s.successionGroupId)).size,
    ).toBe(1);
    succession.forEach((s, i) => {
      expect(s.sowingMethod).toBe("indoor");
      expect(s.successionIndex).toBe(i);
      expect(s.seedStartDate).toBeDefined();
      expect(s.transplantDate).toBeDefined();
    });
    // Succession anchors spaced by intervalDays: anchors 2026-04-15/29 and
    // 2026-05-13 → indoor harvest starts Jul 24, Aug 7, Aug 21.
    expect(succession[1]!.harvestStartDate).toBe("2026-08-07");
    expect(succession[2]!.harvestStartDate).toBe("2026-08-21");
  });

  it("backup export/import round trip preserves explicit and absent methods", async () => {
    // DB currently holds: 1 direct-method schedule, 3 indoor-method
    // succession schedules, 1 legacy (absent) method schedule.
    const before = await plantingScheduleRepository.getAll();
    expect(before).toHaveLength(5);

    const blob = await exportAll();
    await destroyAndRecreate();
    const file = new File([blob], "jninty-backup.zip", {
      type: "application/zip",
    });
    const parsed = await parseZip(file);
    expect(parsed.valid).toBe(true);
    const result = await executeImportReplace(parsed);
    expect(result.errors).toEqual([]);

    const restored = await plantingScheduleRepository.getAll();
    expect(restored).toHaveLength(5);
    const byMethod = (m: string | undefined) =>
      restored.filter((s) => s.sowingMethod === m);
    expect(byMethod("direct")).toHaveLength(1);
    expect(byMethod("indoor")).toHaveLength(3);
    expect(byMethod(undefined)).toHaveLength(1);

    // Task-level method snapshots also survive the round trip (the saved
    // plan's display surface: task popovers show "Sowing: …" when present).
    const restoredTasks = await scheduleTaskRepository.getAll();
    expect(restoredTasks.filter((t) => t.sowingMethod === "direct")).toHaveLength(2);
    expect(restoredTasks.filter((t) => t.sowingMethod === "indoor")).toHaveLength(15);
    expect(restoredTasks.filter((t) => t.sowingMethod === undefined)).toHaveLength(5);
  });
});
