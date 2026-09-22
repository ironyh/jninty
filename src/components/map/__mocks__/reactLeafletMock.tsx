/* eslint-disable react-refresh/only-export-components -- test-only mock: mixes components with its test-event registry */
/**
 * Deterministic jsdom mock of the react-leaflet surface used by
 * LocationMapPicker. Renders plain divs carrying the real props as data
 * attributes and exposes a registry so tests can drive map events (clicks,
 * tile errors), read marker positions/icon markup, and observe view sync
 * (panTo) without a real map engine.
 *
 * Imported ONLY from test files via vi.mock("react-leaflet", ...).
 */
import { useEffect } from "react";
import type { ReactNode } from "react";
import { vi } from "vitest";

export const __registry: {
  clickHandlers: Set<(event: {
    latlng: { lat: number; lng: number };
  }) => void>;
  tileErrorHandler: ((error: unknown) => void) | null;
  tileLoadHandler: (() => void) | null;
  map: { panTo: ReturnType<typeof vi.fn>; getZoom: () => number } | null;
  lastIconHtml: string;
} = {
  clickHandlers: new Set(),
  tileErrorHandler: null,
  tileLoadHandler: null,
  map: null,
  lastIconHtml: "",
};

/** Simulate a user click on the map surface. */
export function __fireMapClick(lat: number, lon: number): void {
  const event = { latlng: { lat, lng: lon } };
  for (const handler of [...__registry.clickHandlers]) handler(event);
}

/** Simulate a tile load failure. */
export function __fireTileError(error: unknown): void {
  __registry.tileErrorHandler?.(error);
}

/** Simulate a tile load success. */
export function __fireTileLoad(): void {
  __registry.tileLoadHandler?.();
}

export function MapContainer({
  children,
  center,
  zoom,
}: {
  children?: ReactNode;
  center?: [number, number];
  zoom?: number;
}) {
  return (
    <div
      data-testid="mock-map"
      data-center={center ? center.join(",") : ""}
      data-zoom={zoom != null ? String(zoom) : ""}
    >
      {children}
    </div>
  );
}

export function TileLayer({
  attribution,
  eventHandlers,
}: {
  attribution?: string;
  eventHandlers?: {
    tileerror?: (error: unknown) => void;
    tileload?: () => void;
  };
}) {
  useEffect(() => {
    __registry.tileErrorHandler = eventHandlers?.tileerror ?? null;
    __registry.tileLoadHandler = eventHandlers?.tileload ?? null;
    return () => {
      __registry.tileErrorHandler = null;
      __registry.tileLoadHandler = null;
    };
  });
  return <div data-testid="mock-tilelayer" data-attribution={attribution ?? ""} />;
}

export function Marker({
  position,
  icon,
}: {
  position?: [number, number] | null;
  icon?: { options?: { html?: string } };
}) {
  useEffect(() => {
    __registry.lastIconHtml = icon?.options?.html ?? "";
  });
  return (
    <div
      data-testid="mock-marker"
      data-position={position ? `${position[0]},${position[1]}` : "none"}
      data-icon-html={icon?.options?.html ?? ""}
    />
  );
}

export function useMap() {
  if (!__registry.map) {
    __registry.map = {
      panTo: vi.fn(),
      getZoom: () => 12,
    };
  }
  return __registry.map;
}

export function useMapEvents(handlers: {
  click?: (event: { latlng: { lat: number; lng: number } }) => void;
}) {
  const click = handlers.click;
  useEffect(() => {
    if (!click) return;
    __registry.clickHandlers.add(click);
    return () => {
      __registry.clickHandlers.delete(click);
    };
  });
  return {};
}
