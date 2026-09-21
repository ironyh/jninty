/**
 * Regression (real repository on fake-indexeddb): task alert completeness —
 * getUpcoming(days) / getOverdue().
 *
 * Base implementation reads via pouchdb-find with a dueDate selector and NO
 * limit, so results cap at the 25-MATCHED-doc default. Matched docs include
 * COMPLETED and SOFT-DELETED tasks (the selectors only bound docType and
 * dueDate), so noise consumes cap slots before the JS post-filter and live
 * alerts silently disappear. The fix reads via the shared complete
 * getAllDocsByType helper with identical predicates — ordering (ascending
 * _id) and semantics preserved.
 *
 * Coverage (B's draft plus the R-review gaps):
 *   - OVERDUE completed/deleted noise, not only upcoming-window noise.
 *   - EXACT identity assertions everywhere (ids AND order), including the
 *     <25 positive control — no count-only assertions.
 *   - Fixed Date clock via vi fake timers limited to Date (setTimeout and
 *     microtasks stay real — async is never frozen); all ledger dates are
 *     derived from the same fixed now.
 *   - No empty hooks; single beforeEach resets DB, ledger and clock.
 *
 * Deterministic ledger (LOCAL-calendar day offsets from the fixed now):
 *   - 30 live pending upcoming  due [today, today+7]
 *   -  3 live pending beyond    due  today+8      (excluded from days=7)
 *   - 30 live pending overdue   due [today-5, today-1]
 *   - 10 completed:             5 due in upcoming window, 5 OVERDUE
 *   -  5 soft-deleted:          3 due in upcoming window, 2 OVERDUE
 *   -  5 journal entries + 10 plants (unrelated-type noise)
 * Creation is interleaved across categories so live/completed/deleted/
 * unrelated records are mixed in storage order.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import "fake-indexeddb/auto";
import { taskRepository, journalRepository, plantRepository } from "../../index.ts";
import { resetLocalDB } from "../client.ts";

vi.setConfig({ testTimeout: 60_000 });

// Fixed wall clock at local noon — no midnight-boundary ambiguity. Date is
// the only faked timer (setTimeout/microtasks stay real), and shouldAdvance
// lets Date.now() follow real elapsed time: the LOCAL DATE stays pinned to
// 2026-09-21 for the duration of a test while monotonic time still advances
// (a fully frozen Date.now() makes the base pouchdb-find path spin forever).
const FIXED_NOW = new Date("2026-09-21T12:00:00");

function localDayOffset(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

const SEASON = "22222222-2222-4222-8222-222222222222";
const PLANT_A = "11111111-1111-4111-8111-111111111111";

type Bucket =
  | "upcoming"
  | "beyond"
  | "overdue"
  | "completedUpcoming"
  | "completedOverdue"
  | "deletedUpcoming"
  | "deletedOverdue";

interface LedgerEntry {
  id: string;
  docId: string;
  dueDate: string;
  /** false for completed and soft-deleted tasks — must never alert. */
  live: boolean;
}

const LEDGER: LedgerEntry[] = [];

async function createTask(bucket: Bucket, dueDate: string, completed = false) {
  return taskRepository.create({
    title: `Alert task [${bucket}] due ${dueDate}`,
    plantInstanceId: PLANT_A,
    seasonId: SEASON,
    dueDate,
    priority: "normal",
    isCompleted: completed,
  });
}

function record(
  t: { id: string },
  dueDate: string,
  live: boolean,
) {
  LEDGER.push({ id: t.id, docId: `task:${t.id}`, dueDate, live });
}

/** Exact expected ids: live tasks in the due window, ascending by doc _id. */
function expectedLiveInDueWindow(
  minDue: string | null,
  maxDue: string | null,
): string[] {
  return LEDGER.filter((l) => {
    if (!l.live) return false;
    if (minDue && l.dueDate < minDue) return false;
    if (maxDue && l.dueDate > maxDue) return false;
    return true;
  })
    .map((l) => l.docId)
    .sort((a, b) => a.localeCompare(b))
    .map((docId) => docId.split(":")[1] as string);
}

/** Exact expected NON-live ids in the due window (noise that must not alert). */
function expectedNoiseInDueWindow(
  minDue: string | null,
  maxDue: string | null,
): string[] {
  return LEDGER.filter((l) => {
    if (l.live) return false;
    if (minDue && l.dueDate < minDue) return false;
    if (maxDue && l.dueDate > maxDue) return false;
    return true;
  })
    .map((l) => l.id)
    .sort((a, b) => a.localeCompare(b));
}

async function seedLedger() {
  // Interleaved rounds: upcoming + overdue + noise each round; completed and
  // deleted spread across BOTH windows.
  for (let i = 0; i < 30; i++) {
    const u = await createTask("upcoming", localDayOffset(i % 8));
    record(u, localDayOffset(i % 8), true);

    const o = await createTask("overdue", localDayOffset(-1 - (i % 5)));
    record(o, localDayOffset(-1 - (i % 5)), true);

    if (i < 5) {
      const c = await createTask("completedUpcoming", localDayOffset(i % 3), true);
      record(c, localDayOffset(i % 3), false);
    }
    if (i < 5) {
      const c = await createTask("completedOverdue", localDayOffset(-1 - i), true);
      record(c, localDayOffset(-1 - i), false);
    }
    if (i % 6 === 5) {
      await journalRepository.create({
        plantInstanceId: PLANT_A,
        seasonId: SEASON,
        activityType: "watering",
        body: `noise journal ${i}`,
        photoIds: [],
        isMilestone: false,
      });
    }
    if (i % 3 === 0) {
      await plantRepository.create({
        species: `noise species ${i}`,
        type: "vegetable",
        isPerennial: false,
        source: "seed",
        status: "active",
        tags: [],
      });
    }
  }

  // Soft-deleted noise in BOTH windows, interleaved with the live seed.
  for (let i = 0; i < 3; i++) {
    const d = await createTask("deletedUpcoming", localDayOffset(2));
    await taskRepository.softDelete(d.id);
    record(d, localDayOffset(2), false);
  }
  for (let i = 0; i < 2; i++) {
    const d = await createTask("deletedOverdue", localDayOffset(-1 - i));
    await taskRepository.softDelete(d.id);
    record(d, localDayOffset(-1 - i), false);
  }

  // Beyond-boundary controls: due today+8 — excluded from getUpcoming(7),
  // included in getUpcoming(8).
  for (let i = 0; i < 3; i++) {
    const b = await createTask("beyond", localDayOffset(8));
    record(b, localDayOffset(8), true);
  }
}

describe("task alert completeness — getUpcoming/getOverdue (real repository)", () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ["Date"],
      shouldAdvanceTime: true,
      advanceTimeDelta: 20,
    });
    vi.setSystemTime(FIXED_NOW);
    resetLocalDB();
    LEDGER.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("getUpcoming(7) returns exactly the 30 live pending tasks due [today, today+7] — exact identities and order", async () => {
    await seedLedger();
    const expected = expectedLiveInDueWindow(localDayOffset(0), localDayOffset(7));
    expect(expected).toHaveLength(30);

    const result = await taskRepository.getUpcoming(7);
    expect(result.map((t) => t.id)).toEqual(expected);

    // Noise exclusion, both windows: completed and soft-deleted must never
    // appear (exact identities).
    const upcomingNoise = expectedNoiseInDueWindow(
      localDayOffset(0),
      localDayOffset(7),
    );
    expect(upcomingNoise).toHaveLength(8); // 5 completed + 3 deleted
    const resultIds = result.map((t) => t.id);
    for (const noiseId of upcomingNoise) {
      expect(resultIds).not.toContain(noiseId);
    }
  });

  it("getOverdue returns exactly the 30 live pending overdue tasks — exact identities and order, due-today excluded, overdue completed/deleted noise excluded", async () => {
    await seedLedger();
    const overdueExpected = LEDGER.filter(
      (l) => l.live && l.dueDate < localDayOffset(0),
    )
      .map((l) => l.docId)
      .sort((a, b) => a.localeCompare(b))
      .map((docId) => docId.split(":")[1] as string);
    expect(overdueExpected).toHaveLength(30);

    const result = await taskRepository.getOverdue();
    expect(result.map((t) => t.id)).toEqual(overdueExpected);

    // OVERDUE noise (the review gap): 5 completed-overdue + 2 deleted-
    // overdue tasks share the overdue window and must never alert.
    const overdueNoise = expectedNoiseInDueWindow(null, localDayOffset(-1));
    expect(overdueNoise).toHaveLength(7); // 5 completed + 2 deleted
    const resultIds = result.map((t) => t.id);
    for (const noiseId of overdueNoise) {
      expect(resultIds).not.toContain(noiseId);
    }
  });

  it("parameter boundary: getUpcoming(0) returns only tasks due today — exact identities", async () => {
    await seedLedger();
    const dueToday = LEDGER.filter(
      (l) => l.live && l.dueDate === localDayOffset(0),
    )
      .map((l) => l.docId)
      .sort((a, b) => a.localeCompare(b))
      .map((docId) => docId.split(":")[1] as string);
    expect(dueToday).toHaveLength(4); // upcoming rounds i = 0, 8, 16, 24

    const result = await taskRepository.getUpcoming(0);
    expect(result.map((t) => t.id)).toEqual(dueToday);
  });

  it("parameter days: getUpcoming(8) additionally includes the three today+8 tasks — exact identities", async () => {
    await seedLedger();
    const result = await taskRepository.getUpcoming(8);
    const expected = expectedLiveInDueWindow(localDayOffset(0), localDayOffset(8));
    expect(expected).toHaveLength(33); // 30 + 3 beyond-boundary
    expect(result.map((t) => t.id)).toEqual(expected);
  });

  it("positive control (<25 matches): a small ledger returns complete with exact identities — both methods", async () => {
    for (let i = 0; i < 10; i++) {
      const u = await createTask("upcoming", localDayOffset(i % 7));
      record(u, localDayOffset(i % 7), true);
    }
    const o1 = await createTask("overdue", localDayOffset(-1));
    record(o1, localDayOffset(-1), true);
    const o2 = await createTask("overdue", localDayOffset(-2));
    record(o2, localDayOffset(-2), true);
    const c = await createTask("completedUpcoming", localDayOffset(1), true);
    record(c, localDayOffset(1), false);
    const d = await createTask("upcoming", localDayOffset(1));
    await taskRepository.softDelete(d.id);
    record(d, localDayOffset(1), false);

    const upcoming = await taskRepository.getUpcoming(7);
    expect(upcoming.map((t) => t.id)).toEqual(
      expectedLiveInDueWindow(localDayOffset(0), localDayOffset(7)),
    );
    expect(upcoming.map((t) => t.id)).not.toContain(d.id);

    const overdue = await taskRepository.getOverdue();
    expect(overdue.map((t) => t.id)).toEqual(
      expectedLiveInDueWindow(null, localDayOffset(-1)),
    );
  });
});
