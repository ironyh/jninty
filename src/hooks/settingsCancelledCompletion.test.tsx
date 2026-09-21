// Deterministic regression for the cancelled-initialization lifecycle gap in
// SettingsProvider.
//
// Observed failure (task-alert-query-completeness logs, focused.log): a
// successful initialize completing after the provider unmounted ran the
// unguarded `setLoading(false)` continuation (useSettings.tsx:61). React's
// dispatchSetState → requestUpdateLane → getCurrentEventPriority reads
// `window.event`; when the continuation runs without a `window` binding
// (test-environment teardown in the observed case), it throws
// "ReferenceError: window is not defined", which surfaces as an unhandled
// rejection of the floating effect promise.
//
// Reproduction here is deterministic, not teardown-timed: mount the ACTUAL
// SettingsProvider with a HELD initialize promise, really unmount (cancelled
// = true), remove the `window` binding by its exact property descriptor
// (simulating the post-teardown state; the original descriptor is restored in
// finally), then release the held success. On the unguarded base the
// continuation throws the same ReferenceError → captured unhandled
// rejection → this test FAILS. With the lifecycle guard it returns before
// any state update → no rejection → PASS.
//
// Listener hygiene: existing process.listeners are snapshotted BEFORE this
// file installs anything. Each capturing test installs exactly two owned
// listeners (a capture and a sentinel witness), performs ALL observation
// (mount, unmount, release, both drains, both assertions) with them
// installed, and its finally removes BOTH owned listeners by exact
// reference. After cleanup the live listener set must equal the original
// snapshot — no owned listener leaks and nothing pre-existing is removed.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import type { Settings } from "../validation/settings.schema.ts";

const DEFAULT_SETTINGS: Settings = {
  growingZone: "7a",
  lastFrostDate: "2026-04-15",
  firstFrostDate: "2026-10-15",
  gridUnit: "feet",
  temperatureUnit: "fahrenheit",
  theme: "light",
  highContrast: false,
  fontSize: "normal",
  keepOriginalPhotos: false,
  dbSchemaVersion: 1,
  exportVersion: 1,
};

const getMock = vi.fn<() => Promise<Settings | undefined>>();
const initializeMock = vi.fn<() => Promise<Settings>>();
const updateMock = vi.fn<() => Promise<Settings>>();

vi.mock("../db/index.ts", () => ({
  settingsRepository: {
    get: () => getMock(),
    initialize: () => initializeMock(),
    update: () => updateMock(),
  },
}));

import { useSettings, SettingsProvider } from "./useSettings.tsx";

let releaseInitialize!: (value: Settings) => void;
let rejectInitialize!: (err: unknown) => void;

beforeEach(() => {
  vi.clearAllMocks();
  getMock.mockResolvedValue(undefined);
  initializeMock.mockImplementation(
    () =>
      new Promise<Settings>((res, rej) => {
        releaseInitialize = res;
        rejectInitialize = rej;
      }),
  );
});

/**
 * Snapshot the current unhandledRejection listeners, then install exactly
 * two OWNED listeners: a capture (records rejections for assertions) and a
 * sentinel witness (independently records the same events). cleanup removes
 * ONLY those two owned listeners by exact reference.
 */
function installRejectionCapture() {
  const original = process.listeners("unhandledRejection").slice();
  const captured: unknown[] = [];
  const sentinelCalls: unknown[] = [];
  const capture = (reason: unknown) => {
    captured.push(reason);
  };
  const sentinel = (reason: unknown) => {
    sentinelCalls.push(reason);
  };
  process.on("unhandledRejection", sentinel);
  process.on("unhandledRejection", capture);
  return {
    original,
    captured,
    sentinelCalls,
    cleanup() {
      process.off("unhandledRejection", capture);
      process.off("unhandledRejection", sentinel);
    },
    ownedRemoved() {
      const listeners = process.listeners("unhandledRejection");
      return {
        captureRemoved: !listeners.includes(capture),
        sentinelRemoved: !listeners.includes(sentinel),
      };
    },
    originalRestored() {
      const now = process.listeners("unhandledRejection");
      return (
        now.length === original.length &&
        now.every((fn, i) => fn === original[i])
      );
    },
  };
}

/** Remove the window binding by its exact property descriptor; restorable. */
function withWindowRemoved(run: () => Promise<void>): Promise<void> {
  const globalRef = globalThis as unknown as Record<string, unknown>;
  const original = Object.getOwnPropertyDescriptor(globalRef, "window");
  delete globalRef.window;
  return run().finally(() => {
    if (original) {
      Object.defineProperty(globalRef, "window", original);
    } else {
      // It was not an own property before; leave none behind.
      delete globalRef.window;
    }
  });
}

describe("SettingsProvider cancelled-initialization lifecycle", () => {
  it("mounted positive control: initialize completes normally (settings set, loading false)", async () => {
    getMock.mockResolvedValue(undefined);
    initializeMock.mockResolvedValue({
      ...DEFAULT_SETTINGS,
      growingZone: "6b",
    });

    const { result } = renderHook(() => useSettings(), {
      wrapper: SettingsProvider,
    });

    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.settings.growingZone).toBe("6b");
    expect(initializeMock).toHaveBeenCalledTimes(1);
  });

  it("unmount before a successful initialize release must not run the state continuation (no unhandled rejection)", async () => {
    // get() → undefined so the provider takes the initialize branch; the
    // initialize promise is held.
    getMock.mockResolvedValue(undefined);

    const capture = installRejectionCapture();
    try {
      const { unmount } = renderHook(() => useSettings(), {
        wrapper: SettingsProvider,
      });
      // Wait until the provider actually entered the initialize branch
      // (get() resolved, initialize() called), THEN unmount — cancelled =
      // true while the initialize promise is still pending.
      await waitFor(() => expect(initializeMock).toHaveBeenCalledTimes(1));
      unmount();

      // Simulate the post-teardown state deterministically: remove the
      // window binding so React's getCurrentEventPriority cannot read
      // window.event.
      await withWindowRemoved(async () => {
        // Release the held SUCCESSFUL initialize after unmount.
        await act(async () => {
          releaseInitialize({ ...DEFAULT_SETTINGS, growingZone: "5a" });
        });
        // First drain: let microtasks and the unhandled-rejection tick
        // deliver the rejection to the (still-installed) owned listeners.
        await new Promise((r) => setTimeout(r, 25));

        // DESIRED behavior: the cancelled continuation returns before any
        // state update — nothing rejects. On the unguarded base this fails
        // with the captured "ReferenceError: window is not defined" thrown
        // at the setLoading(false) line (61).
        const detail = capture.captured
          .map((r) =>
            r instanceof Error ? `${r.name}: ${r.message}` : String(r),
          )
          .join(" | ");
        expect(capture.captured, `captured: ${detail}`).toEqual([]);
      });

      // Second drain — capture is STILL installed, so this observation is
      // live: any rejection surfacing after the first drain would grow the
      // array and fail the re-assertion below.
      await new Promise((r) => setTimeout(r, 25));
      const detail = capture.captured
        .map((r) =>
          r instanceof Error ? `${r.name}: ${r.message}` : String(r),
        )
        .join(" | ");
      expect(capture.captured, `late captured: ${detail}`).toEqual([]);
    } finally {
      // Remove BOTH owned listeners by exact reference — the sentinel is
      // not left installed.
      capture.cleanup();
    }

    // The live listener set must equal the pre-install snapshot: neither
    // owned listener leaks and no pre-existing listener was removed.
    expect(capture.ownedRemoved()).toEqual({
      captureRemoved: true,
      sentinelRemoved: true,
    });
    expect(capture.originalRestored()).toBe(true);
  });

  it("stored-settings mounted control: a new provider mounts from its get() result (test double)", async () => {
    // Honest scope: this control uses the mocked repository's get(), so it
    // proves only that a NEW provider mounts from stored settings and does
    // not re-initialize. It does NOT itself prove persisted writes or
    // persistence across a real cancellation+remount cycle — persistence is
    // covered by the repository round-trip tests (settingsInitialization).
    getMock.mockResolvedValue({ ...DEFAULT_SETTINGS, growingZone: "5a" });
    initializeMock.mockResolvedValue({
      ...DEFAULT_SETTINGS,
      growingZone: "never",
    });

    const { result } = renderHook(() => useSettings(), {
      wrapper: SettingsProvider,
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.settings.growingZone).toBe("5a");
    expect(initializeMock).not.toHaveBeenCalled();
  });

  it("cancelled error path unchanged: a rejected initialize after unmount is swallowed (no unhandled rejection)", async () => {
    getMock.mockResolvedValue(undefined);

    const capture = installRejectionCapture();
    try {
      const { unmount } = renderHook(() => useSettings(), {
        wrapper: SettingsProvider,
      });
      await waitFor(() => expect(initializeMock).toHaveBeenCalledTimes(1));
      unmount();
      await act(async () => {
        rejectInitialize(new Error("initialize write failed"));
      });
      await new Promise((r) => setTimeout(r, 25));

      // Pre-existing semantics (guard already present on the error branch):
      // the error is dropped purely on lifecycle grounds. Pinned here so the
      // new success-path guard cannot alter error semantics.
      expect(capture.captured).toEqual([]);
    } finally {
      capture.cleanup();
    }

    expect(capture.ownedRemoved()).toEqual({
      captureRemoved: true,
      sentinelRemoved: true,
    });
    expect(capture.originalRestored()).toBe(true);
  });
});
