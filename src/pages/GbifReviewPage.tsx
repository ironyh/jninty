import { useEffect, useMemo, useRef, useState } from "react";
import Card from "../components/ui/Card";
import Badge from "../components/ui/Badge";
import Button from "../components/ui/Button";
import { loadKnowledgeBase } from "../services/knowledgeBase.ts";
import { PLANT_CATEGORIES } from "../constants/knowledgeCategories.ts";
import type { PlantKnowledge } from "../validation/plantKnowledge.schema.ts";
import { builtInEntryId } from "../services/knowledgeBase.ts";
import {
  GBIF_DATASET_URL,
  GBIF_LICENSE_URL,
  fetchGbifMatch,
  gbifDisplayName,
  gbifFamilyOf,
  gbifSpeciesPageUrl,
  reviewFindings,
  type GbifFetchOutcome,
} from "../services/gbifReview.ts";

// ─── Experimental, read-only GBIF name-review prototype ───
// Users pick a catalog plant, explicitly request a GBIF name/taxonomy
// candidate, and compare it against the stored catalog values. Nothing here
// writes to the database: this page imports no repository and performs no
// mutation — every displayed value is either stored catalog data read via
// loadKnowledgeBase() or the validated GBIF response shown beside it.

type LoadState = "idle" | "loading" | "done";

function formatTimestamp(iso: string): string {
  return iso.replace("T", " ").replace(/Z$/, " UTC");
}

function statusBadgeVariant(status: string | undefined) {
  if (status === "ACCEPTED") return "success" as const;
  if (status === "SYNONYM") return "warning" as const;
  return "default" as const;
}

function optionLabel(p: PlantKnowledge): string {
  return `${p.commonName} — ${p.species}${p.variety ? ` '${p.variety}'` : ""}`;
}

export default function GbifReviewPage() {
  const catalog = useMemo(() => loadKnowledgeBase(), []);

const grouped = useMemo(() => {
  return PLANT_CATEGORIES.map((cat) => ({
    label: cat.label,
    entries: catalog
      .filter((p) => cat.plantTypes.includes(p.plantType))
      .slice()
      .sort((a, b) => a.commonName.localeCompare(b.commonName)),
  })).filter((g) => g.entries.length > 0);
}, [catalog]);

  const [selectedId, setSelectedId] = useState<string>("");
  const [state, setState] = useState<LoadState>("idle");
  const [outcome, setOutcome] = useState<GbifFetchOutcome | null>(null);
  const [requestedName, setRequestedName] = useState<string>("");

  // Stale-response protection: an incrementing sequence token plus an
  // AbortController per request. If the selection changes while a request is
  // in flight, the request is aborted and any late response is discarded.
  const requestSeqRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  // Leaving the page must abort any in-flight request and invalidate the
  // sequence so a late completion can never reach (unmounted) state.
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      requestSeqRef.current += 1;
    };
  }, []);

  const selected = catalog.find((p) => builtInEntryId(p.species, p.variety) === selectedId);

  function handleSelectionChange(id: string) {
    setSelectedId(id);
    // Selection changed → anything in flight is now stale.
    abortRef.current?.abort();
    requestSeqRef.current += 1;
    setState("idle");
    setOutcome(null);
    setRequestedName("");
  }

  async function handleFetch() {
    if (!selected || state === "loading") return;
    const nameToCheck = selected.species; // stored name, sent verbatim
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const seq = requestSeqRef.current + 1;
    requestSeqRef.current = seq;

    setRequestedName(nameToCheck);
    setState("loading");
    setOutcome(null);

    const result = await fetchGbifMatch(nameToCheck, {
      signal: controller.signal,
    });

    if (seq !== requestSeqRef.current) return; // stale response — discard
    setOutcome(result);
    setState("done");
  }

  const matchResult = outcome?.kind === "match" ? outcome.result : null;
  const findings =
    selected && matchResult ? reviewFindings(requestedName, selected.family, matchResult) : [];
  const reviewFindingsList = findings.filter((f) => f.level === "review");
  const infoFindings = findings.filter((f) => f.level === "info");
  const usage = matchResult?.usage;
  const acceptedUsage = matchResult?.acceptedUsage;

  return (
    <div className="mx-auto max-w-5xl p-4" data-testid="gbif-review-root">
      {/* Header with the mandatory experimental label */}
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="font-display text-2xl font-bold text-text-heading">
          GBIF name check
        </h1>
        <Badge variant="warning" data-testid="gbif-experimental-banner">
          Experimental — read-only prototype
        </Badge>
      </div>

      <Card className="mt-3 border-dashed bg-surface-muted/40">
        <p className="text-sm text-text-secondary">
          Compare a catalog plant's scientific name against the GBIF Backbone
          Taxonomy. This screen <strong>never saves, overwrites, or
          normalizes anything</strong> — it only displays GBIF's candidate
          next to the stored catalog values for human review. A GBIF match is
          a name-resolution candidate, <strong>not</strong> a verified
          identity for your plant.
        </p>
        <p className="mt-2 text-xs text-text-secondary">
          Source:{" "}
          <a
            className="text-primary underline"
            href={GBIF_DATASET_URL}
            target="_blank"
            rel="noreferrer"
            data-testid="gbif-dataset-link"
          >
            GBIF Backbone Taxonomy
          </a>{" "}
          (GBIF Secretariat), gbif.org — data licensed{" "}
          <a
            className="text-primary underline"
            href={GBIF_LICENSE_URL}
            target="_blank"
            rel="noreferrer"
            data-testid="gbif-license-link"
          >
            CC BY 4.0
          </a>
          .
        </p>
      </Card>

      {/* Plant selection */}
      <div className="mt-6 grid gap-4 md:grid-cols-2">
        <Card>
          <h2 className="font-display text-lg font-semibold text-text-heading">
            1. Choose a catalog plant
          </h2>
          <div className="mt-3">
            <label htmlFor="gbif-plant-select" className="sr-only">
              Catalog plant
            </label>
            <select
              id="gbif-plant-select"
              data-testid="gbif-plant-select"
              className="w-full rounded-lg border border-border-strong bg-surface-elevated px-3 py-2 text-sm text-text-primary"
              value={selectedId}
              onChange={(e) => handleSelectionChange(e.target.value)}
            >
              <option value="">— Select a plant —</option>
              {grouped.map(({ label, entries }) => (
                <optgroup key={label} label={label}>
                  {entries.map((p) => (
                    <option
                      key={builtInEntryId(p.species, p.variety)}
                      value={builtInEntryId(p.species, p.variety)}
                    >
                      {optionLabel(p)}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>

          {selected && (
            <dl className="mt-4 space-y-1 text-sm" data-testid="gbif-stored-panel">
              <div className="flex gap-2">
                <dt className="text-text-secondary">Catalog name:</dt>
                <dd className="font-medium text-text-primary" data-testid="gbif-stored-name">
                  {optionLabel(selected)}
                </dd>
              </div>
              <div className="flex gap-2">
                <dt className="text-text-secondary">Stored family:</dt>
                <dd className="font-medium text-text-primary" data-testid="gbif-stored-family">
                  {selected.family ?? "not recorded"}
                </dd>
              </div>
            </dl>
          )}

          <div className="mt-4 flex items-center gap-3">
            <Button
              data-testid="gbif-fetch-btn"
              onClick={() => void handleFetch()}
              disabled={!selected || state === "loading"}
            >
              {state === "loading"
                ? `Querying GBIF for “${requestedName}”…`
                : `Check this name on GBIF`}
            </Button>
            <span className="text-xs text-text-secondary">
              Explicit request — one lookup per click, no background queries.
            </span>
          </div>
        </Card>

        {/* Outcome panel */}
        <Card>
          <h2 className="font-display text-lg font-semibold text-text-heading">
            2. GBIF candidate
          </h2>

          {state === "loading" && (
            <p className="mt-3 text-sm text-text-secondary" role="status" data-testid="gbif-loading">
              Querying GBIF…
            </p>
          )}

          {state === "idle" && (
            <p className="mt-3 text-sm text-text-secondary" data-testid="gbif-idle">
              {selected
                ? "No lookup performed yet for this plant. The stored catalog name stays authoritative regardless of what GBIF returns."
                : "Select a plant above to begin."}
            </p>
          )}

          {outcome?.kind === "error" && (
            <div className="mt-3" data-testid="gbif-error">
              <p className="text-sm font-medium text-status-danger-text" role="alert" data-testid="gbif-announce-error">
                {outcome.message}
              </p>
              <p className="mt-1 text-xs text-text-secondary">
                The app works fine without GBIF — this screen is optional.
              </p>
              <Button
                variant="secondary"
                size="sm"
                className="mt-2"
                data-testid="gbif-retry-btn"
                onClick={() => void handleFetch()}
              >
                Retry
              </Button>
            </div>
          )}

          {outcome?.kind === "match" && matchResult && (
            <div className="mt-3" data-testid="gbif-result">
              {!usage && (
                <p className="text-sm font-medium text-status-danger-text" data-testid="gbif-no-match">
                  No candidate returned for “{requestedName}”.
                </p>
              )}

              {usage && (
                <div className="space-y-2 text-sm">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className="font-display text-base font-semibold italic text-text-primary" data-testid="gbif-candidate-name">
                      {gbifDisplayName(usage)}
                    </span>
                    <Badge variant={statusBadgeVariant(usage.status)}>
                      {usage.status ?? "status unknown"}
                    </Badge>
                    <Badge>{`rank: ${usage.rank.toLowerCase()}`}</Badge>
                    <Badge>{`match: ${matchResult.diagnostics.matchType.toLowerCase()}`}</Badge>
                  </div>

                  <p className="text-text-secondary" data-testid="gbif-score">
                    GBIF's score:{" "}
                    <strong className="text-text-primary">
                      {matchResult.diagnostics.confidence !== undefined
                        ? `${String(matchResult.diagnostics.confidence)} / 100`
                        : "not returned"}
                    </strong>{" "}
                    — this is GBIF's internal match score for the name string,
                    <strong> not a certainty</strong> that this is your plant.
                  </p>

                  <p className="text-text-secondary" data-testid="gbif-candidate-family">
                    Family (GBIF classification):{" "}
                    <strong className="text-text-primary">
                      {gbifFamilyOf(matchResult) ?? "not returned"}
                    </strong>
                  </p>

                  {acceptedUsage && (
                    <div className="rounded-lg bg-surface-muted p-3" data-testid="gbif-accepted-usage">
                      <p className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
                        {usage.status === "SYNONYM"
                          ? "GBIF's currently accepted name for this synonym"
                          : "GBIF's currently accepted name"}
                      </p>
                      <p className="mt-1 italic text-text-primary">
                        {gbifDisplayName(acceptedUsage)}
                      </p>
                      <p className="mt-1 text-xs text-text-secondary">
                        Shown for comparison only — the stored catalog name was
                        not changed.
                      </p>
                    </div>
                  )}

                  <p className="text-xs text-text-secondary">
                    <a
                      className="text-primary underline"
                      href={gbifSpeciesPageUrl(usage)}
                      target="_blank"
                      rel="noreferrer"
                      data-testid="gbif-source-link"
                    >
                      Source record on gbif.org
                    </a>
                  </p>
                </div>
              )}

              {/* Query/retrieval provenance — rendered for every successful
                  response, including no-candidate (NONE) results. The API
                  request link is the exact reproducible query; no species
                  record link is fabricated when GBIF returned no usage. */}
              <p className="mt-2 text-xs text-text-secondary" data-testid="gbif-provenance">
                <span data-testid="gbif-retrieved-at">
                  retrieved {formatTimestamp(outcome.retrievedAt)}
                </span>
                {outcome.fromCache ? " (from this session's cache)" : ""}
                {" · queried “"}
                {requestedName}
                {"” · "}
                <a
                  className="text-primary underline"
                  href={outcome.requestUrl}
                  target="_blank"
                  rel="noreferrer"
                  data-testid="gbif-api-request-link"
                >
                  GBIF species-match API request
                </a>
              </p>

              <p role="status" className="sr-only" data-testid="gbif-announce-done">
                {usage
                  ? `GBIF query complete. Candidate returned: ${gbifDisplayName(usage)}.`
                  : "GBIF query complete. No candidate returned."}
              </p>

              {/* Plain-language findings: review items first */}
              {(reviewFindingsList.length > 0 || infoFindings.length > 0) && (
                <div className="mt-4 space-y-2" data-testid="gbif-findings">
                  {reviewFindingsList.map((f) => (
                    <div
                      key={f.title}
                      className="rounded-lg border border-status-warning-text/40 bg-status-warning-bg p-3"
                      data-testid="gbif-finding-review"
                    >
                      <p className="text-sm font-semibold text-text-primary">
                        ⚠ {f.title}
                      </p>
                      <p className="mt-1 text-xs text-text-secondary">{f.explanation}</p>
                    </div>
                  ))}
                  {infoFindings.map((f) => (
                    <div
                      key={f.title}
                      className="rounded-lg border border-border-default bg-surface-muted p-3"
                      data-testid="gbif-finding-info"
                    >
                      <p className="text-sm font-semibold text-text-primary">
                        {f.title}
                      </p>
                      <p className="mt-1 text-xs text-text-secondary">{f.explanation}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </Card>
      </div>

      <p className="mt-6 text-xs text-text-secondary" data-testid="gbif-scope-note">
        Scope of this prototype: name/taxonomy lookups only. No cultivation
        advice, no species normalization, no imports, no background or bulk
        queries, and no writes to your garden data. Offline: the app is
        unaffected; this screen simply reports that GBIF is unreachable.
      </p>
    </div>
  );
}
