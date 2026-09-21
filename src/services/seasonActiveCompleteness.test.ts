// Regression tests for complete season active-selection reads.
// getActive() and deactivateAllExcept() (via setActive / update-activation)
// previously read with the unbounded-default pouchdb-find selector, capped at
// 25 matched documents. These tests assert the DESIRED behavior with >25
// seasons: FAIL against the find()-based implementation (base 80e270f), PASS
// with prefix-bounded allDocs reads. getAll() is a separate concern and is
// deliberately not exercised here. Mocking pattern mirrors
// scheduling-query-completeness.test.ts (memory PouchDB as localDB, actual
// seasonRepository).
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeAll, vi } from "vitest";
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
    testDB = new PouchDB(`season-completeness-${crypto.randomUUID()}`, {
      adapter: "memory",
    });
    const { resetIndexState } = await import("../db/pouchdb/indexes.ts");
    resetIndexState();
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

vi.mock("../services/syncConfigStore.ts", () => ({
  getSyncConfig: vi.fn().mockReturnValue(null),
  saveSyncConfig: vi.fn(),
  clearSyncConfig: vi.fn(),
}));

import { seasonRepository } from "../db/index.ts";
import { localDB, destroyAndRecreate } from "../db/pouchdb/client.ts";

// Stable, schema-valid UUID v4 whose string order follows i.
const sid = (i: number) =>
  `c0000000-0000-4000-8000-${String(i).padStart(12, "0")}`;

const CREATED_AT = "2026-01-01T00:00:00.000Z";

async function putSeason(opts: {
  i: number;
  active?: boolean;
  deleted?: boolean;
}): Promise<string> {
  const id = sid(opts.i);
  await localDB.put({
    _id: `season:${id}`,
    docType: "season",
    id,
    version: 1,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...(opts.deleted ? { deletedAt: "2026-02-01T00:00:00.000Z" } : {}),
    name: `Season ${2000 + opts.i}`,
    year: 2000 + opts.i,
    startDate: "2026-03-01",
    endDate: "2026-11-30",
    isActive: opts.active ?? false,
  });
  return id;
}

async function putDecoy(n: number): Promise<void> {
  await localDB.put({
    _id: `journalEntry::season-fix-decoy-${n}`,
    docType: "journalEntry",
    title: "unrelated",
  });
}

/** Exact ledger of all season docs, sorted by _id (stable ids ⇒ by i). */
async function ledger(): Promise<
  Array<{ id: string; isActive: boolean; deleted: boolean; version: number }>
> {
  const res = await localDB.allDocs({
    startkey: "season:",
    endkey: "season:\ufff0",
    include_docs: true,
  });
  return res.rows
    .map((r) => r.doc as Record<string, any>)
    .map((d) => ({
      id: d.id as string,
      isActive: d.isActive as boolean,
      deleted: d.deletedAt != null,
      version: d.version as number,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

const liveActive = (l: Awaited<ReturnType<typeof ledger>>) =>
  l.filter((s) => s.isActive && !s.deleted).map((s) => s.id);

async function decoySnapshot(): Promise<Array<{ _id: string; _rev: string }>> {
  const res = await localDB.allDocs({ include_docs: true });
  return res.rows
    .map((r) => r.doc as Record<string, any>)
    .filter(
      (d) =>
        d.docType !== "season" && !String(d._id).startsWith("_design/"),
    )
    .map((d) => ({ _id: d._id, _rev: d._rev }));
}

/** Seeds 30 seasons; actives/deleted as specified; returns nothing. */
async function seedThirty(
  actives: number[],
  deleted: number[],
): Promise<void> {
  for (let i = 1; i <= 30; i++) {
    await putSeason({ i, active: actives.includes(i), deleted: deleted.includes(i) });
  }
}

describe("season repository complete reads (getActive + deactivation)", () => {
  beforeAll(async () => {
    await destroyAndRecreate();
  });

  it(">25: getActive finds the live active season even when it sorts beyond the 25-match cap", async () => {
    await destroyAndRecreate();
    // Only live active = #27, beyond the cap; soft-deleted #3/#14/#26 consume slots.
    await seedThirty([27], [3, 14, 26]);
    const active = await seasonRepository.getActive();
    expect(active?.id).toBe(sid(27));
    expect(active?.year).toBe(2027);
  });

  it(">25: setActive yields exactly ONE live active season; deleted-active and unrelated docs unchanged", async () => {
    await destroyAndRecreate();
    // #2 live active (in cap), #27 live active (beyond cap), #30 deleted-active.
    await seedThirty([2, 27, 30], [3, 30]);
    await putDecoy(1);
    await putDecoy(2);
    const decoysBefore = await decoySnapshot();
    const before = await ledger();

    await seasonRepository.setActive(sid(5));

    const after = await ledger();
    expect(liveActive(after)).toEqual([sid(5)]);
    // Deleted-active #30 is skipped by deactivation (exact mutation preserved)
    // and never counts as live active.
    expect(after.find((s) => s.id === sid(30))).toMatchObject({
      isActive: true,
      deleted: true,
      version: 1,
    });
    // Exactly #2, #5 and #27 mutated (both stale actives deactivated, target
    // activated); every other doc byte-stable.
    const mutated = after
      .filter(
        (s) =>
          !before.find(
            (b) =>
              b.id === s.id &&
              b.version === s.version &&
              b.isActive === s.isActive,
          ),
      )
      .map((s) => s.id)
      .sort();
    expect(mutated).toEqual([sid(2), sid(5), sid(27)].sort());
    // Decoys untouched.
    expect(await decoySnapshot()).toEqual(decoysBefore);
    // getActive agrees with the single live active.
    expect((await seasonRepository.getActive())?.id).toBe(sid(5));
  });

  it(">25: update(isActive:true) on an inactive season deactivates every other live active", async () => {
    await destroyAndRecreate();
    // The audit only exercised update below the cap; this is the >25 case.
    await seedThirty([2, 27], [3]);
    await seasonRepository.update(sid(5), { isActive: true });
    const after = await ledger();
    expect(liveActive(after)).toEqual([sid(5)]);
    expect(after.find((s) => s.id === sid(27))).toMatchObject({
      isActive: false,
      deleted: false,
    });
  });

  it(">25: negative controls — nonexistent or soft-deleted target rejects with zero mutation", async () => {
    await destroyAndRecreate();
    await seedThirty([2, 27, 30], [3, 30]);
    const before = JSON.stringify(await ledger());
    const decoysBefore = JSON.stringify(await decoySnapshot());

    await expect(seasonRepository.setActive(sid(99))).rejects.toThrow(
      /Season not found/,
    );
    await expect(seasonRepository.setActive(sid(3))).rejects.toThrow(
      /Season not found/,
    );

    expect(JSON.stringify(await ledger())).toBe(before);
    expect(JSON.stringify(await decoySnapshot())).toBe(decoysBefore);
  });

  it("below cap: getActive, setActive and update-activation behave correctly (control)", async () => {
    await destroyAndRecreate();
    for (let i = 1; i <= 10; i++) {
      await putSeason({ i, active: i === 2, deleted: i === 9 });
    }
    await seasonRepository.setActive(sid(5));
    let l = await ledger();
    expect(liveActive(l)).toEqual([sid(5)]);
    expect((await seasonRepository.getActive())?.id).toBe(sid(5));

    await seasonRepository.update(sid(6), { isActive: true });
    l = await ledger();
    expect(liveActive(l)).toEqual([sid(6)]);
  });
});
