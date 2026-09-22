import { describe, it, expect } from "vitest";
import {
  OSM_TILE_URL,
  OSM_ATTRIBUTION,
  OSM_MAX_ZOOM,
  TILE_ERROR_MESSAGE,
  DEFAULT_CENTER,
  DEFAULT_ZOOM,
  isValidCoordinate,
} from "./mapTiles.ts";

describe("mapTiles adapter (tile terms compliance)", () => {
  it("targets the public OSM tile endpoint with the standard {z}/{x}/{y} template", () => {
    expect(OSM_TILE_URL).toBe("https://tile.openstreetmap.org/{z}/{x}/{y}.png");
  });

  it("carries the mandatory OpenStreetMap attribution with a copyright link", () => {
    expect(OSM_ATTRIBUTION).toContain("OpenStreetMap");
    expect(OSM_ATTRIBUTION).toContain("https://www.openstreetmap.org/copyright");
  });

  it("uses no API key material anywhere in the configuration", () => {
    const all = JSON.stringify({
      OSM_TILE_URL,
      OSM_ATTRIBUTION,
      OSM_MAX_ZOOM,
      DEFAULT_CENTER,
      DEFAULT_ZOOM,
    });
    expect(all.toLowerCase()).not.toContain("key");
    expect(all.toLowerCase()).not.toContain("token");
    expect(all).not.toMatch(/api\.|access_token/i);
  });

  it("keeps zoom bounds sane for an interactive single view (no bulk fetch config)", () => {
    expect(OSM_MAX_ZOOM).toBeLessThanOrEqual(19);
    expect(DEFAULT_ZOOM).toBeLessThanOrEqual(OSM_MAX_ZOOM);
    const [lat, lon] = DEFAULT_CENTER;
    expect(lat).toBeGreaterThanOrEqual(-90);
    expect(lat).toBeLessThanOrEqual(90);
    expect(lon).toBeGreaterThanOrEqual(-180);
    expect(lon).toBeLessThanOrEqual(180);
  });

  it("network failure status is understandable and explicitly non-destructive", () => {
    expect(TILE_ERROR_MESSAGE).toContain("failed to load");
    expect(TILE_ERROR_MESSAGE).toContain("Reload to retry");
    expect(TILE_ERROR_MESSAGE).toContain("unaffected");
  });

  it("documents caching, identification and no-SLA requirements honestly", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const source = fs.readFileSync(
      path.resolve(process.cwd(), "src/services/mapTiles.ts"),
      "utf8",
    );
    expect(source).toContain("operations.osmfoundation.org/policies/tiles/");
    expect(source).toContain("Cache-Control");
    expect(source).toContain("Referer");
    expect(source).toContain("no SLA");
    // The adapter must NOT claim a blanket guaranteed service permission.
    expect(source.toLowerCase()).not.toContain(
      "guaranteed service permission",
    );
  });
});

describe("isValidCoordinate", () => {
  it("accepts finite in-range coordinates", () => {
    expect(isValidCoordinate(55.605, 13.0)).toBe(true);
    expect(isValidCoordinate(-90, -180)).toBe(true);
    expect(isValidCoordinate(90, 180)).toBe(true);
  });

  it("rejects non-finite and out-of-range values", () => {
    expect(isValidCoordinate(Number.NaN, 0)).toBe(false);
    expect(isValidCoordinate(Number.POSITIVE_INFINITY, 0)).toBe(false);
    expect(isValidCoordinate("55", "13")).toBe(false); // strings are not coordinates
    expect(isValidCoordinate(null, 0)).toBe(false);
    expect(isValidCoordinate(90.0001, 0)).toBe(false);
    expect(isValidCoordinate(0, -180.0001)).toBe(false);
  });
});
