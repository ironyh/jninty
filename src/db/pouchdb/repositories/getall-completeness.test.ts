/**
 * Regression: complete getAll reads for the ten repositories that still read
 * through un-limited localDB.find() (pouchdb-find default 25-doc cap).
 *
 * Deterministic ledger: per docType 30 live docs + 5 soft-deleted, created
 * ROUND-ROBIN across all ten types so live/deleted/unrelated docs are
 * interleaved in the store. All assertions are on EXACT id sequences
 * (identities AND order), never on loose counts:
 *
 *   - plain repos:  expected order = _id ascending (identical to the mango
 *     [docType,_id] index order the find()-based reads returned);
 *   - journal.getAll: preserved createdAt-descending sort;
 *   - season.getAll:  preserved year-descending sort (distinct years).
 *
 * Also verifies the real exportAll() ZIP + real Merge/Replace executors
 * against the same ledger for the NINE affected exported types (field
 * fidelity, exact identities, user-created task-rule filtering) with the
 * untouched scheduling/photos/settings paths as controls.
 *
 * Expenses export is a SEPARATE scope (fix/export-expenses) — asserted nowhere here.
 * Filtered reads, season setActive/getActive are SEPARATE scopes — untouched.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import JSZip from "jszip";
import PouchDB from "pouchdb";
import PouchDBFind from "pouchdb-find";
import PouchDBAdapterMemory from "pouchdb-adapter-memory";

PouchDB.plugin(PouchDBFind);
PouchDB.plugin(PouchDBAdapterMemory);

vi.setConfig({ testTimeout: 180_000 });

let testDB: PouchDB.Database;

vi.mock("../client.ts", () => ({
  get localDB() {
    return testDB;
  },
  async getAllDocsByType(docType: string) {
    const result = await testDB.allDocs({
      startkey: `${docType}:`,
      endkey: `${docType}:\ufff0`,
      include_docs: true,
    });
    return result.rows.map((r) => r.doc).filter(Boolean);
  },
  async destroyAndRecreate() {
    testDB = new PouchDB(`getall-fix-${crypto.randomUUID()}`, {
      adapter: "memory",
    });
  },
  setupSync: vi.fn(),
  stopSync: vi.fn(),
  getSyncStatus: () => "disabled",
  subscribeSyncStatus: () => () => undefined,
  getLastSyncedAt: () => null,
  testConnection: vi.fn(),
}));

vi.mock("../originalsStore.ts", () => ({
  _setOriginalsDB: vi.fn(),
  getOriginalsDB: vi.fn(),
  async saveOriginal(photoId: string, data: unknown) {
    originalsMap.set(photoId, data);
  },
  async getOriginal(photoId: string) {
    return originalsMap.get(photoId);
  },
  async removeOriginal(photoId: string) {
    originalsMap.delete(photoId);
  },
  async clearAllOriginals() {
    originalsMap.clear();
  },
  async destroyAndRecreateOriginals() {
    originalsMap.clear();
  },
  async getOriginalsSizeBytes() {
    return 0;
  },
}));

vi.mock("file-saver", () => ({ saveAs: vi.fn() }));

const originalsMap = new Map<string, unknown>();

const plantRepo = await import("./plantRepository.ts");
const journalRepo = await import("./journalRepository.ts");
const taskRepo = await import("./taskRepository.ts");
const bedRepo = await import("./gardenBedRepository.ts");
const seasonRepo = await import("./seasonRepository.ts");
const plantingRepo = await import("./plantingRepository.ts");
const seedRepo = await import("./seedRepository.ts");
const ruleRepo = await import("./taskRuleRepository.ts");
const expenseRepo = await import("./expenseRepository.ts");
const ukpRepo = await import("./userPlantKnowledgeRepository.ts");
const psRepo = await import("./plantingScheduleRepository.ts");
const stRepo = await import("./scheduleTaskRepository.ts");
const { exportAll, getTableValidations, SCHEMA_VERSION } = await import(
  "../../../services/exporter.ts"
);
const { parseZip, executeImportMerge, executeImportReplace } = await import(
  "../../../services/importer.ts"
);
const settingsRepo = await import("./settingsRepository.ts");
const clientModule = await import("../client.ts");
const originalsStore = await import("../originalsStore.ts");

const PLANT_A = "11111111-1111-4111-8111-111111111111";
const SEASON_A = "22222222-2222-4222-8222-222222222222";
const BED_A = "33333333-3333-4333-8333-333333333333";

const N_LIVE = 30;
const N_DELETED = 5;
const DELETE_ROUNDS = [4, 9, 14, 19, 24]; // interleaved between live rounds

function todayLocal(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

function localDayOffset(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

type Captured = {
  /** live entities in creation order */
  live: Array<Record<string, unknown> & { id: string }>;
  /** doc _ids of live docs */
  liveDocIds: string[];
  deletedIds: string[];
};

type Ledger = Record<string, Captured>;

const ALL_TYPES = [
  "plant",
  "journal",
  "task",
  "gardenBed",
  "season",
  "planting",
  "seed",
  "taskRule",
  "expense",
  "userPlantKnowledge",
] as const;

/** The ten getAll methods under test, with their expected orderings. */
const PLAIN_ORDERED = [
  "plant",
  "task",
  "gardenBed",
  "planting",
  "seed",
  "taskRule",
  "expense",
  "userPlantKnowledge",
] as const;

async function createLive(
  type: (typeof ALL_TYPES)[number],
  r: number,
): Promise<Record<string, unknown> & { id: string }> {
  switch (type) {
    case "plant":
      return await plantRepo.create({
        species: `Species #${r}`,
        type: "vegetable",
        isPerennial: false,
        source: "seed",
        status: "active",
        tags: [`t${r}`],
      });
    case "journal":
      return await journalRepo.create({
        plantInstanceId: PLANT_A,
        seasonId: SEASON_A,
        activityType: "watering",
        body: `Journal body #${r}`,
        photoIds: [],
        isMilestone: false,
      });
    case "task":
      return await taskRepo.create({
        title: `Task #${r}`,
        plantInstanceId: PLANT_A,
        seasonId: SEASON_A,
        dueDate: r % 2 === 0 ? todayLocal() : localDayOffset(3),
        priority: "normal",
        isCompleted: false,
      });
    case "gardenBed":
      return await bedRepo.create({
        name: `Bed #${r}`,
        type: "vegetable_bed",
        gridX: r,
        gridY: 0,
        gridWidth: 1,
        gridHeight: 1,
        shape: "rectangle",
        color: "#8b4513",
      });
    case "season":
      // distinct years so the year-descending sort is meaningfully exercised
      return await seasonRepo.create({
        name: `Season #${r}`,
        year: 2030 - r,
        startDate: "2026-03-15",
        endDate: "2026-10-31",
        isActive: false,
      });
    case "planting":
      return await plantingRepo.create({
        plantInstanceId: PLANT_A,
        seasonId: SEASON_A,
        bedId: BED_A,
        datePlanted: localDayOffset(-30),
      });
    case "seed":
      return await seedRepo.create({
        name: `Seed #${r}`,
        species: "Solanum lycopersicum",
        quantityRemaining: 10 + r,
        quantityUnit: "count",
        expiryDate: "2030-12-31",
      });
    case "taskRule":
      return await ruleRepo.create({
        appliesTo: { plantType: "vegetable" },
        trigger: { type: "seasonal", month: 3, day: 15 },
        task: { title: `Rule task #${r}` },
        isBuiltIn: r % 3 === 0, // interleaved built-ins among user rules
      });
    case "expense":
      return await expenseRepo.create({
        name: `Expense #${r}`,
        category: "tools",
        amount: 10 + r,
        date: todayLocal(),
        seasonId: SEASON_A,
      });
    case "userPlantKnowledge":
      return await ukpRepo.create({
        species: `Species #${r}`,
        commonName: `Common #${r}`,
        plantType: "vegetable",
        isPerennial: false,
        cropGroup: "tomato",
        sunNeeds: "full_sun",
        waterNeeds: "moderate",
      });
  }
}

async function buildLedger(): Promise<Ledger> {
  const ledger: Ledger = {};
  for (const t of ALL_TYPES) {
    ledger[t] = { live: [], liveDocIds: [], deletedIds: [] };
  }

  const softDelete = async (
    type: (typeof ALL_TYPES)[number],
    entity: { id: string },
  ) => {
    switch (type) {
      case "plant":
        await plantRepo.softDelete(entity.id);
        break;
      case "journal":
        await journalRepo.softDelete(entity.id);
        break;
      case "task":
        await taskRepo.softDelete(entity.id);
        break;
      case "gardenBed":
        await bedRepo.softDelete(entity.id);
        break;
      case "season":
        await seasonRepo.softDelete(entity.id);
        break;
      case "planting":
        await plantingRepo.softDelete(entity.id);
        break;
      case "seed":
        await seedRepo.softDelete(entity.id);
        break;
      case "taskRule":
        await ruleRepo.softDelete(entity.id);
        break;
      case "expense":
        await expenseRepo.softDelete(entity.id);
        break;
      case "userPlantKnowledge":
        await ukpRepo.softDelete(entity.id);
        break;
    }
  };

  // Round-robin creation across all ten types; deletion rounds interleaved
  // between live rounds so live/deleted/unrelated docs are mixed in-store.
  for (let r = 0; r < N_LIVE; r++) {
    for (const t of ALL_TYPES) {
      const entity = (await createLive(t, r)) as Record<string, unknown> & {
        id: string;
      };
      const cap = ledger[t];
      cap!.live.push(entity);
      cap!.liveDocIds.push(`${t}:${entity.id}`);
    }
    if (DELETE_ROUNDS.includes(r)) {
      for (const t of ALL_TYPES) {
        const e = (await createLive(t, 100 + r)) as Record<string, unknown> & {
          id: string;
        };
        await softDelete(t, e);
        ledger[t]!.deletedIds.push(e.id);
      }
    }
  }
  return ledger;
}

/** Expected exact sequences per repo after the fix. */
function expectedSequences(ledger: Ledger): Record<string, string[]> {
  const byDocIdAsc = (cap: Captured) =>
    [...cap.liveDocIds].sort((a, b) => a.localeCompare(b)).map(
      (docId) => docId.split(":")[1] as string,
    );
  const seq: Record<string, string[]> = {};
  for (const t of PLAIN_ORDERED) {
    seq[t] = byDocIdAsc(ledger[t]!);
  }
  // journal.getAll: createdAt desc (stable ties by _id asc)
  const journalCap = ledger.journal!;
  seq.journal = journalCap.live
    .map((e, i) => ({ e, docId: journalCap.liveDocIds[i]! }))
    .sort(
      (a, b) =>
        (b.e.createdAt as string).localeCompare(a.e.createdAt as string) ||
        a.docId.localeCompare(b.docId),
    )
    .map((x) => x.e.id);
  // season.getAll: year desc (stable ties by _id asc); years are distinct here
  const seasonCap = ledger.season!;
  seq.season = seasonCap.live
    .map((e, i) => ({ e, docId: seasonCap.liveDocIds[i]! }))
    .sort(
      (a, b) =>
        (b.e.year as number) - (a.e.year as number) ||
        a.docId.localeCompare(b.docId),
    )
    .map((x) => x.e.id);
  return seq;
}

const GETALL: Record<
  string,
  () => Promise<Array<{ id: string }>>
> = {
  plant: () => plantRepo.getAll(),
  journal: () => journalRepo.getAll(),
  task: () => taskRepo.getAll(),
  gardenBed: () => bedRepo.getAll(),
  season: () => seasonRepo.getAll(),
  planting: () => plantingRepo.getAll(),
  seed: () => seedRepo.getAll(),
  taskRule: () => ruleRepo.getAll(),
  expense: () => expenseRepo.getAll(),
  userPlantKnowledge: () => ukpRepo.getAll(),
};

beforeEach(async () => {
  testDB = new PouchDB(`getall-fix-${crypto.randomUUID()}`, {
    adapter: "memory",
  });
  originalsMap.clear();
});

describe("getAll completeness (ten repositories)", () => {
  it("returns every live record in the preserved order — exact identities, no deleted/unrelated leakage", async () => {
    const ledger = await buildLedger();
    const expected = expectedSequences(ledger);

    for (const t of ALL_TYPES) {
      const result = await GETALL[t]!();
      const gotIds = result.map((r) => r.id);
      expect(gotIds, `${t}.getAll exact identities+order`).toEqual(
        expected[t],
      );
      expect(gotIds, `${t}.getAll count`).toHaveLength(N_LIVE);
      for (const d of ledger[t]!.deletedIds) {
        expect(gotIds, `${t}.getAll excludes soft-deleted ${d}`).not.toContain(
          d,
        );
      }
    }

    // spot-check field fidelity at repo level (first/mid/last rows carry the
    // ledger entities at the expected _id-ordered positions)
    const plants = await plantRepo.getAll();
    const plantById = new Map(ledger.plant!.live.map((e) => [e.id, e]));
    expect(plants[0]!.species).toBe(
      plantById.get(expected.plant![0]!)!.species,
    );
    expect(plants[15]!.species).toBe(
      plantById.get(expected.plant![15]!)!.species,
    );
    expect(plants[N_LIVE - 1]!.species).toBe(
      plantById.get(expected.plant![N_LIVE - 1]!)!.species,
    );
    const seasons = await seasonRepo.getAll();
    expect(seasons[0]!.year).toBe(2030); // year-desc preserved
    expect(seasons[N_LIVE - 1]!.year).toBe(2001);
  });

  it("exportAll ZIP + Merge/Replace round-trip all nine affected exported types exactly (field fidelity, task-rule filtering, controls intact)", async () => {
    const ledger = await buildLedger();
    const expected = expectedSequences(ledger);

    // controls' ledger (untouched repos): 30 live + 5 deleted each
    const scheduleIds: string[] = [];
    for (let r = 0; r < N_LIVE; r++) {
      const ps = await psRepo.create({
        cropId: `crop-${r}`,
        varietyId: `variety-${r}`,
        cropSource: "builtin",
        cropName: `Crop #${r}`,
        varietyName: `Variety #${r}`,
        anchorDate: localDayOffset(-45),
        direction: "forward",
        seasonId: SEASON_A,
        harvestStartDate: localDayOffset(10),
        harvestEndDate: localDayOffset(40),
        status: "active",
      });
      scheduleIds.push(ps.id);
    }
    for (let r = 0; r < N_DELETED; r++) {
      const ps = await psRepo.create({
        cropId: `crop-del-${r}`,
        varietyId: `variety-del-${r}`,
        cropSource: "builtin",
        cropName: `Deleted crop #${r}`,
        varietyName: `Deleted variety #${r}`,
        anchorDate: localDayOffset(-80),
        direction: "forward",
        seasonId: SEASON_A,
        harvestStartDate: localDayOffset(-10),
        harvestEndDate: localDayOffset(5),
        status: "completed",
      });
      await psRepo.softDelete(ps.id);
    }
    for (let r = 0; r < N_LIVE; r++) {
      const st = await stRepo.create({
        plantingScheduleId: scheduleIds[r % scheduleIds.length]!,
        taskType: "harvest",
        title: `Schedule task #${r}`,
        scheduledDate: localDayOffset(10),
        originalDate: localDayOffset(10),
        sequenceOrder: r,
        cropName: "Crop",
        varietyName: "Variety",
        isCompleted: false,
      });
      void st;
    }
    for (let r = 0; r < N_DELETED; r++) {
      const st = await stRepo.create({
        plantingScheduleId: scheduleIds[0]!,
        taskType: "seed_start",
        title: `Deleted schedule task #${r}`,
        scheduledDate: localDayOffset(-10),
        originalDate: localDayOffset(-10),
        sequenceOrder: r,
        cropName: "Crop",
        varietyName: "Variety",
        isCompleted: false,
      });
      await stRepo.softDelete(st.id);
    }

    // settings + photos (untouched export paths)
    await settingsRepo.update({
      growingZone: "7a",
      lastFrostDate: "2026-04-15",
      firstFrostDate: "2026-10-15",
      gridUnit: "feet",
      temperatureUnit: "fahrenheit",
      theme: "light",
      keepOriginalPhotos: true,
      dbSchemaVersion: SCHEMA_VERSION,
      exportVersion: 1,
    });
    const ts = new Date().toISOString();
    const livePhotoIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const id = crypto.randomUUID();
      const deleted = i === 2;
      await clientModule.localDB.put({
        _id: `photo:${id}`,
        docType: "photo",
        id,
        version: 1,
        createdAt: ts,
        updatedAt: ts,
        originalStored: true,
        ...(deleted ? { deletedAt: ts } : {}),
      });
      const stored = await clientModule.localDB.get<{ _rev: string }>(
        `photo:${id}`,
      );
      await clientModule.localDB.putAttachment(
        `photo:${id}`,
        "thumbnail",
        stored!._rev,
        Buffer.from(`thumb-${i}`),
        "image/jpeg",
      );
      await originalsStore.saveOriginal(id, new Blob([Buffer.from(`original-${i}`)]));
      if (!deleted) livePhotoIds.push(id);
    }

    // ── pre-export reference: repo output must already equal ledger ──
    const preExport: Record<string, Array<{ id: string }>> = {};
    for (const t of ALL_TYPES) preExport[t] = await GETALL[t]!();

    // ── real export ──
    const blob = await exportAll();
    const zip = await JSZip.loadAsync(blob);
    const rowsOf = async (countKey: string): Promise<Array<Record<string, unknown>>> => {
      const tv = getTableValidations().find((v) => v.countKey === countKey)!;
      const f = zip.file(tv.filename);
      return JSON.parse(await f!.async("string")) as Array<Record<string, unknown>>;
    };
    const docTypeToCountKey: Record<string, string> = {
      plant: "plantInstances",
      journal: "journalEntries",
      task: "tasks",
      gardenBed: "gardenBeds",
      season: "seasons",
      planting: "plantings",
      seed: "seeds",
      taskRule: "taskRules",
      userPlantKnowledge: "userPlantKnowledge",
      plantingSchedule: "plantingSchedules",
      scheduleTask: "scheduleTasks",
    };
    const NINE = [
      "plant",
      "journal",
      "task",
      "gardenBed",
      "season",
      "planting",
      "seed",
      "taskRule",
      "userPlantKnowledge",
    ] as const;

    // expected ZIP/restore content per type: user-created subset for taskRule
    // (built-ins are intentionally not exported), full live ledger otherwise
    const restoreExpected: Record<string, string[]> = {};
    const restoreEntities: Record<
      string,
      Array<Record<string, unknown>>
    > = {};
    for (const t of NINE) {
      const liveById = new Map(ledger[t]!.live.map((e) => [e.id, e]));
      const ids =
        t === "taskRule"
          ? expected[t]!.filter((id) => liveById.get(id)!.isBuiltIn === false)
          : expected[t]!;
      restoreExpected[t] = ids;
      restoreEntities[t] = ids.map((id) => liveById.get(id)!);
    }

    for (const t of NINE) {
      const rows = await rowsOf(docTypeToCountKey[t]!);
      const gotIds = rows.map((r) => r.id as string);
      expect(gotIds, `ZIP ${t} exact identities+order`).toEqual(
        restoreExpected[t],
      );
      // field fidelity: every exported row deep-equals the ledger entity
      expect(rows, `ZIP ${t} field fidelity`).toEqual(restoreEntities[t]);
    }
    // user-created task-rule filtering: exactly the isBuiltIn=false live rules
    const ruleRows = await rowsOf("taskRules");
    expect(ruleRows.every((r) => r.isBuiltIn === false)).toBe(true);
    expect(ruleRows).toHaveLength(ledger.taskRule!.live.filter((r) => r.isBuiltIn === false).length);
    // controls
    expect((await rowsOf("plantingSchedules")).map((r) => r.id)).toHaveLength(N_LIVE);
    expect((await rowsOf("scheduleTasks")).map((r) => r.id)).toHaveLength(N_LIVE);
    const photoRows = await rowsOf("photos");
    // photos are exported in allDocs _id order (photo:<uuid> ascending)
    expect(photoRows.map((p) => p.id)).toEqual([...livePhotoIds].sort());
    expect((await rowsOf("settings"))).toHaveLength(1);

    // ── real Merge import into a FRESH DB ──
    const parsed = await parseZip(
      new File([blob], "backup.zip", { type: "application/zip" }),
    );
    testDB = new PouchDB(`getall-merge-${crypto.randomUUID()}`, {
      adapter: "memory",
    });
    const mergeResult = await executeImportMerge(parsed);
    expect(mergeResult.errors).toEqual([]);
    for (const t of NINE) {
      const restored = await GETALL[t]!();
      expect(restored.map((r) => r.id), `merge ${t} exact identities`).toEqual(
        restoreExpected[t],
      );
      expect(restored, `merge ${t} field fidelity`).toEqual(
        restoreEntities[t],
      );
    }

    // ── real Replace import over the POPULATED ledger DB ──
    const parsed2 = await parseZip(
      new File([blob], "backup2.zip", { type: "application/zip" }),
    );
    const replaceResult = await executeImportReplace(parsed2);
    expect(replaceResult.errors).toEqual([]);
    for (const t of NINE) {
      const restored = await GETALL[t]!();
      expect(
        restored.map((r) => r.id),
        `replace ${t} exact identities`,
      ).toEqual(restoreExpected[t]);
      expect(restored, `replace ${t} field fidelity`).toEqual(
        restoreEntities[t],
      );
    }
    expect(await settingsRepo.get()).not.toBeUndefined();
    const photosAfter = await clientModule.localDB.allDocs({
      startkey: "photo:",
      endkey: "photo:\uffff",
      include_docs: true,
    });
    expect(
      photosAfter.rows
        .map((r) => (r.doc as { id?: string } | undefined)?.id)
        .filter((x): x is string => x != null),
    ).toEqual([...livePhotoIds].sort());
    expect(originalsMap.size).toBe(livePhotoIds.length);
    // controls untouched
    expect((await psRepo.getAll())).toHaveLength(N_LIVE);
    expect((await stRepo.getAll())).toHaveLength(N_LIVE);
  });
});
