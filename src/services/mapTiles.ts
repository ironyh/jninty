/**
 * Tile-source adapter for the garden location map.
 *
 * Primary-source verification (OpenStreetMap Foundation tile usage policy,
 * https://operations.osmfoundation.org/policies/tiles/, retrieved 2026-09-22):
 *  - ATTRIBUTION: visible "© OpenStreetMap contributors" on the map (bottom
 *    right), not hidden behind UI. Rendered by react-leaflet's attribution
 *    control via OSM_ATTRIBUTION below.
 *  - PERMITTED USE: normal interactive human viewing that fetches only the
 *    tiles needed for the current viewport (plus modest browser look-ahead
 *    and re-visits served from the browser's local cache honouring the
 *    server's caching headers). This is exactly what the picker does. Bulk
 *    downloading, tile archives, pre-seeding, automated scans, headless
 *    fetches and offline pack features are prohibited — none are implemented
 *    here, and this adapter exposes no way to do them.
 *  - CACHING: honour the server's Cache-Control/Expires/Etag headers (the
 *    browser does this automatically for <img>-style tile loads).
 *  - IDENTIFICATION: web pages must send a valid HTTP Referer (browsers do
 *    this by default for same-page tile requests). The app must NOT set a
 *    restrictive Referrer-Policy that strips Referer for tile.openstreetmap.org.
 *  - NO GUARANTEE: there is no SLA — availability is best-effort and access
 *    can be blocked without notice. Do NOT claim a blanket guaranteed service
 *    permission; if the map must be guaranteed, self-hosting or a commercial
 *    provider would be required (out of scope for this slice).
 *
 * HTTPS-only endpoint, no API key, no paid service. No geocoding.
 */

export const OSM_TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";

/** Required by the OSM tile usage policy — must stay visible on the map. */
export const OSM_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

export const OSM_MAX_ZOOM = 19;

/** Small default view so the map is never at zoom 0 before a position exists. */
export const DEFAULT_CENTER: [number, number] = [55.605, 13.0]; // Skåne, SE
export const DEFAULT_ZOOM = 12;

/**
 * Human-readable status for tile/network failures (never destroys data).
 * LATCHED: once a tile failure occurs, the warning stays for the component's
 * lifetime — individual later successes do not prove the whole grid restored
 * — and reloading the page (which re-mounts everything) is the retry.
 */
export const TILE_ERROR_MESSAGE =
  "Some map tiles failed to load. Reload to retry. Saved location is unaffected.";

/**
 * Finite, in-range coordinate validation. Both values must be finite numbers
 * inside WGS-84 lat/lon bounds. Guards user selections, geolocation results,
 * and stored settings before anything is saved or rendered.
 */
export function isValidCoordinate(
  latitude: unknown,
  longitude: unknown,
): boolean {
  if (typeof latitude !== "number" || typeof longitude !== "number") {
    return false;
  }
  const lat = latitude;
  const lon = longitude;
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= -90 &&
    lat <= 90 &&
    lon >= -180 &&
    lon <= 180
  );
}
