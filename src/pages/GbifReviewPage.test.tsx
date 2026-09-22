import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import GbifReviewPage from "./GbifReviewPage.tsx";
import { builtInEntryId } from "../services/knowledgeBase.ts";
import { clearGbifSessionCache } from "../services/gbifReview.ts";

import lactucaSativa from "../services/__fixtures__/gbif/lactuca-sativa.json";
import dahliaSpp from "../services/__fixtures__/gbif/dahlia-spp.json";
import botrytis from "../services/__fixtures__/gbif/brassica-oleracea-var-botrytis.json";

// Saved raw GBIF v2 response bodies (captured 2026-09-20) replayed offline.
function okResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as unknown as Response;
}

function selectPlant(label: string) {
  const select = screen.getByRole("combobox", { name: /catalog plant/i });
  fireEvent.change(select, { target: { value: label } });
}

beforeEach(() => {
  clearGbifSessionCache();
  vi.unstubAllGlobals();
});

describe("GbifReviewPage", () => {
  it("labels the screen as an experimental read-only prototype", () => {
    render(<GbifReviewPage />);
    expect(screen.getByTestId("gbif-experimental-banner")).toHaveTextContent(
      /experimental/i,
    );
    expect(screen.getByTestId("gbif-review-root")).toHaveTextContent(
      /never saves, overwrites, or normalizes/i,
    );
  });

  it("shows the stored catalog name and family beside the candidate area", async () => {
    const user = userEvent.setup();
    render(<GbifReviewPage />);
    selectPlant(builtInEntryId("Lactuca sativa"));
    expect(screen.getByTestId("gbif-stored-name")).toHaveTextContent(
      "Lettuce — Lactuca sativa",
    );
    expect(screen.getByTestId("gbif-stored-family")).toHaveTextContent(
      "Asteraceae",
    );

    const fetchMock = vi.fn(async () => okResponse(lactucaSativa));
    vi.stubGlobal("fetch", fetchMock);
    await user.click(screen.getByTestId("gbif-fetch-btn"));

    // Candidate is displayed beside the stored values, clearly labelled as
    // GBIF's score rather than a certainty.
    expect(await screen.findByTestId("gbif-candidate-name")).toHaveTextContent(
      "Lactuca sativa",
    );
    expect(screen.getByTestId("gbif-score")).toHaveTextContent(/GBIF's score: 99/);
    expect(screen.getByTestId("gbif-score")).toHaveTextContent(/not a certainty/i);
    expect(screen.getByTestId("gbif-source-link")).toHaveAttribute(
      "href",
      "https://www.gbif.org/species/7403263",
    );
    expect(screen.getByTestId("gbif-retrieved-at")).toHaveTextContent(/retrieved/);
    expect(screen.getByTestId("gbif-stored-name")).toHaveTextContent(
      "Lettuce — Lactuca sativa",
    );
    expect(screen.getByText(/Exact match, currently accepted/)).toBeTruthy();
  });

  it("shows a plain no-match outcome for the captured Dahlia spp. response", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async () => okResponse(dahliaSpp));
    vi.stubGlobal("fetch", fetchMock);
    render(<GbifReviewPage />);
    selectPlant(builtInEntryId("Dahlia spp."));
    await user.click(screen.getByTestId("gbif-fetch-btn"));

    expect(await screen.findByTestId("gbif-no-match")).toHaveTextContent(
      /No candidate returned/i,
    );
    const findings = screen.getAllByTestId("gbif-finding-review");
    expect(
      findings.some((el) => el.textContent?.includes("Multiple equal matches for Dahlia")),
    ).toBe(true);
    expect(screen.queryByTestId("gbif-source-link")).toBeNull();
    // The stored panel is untouched.
    expect(screen.getByTestId("gbif-stored-name")).toHaveTextContent("Dahlia");

    // R1-4: a NONE response still carries retrieval/query provenance — the
    // timestamp, the exact queried name and the reproducible API request —
    // but no species record link is fabricated for a nonexistent usage.
    expect(screen.getByTestId("gbif-retrieved-at")).toHaveTextContent(/retrieved/);
    expect(screen.getByTestId("gbif-provenance")).toHaveTextContent(
      /queried “Dahlia spp\.”/,
    );
    expect(screen.getByTestId("gbif-api-request-link")).toHaveAttribute(
      "href",
      "https://api.gbif.org/v2/species/match?scientificName=Dahlia%20spp.&kingdom=Plantae",
    );
    // D1: completion is announced politely even for the no-candidate case.
    expect(screen.getByTestId("gbif-announce-done")).toHaveTextContent(
      /No candidate returned\./,
    );
  });

  it("offers an explicit retry after a network failure", async () => {
    const user = userEvent.setup();
    const failing = vi.fn(async () => {
      throw new TypeError("network down");
    });
    vi.stubGlobal("fetch", failing);
    render(<GbifReviewPage />);
    selectPlant(builtInEntryId("Lactuca sativa"));
    await user.click(screen.getByTestId("gbif-fetch-btn"));

    expect(await screen.findByTestId("gbif-error")).toHaveTextContent(
      /could not reach gbif\.org/i,
    );
    // D1: the error outcome is announced assertively to assistive tech.
    const announcement = screen.getByTestId("gbif-announce-error");
    expect(announcement).toHaveAttribute("role", "alert");
    expect(screen.queryByTestId("gbif-result")).toBeNull();

    vi.stubGlobal("fetch", vi.fn(async () => okResponse(lactucaSativa)));
    await user.click(screen.getByTestId("gbif-retry-btn"));
    expect(await screen.findByTestId("gbif-candidate-name")).toHaveTextContent(
      "Lactuca sativa",
    );
  });

  it("aborts the in-flight request and discards the stale response when the selection changes while pending", async () => {
    render(<GbifReviewPage />);
    selectPlant(builtInEntryId("Lactuca sativa"));

    let resolveFetch!: (r: Response) => void;
    let capturedSignal: AbortSignal | undefined;
    let bodyReadCompleted = false;
    const slowFetch = vi.fn(
      (_url: string, init?: { signal?: AbortSignal }) => {
        capturedSignal = init?.signal;
        return new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        });
      },
    );
    vi.stubGlobal("fetch", slowFetch);
    fireEvent.click(screen.getByTestId("gbif-fetch-btn"));
    expect(await screen.findByTestId("gbif-loading")).toBeTruthy();

    // User switches to Dahlia while the Lettuce request is still pending.
    selectPlant(builtInEntryId("Dahlia spp."));
    expect(screen.queryByTestId("gbif-loading")).toBeNull();
    // The pending request is aborted, not left running.
    expect(capturedSignal?.aborted).toBe(true);

    // Let the deferred fetch AND body read complete, drained inside act, so
    // the stale-absence assertions below are meaningful (the response had
    // every chance to render and was still discarded).
    await act(async () => {
      resolveFetch({
        ok: true,
        status: 200,
        json: async () => {
          bodyReadCompleted = true;
          return lactucaSativa;
        },
      } as unknown as Response);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(bodyReadCompleted).toBe(true);
    await waitFor(() => {
      expect(screen.queryByTestId("gbif-result")).toBeNull();
    });
    // The late Lettuce candidate must not be shown against Dahlia.
    expect(screen.queryByTestId("gbif-candidate-name")).toBeNull();
    expect(screen.getByTestId("gbif-stored-name")).toHaveTextContent("Dahlia");

    // A fresh explicit request for the new selection works normally.
    vi.stubGlobal("fetch", vi.fn(async () => okResponse(dahliaSpp)));
    fireEvent.click(screen.getByTestId("gbif-fetch-btn"));
    expect(await screen.findByTestId("gbif-no-match")).toBeTruthy();
  });

  it("aborts the in-flight request on unmount and suppresses late completion", async () => {
    let resolveFetch!: (r: Response) => void;
    let capturedSignal: AbortSignal | undefined;
    const deferredFetch = vi.fn(
      (_url: string, init?: { signal?: AbortSignal }) => {
        capturedSignal = init?.signal;
        return new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        });
      },
    );
    vi.stubGlobal("fetch", deferredFetch);
    const { unmount } = render(<GbifReviewPage />);
    selectPlant(builtInEntryId("Lactuca sativa"));
    fireEvent.click(screen.getByTestId("gbif-fetch-btn"));
    await screen.findByTestId("gbif-loading");

    // Real unmount while the request is in flight.
    unmount();
    expect(capturedSignal?.aborted).toBe(true);

    // Letting the request complete afterwards must not crash or resurrect
    // state — the sequence is invalidated, the response is dropped.
    await act(async () => {
      resolveFetch(okResponse(lactucaSativa));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  });

  it("never issues a request until the user explicitly clicks the check button", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<GbifReviewPage />);
    selectPlant(builtInEntryId("Lactuca sativa"));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("links the source dataset and license, and states the synonym-established accepted-name heading (C/D)", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(async () => okResponse(botrytis)));
    render(<GbifReviewPage />);
    selectPlant(builtInEntryId("Brassica oleracea var. botrytis"));

    // Traceability links in the attribution line.
    expect(screen.getByTestId("gbif-dataset-link")).toHaveAttribute(
      "href",
      "https://www.gbif.org/dataset/d7dddbf4-2cf0-4f39-9b2a-bb099caae36c",
    );
    expect(screen.getByTestId("gbif-license-link")).toHaveAttribute(
      "href",
      "http://creativecommons.org/licenses/by/4.0/legalcode",
    );

    await user.click(screen.getByTestId("gbif-fetch-btn"));
    expect(await screen.findByTestId("gbif-accepted-usage")).toHaveTextContent(
      /GBIF's currently accepted name for this synonym/i,
    );
    // Synonym status is established by the response, so the polite
    // completion announcement names the candidate.
    expect(screen.getByTestId("gbif-announce-done")).toHaveTextContent(
      /Candidate returned: Brassica oleracea var\. botrytis/,
    );
  });

  it("uses a neutral accepted-name heading when synonym status is not established (C1)", async () => {
    // Synthetic response: acceptedUsage present without a SYNONYM status on
    // the matched usage. No captured fixture has this shape; it pins the
    // neutral-wording branch only.
    const neutral = {
      usage: {
        key: "111",
        name: "Lactuca sativa L.",
        canonicalName: "Lactuca sativa",
        rank: "SPECIES",
        status: "ACCEPTED",
      },
      acceptedUsage: {
        key: "111",
        name: "Lactuca sativa L.",
        canonicalName: "Lactuca sativa",
        rank: "SPECIES",
        status: "ACCEPTED",
      },
      classification: [
        { key: "6", name: "Plantae", rank: "KINGDOM" },
        { key: "3065", name: "Asteraceae", rank: "FAMILY" },
      ],
      synonym: false,
      diagnostics: { matchType: "EXACT", confidence: 90 },
    };
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(async () => okResponse(neutral)));
    render(<GbifReviewPage />);
    selectPlant(builtInEntryId("Lactuca sativa"));
    await user.click(screen.getByTestId("gbif-fetch-btn"));
    expect(await screen.findByTestId("gbif-accepted-usage")).toHaveTextContent(
      /GBIF's currently accepted name/i,
    );
    expect(screen.getByTestId("gbif-accepted-usage")).not.toHaveTextContent(
      /for this synonym/i,
    );
  });
});
