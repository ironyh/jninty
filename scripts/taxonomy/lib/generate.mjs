// Pure artifact builder: Jninty input species + WFO/Dyntaxa resolver results
// + explicit overrides -> taxonomy artifact object. Deterministic: rows are
// sorted by jnintySpecies, name arrays sorted; only `generatedAt` and source
// `retrievedAt` timestamps are volatile.
import { authoredCanonical, sourceCanonical, speciesKind } from "./names.mjs";

function classifyReview(wfo, dyntaxa, hasOverride) {
  const notes = [];
  const info = [];
  let status = "clean";

  if (wfo) {
    if (wfo.matchType === "synonym") notes.push(`WFO treats Jninty's name as a synonym; accepted name is ${wfo.acceptedName}`);
    if (wfo.matchType === "ambiguous") notes.push("WFO has multiple accepted candidates — not auto-resolved: " + (wfo.candidates ?? []).join(" | "));
    if (wfo.matchType === "genus-only") notes.push("aggregate name — resolved at genus rank only");
    if (wfo.matchType === "unreviewed") notes.push("WFO backbone rows for this name are unreviewed (status: " + (wfo.status ?? "?") + ")");
    if (["unresolved", "unresolved-aggregate", "error"].includes(wfo.matchType)) notes.push("WFO: " + wfo.matchType);
    if (Array.isArray(wfo.notes)) notes.push(...wfo.notes);
    const wfoAcceptedCanonical = sourceCanonical(wfo.acceptedName, wfo.rank);
    if (wfoAcceptedCanonical && !hasOverride && wfoAcceptedCanonical !== authoredCanonical(wfo.jnintySpecies) && wfo.matchType !== "genus-only") {
      notes.push("WFO accepted name differs from Jninty species string (Jninty name preserved)");
    }
    // explicit conflicts force needs-review even when the match type is "accepted"
    if (wfo.needsReview === true || (Array.isArray(wfo.candidates) && wfo.candidates.length > 0)) {
      if (wfo.needsReview === true && wfo.matchType === "accepted") {
        notes.push("WFO backbone conflict: " + (wfo.candidates ?? []).join(" | "));
      }
      if (wfo.matchType !== "accepted" || wfo.needsReview === true) status = "needs-review";
    }
    if (Array.isArray(wfo.info)) info.push(...wfo.info);
  } else notes.push("no WFO result");

  if (dyntaxa) {
    if (dyntaxa.matchType === "absent") notes.push("absent from Dyntaxa (legitimate for garden exotics; not an error)");
    if (dyntaxa.matchType === "synonym") notes.push("Dyntaxa treats name as synonym of " + (dyntaxa.acceptedName ?? "?"));
    if (dyntaxa.matchType === "genus-level") notes.push("Dyntaxa genus-level only");
    if (dyntaxa.matchType === "ambiguous") notes.push("Dyntaxa ambiguous — not auto-resolved");
  } else if (!hasOverride) notes.push("no Dyntaxa result");

  if (hasOverride) status = "manual-override";
  else if (notes.length > 0) status = "needs-review";

  if (dyntaxa?.scientificName && wfo?.acceptedName && dyntaxa.matchType !== "manual") {
    const dynCanon = dyntaxa.canonicalName ?? dyntaxa.scientificName;
    const wfoCanon = sourceCanonical(wfo.acceptedName, wfo.rank);
    const agrees = dynCanon.toLowerCase() === wfoCanon.toLowerCase() ||
      dynCanon.toLowerCase().startsWith(wfoCanon.toLowerCase()) ||
      wfoCanon.toLowerCase().startsWith(dynCanon.toLowerCase());
    if (!agrees) {
      info.push(`authority disagreement: Dyntaxa '${dynCanon}' vs WFO accepted '${wfoCanon}'`);
      if (status === "clean") status = "needs-review";
    }
  }

  return { status, notes, info };
}

/**
 * @param {object} params
 * @param {string[]} params.species        authored Jninty species strings (deduped)
 * @param {Map}    params.wfoResults       species -> WFO resolver result
 * @param {Map}    params.dyntaxaResults   species -> Dyntaxa resolver result
 * @param {object} params.overridesDoc     parsed data/taxonomy/overrides.json
 * @param {object} params.sources          pinned source metadata (committed inputs)
 * @param {string} params.generatedAt
 * @param {(override, sources) => {stale: string|null, dyntaxa: object|null}} params.applyOverrideCheck
 */
export function buildTaxonomyArtifact({ species, wfoResults, dyntaxaResults, overridesDoc, sources, generatedAt, applyOverrideCheck }) {
  const overrides = new Map((overridesDoc?.overrides ?? []).map((o) => [o.jnintySpecies, o]));

  const taxa = species.map((jnintySpecies) => {
    const wfo = wfoResults.get(jnintySpecies) ?? null;
    let dyntaxa = dyntaxaResults.get(jnintySpecies) ?? null;
    const ov = overrides.get(jnintySpecies) ?? null;
    let reviewStatus = "clean";
    let extraNotes = [];

    if (ov) {
      const { stale, dyntaxa: manualDyntaxa } = applyOverrideCheck(ov, { wfoResults, dyntaxaResults });
      if (manualDyntaxa) {
        dyntaxa = { ...manualDyntaxa, liveQueryResult: dyntaxa ? { matchType: dyntaxa.matchType, scientificName: dyntaxa.scientificName ?? null } : null };
      }
      extraNotes.push("manual override: " + (ov.note ?? ov.sources?.dyntaxa?.decision ?? ""));
      reviewStatus = stale ? "stale-override" : "manual-override";
      if (stale) extraNotes.push(stale);
    }

    const classification = classifyReview(
      wfo ? { ...wfo, jnintySpecies } : null,
      dyntaxa,
      Boolean(ov),
    );

    return {
      jnintySpecies,
      speciesKind: speciesKind(jnintySpecies),
      wfo: wfo ? {
        id: wfo.id ?? null,
        matchedName: wfo.matchedName ?? null,
        acceptedName: wfo.acceptedName ?? null,
        acceptedWfoId: wfo.acceptedWfoId ?? null,
        status: wfo.status ?? null,
        rank: wfo.rank ?? null,
        matchType: wfo.matchType ?? null,
        candidates: wfo.candidates ?? null,
      } : null,
      dyntaxa: dyntaxa ? {
        id: dyntaxa.id ?? null,
        scientificName: dyntaxa.scientificName ?? null,
        canonicalName: dyntaxa.canonicalName ?? null,
        acceptedName: dyntaxa.acceptedName ?? null,
        acceptedId: dyntaxa.acceptedId ?? null,
        taxonomicStatus: dyntaxa.taxonomicStatus ?? null,
        rank: dyntaxa.rank ?? null,
        matchType: dyntaxa.matchType ?? null,
        recommendedSwedishName: dyntaxa.recommendedSwedishName ?? null,
        otherSwedishNames: dyntaxa.otherSwedishNames ?? null,
        liveQueryResult: dyntaxa.liveQueryResult ?? null,
      } : null,
      review: {
        // an override's status (manual-override / stale-override) takes
        // precedence over the automatic classification
        status: reviewStatus === "clean" ? classification.status : reviewStatus,
        notes: [...extraNotes, ...classification.notes],
        info: classification.info,
      },
    };
  }).sort((a, b) => a.jnintySpecies.localeCompare(b.jnintySpecies));

  const tally = (f) => taxa.reduce((acc, t) => {
    const k = f(t) ?? "missing";
    acc[k] = (acc[k] ?? 0) + 1;
    return acc;
  }, {});

  return {
    schemaVersion: 1,
    generatedAt,
    resolver: { name: "jninty-taxonomy-pipeline", version: "1.0.0" },
    inputs: sources,
    overridesApplied: taxa.filter((t) => ["manual-override", "stale-override"].includes(t.review.status)).map((t) => t.jnintySpecies),
    summary: {
      totalSpecies: taxa.length,
      wfoMatchTypes: tally((t) => t.wfo?.matchType),
      dyntaxaMatchTypes: tally((t) => t.dyntaxa?.matchType),
      reviewStatuses: tally((t) => t.review.status),
      swedishNameCoverage: taxa.filter((t) => t.dyntaxa?.recommendedSwedishName || (t.dyntaxa?.otherSwedishNames?.length ?? 0) > 0).length,
    },
    taxa,
  };
}
