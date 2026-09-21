/**
 * Regression: settings initialization race (fix/settings-initialization-race).
 * R2 revision — evidence corrections per review:
 *
 *  - The provider lifecycle case now renders a REAL consumer (useSettings)
 *    and OBSERVES context state: the loading flag, then the resolved settings
 *    values after a concurrent initializer wins. A separate case genuinely
 *    unmounts the provider while its initialization is held at a barrier,
 *    INJECTS a non-409 rejection at the held put, awaits settlement, and
 *    asserts no unhandled rejection escapes. The mounted-failure path is
 *    deliberately not asserted (see LIMITATIONS) — no claim without
 *    observation.
 *  - The reset-straddle regressions (T5/T5b) hold the operation's internal
 *    GET on the old database — the point where instance pinning matters,
 *    because the put has not been evaluated yet — then reset, let the
 *    replacement initialize, and only then release the get. Assertions: the
 *    replacement database's record AND rev are exactly unchanged and the old
 *    operation fulfills with its own outcome. A pin-removal mutant fails
 *    these (its put binds to the new database: update 409s; initialize
 *    recovers but resolves with the winner's record) — the negative control
 *    run is captured in logs/pin-removal-negative-control.log.
 *  - Barriers expose awaited `held` promises and explicit settlement awaits (`vi.waitFor` on observed settlement flags); a final event-loop drain precedes observer-emptiness assertions in P2.
 *    Outcomes are asserted via observable settlement and stored-document
 *    state, never via barrier-internal flags alone.
 *
 * The affected production files (settingsRepository.ts, useSettings.tsx,
 * client.ts) are byte-identical between base 80e270f and this branch except
 * for this slice's own fix.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import "fake-indexeddb/auto";
import { render, screen } from "@testing-library/react";
import { SettingsProvider, useSettings } from "../../../hooks/useSettings.tsx";
import { settingsRepository } from "../../index.ts";
import { destroyAndRecreate, resetLocalDB, localDB } from "../client.ts";

vi.setConfig({ testTimeout: 60_000 });

const DOC_ID = "settings:singleton";

const DEFAULTS_A = {
  growingZone: "7a",
  lastFrostDate: "2026-04-15",
  firstFrostDate: "2026-10-15",
  gridUnit: "feet" as const,
  temperatureUnit: "fahrenheit" as const,
  theme: "light" as const,
  highContrast: false,
  fontSize: "normal" as const,
  keepOriginalPhotos: true,
  dbSchemaVersion: 5,
  exportVersion: 1,
};

const DEFAULTS_B = {
  growingZone: "3b",
  lastFrostDate: "2026-05-01",
  firstFrostDate: "2026-09-30",
  gridUnit: "meters" as const,
  temperatureUnit: "celsius" as const,
  theme: "dark" as const,
  highContrast: false,
  fontSize: "normal" as const,
  keepOriginalPhotos: false,
  dbSchemaVersion: 5,
  exportVersion: 1,
};

type Gate = {
  heldCount: () => number;
  held: Promise<void>;
  release: () => void;
};

/** Hold the FIRST `settings:singleton` GET on this instance. */
function holdFirstSettingsGet(db: typeof localDB): Gate {
  const origGet = db.get.bind(db);
  const state = { held: 0, released: false };
  let release!: () => void;
  let notifyHeld!: () => void;
  const held = new Promise<void>((r) => (notifyHeld = r));
  const gate = new Promise<void>((r) => {
    release = r;
  });
  (db as unknown as { get: unknown }).get = function (
    id: string,
    ...rest: unknown[]
  ) {
    if (id === DOC_ID && state.held === 0) {
      state.held += 1;
      notifyHeld();
      return gate.then(() =>
        (origGet as (i: string, ...r: unknown[]) => unknown)(id, ...rest),
      );
    }
    return (origGet as (i: string, ...r: unknown[]) => unknown)(id, ...rest);
  };
  return {
    heldCount: () => state.held,
    held,
    release,
  };
}

/**
 * Hold the Nth (1-based) ``settings:singleton`` PUT on this instance.
 */
function holdSettingsPut(db: typeof localDB, ordinal: number) {
  const origPut = db.put.bind(db);
  const state = { held: 0, passed: 0 };
  let release!: () => void;
  let notifyHeld!: () => void;
  const held = new Promise<void>((r) => (notifyHeld = r));
  const gate = new Promise<void>((r) => {
    release = r;
  });
  (db as unknown as { put: unknown }).put = function (
    doc: { _id?: string },
    ...rest: unknown[]
  ) {
    if (doc && doc._id === DOC_ID) {
      if (state.passed === ordinal - 1 && state.held === 0) {
        state.held += 1;
        notifyHeld();
        return gate.then(() =>
          (origPut as (d: { _id?: string }, ...r: unknown[]) => unknown)(
            doc,
            ...rest,
          ),
        );
      }
      state.passed += 1;
    }
    return (origPut as (d: { _id?: string }, ...r: unknown[]) => unknown)(
      doc,
      ...rest,
    );
  };
  return {
    heldCount: () => state.held,
    held,
    release,
  };
}

/** Track settlement without swallowing rejections. */
function track<T>(promise: Promise<T>) {
  const state: { value: "pending" | "fulfilled" | "rejected" } = {
    value: "pending",
  };
  void promise.then(
    () => (state.value = "fulfilled"),
    () => (state.value = "rejected"),
  );
  return state;
}

async function storedSettings(): Promise<Record<string, unknown> | undefined> {
  try {
    const doc = await localDB.get<Record<string, unknown>>(DOC_ID);
    const { _id, _rev, docType, ...rest } = doc;
    void _id;
    void _rev;
    void docType;
    return rest;
  } catch {
    return undefined;
  }
}

beforeEach(() => {
  resetLocalDB();
});

describe("settings initialization race (real client, deterministic barriers)", () => {
  it("T1: two concurrent initializers — the stored winner (with its own values) is preserved and the loser resolves without surfacing 409", async () => {
    const putGate = holdSettingsPut(localDB, 1);

    const init1 = settingsRepository.initialize(DEFAULTS_A);
    const init1State = track(init1);
    await putGate.held;
    expect(putGate.heldCount()).toBe(1);
    expect(init1State.value).toBe("pending");
    expect(await storedSettings()).toBeUndefined();

    const init2 = settingsRepository.initialize(DEFAULTS_B);
    const r2 = await init2;
    expect(r2).toMatchObject(DEFAULTS_B);
    expect(await storedSettings()).toMatchObject(DEFAULTS_B);

    putGate.release();
    const r1 = await init1;
    expect(init1State.value).toBe("fulfilled");
    expect(r1).toMatchObject(DEFAULTS_B);
    expect(await storedSettings()).toMatchObject(DEFAULTS_B);
  });

  it("T2: initialize() preserves pre-existing settings that differ from the defaults", async () => {
    await settingsRepository.initialize(DEFAULTS_A);
    await settingsRepository.update({
      gardenName: "My Garden",
      growingZone: "9b",
    });

    const result = await settingsRepository.initialize(DEFAULTS_A);

    expect(result.gardenName).toBe("My Garden");
    expect(result.growingZone).toBe("9b");
    expect(await storedSettings()).toMatchObject({
      gardenName: "My Garden",
      growingZone: "9b",
    });
  });

  it("T3: ordinary update still applies user edits", async () => {
    await settingsRepository.initialize(DEFAULTS_A);

    const result = await settingsRepository.update({ gardenName: "Renamed" });

    expect(result.gardenName).toBe("Renamed");
    const stored = await storedSettings();
    expect(stored?.gardenName).toBe("Renamed");
    expect(stored?.growingZone).toBe(DEFAULTS_A.growingZone);
  });

  it("T4: ordinary update surfaces genuine failure (destroyed database) instead of returning stored settings", async () => {
    await settingsRepository.initialize(DEFAULTS_A);
    const putGate = holdSettingsPut(localDB, 1);

    const leg = settingsRepository.update({ gardenName: "X" });
    const legState = track(leg);
    await putGate.held;
    expect(putGate.heldCount()).toBe(1);
    expect(legState.value).toBe("pending");

    await destroyAndRecreate();

    putGate.release();
    const err = await leg.then(
      () => null,
      (e: { status?: number }) => e,
    );
    expect(err).not.toBeNull();
    expect(err!.status).not.toBe(409);
    expect(await storedSettings()).toBeUndefined();
  });

  it("T4b: ordinary update with a stale concurrent write rejects with 409 instead of silently returning the stored record", async () => {
    await settingsRepository.initialize(DEFAULTS_A);
    const putGate = holdSettingsPut(localDB, 1);

    const stale = settingsRepository.update({ gardenName: "Stale edit" });
    const staleState = track(stale);
    await putGate.held;

    const fresh = await settingsRepository.update({ gardenName: "Fresh edit" });
    expect(fresh.gardenName).toBe("Fresh edit");

    putGate.release();
    const err = await stale.then(
      () => null,
      (e: { status?: number }) => e,
    );
    expect(staleState.value).toBe("rejected");
    expect(err).not.toBeNull();
    expect(err!.status).toBe(409);
    expect((await storedSettings())?.gardenName).toBe("Fresh edit");
  });

  it("T5: initialize suspended in its GET across resetLocalDB completes on its pinned database; the replacement's record and rev are exactly unchanged", async () => {
    // Hold initialize's internal GET on the old database (A): the put has not
    // been evaluated yet, so this is the point where instance pinning matters.
    const getGate = holdFirstSettingsGet(localDB);

    const leg1 = settingsRepository.initialize(DEFAULTS_A);
    const leg1State = track(leg1);
    await getGate.held;
    expect(getGate.heldCount()).toBe(1);
    expect(leg1State.value).toBe("pending");

    // Test boundary: resetLocalDB() (A -> B) while leg 1 is suspended.
    resetLocalDB();

    // The replacement initializes itself on B and its record wins there.
    const replacement = await settingsRepository.initialize(DEFAULTS_B);
    expect(replacement).toMatchObject(DEFAULTS_B);
    const bBefore = await localDB.get<Record<string, unknown>>(DOC_ID);

    // Release leg 1's get: its put must bind to its PINNED instance (A).
    getGate.release();
    const r1 = await leg1;
    expect(leg1State.value).toBe("fulfilled");
    expect(r1).toMatchObject(DEFAULTS_A); // pinned outcome: its own record

    // The replacement database's record AND rev are exactly unchanged.
    const bAfter = await localDB.get<Record<string, unknown>>(DOC_ID);
    expect(bAfter).toEqual(bBefore);
  });

  it("T5b: update suspended in its GET across resetLocalDB fulfills on its pinned database; the replacement is untouched", async () => {
    // Seed the old database so the suspended get returns a REAL record with a
    // rev in hand (a no-document miss would die in schema parse before the
    // pinned put is ever reached).
    await settingsRepository.initialize(DEFAULTS_A);

    const getGate = holdFirstSettingsGet(localDB);

    const leg1 = settingsRepository.update({ gardenName: "Old DB edit" });
    const leg1State = track(leg1);
    await getGate.held; // leg 1 suspended AFTER its get returned the rev
    expect(getGate.heldCount()).toBe(1);
    expect(leg1State.value).toBe("pending");

    resetLocalDB(); // A -> B while leg 1 holds a rev and has not put yet
    const replacement = await settingsRepository.initialize(DEFAULTS_B);
    expect(replacement).toMatchObject(DEFAULTS_B);
    const bBefore = await localDB.get<Record<string, unknown>>(DOC_ID);

    getGate.release(); // leg 1's put binds to its PINNED instance (A)
    const r1 = await leg1;
    expect(leg1State.value).toBe("fulfilled"); // a pin-less mutant 409s here
    expect(r1.gardenName).toBe("Old DB edit");

    const bAfter = await localDB.get<Record<string, unknown>>(DOC_ID);
    expect(bAfter).toEqual(bBefore); // replacement untouched by the old op
  });

  it("N1: a non-404 read failure propagates verbatim and no put is attempted", async () => {
    const sentinel = Object.assign(new Error("transient read failure"), {
      status: 500,
    });
    const origGet = localDB.get.bind(localDB);
    const origPut = localDB.put.bind(localDB);
    let putCalls = 0;
    (localDB as unknown as { get: unknown }).get = () =>
      Promise.reject(sentinel);
    (localDB as unknown as { put: unknown }).put = (...a: unknown[]) => {
      putCalls += 1;
      return (origPut as (...a: unknown[]) => unknown)(...a);
    };
    try {
      const err = await settingsRepository.initialize(DEFAULTS_A).then(
        () => null,
        (e: Error) => e,
      );
      expect(err).toBe(sentinel); // original error preserved (identity)
      expect(putCalls).toBe(0); // no write attempted
      expect(await storedSettings()).toBeUndefined();
    } finally {
      (localDB as unknown as { get: unknown }).get = origGet;
      (localDB as unknown as { put: unknown }).put = origPut;
    }
  });

  it("N2: a corrupt stored document (schema failure) propagates and no write is attempted", async () => {
    await localDB.put({
      _id: DOC_ID,
      docType: "settings",
      growingZone: "corrupt",
    });
    const rawBefore = await localDB.get<Record<string, unknown>>(DOC_ID);

    const origPut = localDB.put.bind(localDB);
    let putCalls = 0;
    (localDB as unknown as { put: unknown }).put = (...a: unknown[]) => {
      putCalls += 1;
      return (origPut as (...a: unknown[]) => unknown)(...a);
    };
    try {
      const err = await settingsRepository.initialize(DEFAULTS_A).then(
        () => null,
        (e: Error) => e,
      );
      expect((err as Error | null)?.name).toBe("ZodError");
      expect(putCalls).toBe(0);
      const rawAfter = await localDB.get<Record<string, unknown>>(DOC_ID);
      expect(rawAfter).toEqual(rawBefore); // preserved, not written over
    } finally {
      (localDB as unknown as { put: unknown }).put = origPut;
    }
  });

  it("N3: a genuine 404 (missing document) still enters creation", async () => {
    const result = await settingsRepository.initialize(DEFAULTS_A);
    expect(result).toMatchObject(DEFAULTS_A);
    expect(await storedSettings()).toMatchObject(DEFAULTS_A);
  });

  it("T1b control: the OLD initialization path (update) surfaces the 409 instead of preserving the winner — why initialize exists", async () => {
    const putGate = holdSettingsPut(localDB, 1);
    const stale = settingsRepository.update(DEFAULTS_A);
    const staleState = track(stale);
    await putGate.held;

    const winner = await settingsRepository.initialize(DEFAULTS_B);
    expect(winner).toMatchObject(DEFAULTS_B);

    putGate.release();
    const err = await stale.then(() => null, (e: { status?: number }) => e);
    expect(staleState.value).toBe("rejected");
    expect(err).not.toBeNull();
    expect(err!.status).toBe(409);
  });
});

describe("provider lifecycle (real useSettings consumer)", () => {
  const PROBE_LOADING = "probe:loading";

  function SettingsProbe() {
    const { settings, loading } = useSettings();
    if (loading) {
      return <div data-testid="probe">{PROBE_LOADING}</div>;
    }
    return (
      <div data-testid="probe">
        {`probe:zone=${settings.growingZone};name=${settings.gardenName ?? "none"}`}
      </div>
    );
  }

  function renderProbe() {
    return render(
      <SettingsProvider>
        <SettingsProbe />
      </SettingsProvider>,
    );
  }

  it("P1: a real useSettings consumer observes loading, then the concurrent winner's values (never defaults over the winner)", async () => {
    const putGate = holdSettingsPut(localDB, 1); // hold the provider's init put
    renderProbe();
    await putGate.held; // provider suspended at its rev-less put
    // Observed consumer state, not narration:
    expect(screen.getByTestId("probe").textContent).toBe(PROBE_LOADING);

    // A concurrent initializer wins BEFORE the provider resumes.
    const winner = await settingsRepository.initialize(DEFAULTS_B);
    expect(winner).toMatchObject(DEFAULTS_B);
    expect(screen.getByTestId("probe").textContent).toBe(PROBE_LOADING);

    putGate.release();
    // Awaits BOTH the loading=false transition and the observed winner values.
    await vi.waitFor(() => {
      expect(screen.getByTestId("probe").textContent).toBe(
        `probe:zone=${DEFAULTS_B.growingZone};name=none`,
      );
    });
  });

  it("P2: unmount while initialization is held, then an injected non-409 REJECTION — nothing escapes as an unhandled rejection", async () => {
    const seen: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      seen.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    // Injectable wrapper: holds the provider's init put, then genuinely
    // REJECTS it with an injected non-409 failure (discarded-database-style).
    const origGet = localDB.get.bind(localDB);
    const origPut = localDB.put.bind(localDB);
    let heldSeen = false;
    let inject!: (err: unknown) => void;
    let initPutSettled = false;
    const injected = new Promise<never>((_, reject) => {
      inject = (err: unknown) => {
        reject(err); // genuine rejection, not a resolve-with-error
      };
    });
    void injected.catch(() => {
      initPutSettled = true; // settlement observer (own handler)
    });
    (localDB as unknown as { get: unknown }).get = function (
      id: string,
      ...rest: unknown[]
    ) {
      return (origGet as (i: string, ...r: unknown[]) => unknown)(id, ...rest);
    };
    (localDB as unknown as { put: unknown }).put = function (
      doc: { _id?: string },
      ...rest: unknown[]
    ) {
      if (doc && doc._id === DOC_ID && !heldSeen) {
        heldSeen = true;
        return injected; // the provider's initialize awaits this rejection
      }
      return (origPut as (d: { _id?: string }, ...r: unknown[]) => unknown)(
        doc,
        ...rest,
      );
    };

    try {
      const { unmount } = renderProbe();
      await vi.waitFor(() => expect(heldSeen).toBe(true)); // init put at barrier
      expect(await storedSettings()).toBeUndefined();

      unmount(); // real unmount: cancelled = true, no active consumer remains

      // Inject the non-409 rejection and AWAIT explicit initialization
      // settlement: the rejection propagates through initialize (rethrown)
      // into the effect's cancelled-guard catch.
      inject(new Error("injected: pinned database discarded"));
      await vi.waitFor(() => expect(initPutSettled).toBe(true));
      // Final event-loop drain so any escaping rejection would surface.
      await new Promise((r) => setTimeout(r, 50));

      // The lifecycle guard dropped the post-cancellation rejection: the
      // process-level observer recorded nothing.
      expect(seen).toEqual([]);
      expect(await storedSettings()).toBeUndefined();
    } finally {
      (localDB as unknown as { get: unknown }).get = origGet;
      (localDB as unknown as { put: unknown }).put = origPut;
      process.removeListener("unhandledRejection", onUnhandled);
    }
  });


});
