/**
 * Regression tests — query completeness for seedRepository.getExpiringSoon.
 *
 * The previous implementation went through localDB.find, whose installed
 * pouchdb-find plugin caps every query at 25 docs when `limit` is omitted
 * (guard: node_modules/pouchdb-find/lib/index.js:1350). A garden with more
 * than 25 seeds expiring within the window therefore made the dashboard
 * widget (DashboardPage.tsx:48, "N seeds expiring soon") silently
 * undercount. These tests assert CORRECT expected id SETS from the FIXTURE
 * (sorted comparison, deterministic regardless of create() ids): all
 * qualifying rows are returned, and expired, far-future, missing-expiry,
 * soft-deleted and cross-docType rows are excluded per the method's
 * contract.
 *
 * Same harness as query-completeness.regression.test.ts: real PouchDB
 * (memory adapter) + the real pouchdb-find plugin; only the DB instance is
 * injected. Fixed clock via vi.useFakeTimers({ toFake: ["Date"] }) so the
 * inclusive window boundaries are exact: getExpiringSoon(30) sees
 * [2026-09-23, 2026-10-23]. Each test DB is closed after use.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import PouchDB from "pouchdb";
import PouchDBFind from "pouchdb-find";
import PouchDBAdapterMemory from "pouchdb-adapter-memory";
import { seedSchema } from "../../../validation/seed.schema.ts";
import { toPouchDoc } from "../utils.ts";

PouchDB.plugin(PouchDBFind);
PouchDB.plugin(PouchDBAdapterMemory);

let testDB: PouchDB.Database;

vi.mock("../client.ts", () => ({
  get localDB() {
    return testDB;
  },
}));

const seedRepo = await import("./seedRepository.ts");
const taskRepo = await import("./taskRepository.ts");

const FIXED_NOW = new Date("2026-09-23T12:00:00Z");
const TODAY = "2026-09-23";
const CUTOFF = "2026-10-23";

function detUuid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

interface FixtureSeed {
  id: string;
  expiryDate?: string;
  deleted?: boolean;
}

/**
 * Insert one seed doc with a DETERMINISTIC id. A row with no expiryDate is
 * stored WITHOUT the key (the field is optional; PouchDB rejects explicit
 * undefined values).
 */
async function putSeed(s: FixtureSeed): Promise<void> {
  const base: Record<string, unknown> = {
    id: s.id,
    name: `Seed packet ${s.id.slice(-4)}`,
    species: "Fixtura seeda",
    quantityRemaining: 5,
    quantityUnit: "packets",
    version: 1,
    createdAt: "2026-09-20T00:00:00.000Z",
    updatedAt: "2026-09-20T00:00:00.000Z",
  };
  if (s.expiryDate !== undefined) base["expiryDate"] = s.expiryDate;
  const parsed = seedSchema.parse(base);
  const doc = toPouchDoc(parsed, "seed") as Record<string, unknown>;
  if (s.deleted) doc["deletedAt"] = "2026-09-22T00:00:00.000Z";
  await testDB.put(doc as never);
}

async function seedTask(title: string): Promise<void> {
  await taskRepo.create({
    title,
    dueDate: "2026-09-23",
    priority: "low",
    isCompleted: false,
  });
}

let dbCounter = 0;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: FIXED_NOW });
  dbCounter += 1;
  testDB = new PouchDB(`test-seed-expiry-completeness-${dbCounter}`, {
    adapter: "memory",
  });
});

afterEach(async () => {
  vi.useRealTimers();
  await testDB.close();
});

describe("seedRepository.getExpiringSoon — query completeness", () => {
  it("returns ALL 30 qualifying seeds with their exact id set, excluding expired, far-future, missing-expiry, soft-deleted and cross-docType rows", async () => {
    // Relevant fixture: 30 qualifying seeds, including BOTH inclusive
    // boundary dates (today and today+30).
    const qualifying: FixtureSeed[] = [];
    for (let i = 1; i <= 28; i++) {
      const day = 24 + (i - 1); // 24..51
      const month = day > 30 ? "10" : "09";
      const d = String(day > 30 ? day - 30 : day).padStart(2, "0");
      qualifying.push({ id: detUuid(i), expiryDate: `2026-${month}-${d}` });
    }
    qualifying[0]!.expiryDate = TODAY; // seed 001: today boundary
    qualifying.push({ id: detUuid(29), expiryDate: CUTOFF }); // seed 029: cutoff boundary
    qualifying.push({ id: detUuid(30), expiryDate: "2026-10-02" });

    // Irrelevant noise with EXPLICIT ids — asserted absent by id, not via a
    // derived "missing" list (which would be tautological).
    const noiseExpired: FixtureSeed[] = [
      { id: detUuid(9101), expiryDate: "2026-09-22" }, // expired yesterday
    ];
    const noiseFarFuture: FixtureSeed[] = [
      { id: detUuid(9102), expiryDate: "2027-01-01" }, // beyond cutoff
    ];
    const noiseNoExpiry: FixtureSeed[] = [
      { id: detUuid(9103) }, // no expiryDate at all — never qualified
    ];
    const noiseSoftDeleted: FixtureSeed[] = [
      // qualifying window but soft-deleted
      { id: detUuid(9104), expiryDate: "2026-10-01", deleted: true },
      { id: detUuid(9105), expiryDate: "2026-10-02", deleted: true },
    ];
    const noiseSeedIds = [
      ...noiseExpired,
      ...noiseFarFuture,
      ...noiseNoExpiry,
      ...noiseSoftDeleted,
    ].map((s) => s.id);

    for (const s of qualifying) await putSeed(s);
    for (const s of [
      ...noiseExpired,
      ...noiseFarFuture,
      ...noiseNoExpiry,
      ...noiseSoftDeleted,
    ]) {
      await putSeed(s);
    }
    await seedTask("cross-docType noise A");
    await seedTask("cross-docType noise B");

    const result = await seedRepo.getExpiringSoon(30);
    const returnedIds = result.map((r) => r.id).sort();

    // Exact id sets: every qualifying seed present, nothing extra.
    expect(returnedIds).toEqual(qualifying.map((s) => s.id).sort());
    expect(result).toHaveLength(qualifying.length);
    expect(result.every((r) => r.deletedAt == null)).toBe(true);
    for (const id of noiseSeedIds) {
      expect(returnedIds).not.toContain(id);
    }
    // Noise counts for this scenario (documented): 1 expired, 1 far-future,
    // 1 missing-expiry, 2 qualifying-but-soft-deleted, 2 cross-docType tasks.
    expect(noiseSeedIds).toHaveLength(5);
  });

  it("returns the exact small set when under the old 25-doc cap (positive control)", async () => {
    const controlFixture: FixtureSeed[] = [
      { id: detUuid(9001), expiryDate: TODAY }, // today boundary
      { id: detUuid(9002), expiryDate: "2026-10-01" },
      { id: detUuid(9003), expiryDate: "2026-10-10" },
      { id: detUuid(9004), expiryDate: CUTOFF }, // cutoff boundary
      { id: detUuid(9005), expiryDate: "2026-10-15" },
    ];
    for (const s of controlFixture) await putSeed(s);
    await putSeed({ id: detUuid(9101), expiryDate: "2026-09-22" }); // expired

    const result = await seedRepo.getExpiringSoon(30);
    expect(result.map((r) => r.id).sort()).toEqual(
      controlFixture.map((s) => s.id).sort(),
    );
  });

  it("returns [] when no seed qualifies (empty-result control)", async () => {
    await putSeed({ id: detUuid(9201), expiryDate: "2026-09-22" }); // expired
    await putSeed({ id: detUuid(9202), expiryDate: "2027-01-01" }); // far future
    await putSeed({ id: detUuid(9203) }); // no expiryDate
    await putSeed({
      id: detUuid(9204),
      expiryDate: "2026-10-01",
      deleted: true,
    }); // qualifying but soft-deleted

    const result = await seedRepo.getExpiringSoon(30);
    expect(result).toEqual([]);
  });

  it("boundary dates are inclusive for rows that exist inside the window", async () => {
    await putSeed({ id: detUuid(7001), expiryDate: TODAY });
    await putSeed({ id: detUuid(7002), expiryDate: CUTOFF });

    const result = await seedRepo.getExpiringSoon(30);
    const ids = result.map((r) => r.id).sort();
    expect(ids).toEqual([detUuid(7001), detUuid(7002)].sort());
  });
});
