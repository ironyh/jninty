/**
 * Focused regressions for LocationMapPicker (react-leaflet mocked — see
 * __mocks__/reactLeafletMock.tsx). Covers the acceptance contract:
 * existing coordinates are displayed read-only; a selection is pending until
 * the explicit Save writes; Cancel discards without any write; geolocation
 * runs only on click, validates results, and stale callbacks cannot overwrite
 * cancelled/newer selections; save rejection keeps the pending selection and
 * shows no success; tile failures surface an understandable banner.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, act, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("react-leaflet", async () => {
  return await import("./__mocks__/reactLeafletMock.tsx");
});

import LocationMapPicker from "./LocationMapPicker.tsx";
import {
  __fireMapClick,
  __fireTileError,
  __fireTileLoad,
  __registry,
} from "./__mocks__/reactLeafletMock.tsx";
import { TILE_ERROR_MESSAGE } from "../../services/mapTiles.ts";

let geoSuccess:
  | ((pos: { coords: { latitude: number; longitude: number } }) => void)
  | null = null;
let geoError:
  | ((err: { code: number; PERMISSION_DENIED: number }) => void)
  | null = null;
const PERMISSION_DENIED = 1;

function installGeolocation() {
  const getCurrentPosition = vi.fn((success, error) => {
    geoSuccess = success;
    geoError = error;
  });
  // jsdom ships its own navigator.geolocation stub on the prototype — shadow
  // it with an instance GETTER so our capture always wins.
  Object.defineProperty(navigator, "geolocation", {
    configurable: true,
    get() {
      return { getCurrentPosition };
    },
  });
  return getCurrentPosition;
}

function restoreGeolocation() {
  delete (navigator as unknown as { geolocation?: unknown }).geolocation;
}

function markerPosition(): string | null {
  const marker = screen.queryByTestId("mock-marker");
  return marker ? (marker.dataset.position ?? null) : null;
}

function fireMapClick(lat: number, lon: number) {
  act(() => {
    __fireMapClick(lat, lon);
  });
}

function fireGeoSuccess(lat: number, lon: number) {
  act(() => {
    geoSuccess?.({ coords: { latitude: lat, longitude: lon } });
  });
}

function fireGeoDenied() {
  act(() => {
    geoError?.({ code: PERMISSION_DENIED, PERMISSION_DENIED });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  geoSuccess = null;
  geoError = null;
  installGeolocation();
});

afterEach(() => {
  // vitest globals are off: testing-library auto-cleanup is inactive, so
  // unmount rendered trees explicitly to keep queries scoped per test.
  cleanup();
  restoreGeolocation();
});

const EXISTING = { latitude: 55.605, longitude: 13.0 };

describe("LocationMapPicker", () => {
  it("displays existing saved coordinates read-only and keeps Save disabled until a selection is made", () => {
    render(
      <LocationMapPicker
        latitude={EXISTING.latitude}
        longitude={EXISTING.longitude}
        onSave={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    expect(markerPosition()).toBe("55.605,13");
    expect(screen.getByRole("button", { name: "Save position" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Cancel selection" })).toBeNull();
    // Attribution must be carried by the tile layer.
    expect(screen.getByTestId("mock-tilelayer").dataset.attribution).toContain(
      "OpenStreetMap",
    );
  });

  it("renders without crashing when the saved coordinates are invalid, treating them as absent", () => {
    render(
      <LocationMapPicker
        latitude={Number.NaN}
        longitude={Number.NaN}
        onSave={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    // No marker at all: the invalid saved position is never rendered.
    expect(markerPosition()).toBeNull();
    expect(screen.getByRole("button", { name: "Save position" })).toBeDisabled();
  });

  it("a map click selects a pending position; Save writes exactly those coordinates and reports success", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<LocationMapPicker latitude={55.605} longitude={13.0} onSave={onSave} />);

    fireMapClick(55.51, 13.05);
    expect(markerPosition()).toBe("55.51,13.05");
    const save = screen.getByRole("button", { name: "Save position" });
    expect(save).toBeEnabled();
    expect(screen.getByRole("button", { name: "Cancel selection" })).not.toBeNull();

    await user.click(save);
    await waitFor(() =>
      expect(screen.getByText(/Location saved: 55\.51000, 13\.05000/)).not.toBeNull(),
    );
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith(55.51, 13.05);
    // Pending cleared after success: marker back to the (old) existing value.
    expect(markerPosition()).toBe("55.605,13");
  });

  it("Cancel discards the pending selection without any write", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue(undefined);
    const onCancel = vi.fn();
    render(
      <LocationMapPicker
        latitude={55.605}
        longitude={13.0}
        onSave={onSave}
        onCancel={onCancel}
      />,
    );

    fireMapClick(56.0, 12.5);
    await user.click(screen.getByRole("button", { name: "Cancel selection" }));

    expect(onSave).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(markerPosition()).toBe("55.605,13"); // old value restored visually
    expect(screen.getByRole("button", { name: "Save position" })).toBeDisabled();
    expect(screen.getByText(/Selection discarded/)).not.toBeNull();
  });

  it("a late geolocation success cannot overwrite a newer manual selection", async () => {
    const user = userEvent.setup();
    render(
      <LocationMapPicker
        latitude={55.605}
        longitude={13.0}
        onSave={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Use my location" }));
    expect(geoSuccess).not.toBeNull();

    // The user clicks the map while the device lookup is in flight — this is
    // a NEWER selection and invalidates the in-flight request.
    fireMapClick(56.9, 12.1);
    expect(markerPosition()).toBe("56.9,12.1");

    // The stale geolocation result arrives afterwards and must be dropped.
    fireGeoSuccess(40.7, -74.0);
    expect(markerPosition()).toBe("56.9,12.1");
  });

  it("a geolocation callback after unmount is ignored", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue(undefined);
    const { unmount } = render(
      <LocationMapPicker latitude={55.605} longitude={13.0} onSave={onSave} />,
    );
    await user.click(screen.getByRole("button", { name: "Use my location" }));
    expect(geoSuccess).not.toBeNull();
    unmount();

    expect(() => fireGeoSuccess(40.7, -74.0)).not.toThrow();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("geolocation results outside valid ranges are rejected with the pending selection untouched", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <LocationMapPicker latitude={55.605} longitude={13.0} onSave={onSave} />,
    );

    await user.click(screen.getByRole("button", { name: "Use my location" }));
    fireMapClick(56.9, 12.1); // newer manual selection
    fireGeoSuccess(999, -74.0); // invalid — must be dropped

    expect(markerPosition()).toBe("56.9,12.1");
    expect(onSave).not.toHaveBeenCalled();
  });

  it("permission denial explains the manual fallback and requires no permission for the map", async () => {
    const user = userEvent.setup();
    render(
      <LocationMapPicker
        latitude={55.605}
        longitude={13.0}
        onSave={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Use my location" }));
    fireGeoDenied();

    expect(screen.getByText(/Location permission was denied/)).not.toBeNull();
    // Manual clicking remains available without any permission.
    fireMapClick(55.7, 13.1);
    expect(markerPosition()).toBe("55.7,13.1");
  });

  it("a save rejection keeps the pending selection, shows no success, and allows a retry", async () => {
    const user = userEvent.setup();
    const onSave = vi
      .fn()
      .mockRejectedValueOnce(new Error("settings write failed"))
      .mockResolvedValueOnce(undefined);
    render(<LocationMapPicker latitude={55.605} longitude={13.0} onSave={onSave} />);

    fireMapClick(55.4, 12.9);
    await user.click(screen.getByRole("button", { name: "Save position" }));

    expect(
      screen.getByText(/Saving failed — your previously saved location is unchanged/),
    ).not.toBeNull();
    expect(screen.queryByText(/Location saved/)).toBeNull();
    expect(markerPosition()).toBe("55.4,12.9"); // pending kept
    const save = screen.getByRole("button", { name: "Save position" });
    expect(save).toBeEnabled(); // retry possible

    await user.click(save);
    await waitFor(() =>
      expect(screen.getByText(/Location saved: 55\.40000, 12\.90000/)).not.toBeNull(),
    );
    expect(onSave).toHaveBeenCalledTimes(2);
  });

  it("a tile load failure shows an understandable, non-destructive banner", () => {
    render(
      <LocationMapPicker
        latitude={55.605}
        longitude={13.0}
        onSave={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    act(() => {
      __fireTileError(new Error("network unreachable"));
    });
    expect(screen.getByText(TILE_ERROR_MESSAGE)).not.toBeNull();
    expect(markerPosition()).toBe("55.605,13"); // saved location untouched
  });
});

describe("LocationMapPicker — R1 review hardening", () => {
  it("marker icon carries inline visible styling (never an invisible empty div)", async () => {
    render(
      <LocationMapPicker
        latitude={55.605}
        longitude={13.0}
        onSave={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    await waitFor(() => expect(__registry.lastIconHtml).not.toBe(""));
    const marker = screen.getByTestId("mock-marker");
    const iconHtml = marker.dataset.iconHtml ?? "";
    expect(iconHtml).toContain("background:");
    expect(iconHtml).toContain("border-radius:50%");
  });

  it("view sync: selecting a new position pans the map to it (ordinary renders do not)", async () => {
    render(
      <LocationMapPicker
        latitude={55.605}
        longitude={13.0}
        onSave={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    await waitFor(() => expect(__registry.map).not.toBeNull());
    const mapSpy = __registry.map!.panTo as ReturnType<typeof vi.fn>;
    mapSpy.mockClear();

    fireMapClick(56.9, 12.1);
    await waitFor(() => expect(mapSpy).toHaveBeenCalledWith([56.9, 12.1]));

    // A plain re-render (no selection change) must not re-pan.
    const callsAfterClick = mapSpy.mock.calls.length;
    fireMapClick(56.9, 12.1); // same position → same target → no pan
    expect(mapSpy).toHaveBeenCalledTimes(callsAfterClick);
  });

  it("while a save is in flight, new selections and geolocation are refused; success clears only the saved selection", async () => {
    const user = userEvent.setup();
    let releaseSave!: (v: void) => void;
    const onSave = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseSave = resolve;
        }),
    );
    render(<LocationMapPicker latitude={55.605} longitude={13.0} onSave={onSave} />);

    fireMapClick(55.4, 12.9);
    await user.click(screen.getByRole("button", { name: "Save position" }));
    expect(screen.getByRole("button", { name: "Saving…" })).not.toBeNull();

    // While saving: map clicks are refused…
    const getCurrentPosition = installGeolocation();
    fireMapClick(57.5, 11.9);
    expect(markerPosition()).toBe("55.4,12.9");

    // …and "Use my location" is refused too (no new device lookup starts).
    await user.click(screen.getByRole("button", { name: "Use my location" }));
    expect(getCurrentPosition).not.toHaveBeenCalled();

    // Resolve the save: only the saved selection is cleared.
    await act(async () => {
      releaseSave();
    });
    await waitFor(() =>
      expect(screen.getByText(/Location saved: 55\.40000, 12\.90000/)).not.toBeNull(),
    );
    expect(markerPosition()).toBe("55.605,13");
  });

  it("an in-flight device lookup can be cancelled, and its late callback is dropped", async () => {
    const user = userEvent.setup();
    installGeolocation();
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <LocationMapPicker
        latitude={55.605}
        longitude={13.0}
        onSave={onSave}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Use my location" }));
    expect(screen.getByText(/Requesting your location/)).not.toBeNull();

    await user.click(screen.getByRole("button", { name: "Cancel lookup" }));
    expect(screen.getByText(/Location request cancelled/)).not.toBeNull();
    expect(screen.queryByText(/Requesting your location/)).toBeNull();

    // The device result arrives after cancellation — must be dropped.
    fireGeoSuccess(40.7, -74.0);
    expect(markerPosition()).not.toBe("40.7,-74.0");
    expect(onSave).not.toHaveBeenCalled();
  });
});

describe("LocationMapPicker — race regressions: deferred save × device lookup", () => {
  function deferredSave() {
    let release!: (v: void) => void;
    let reject!: (e: unknown) => void;
    const onSave = vi.fn(
      () =>
        new Promise<void>((resolve, rejectPromise) => {
          release = resolve;
          reject = rejectPromise;
        }),
    );
    return {
      onSave,
      resolve: () => release(),
      reject: () => reject(new Error("settings write failed")),
    };
  }

  it("pending selection → in-flight device lookup → deferred Save: late geo success and error are dropped while the save is unresolved", async () => {
    const user = userEvent.setup();
    const save = deferredSave();
    render(<LocationMapPicker latitude={55.605} longitude={13.0} onSave={save.onSave} />);

    // 1. Pending selection (map click).
    fireMapClick(55.4, 12.9);
    expect(markerPosition()).toBe("55.4,12.9");

    // 2. Device lookup starts AFTER the selection — valid while not saving.
    await user.click(screen.getByRole("button", { name: "Use my location" }));
    expect(geoSuccess).not.toBeNull();

    // 3. Deferred Save starts — this invalidates the in-flight lookup.
    await user.click(screen.getByRole("button", { name: "Save position" }));
    expect(screen.getByRole("button", { name: "Saving…" })).not.toBeNull();
    expect(save.onSave).toHaveBeenCalledTimes(1);
    expect(save.onSave).toHaveBeenCalledWith(55.4, 12.9);

    // 4. Late geolocation outcomes arrive while the save is unresolved —
    //    both must be dropped: the saved selection stays (55.4, 12.9).
    fireGeoSuccess(40.7, -74.0);
    expect(markerPosition()).toBe("55.4,12.9");

    fireGeoDenied();
    expect(screen.queryByText(/Location permission was denied/)).toBeNull();
    expect(screen.getByRole("button", { name: "Saving…" })).not.toBeNull();

    // 5. The save resolves: exactly one write with the saved coordinates.
    await act(async () => {
      save.resolve();
    });
    await waitFor(() =>
      expect(screen.getByText(/Location saved: 55\.40000, 12\.90000/)).not.toBeNull(),
    );
    expect(save.onSave).toHaveBeenCalledTimes(1);
  });

  it("deferred Save rejection after an attempted newer map click retains the original pending, shows failure, and re-enables retry", async () => {
    const user = userEvent.setup();
    const save = deferredSave();
    render(<LocationMapPicker latitude={55.605} longitude={13.0} onSave={save.onSave} />);

    fireMapClick(55.4, 12.9);
    await user.click(screen.getByRole("button", { name: "Save position" }));
    expect(screen.getByRole("button", { name: "Saving…" })).not.toBeNull();

    // Attempted newer selection while saving — refused by design.
    fireMapClick(57.5, 11.9);
    expect(markerPosition()).toBe("55.4,12.9");

    // The deferred save REJECTS.
    await act(async () => {
      save.reject();
    });

    // Failure surfaced; the ORIGINAL pending (55.4, 12.9) is retained — the
    // refused 57.5 click never became pending.
    expect(
      screen.getByText(/Saving failed — your previously saved location is unchanged/),
    ).not.toBeNull();
    expect(screen.queryByText(/Location saved/)).toBeNull();
    expect(markerPosition()).toBe("55.4,12.9");
    expect(screen.getByRole("button", { name: "Save position" })).toBeEnabled();

    // Retry after recovery persists the retained selection.
    save.onSave.mockResolvedValueOnce(undefined);
    await user.click(screen.getByRole("button", { name: "Save position" }));
    await waitFor(() =>
      expect(screen.getByText(/Location saved: 55\.40000, 12\.90000/)).not.toBeNull(),
    );
    expect(save.onSave).toHaveBeenCalledTimes(2);
    expect(save.onSave.mock.calls[1]).toEqual([55.4, 12.9]);
  });
});

describe("LocationMapPicker — tile banner lifecycle (R2 review)", () => {
  function renderWithFailure() {
    render(
      <LocationMapPicker
        latitude={55.605}
        longitude={13.0}
        onSave={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    act(() => {
      __fireTileError(new Error("network unreachable"));
    });
    expect(screen.getByText(TILE_ERROR_MESSAGE)).not.toBeNull();
  }

  it("a map click does NOT dismiss the tile-failure banner (a click cannot restore tiles)", () => {
    renderWithFailure();

    fireMapClick(56.9, 12.1);
    expect(screen.getByText(TILE_ERROR_MESSAGE)).not.toBeNull();
  });

  it('unrelated successes, map clicks and geo results do not clear the latched failure warning', async () => {
    const user = userEvent.setup();
    installGeolocation();
    renderWithFailure();

    // A successful load of an unrelated tile must not claim recovery...
    act(() => {
      __fireTileLoad();
    });
    expect(screen.getByText(TILE_ERROR_MESSAGE)).not.toBeNull();

    // ...nor may a newer manual selection...
    fireMapClick(56.9, 12.1);
    expect(screen.getByText(TILE_ERROR_MESSAGE)).not.toBeNull();

    // ...nor a geolocation result. A real in-flight lookup exists only after
    // "Use my location", so start one and deliver its result: the newer
    // valid selection is adopted, and the warning stays latched.
    await user.click(screen.getByRole('button', { name: 'Use my location' }));
    fireGeoSuccess(56.95, 12.15);
    expect(markerPosition()).toBe('56.95,12.15');
    expect(screen.getByText(TILE_ERROR_MESSAGE)).not.toBeNull();
  });

});
