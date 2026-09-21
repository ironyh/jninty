import { z } from "zod";

// ─── What this module is ───
//
// A small, bounded, read-only adapter for the GBIF species name-match API
// (v2), used only by the experimental GBIF name-review screen. It NEVER
// writes to the database: callers receive plain data and display it beside
// the stored catalog name. See DELIVERY notes and the screen's on-page
// disclaimer.
//
// Endpoint evidence (verified 2026-09-20 against the official OpenAPI spec,
// https://techdocs.gbif.org/openapi/checklistbank.json, saved copy
// Temp/jninty-companion/api-feasibility-2026-09-20/raw/gbif/openapi-checklistbank.json):
//   GET https://api.gbif.org/v2/species/match?scientificName=...
// v1 /v1/species/match is officially deprecated in that spec; v2 is current.
// Access observed without keys/accounts; data license CC BY 4.0 (GBIF
// Backbone Taxonomy registry record). Attribution is rendered in the UI.

export const GBIF_MATCH_ENDPOINT = "https://api.gbif.org/v2/species/match";
export const GBIF_SPECIES_PAGE_BASE = "https://www.gbif.org/species";
/** Registry record for the GBIF Backbone Taxonomy dataset (license: CC BY 4.0). */
export const GBIF_DATASET_URL =
  "https://www.gbif.org/dataset/d7dddbf4-2cf0-4f39-9b2a-bb099caae36c";
export const GBIF_LICENSE_URL =
  "http://creativecommons.org/licenses/by/4.0/legalcode";
export const GBIF_ATTRIBUTION =
  "Source: GBIF Backbone Taxonomy (GBIF Secretariat), gbif.org — data licensed CC BY 4.0.";

const DEFAULT_TIMEOUT_MS = 10_000;
const SESSION_CACHE_LIMIT = 50;

// ─── Response schemas (mirror the OpenAPI NameUsageMatch / Diagnostics) ───

const idLike = z
  .union([z.string(), z.number()])
  .transform((v) => String(v));

export const gbifUsageSchema = z
  .object({
    key: idLike,
    name: z.string().min(1),
    canonicalName: z.string().optional(),
    authorship: z.string().optional(),
    rank: z.string().min(1),
    status: z.string().optional(),
    code: z.string().optional(),
  })
  .passthrough();

export const gbifClassificationEntrySchema = z
  .object({
    key: idLike,
    name: z.string().min(1),
    rank: z.string().min(1),
  })
  .passthrough();

export const gbifDiagnosticsSchema = z
  .object({
    matchType: z.enum([
      "EXACT",
      "VARIANT",
      "CANONICAL",
      "AMBIGUOUS",
      "NONE",
      "UNSUPPORTED",
      "HIGHERRANK",
    ]),
    confidence: z.number().int().min(0).max(100).optional(),
    note: z.string().optional(),
    issues: z.array(z.string()).optional(),
    processingFlags: z.array(z.string()).optional(),
    // Alternatives are validated shallowly on purpose: this prototype only
    // counts them and surfaces their names, it never recurses.
    alternatives: z
      .array(z.object({ usage: gbifUsageSchema.optional() }).passthrough())
      .optional(),
  })
  .passthrough();

export const gbifMatchResponseSchema = z
  .object({
    usage: gbifUsageSchema.optional(),
    acceptedUsage: gbifUsageSchema.optional(),
    classification: z.array(gbifClassificationEntrySchema).optional(),
    synonym: z.boolean().optional(),
    diagnostics: gbifDiagnosticsSchema,
  })
  .passthrough();

export type GbifUsage = z.infer<typeof gbifUsageSchema>;
export type GbifClassificationEntry = z.infer<
  typeof gbifClassificationEntrySchema
>;
export type GbifDiagnostics = z.infer<typeof gbifDiagnosticsSchema>;
export type GbifMatchResponse = z.infer<typeof gbifMatchResponseSchema>;

// ─── Outcome type ───

export type GbifErrorType =
  | "network" // fetch rejected (offline, DNS, connection reset)
  | "timeout" // our own bounded timeout fired
  | "aborted" // caller cancelled (e.g. selection changed)
  | "http" // non-2xx status
  | "invalid"; // malformed JSON or failed response validation

export type GbifFetchOutcome =
  | {
      kind: "match";
      result: GbifMatchResponse;
      /** ISO timestamp of when GBIF was actually queried (cache keeps the original). */
      retrievedAt: string;
      /** The exact request URL (name URL-encoded). */
      requestUrl: string;
      fromCache: boolean;
    }
  | {
      kind: "error";
      errorType: GbifErrorType;
      message: string;
      httpStatus?: number;
    };

// ─── Bounded in-memory session cache, keyed by the exact request URL ───
//
// Successful matches only: errors stay retryable. Cache hits keep the
// original retrieval timestamp so the UI never misrepresents freshness.

const sessionCache = new Map<string, GbifFetchOutcome & { kind: "match" }>();

export function clearGbifSessionCache(): void {
  sessionCache.clear();
}

// ─── Core fetch ───

export function buildGbifMatchUrl(scientificName: string): string {
  return `${GBIF_MATCH_ENDPOINT}?scientificName=${encodeURIComponent(scientificName)}`;
}

export interface FetchGbifMatchOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

/**
 * Query GBIF v2 species/match for one scientific name.
 * Read-only: performs a single GET, validates the response, never touches
 * the database. Malformed or failed responses become typed errors, never
 * partial guesses.
 */
export async function fetchGbifMatch(
  scientificName: string,
  options: FetchGbifMatchOptions = {},
): Promise<GbifFetchOutcome> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, signal, fetchImpl = fetch, now = () => new Date() } =
    options;

  const requestUrl = buildGbifMatchUrl(scientificName);

  // A caller that is already cancelled must not start any work — checked
  // before the cache and before the network.
  if (signal?.aborted) {
    return {
      kind: "error",
      errorType: "aborted",
      message: "Request cancelled before it started.",
    };
  }

  const cached = sessionCache.get(requestUrl);
  if (cached) {
    // Refresh LRU order
    sessionCache.delete(requestUrl);
    sessionCache.set(requestUrl, cached);
    return { ...cached, fromCache: true };
  }

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onExternalAbort = () => controller.abort();
  signal?.addEventListener("abort", onExternalAbort);

  try {
    let response: Response;
    try {
      response = await fetchImpl(requestUrl, { signal: controller.signal });
    } catch {
      if (signal?.aborted) {
        return { kind: "error", errorType: "aborted", message: "Request cancelled." };
      }
      if (timedOut) {
        return {
          kind: "error",
          errorType: "timeout",
          message: `GBIF did not respond within ${String(timeoutMs / 1000)} s.`,
        };
      }
      return {
        kind: "error",
        errorType: "network",
        message: "Could not reach gbif.org — you may be offline.",
      };
    }

    if (!response.ok) {
      return {
        kind: "error",
        errorType: "http",
        httpStatus: response.status,
        message: `GBIF returned HTTP ${String(response.status)}.`,
      };
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch {
      // The body read can be interrupted by our own timeout or by the
      // caller's cancellation — those keep their classifications and must
      // not be misreported as malformed JSON.
      if (timedOut) {
        return {
          kind: "error",
          errorType: "timeout",
          message: `GBIF did not respond within ${String(timeoutMs / 1000)} s.`,
        };
      }
      if (signal?.aborted) {
        return {
          kind: "error",
          errorType: "aborted",
          message: "Request cancelled.",
        };
      }
      return {
        kind: "error",
        errorType: "invalid",
        message: "GBIF returned a response that is not valid JSON.",
      };
    }

    const parsed = gbifMatchResponseSchema.safeParse(json);
    if (!parsed.success) {
      return {
        kind: "error",
        errorType: "invalid",
        message: "GBIF response did not have the expected structure.",
      };
    }

    // A response that completed only after the caller cancelled (or the
    // clock ran out) is never returned as data and never cached.
    if (timedOut) {
      return {
        kind: "error",
        errorType: "timeout",
        message: `GBIF did not respond within ${String(timeoutMs / 1000)} s.`,
      };
    }
    if (signal?.aborted) {
      return {
        kind: "error",
        errorType: "aborted",
        message: "Request cancelled.",
      };
    }

    const outcome: GbifFetchOutcome & { kind: "match" } = {
      kind: "match",
      result: parsed.data,
      retrievedAt: now().toISOString(),
      requestUrl,
      fromCache: false,
    };

    sessionCache.set(requestUrl, outcome);
    if (sessionCache.size > SESSION_CACHE_LIMIT) {
      const oldest = sessionCache.keys().next().value;
      if (oldest !== undefined) sessionCache.delete(oldest);
    }

    return outcome;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onExternalAbort);
  }
}

// ─── Mechanical interpretation helpers (no botanical judgement) ───

export function gbifFamilyOf(result: GbifMatchResponse): string | undefined {
  return result.classification?.find((c) => c.rank === "FAMILY")?.name;
}

export function gbifSpeciesPageUrl(usage: GbifUsage): string {
  return `${GBIF_SPECIES_PAGE_BASE}/${usage.key}`;
}

/** Display name without the formattedName HTML italics markers. */
export function gbifDisplayName(usage: GbifUsage): string {
  return usage.name.replace(/<[^>]+>/g, "");
}

/**
 * One review finding, in plain language. Everything here is a mechanical
 * observation about strings returned by GBIF — never a claim that either
 * name is botanically correct.
 */
export interface ReviewFinding {
  level: "info" | "review";
  title: string;
  explanation: string;
}

function storedNameParts(storedName: string): {
  genus: string | undefined;
  speciesEpithet: string | undefined;
  hasVariety: boolean;
  hasSubspecies: boolean;
  isOpenGenus: boolean;
} {
  const cleaned = storedName.toLowerCase();
  const words = cleaned
    .replace(/\s+/g, " ")
    .split(" ")
    .filter((w) => w !== "×" && w !== "x" && w.length > 0);
  const genus = words[0];
  const speciesEpithet =
    words[1] && !["spp.", "sp.", "var.", "subsp."].includes(words[1])
      ? words[1]
      : undefined;
  return {
    genus,
    speciesEpithet,
    hasVariety: cleaned.includes(" var. "),
    hasSubspecies: cleaned.includes(" subsp. "),
    isOpenGenus: cleaned.includes("spp.") || cleaned.endsWith(" sp."),
  };
}

/**
 * Compare the stored catalog name + family with a GBIF match response and
 * produce plain-language review findings. Purely mechanical string logic.
 */
export function reviewFindings(
  storedName: string,
  storedFamily: string | undefined,
  result: GbifMatchResponse,
): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  const { diagnostics, usage, acceptedUsage } = result;
  const stored = storedNameParts(storedName);

  // 1. Match-type level findings.
  if (diagnostics.matchType === "NONE") {
    findings.push({
      level: "review",
      title: "No match returned",
      explanation:
        "GBIF could not return a single candidate for this name string." +
        (diagnostics.note ? ` GBIF's note: “${diagnostics.note}”.` : "") +
        (stored.isOpenGenus
          ? " The stored name is an open/abbreviated name (“spp.”), which GBIF may refuse to resolve to one species. This is not a verified identity — it needs human review."
          : " This needs human review; it does not mean the catalog name is wrong."),
    });
  } else if (diagnostics.matchType === "HIGHERRANK") {
    const rankLabel = usage ? usage.rank.toLowerCase() : "higher";
    const expectation =
      rankLabel === "genus"
        ? "not to a species"
        : "not to a more precisely resolved taxon";
    const openGenusNote =
      stored.isOpenGenus && rankLabel === "genus"
        ? " The stored name is an open genus (“spp.”), so this is expected"
        : "";
    findings.push({
      level: "review",
      title: `Matched only at a higher rank (${rankLabel})`,
      explanation: `GBIF resolved this name only to the ${rankLabel} rank (${
        usage ? gbifDisplayName(usage) : "higher taxon"
      }), ${expectation}.${openGenusNote}, but it is a ${rankLabel}-level candidate only — not a species-level identity. Human review needed.`,
    });
  } else if (diagnostics.matchType === "AMBIGUOUS") {
    findings.push({
      level: "review",
      title: "Ambiguous — multiple equal candidates",
      explanation:
        "GBIF found more than one equally plausible candidate and did not choose." +
        (diagnostics.note ? ` GBIF's note: “${diagnostics.note}”.` : "") +
        " A human must pick — nothing was selected automatically." +
        (diagnostics.alternatives && diagnostics.alternatives.length > 0
          ? ` GBIF listed ${String(diagnostics.alternatives.length)} alternative(s) with lower confidence.`
          : ""),
    });
  }

  // 2. Synonym / accepted-name findings.
  if (usage && acceptedUsage && usage.status === "SYNONYM") {
    const acceptedName = gbifDisplayName(acceptedUsage);
    const accepted = storedNameParts(acceptedName);
    const sameGenus = accepted.genus === stored.genus;
    const sameSpecies =
      accepted.speciesEpithet !== undefined &&
      accepted.speciesEpithet === stored.speciesEpithet;

    if (sameGenus && sameSpecies) {
      findings.push({
        level: "info",
        title: "Name treated as a synonym",
        explanation: `GBIF currently lists this name as a synonym of ${acceptedName}. The stored catalog name is kept unchanged; compare the two before drawing any conclusion.`,
      });
    } else {
      findings.push({
        level: "review",
        title: "Surprising cross-name match — review required",
        explanation: `GBIF maps the stored name to an accepted name outside the stored species name: “${acceptedName}”. The accepted name does not simply reduce to the stored name (different genus or species epithet). This is exactly the kind of mapping that must be reviewed botanically before anyone trusts it — no claim is made here about which treatment is correct, and nothing was changed.`,
      });
    }
  }

  // 3. Taxon-rank mismatch between the stored name string and the matched rank.
  if (usage && diagnostics.matchType !== "NONE") {
    const rank = usage.rank.toUpperCase();
    const rankMismatch =
      (stored.hasVariety && rank !== "VARIETY") ||
      (stored.hasSubspecies && rank !== "SUBSPECIES") ||
      (stored.isOpenGenus && !["GENUS"].includes(rank));
    if (rankMismatch) {
      findings.push({
        level: "review",
        title: "Taxon-rank mismatch",
        explanation: `The stored name string implies a rank that differs from the rank GBIF matched (GBIF rank: ${usage.rank.toLowerCase()}). Compare carefully; nothing was changed.`,
      });
    }
  }

  // 4. Family comparison — exact string equality only.
  const gbifFamily = gbifFamilyOf(result);
  if (storedFamily === undefined) {
    if (gbifFamily) {
      findings.push({
        level: "info",
        title: "Catalog has no family recorded",
        explanation: `GBIF's classification puts this name in family ${gbifFamily}. The catalog entry has no family value to compare against, so no agreement or contradiction can be checked.`,
      });
    }
  } else if (gbifFamily && gbifFamily !== storedFamily) {
    findings.push({
      level: "review",
      title: "Family differs from the catalog",
      explanation: `Catalog stores “${storedFamily}”; GBIF's classification for the candidate says “${gbifFamily}”. This is a string-level contradiction that needs human review — it does not say which is correct.`,
    });
  } else if (gbifFamily && gbifFamily === storedFamily) {
    findings.push({
      level: "info",
      title: "Family agrees (exact text)",
      explanation: `Both the catalog and GBIF's classification give “${gbifFamily}”. This is an exact-text observation only, not a botanical verification.`,
    });
  }

  // 5. Clean exact + accepted case (only when nothing above needs review).
  if (
    usage &&
    diagnostics.matchType === "EXACT" &&
    usage.status === "ACCEPTED" &&
    !findings.some((f) => f.level === "review")
  ) {
    findings.push({
      level: "info",
      title: "Exact match, currently accepted",
      explanation:
        "GBIF matched the name string exactly and lists the usage as currently accepted. This is still GBIF's name resolution, not a verified identity for your plant.",
    });
  }

  return findings;
}
