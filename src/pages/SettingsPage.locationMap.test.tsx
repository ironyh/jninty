
/**
 * SettingsPage integration coverage for the garden location map picker.
 *
 * REAL SettingsPage + REAL settingsRepository (fake-indexeddb). Only the map
 * engine (react-leaflet) is mocked (deterministic click/tile-error registry)
 * and the weather service is mocked to observe clearWeatherCache ordering.
 *
 * Codex R1 requirements covered here (not adapter-constant tests):
 *  - saved coordinate SYNCHRONIZATION through the real page + repository;
 *  - clearWeatherCache BEFORE updateSettings, rejection propagates (no write,
 *    no success status, pending kept, retry works);
 *  - CANCELLATION leaves stored coordinates untouched;
 *  - existing coordinates displayed on open without any write.
 */
import "fake-indexeddb/auto";

vi.setConfig({ testTimeout: 20_000 });
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, act, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { clearPouchDB } from "../db/pouchdb/testUtils.ts";
import { settingsRepository as settingsRepo } from "../db/index.ts";
import { SettingsProvider } from "../hooks/useSettings.tsx";
import { SyncProvider } from "../hooks/useSync.tsx";
import { ToastProvider } from "../components/ui/Toast.tsx";
import SettingsPage from "./SettingsPage.tsx";

vi.mock("react-leaflet", async () => {
  return await import("../components/map/__mocks__/reactLeafletMock.tsx");
});

const clearWeatherCacheMock = vi.fn<() => Promise<void>>();
vi.mock("../services/weather.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/weather.ts")>();
  return {
    ...actual,
    clearWeatherCache: () => clearWeatherCacheMock(),
    searchLocation: vi.fn().mockResolvedValue([]),
  };
});

vi.mock("../services/exporter.ts", () => ({
  exportAll: vi.fn().mockResolvedValue(new Blob(["zip"])),
  triggerDownload: vi.fn(),
}));
vi.mock("../db/search.ts", () => ({
  rebuildIndex: vi.fn().mockResolvedValue(5),
}));
vi.mock("../services/storageUsage.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/storageUsage.ts")>();
  return {
    ...actual,
    getStorageUsage: vi.fn().mockResolvedValue({
      thumbnailBytes: 512,
      displayBytes: 1024,
      originalBytes: 0,
      dataBytes: 2048,
      totalBytes: 3584,
      quotaBytes: 100_000_000,
    }),
  };
});

import { __fireMapClick } from "../components/map/__mocks__/reactLeafletMock.tsx";


beforeEach(async () => {
  await clearPouchDB();
  vi.clearAllMocks();
  clearWeatherCacheMock.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
});

function renderSettings() {
  return render(
    <SettingsProvider>
      <SyncProvider>
        <ToastProvider>
          <SettingsPage />
        </ToastProvider>
      </SyncProvider>
    </SettingsProvider>,
  );
}

function fireMapClick(lat: number, lon: number) {
  act(() => {
    __fireMapClick(lat, lon);
  });
}

async function readStoredSettings() {
  return settingsRepo.get();
}

async function waitForPageReady() {
  // The Location card (and its Save button) renders once settings load.
  await screen.findByRole("button", { name: "Save position" }, { timeout: 10_000 });
}

describe("SettingsPage location map integration", () => {
  afterEach(() => {
    cleanup();
  });

  it("a map selection saved through the picker synchronizes the stored settings and the coordinates display", async () => {
    const user = userEvent.setup();
    renderSettings();
    await waitForPageReady();

    expect(screen.queryByText(/Current coordinates/)).toBeNull();

    fireMapClick(55.585, 13.002);
    // The pending selection must be committed before Save: wait for the
    // picker's own confirmation status, then verify the button is enabled.
    await screen.findByText(
      /Position selected\. Save to update the garden location/,
      undefined,
      { timeout: 10_000 },
    );
    expect(screen.getByRole("button", { name: "Save position" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Save position" }));

    await waitFor(
      () => {
        expect(
          screen.getByText(/Location saved: 55\.58500, 13\.00200/),
        ).not.toBeNull();
      },
      { timeout: 10_000 },
    );
    const stored = await readStoredSettings();
    expect(stored?.latitude).toBeCloseTo(55.585, 5);
    expect(stored?.longitude).toBeCloseTo(13.002, 5);
    expect(clearWeatherCacheMock).toHaveBeenCalled();
    expect(screen.getByText(/55\.5850, 13\.0020/)).not.toBeNull();
  });

  it("cancel discards a pending map selection — stored coordinates and display unchanged", async () => {
    await settingsRepo.initialize({
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
      latitude: 55.605,
      longitude: 13.0,
    });
    const user = userEvent.setup();
    renderSettings();
    await waitForPageReady();
    await screen.findByText(/55\.6050, 13\.0000/);

    fireMapClick(56.9, 12.1);
    await user.click(screen.getByRole("button", { name: "Cancel selection" }));

    expect(screen.getByText(/Selection discarded/)).not.toBeNull();
    const storedAfter = await readStoredSettings();
    expect(storedAfter?.latitude).toBe(55.605);
    expect(storedAfter?.longitude).toBe(13.0);
    expect(clearWeatherCacheMock).not.toHaveBeenCalled();
  });

  it("a weather-cache failure propagates: no settings write, no success status, pending selection kept — retry persists", async () => {
    // Seed BEFORE render: the provider reads settings once at mount, so a
    // mid-test repository write would never refresh the page state.
    await settingsRepo.initialize({
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
      latitude: 55.605,
      longitude: 13.0,
    });
    clearWeatherCacheMock.mockRejectedValue(new Error("cache clear failed"));
    const user = userEvent.setup();
    renderSettings();
    await waitForPageReady();
    await screen.findByText(/55\.6050, 13\.0000/);

    fireMapClick(56.4, 12.7);
    await user.click(screen.getByRole("button", { name: "Save position" }));

    expect(
      screen.getByText(/Saving failed — your previously saved location is unchanged/),
    ).not.toBeNull();
    expect(screen.queryByText(/Location saved/)).toBeNull();
    const stored = await readStoredSettings();
    expect(stored?.latitude).toBe(55.605);
    expect(stored?.longitude).toBe(13.0);
    expect(screen.getByRole("button", { name: "Save position" })).toBeEnabled();

    clearWeatherCacheMock.mockResolvedValue(undefined);
    await user.click(screen.getByRole("button", { name: "Save position" }));
    await waitFor(
      () =>
        expect(
          screen.getByText(/Location saved: 56\.40000, 12\.70000/),
        ).not.toBeNull(),
      { timeout: 10_000 },
    );
    const recovered = await readStoredSettings();
    expect(recovered?.latitude).toBeCloseTo(56.4, 5);
    expect(recovered?.longitude).toBeCloseTo(12.7, 5);
  });

  it("existing coordinates are displayed on open without any write", async () => {
    await settingsRepo.initialize({
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
      latitude: -33.9,
      longitude: 151.2,
    });
    renderSettings();
    await waitForPageReady();
    await screen.findByText(/-33\.9000, 151\.2000/);
    const stored = await readStoredSettings();
    expect(stored?.latitude).toBe(-33.9);
    expect(stored?.longitude).toBe(151.2);
    expect(clearWeatherCacheMock).not.toHaveBeenCalled();
  });
});
