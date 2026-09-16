// Regression tests for Expense backup/restore — Expense was previously
// absent from the export/import registry (see exporter.getTableValidations),
// so backups silently dropped financial records.
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
    testDB = new PouchDB(`test-export-expenses-${crypto.randomUUID()}`, {
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
  expenseRepository,
  plantRepository,
  seasonRepository,
} from "../db/index.ts";
import { exportAll } from "./exporter.ts";
import { parseZip, executeImportReplace } from "./importer.ts";
import { destroyAndRecreate } from "../db/pouchdb/client.ts";

const asFile = (blob: Blob): File =>
  new File([blob], "jninty-backup.zip", { type: "application/zip" });

// State captured before the round trip.
let originalExpenses: Array<Record<string, unknown>>;
let seasonId: string;
let exportedBlob: Blob;

async function seedData() {
  const season = await seasonRepository.create({
    name: "2026 Season",
    year: 2026,
    startDate: "2026-03-01",
    endDate: "2026-11-30",
    isActive: true,
  });
  seasonId = season.id;
  await plantRepository.create({
    species: "Solanum lycopersicum",
    type: "vegetable",
    isPerennial: false,
    source: "seed",
    status: "active",
    tags: [],
  });
  await expenseRepository.create({
    name: "Seed order",
    category: "other",
    amount: 4.5,
    date: "2026-04-01",
  });
  await expenseRepository.create({
    name: "Compost delivery",
    category: "soil_amendments",
    amount: 65,
    store: "Garden center",
    date: "2026-04-10",
    seasonId: season.id,
    notes: "Bulk discount applied",
  });
  const deleted = await expenseRepository.create({
    name: "Mistaken duplicate",
    category: "tools",
    amount: 1,
    date: "2026-04-02",
  });
  await expenseRepository.softDelete(deleted.id); // must NOT be exported
}

describe("expense backup round trip", () => {
  beforeAll(async () => {
    await destroyAndRecreate();
    await seedData();
    originalExpenses = (await expenseRepository.getAll()).map((e) => ({
      ...e,
    }));
    exportedBlob = await exportAll();
    // The failure this guards against: expenses vanished here.
    await destroyAndRecreate();
    const parsed = await parseZip(asFile(exportedBlob));
    expect(parsed.valid).toBe(true);
    const result = await executeImportReplace(parsed);
    expect(result.errors).toEqual([]);
  });

  it("exports expenses.json with active records only", async () => {
    const zip = await JSZip.loadAsync(exportedBlob);
    const expenses = JSON.parse(
      (await zip.file("data/expenses.json")!.async("string")) ?? "[]",
    );
    expect(expenses).toHaveLength(2); // soft-deleted third record excluded
    expect(expenses.map((e: { name: string }) => e.name).sort()).toEqual([
      "Compost delivery",
      "Seed order",
    ]);
  });

  it("restores the expenses with their original ids", async () => {
    const expenses = await expenseRepository.getAll();
    expect(expenses.map((e) => e.id).sort()).toEqual(
      originalExpenses.map((e) => e.id).sort(),
    );
  });

  it("preserves all meaningful financial fields", () => {
    const compost = originalExpenses.find((e) => e.name === "Compost delivery")!;
    expect(compost.category).toBe("soil_amendments");
    expect(compost.amount).toBe(65);
    expect(compost.store).toBe("Garden center");
    expect(compost.date).toBe("2026-04-10");
    expect(compost.notes).toBe("Bulk discount applied");
  });

  it("keeps multiple records distinct", () => {
    const ids = new Set(originalExpenses.map((e) => e.id));
    expect(ids.size).toBe(originalExpenses.length);
    const names = originalExpenses.map((e) => e.name).sort();
    expect(names).toEqual(["Compost delivery", "Seed order"]);
  });

  it("preserves the seasonId reference to a related entity", () => {
    const compost = originalExpenses.find((e) => e.name === "Compost delivery")!;
    expect(compost.seasonId).toBe(seasonId);
    expect(seasonRepository.getAll().then((s) => s.map((x) => x.id))).resolves.toContain(
      seasonId,
    );
  });

  it("leaves unrelated exported entity types intact", async () => {
    expect(await plantRepository.getAll()).toHaveLength(1);
  });

  it("imports an old backup without expenses.json (count 0, no errors)", async () => {
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
    expect(parsed.counts.expenses).toBe(0);
    const result = await executeImportReplace(parsed);
    expect(result.errors).toEqual([]);
    expect(await expenseRepository.getAll()).toHaveLength(0);
  });
});
