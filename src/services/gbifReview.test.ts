import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildGbifMatchUrl,
  clearGbifSessionCache,
  fetchGbifMatch,
  gbifFamilyOf,
  reviewFindings,
  type GbifMatchResponse,
} from "./gbifReview.ts";

import lactucaSativa from "./__fixtures__/gbif/lactuca-sativa.json";
import botrytis from "./__fixtures__/gbif/brassica-oleracea-var-botrytis.json";
import capitata from "./__fixtures__/gbif/brassica-oleracea-var-capitata.json";
import menthaSpp from "./__fixtures__/gbif/mentha-spp.json";
import dahliaSpp from "./__fixtures__/gbif/dahlia-spp.json";
import dahliaSppKingdomPlantae from "./__fixtures__/gbif/dahlia-spp-kingdom-plantae.json";
import lactucaSativaKingdomPlantae from "./__fixtures__/gbif/lactuca-sativa-kingdom-plantae.json";
import unknownNameKingdomPlantae from "./__fixtures__/gbif/unknown-name-kingdom-plantae.json";
import pisumSativum from "./__fixtures__/gbif/pisum-sativum.json";

// Fixtures are the saved raw GBIF v2 response bodies captured 2026-09-20
// (Temp/jninty-companion/api-feasibility-2026-09-20/raw/gbif/v2/) — real
// service responses, replayed offline for deterministic tests.
// dahlia-spp-kingdom-plantae.json is the fresh 2026-09-22 capture of the same
// name WITH the kingdom=Plantae classification parameter (saved in
// Temp/jninty-companion/api-next-20260922/evidence/): HIGHERRANK to the
// accepted plant genus Dahlia Cav. — a genus-level candidate, not an exact
// species identity.
const typedFixture = (f: unknown) => f as GbifMatchResponse;

function okResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as unknown as Response;
}

function fetchReturning(body: unknown) {
  return vi.fn(async () => okResponse(body));
}

beforeEach(() => {
  clearGbifSessionCache();
});

describe("buildGbifMatchUrl", () => {
  it("URL-encodes the scientific name and always carries the Plantae kingdom context", () => {
    expect(buildGbifMatchUrl("Lactuca sativa")).toBe(
      "https://api.gbif.org/v2/species/match?scientificName=Lactuca%20sativa&kingdom=Plantae",
    );
    expect(buildGbifMatchUrl("Petunia × hybrida")).toBe(
      "https://api.gbif.org/v2/species/match?scientificName=Petunia%20%C3%97%20hybrida&kingdom=Plantae",
    );
  });

  it("carries kingdom=Plantae for every catalog name, including homonym-prone ones (request-parameter regression)", () => {
    // The screen's name source is the built-in plant catalog only
    // (GbifReviewPage loads loadKnowledgeBase(); no free-text input), so
    // Plantae is a valid constant context. "Dahlia spp." previously returned
    // NONE ungated because of the homonymous animal genus.
    for (const name of ["Dahlia spp.", "Lactuca sativa", "Mentha spp.", "Petunia × hybrida"]) {
      const url = buildGbifMatchUrl(name);
      expect(url).toContain("kingdom=Plantae");
      expect(url).toContain(`scientificName=${encodeURIComponent(name)}`);
    }
  });
});

describe("fetchGbifMatch", () => {
  it("returns a validated exact match for a real captured response", async () => {
    const fetchImpl = fetchReturning(lactucaSativa);
    const outcome = await fetchGbifMatch("Lactuca sativa", { fetchImpl });

    expect(outcome.kind).toBe("match");
    if (outcome.kind !== "match") return;
    expect(outcome.requestUrl).toBe(
      "https://api.gbif.org/v2/species/match?scientificName=Lactuca%20sativa&kingdom=Plantae",
    );
    expect(outcome.result.usage?.key).toBe("7403263");
    expect(outcome.result.usage?.status).toBe("ACCEPTED");
    expect(outcome.result.diagnostics.matchType).toBe("EXACT");
    expect(outcome.result.diagnostics.confidence).toBe(99);
    expect(outcome.fromCache).toBe(false);
    expect(outcome.retrievedAt).toBeTruthy();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("serves repeat requests for the same name from the bounded session cache", async () => {
    const fetchImpl = fetchReturning(lactucaSativa);
    const first = await fetchGbifMatch("Lactuca sativa", { fetchImpl });
    const second = await fetchGbifMatch("Lactuca sativa", { fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(second.kind).toBe("match");
    if (first.kind !== "match" || second.kind !== "match") return;
    expect(second.fromCache).toBe(true);
    // A cache hit must keep the original retrieval timestamp, not pretend
    // GBIF was queried again.
    expect(second.retrievedAt).toBe(first.retrievedAt);
  });

  it("does not cache errors — a failed request is retried with a new fetch", async () => {
    const failing = vi.fn(async () => {
      throw new TypeError("network down");
    });
    const first = await fetchGbifMatch("Lactuca sativa", { fetchImpl: failing });
    expect(first).toMatchObject({ kind: "error", errorType: "network" });

    const succeeding = fetchReturning(lactucaSativa);
    const second = await fetchGbifMatch("Lactuca sativa", { fetchImpl: succeeding });
    expect(second.kind).toBe("match");
    expect(succeeding).toHaveBeenCalledTimes(1);
  });

  it("returns a NONE outcome (not an error) for the captured Dahlia spp. response", async () => {
    const outcome = await fetchGbifMatch("Dahlia spp.", {
      fetchImpl: fetchReturning(dahliaSpp),
    });

    expect(outcome.kind).toBe("match");
    if (outcome.kind !== "match") return;
    expect(outcome.result.diagnostics.matchType).toBe("NONE");
    expect(outcome.result.diagnostics.note).toContain("Multiple equal matches");
    expect(outcome.result.usage).toBeUndefined();
  });

  it("resolves Dahlia spp. to the accepted plant genus when kingdom=Plantae disambiguates (paired capture 2026-09-22)", async () => {
    // Fresh capture WITH the kingdom parameter (saved paired evidence,
    // api-next-20260922/evidence/repro-after-kingdom-plantae-dahlia.json):
    // HIGHERRANK to the accepted plant genus Dahlia Cav. This is a genus-level
    // CANDIDATE, never an exact species identity — asserted via the findings
    // below, not via any exact-match claim.
    const outcome = await fetchGbifMatch("Dahlia spp.", {
      fetchImpl: fetchReturning(dahliaSppKingdomPlantae),
    });

    expect(outcome.kind).toBe("match");
    if (outcome.kind !== "match") return;
    expect(outcome.result.diagnostics.matchType).toBe("HIGHERRANK");
    expect(outcome.result.diagnostics.confidence).toBe(95);
    expect(outcome.result.usage?.name).toBe("Dahlia Cav.");
    expect(outcome.result.usage?.rank).toBe("GENUS");
    expect(outcome.result.usage?.status).toBe("ACCEPTED");
    expect(outcome.result.usage?.key).toBe("3093023");
    expect(gbifFamilyOf(outcome.result)).toBe("Asteraceae");

    // The findings must present it as a higher-rank candidate, never as an
    // exact identity.
    const findings = reviewFindings("Dahlia spp.", undefined, outcome.result);
    const titles = findings.map((f) => f.title);
    expect(titles).toContain("Matched only at a higher rank (genus)");
    expect(titles).not.toContain("Exact match, currently accepted");
  });

  it("resolves Dahlia spp. to the accepted plant genus when kingdom=Plantae disambiguates (paired capture 2026-09-22, Lactuca exact control unchanged)", async () => {
    // Paired control with the kingdom parameter (fresh 2026-09-22 capture,
    // api-next-20260922/evidence/paired-evidence-r1.json): an unambiguous name
    // keeps its exact identity — same usage (key/name/rank/status) and the same
    // classification chain as ungated. The only measured difference is
    // diagnostics.confidence 99 -> 100 (a scoring shift, no identity change);
    // the screen labels this score as GBIF's internal value, not a certainty.
    const outcome = await fetchGbifMatch("Lactuca sativa", {
      fetchImpl: fetchReturning(lactucaSativaKingdomPlantae),
    });

    expect(outcome.kind).toBe("match");
    if (outcome.kind !== "match") return;
    expect(outcome.result.diagnostics.matchType).toBe("EXACT");
    expect(outcome.result.diagnostics.confidence).toBe(100);
    expect(outcome.result.usage?.name).toBe("Lactuca sativa L.");
    expect(outcome.result.usage?.rank).toBe("SPECIES");
    expect(outcome.result.usage?.status).toBe("ACCEPTED");
    expect(outcome.result.usage?.key).toBe("7403263");
    // classification chain unchanged by the kingdom hint
    expect(
      (outcome.result.classification ?? []).map((c) => `${c.rank}:${c.name}`).join(" > "),
    ).toBe(
      "KINGDOM:Plantae > PHYLUM:Tracheophyta > CLASS:Magnoliopsida > ORDER:Asterales > FAMILY:Asteraceae > GENUS:Lactuca > SPECIES:Lactuca sativa",
    );

    // exact identity: the clean-exact finding applies (no higher-rank finding)
    const titles = reviewFindings("Lactuca sativa", "Asteraceae", outcome.result).map((f) => f.title);
    expect(titles).toContain("Exact match, currently accepted");
    expect(titles).not.toContain("Matched only at a higher rank (genus)");
  });

  it("handles a constructed unknown name under kingdom=Plantae as a kingdom-level candidate — never an error, never a fabricated species", async () => {
    // Captured 2026-09-22 (one targeted read-only GET, provenance in
    // implementation/unknown-name-kingdom-plantae-provenance.json): the
    // constructed name "Nonexistus fabricatus" does not return NONE with the
    // kingdom hint — GBIF falls back to the kingdom rank itself (HIGHERRANK 99,
    // usage Plantae KINGDOM ACCEPTED). The adapter must surface that as a
    // bounded kingdom-level candidate, never as an error or a species claim.
    const outcome = await fetchGbifMatch("Nonexistus fabricatus", {
      fetchImpl: fetchReturning(unknownNameKingdomPlantae),
    });

    expect(outcome.kind).toBe("match");
    if (outcome.kind !== "match") return;
    expect(outcome.result.diagnostics.matchType).toBe("HIGHERRANK");
    expect(outcome.result.usage?.name).toBe("Plantae");
    expect(outcome.result.usage?.rank).toBe("KINGDOM");
    expect(outcome.result.usage?.status).toBe("ACCEPTED");

    const findings = reviewFindings("Nonexistus fabricatus", undefined, outcome.result);
    const titles = findings.map((f) => f.title);
    expect(titles).toContain("Matched only at a higher rank (kingdom)");
    expect(titles).not.toContain("Exact match, currently accepted");
  });

  it("returns the genus-level HIGHERRANK candidate for the captured Mentha spp. response", async () => {
    const outcome = await fetchGbifMatch("Mentha spp.", {
      fetchImpl: fetchReturning(menthaSpp),
    });

    expect(outcome.kind).toBe("match");
    if (outcome.kind !== "match") return;
    expect(outcome.result.diagnostics.matchType).toBe("HIGHERRANK");
    expect(outcome.result.usage?.rank).toBe("GENUS");
    expect(outcome.result.diagnostics.confidence).toBe(94);
  });

  it("classifies non-JSON garbage as an invalid response", async () => {
    const fetchImpl = vi.fn(async () =>
      ({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError("Unexpected token < in JSON");
        },
      }) as unknown as Response,
    );
    const outcome = await fetchGbifMatch("Lactuca sativa", { fetchImpl });
    expect(outcome).toMatchObject({ kind: "error", errorType: "invalid" });
  });

  it("rejects structurally wrong payloads (validation, not trust)", async () => {
    const badPayload = { diagnostics: { matchType: "SURETHING" }, usage: 42 };
    const outcome = await fetchGbifMatch("Lactuca sativa", {
      fetchImpl: fetchReturning(badPayload),
    });
    expect(outcome).toMatchObject({ kind: "error", errorType: "invalid" });
  });

  it("maps HTTP errors to a typed http error with the status", async () => {
    const fetchImpl = vi.fn(async () =>
      ({ ok: false, status: 503, json: async () => ({}) }) as unknown as Response,
    );
    const outcome = await fetchGbifMatch("Lactuca sativa", { fetchImpl });
    expect(outcome).toMatchObject({
      kind: "error",
      errorType: "http",
      httpStatus: 503,
    });
  });

  it("times out a hung request with the abort controller", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(
      (_url: string, init?: { signal?: AbortSignal }) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        }),
    );
    const pending = fetchGbifMatch("Lactuca sativa", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 50,
    });
    await vi.advanceTimersByTimeAsync(60);
    const outcome = await pending;
    vi.useRealTimers();
    expect(outcome).toMatchObject({ kind: "error", errorType: "timeout" });
  });

  it("reports caller abortion distinctly", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(
      (_url: string, init?: { signal?: AbortSignal }) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        }),
    );
    const pending = fetchGbifMatch("Lactuca sativa", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      signal: controller.signal,
    });
    controller.abort();
    const outcome = await pending;
    expect(outcome).toMatchObject({ kind: "error", errorType: "aborted" });
  });

  it("does not start any request when the caller signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort(); // pre-aborted before the call
    const fetchImpl = vi.fn();
    const outcome = await fetchGbifMatch("Lactuca sativa", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      signal: controller.signal,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ kind: "error", errorType: "aborted" });
  });

  it("preserves timeout classification when the response body hangs and the timer fires", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(
      (_url: string, init?: { signal?: AbortSignal }) =>
        // Headers arrive, but the body never resolves unless aborted.
        Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            new Promise<unknown>((_resolve, reject) => {
              init?.signal?.addEventListener("abort", () =>
                reject(new DOMException("Aborted", "AbortError")),
              );
            }),
        } as unknown as Response),
    );
    const pending = fetchGbifMatch("Lactuca sativa", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 50,
    });
    await vi.advanceTimersByTimeAsync(60);
    const outcome = await pending;
    vi.useRealTimers();
    expect(outcome).toMatchObject({ kind: "error", errorType: "timeout" });
    // A timed-out body read must not be misreported as invalid JSON, and
    // must not have been cached.
    const succeeding = fetchReturning(lactucaSativa);
    const second = await fetchGbifMatch("Lactuca sativa", { fetchImpl: succeeding });
    expect(second.kind).toBe("match");
    expect(succeeding).toHaveBeenCalledTimes(1);
  });

  it("preserves caller-abort classification when the body read is interrupted", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(
      (_url: string, init?: { signal?: AbortSignal }) =>
        Promise.resolve({
          ok: true,
          status: 200,
          // AbortSignal-aware body, like real fetch: rejects immediately if
          // the signal is already aborted when the read starts.
          json: () =>
            new Promise<unknown>((_resolve, reject) => {
              const sig = init?.signal;
              const abortError = () =>
                reject(new DOMException("Aborted", "AbortError"));
              if (sig?.aborted) {
                abortError();
                return;
              }
              sig?.addEventListener("abort", abortError);
            }),
        } as unknown as Response),
    );
    const pending = fetchGbifMatch("Lactuca sativa", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      signal: controller.signal,
    });
    controller.abort();
    const outcome = await pending;
    expect(outcome).toMatchObject({ kind: "error", errorType: "aborted" });
  });

  it("never caches or returns a response that completed only after caller cancellation", async () => {
    const controller = new AbortController();
    // A body read that ignores the abort signal entirely and still resolves
    // (the strictest version of the cancellation race).
    const lenientFetch = vi.fn(async () =>
      ({
        ok: true,
        status: 200,
        json: async () => lactucaSativa,
      }) as unknown as Response,
    );
    const pending = fetchGbifMatch("Lactuca sativa", {
      fetchImpl: lenientFetch as unknown as typeof fetch,
      signal: controller.signal,
    });
    controller.abort();
    const outcome = await pending;
    expect(outcome).toMatchObject({ kind: "error", errorType: "aborted" });

    // The cancelled response must not sit in the session cache.
    const succeeding = fetchReturning(lactucaSativa);
    const second = await fetchGbifMatch("Lactuca sativa", { fetchImpl: succeeding });
    expect(second.kind).toBe("match");
    expect(succeeding).toHaveBeenCalledTimes(1);
    expect(second).toMatchObject({ fromCache: false });
  });
});

describe("reviewFindings", () => {
  it("flags the botrytis cross-name synonymy for review", () => {
    const result = typedFixture(botrytis);
    const findings = reviewFindings(
      "Brassica oleracea var. botrytis",
      "Brassicaceae",
      result,
    );
    const titles = findings.map((f) => f.title);
    expect(titles).toContain("Surprising cross-name match — review required");
    // The stored family agrees with GBIF's classification here (Brassicaceae).
    expect(titles).toContain("Family agrees (exact text)");
    // Accepted usage surfaced.
    expect(result.acceptedUsage?.name).toBe("Brassica cretica subsp. cretica");
  });

  it("treats capitata → B. oleracea as an ordinary synonymy, not a cross-name flag", () => {
    const findings = reviewFindings(
      "Brassica oleracea var. capitata",
      "Brassicaceae",
      typedFixture(capitata),
    );
    expect(findings.map((f) => f.title)).not.toContain(
      "Surprising cross-name match — review required",
    );
    expect(
      findings.find((f) => f.title === "Name treated as a synonym"),
    ).toBeTruthy();
  });

  it("flags Pisum sativum → Lathyrus oleraceus as a cross-name match", () => {
    const findings = reviewFindings(
      "Pisum sativum",
      "Fabaceae",
      typedFixture(pisumSativum),
    );
    expect(findings.map((f) => f.title)).toContain(
      "Surprising cross-name match — review required",
    );
  });

  it("explains the Dahlia spp. no-match plainly", () => {
    const findings = reviewFindings("Dahlia spp.", undefined, typedFixture(dahliaSpp));
    const noMatch = findings.find((f) => f.title === "No match returned");
    expect(noMatch?.level).toBe("review");
    expect(noMatch?.explanation).toContain("Multiple equal matches for Dahlia");
    expect(noMatch?.explanation).toContain("spp.");
  });

  it("reports the genus-only Mentha spp. match as review-needed, not identity", () => {
    const findings = reviewFindings("Mentha spp.", "Lamiaceae", typedFixture(menthaSpp));
    const higher = findings.find((f) =>
      f.title.startsWith("Matched only at a higher rank"),
    );
    expect(higher?.level).toBe("review");
    expect(higher?.explanation).toContain("genus");
  });

  it("reflects the returned rank for a non-genus HIGHERRANK match (synthetic case)", () => {
    // No captured raw response in the evidence set has a non-genus
    // HIGHERRANK diagnostics, so this unit case is a synthetic response —
    // it tests the wording logic only, not GBIF behaviour.
    const familyHigherRank = {
      usage: { key: "2506007", name: "Rosaceae", rank: "FAMILY", status: "ACCEPTED" },
      classification: [{ key: "2506007", name: "Rosaceae", rank: "FAMILY" }],
      diagnostics: { matchType: "HIGHERRANK", confidence: 90 },
    } as unknown as GbifMatchResponse;
    const findings = reviewFindings("Rosaceae spp.", "Rosaceae", familyHigherRank);
    const higher = findings.find((f) => f.level === "review");
    expect(higher?.title).toBe("Matched only at a higher rank (family)");
    expect(higher?.explanation).toContain("family rank (Rosaceae)");
    expect(higher?.explanation).not.toContain("not to a species.");
    expect(higher?.explanation).toContain("not a species-level identity");
  });

  it("flags a family contradiction and a rank mismatch mechanically", () => {
    const lactuca = typedFixture(lactucaSativa);
    const familyFindings = reviewFindings(
      "Lactuca sativa",
      "Fabaceae", // deliberately wrong vs the fixture's Asteraceae
      lactuca,
    );
    const mismatch = familyFindings.find((f) =>
      f.title.startsWith("Family differs"),
    );
    expect(mismatch?.level).toBe("review");
    expect(mismatch?.explanation).toContain("Fabaceae");
    expect(mismatch?.explanation).toContain("Asteraceae");

    // Lactuca sativa has no var./subsp./spp. tokens and is accepted+exact:
    // the clean case yields only informational findings.
    const clean = reviewFindings("Lactuca sativa", "Asteraceae", lactuca);
    expect(clean.every((f) => f.level === "info")).toBe(true);
    expect(clean.map((f) => f.title)).toContain("Exact match, currently accepted");
    expect(gbifFamilyOf(lactuca)).toBe("Asteraceae");
  });
});
