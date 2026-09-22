import { useEffect, useRef, useState } from "react";
import { MapContainer, TileLayer, Marker, useMap, useMapEvents } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import {
  OSM_TILE_URL,
  OSM_ATTRIBUTION,
  OSM_MAX_ZOOM,
  DEFAULT_CENTER,
  DEFAULT_ZOOM,
  TILE_ERROR_MESSAGE,
  isValidCoordinate,
} from "../../services/mapTiles.ts";

/**
 * Garden location picker — a bounded geographic map.
 *
 * Shows a tile background and a marker at the garden's existing coordinates
 * (read-only on open: nothing is written by rendering). A click selects a
 * PENDING position; only the explicit Save button writes (via the onSave
 * callback the host wires to the existing settings latitude/longitude).
 * Cancel discards the pending selection — the previously saved value persists
 * because nothing was written until Save. "Use my location" triggers
 * geolocation ONLY when clicked; manual clicking never needs permission.
 *
 * Race safety: every selection source (map click, geolocation request,
 * cancel, save) bumps a sequence counter, and stale callbacks return early —
 * a late geolocation result can never overwrite a cancelled or newer
 * selection. While a save is in flight, new selections and geolocation
 * requests are refused and the in-flight request is invalidated; the success
 * handler only clears the exact selection that was saved (versioning).
 *
 * View sync: the map pans to the TARGET position (pending ?? saved) whenever
 * that target changes — never on ordinary panning, which is untouched.
 *
 * Tile/network failures surface an understandable banner and leave saved
 * coordinates (and the drawing plan at /map) untouched.
 */

export interface LocationMapPickerProps {
  /** Existing saved latitude (optional — the garden may have none yet). */
  latitude?: number | undefined;
  /** Existing saved longitude (optional). */
  longitude?: number | undefined;
  /**
   * Persist the chosen position. The host owns the write (settings
   * latitude/longitude). Rejecting keeps the pending selection so the user
   * can retry; nothing is discarded and no success status is shown.
   */
  onSave: (latitude: number, longitude: number) => Promise<void>;
  /** Invoked when the user discards a pending selection (no write happens). */
  onCancel?: () => void;
}

interface Pending {
  lat: number;
  lon: number;
}

type Status = { kind: "info" | "error" | "success"; text: string } | null;

/** Self-contained visible marker (inline styles — no external CSS needed). */
const MARKER_ICON = L.divIcon({
  className: "location-map-marker",
  html: '<div aria-hidden="true" style="width:18px;height:18px;border-radius:50%;background:#2D5016;border:3px solid #ffffff;box-shadow:0 1px 4px rgba(0,0,0,0.4)"></div>',
  iconSize: [18, 18],
  iconAnchor: [9, 9],
});

function ClickHandler({ onPick }: { onPick: (lat: number, lon: number) => void }) {
  useMapEvents({
    click(event) {
      onPick(event.latlng.lat, event.latlng.lng);
    },
  });
  return null;
}

/** Pan the view to the target position whenever that target CHANGES. */
function ViewSync({ position }: { position: [number, number] | null }) {
  const map = useMap();
  const lastRef = useRef<string | null>(null);
  useEffect(() => {
    if (!position) return;
    const key = position.join(",");
    if (lastRef.current === key) return;
    lastRef.current = key;
    map.panTo(position);
  }, [map, position]);
  return null;
}

export default function LocationMapPicker({
  latitude,
  longitude,
  onSave,
  onCancel,
}: LocationMapPickerProps) {
  const existingValid = isValidCoordinate(latitude, longitude);
  const [pending, setPending] = useState<Pending | null>(null);
  const [saving, setSaving] = useState(false);
  const [locating, setLocating] = useState(false);
  const [tileError, setTileError] = useState(false);
  // Latched: once a tile failure occurs the warning stays until the
  // component remounts (reload = the retry).
  const [status, setStatus] = useState<Status>(null);
  const requestSeq = useRef(0);
  const savingRef = useRef(false);
  const pendingRef = useRef<Pending | null>(null);
  pendingRef.current = pending;
  const mountedRef = useRef(true);
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const busy = () => savingRef.current;

  // Any newer selection invalidates an in-flight geolocation request.
  function selectManually(lat: number, lon: number) {
    if (busy()) return; // no new selections while a save is in flight
    if (!isValidCoordinate(lat, lon)) {
      setStatus({
        kind: "error",
        text: "That position is outside valid coordinates. Nothing was changed.",
      });
      return;
    }
    requestSeq.current += 1; // invalidates any in-flight geolocation callback
    setLocating(false);
    setPending({ lat, lon });
    setStatus({
      kind: "info",
      text: "Position selected. Save to update the garden location, or cancel.",
    });
  }

  function handleUseMyLocation() {
    if (busy() || locating) return;
    if (!("geolocation" in navigator)) {
      setStatus({
        kind: "error",
        text: "Geolocation is not available in this browser. Click the map to choose the position manually.",
      });
      return;
    }
    const seq = ++requestSeq.current;
    setLocating(true);
    setStatus({ kind: "info", text: "Requesting your location…" });
    navigator.geolocation.getCurrentPosition(
      (position) => {
        // A newer selection, a cancellation, or an unmount invalidates this.
        if (!mountedRef.current || seq !== requestSeq.current) return;
        setLocating(false);
        const coords = position.coords ?? {};
        if (!isValidCoordinate(coords.latitude, coords.longitude)) {
          setStatus({
            kind: "error",
            text: "The device returned an invalid position. Nothing was changed.",
          });
          return;
        }
        setPending({ lat: coords.latitude, lon: coords.longitude });
        setStatus({
          kind: "info",
          text: "Device location selected. Save to update the garden location, or cancel.",
        });
      },
      (err) => {
        if (!mountedRef.current || seq !== requestSeq.current) return;
        setLocating(false);
        setStatus({
          kind: "error",
          text:
            err.code === err.PERMISSION_DENIED
              ? "Location permission was denied. Click the map to choose the position manually — no permission needed."
              : "The device location could not be determined. Click the map to choose the position manually.",
        });
      },
    );
  }

  function handleCancelLookup() {
    // Cancels ONLY the in-flight device lookup — a selection made meanwhile
    // is newer and stays.
    requestSeq.current += 1;
    setLocating(false);
    setStatus({
      kind: "info",
      text: "Location request cancelled. Click the map to choose the position manually.",
    });
  }

  async function handleSave() {
    const saved = pending;
    if (!saved || savingRef.current) return;
    if (!isValidCoordinate(saved.lat, saved.lon)) {
      setStatus({
        kind: "error",
        text: "The selected position is outside valid coordinates. Choose another position.",
      });
      return;
    }
    requestSeq.current += 1; // invalidate in-flight geolocation at save start
    setLocating(false);
    savingRef.current = true;
    setSaving(true);
    setStatus({ kind: "info", text: "Saving…" });
    try {
      await onSaveRef.current(saved.lat, saved.lon);
      if (!mountedRef.current) return;
      // Versioning: only clear the pending selection that was actually saved.
      if (pendingRef.current === saved) {
        setStatus({
          kind: "success",
          text: `Location saved: ${saved.lat.toFixed(5)}, ${saved.lon.toFixed(5)}`,
        });
        setPending(null);
      }
    } catch {
      if (!mountedRef.current) return;
      // Rejection: keep the pending selection, show no success status.
      setStatus({
        kind: "error",
        text: "Saving failed — your previously saved location is unchanged. The selected position is kept; try again.",
      });
    } finally {
      if (mountedRef.current) {
        savingRef.current = false;
        setSaving(false);
      }
    }
  }

  function handleCancelSelection() {
    if (savingRef.current) return;
    requestSeq.current += 1;
    setLocating(false);
    setPending(null);
    setStatus({
      kind: "info",
      text: "Selection discarded. The saved location is unchanged.",
    });
    onCancelRef.current?.();
  }

  const target: [number, number] | null = pending
    ? [pending.lat, pending.lon]
    : existingValid
      ? [latitude as number, longitude as number]
      : null;

  return (
    <div className="rounded-lg border border-border-default p-3">
      <p className="text-xs text-text-muted">
        Click the map to mark the garden position. The drawing plan on the Map
        page stays a separate feature.
      </p>
      <div className="mt-2 overflow-hidden rounded-lg">
        <MapContainer
          center={target ?? DEFAULT_CENTER}
          zoom={DEFAULT_ZOOM}
          maxZoom={OSM_MAX_ZOOM}
          style={{ height: 280, width: "100%" }}
          scrollWheelZoom={false}
        >
          <TileLayer
            url={OSM_TILE_URL}
            attribution={OSM_ATTRIBUTION}
            maxZoom={OSM_MAX_ZOOM}
            eventHandlers={{
              // Latched: one successful tile does not prove the rest of the
              // grid restored, so the warning persists until the component
              // remounts (reload = the retry).
              tileerror: () => setTileError(true),
            }}
          />
          {target && <Marker position={target} icon={MARKER_ICON} />}
          <ClickHandler onPick={selectManually} />
          <ViewSync position={target} />
        </MapContainer>
      </div>

      {tileError && (
        <p role="alert" className="mt-2 text-sm text-red-600">
          {TILE_ERROR_MESSAGE}
        </p>
      )}
      {status && (
        <p
          role="status"
          aria-live="polite"
          className={
            status.kind === "error"
              ? "mt-2 text-sm text-red-600"
              : status.kind === "success"
                ? "mt-2 text-sm text-green-700"
                : "mt-2 text-sm text-text-secondary"
          }
        >
          {status.text}
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={handleUseMyLocation}
          disabled={saving || locating}
          className="rounded-lg border border-border-strong bg-surface px-3 py-1.5 text-sm font-medium text-text-primary transition-colors hover:bg-surface-muted disabled:opacity-50"
        >
          Use my location
        </button>
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={!pending || saving}
          className="rounded-lg bg-primary px-3 py-1.5 text-sm font-semibold text-text-on-primary transition-colors hover:bg-primary-hover disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save position"}
        </button>
        {locating ? (
          <button
            type="button"
            onClick={handleCancelLookup}
            className="rounded-lg px-3 py-1.5 text-sm text-text-secondary transition-colors hover:bg-surface-muted"
          >
            Cancel lookup
          </button>
        ) : (
          pending && (
            <button
              type="button"
              onClick={handleCancelSelection}
              disabled={saving}
              className="rounded-lg px-3 py-1.5 text-sm text-text-secondary transition-colors hover:bg-surface-muted"
            >
              Cancel selection
            </button>
          )
        )}
      </div>
      <p className="mt-2 text-xs text-text-muted">
        Map data © OpenStreetMap contributors —{" "}
        <a
          href="https://www.openstreetmap.org/copyright"
          target="_blank"
          rel="noreferrer"
          className="underline"
        >
          copyright terms
        </a>
        .
      </p>
    </div>
  );
}
