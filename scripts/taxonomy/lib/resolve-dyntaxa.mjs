// Dyntaxa resolution against a pinned DwC-A snapshot (Taxon core rows +
// VernacularName extension rows). Same conservative policy as WFO. Swedish
// names are enrichment: `recommendedSwedishName` uses the dataset's
// isPreferredName flag when present.
import { authoredCanonical, authoredGenus, hybridInsensitiveKey, sourceCanonical } from "./names.mjs";

const ACCEPTED = new Set(["accepted"]);

// A scientificName whose token following the canonical portion is a hybrid
// marker or aggregate/section token belongs to a DIFFERENT taxon than the
// plain name ("Rubus idaeus × sect. Corylifolii" ≠ "Rubus idaeus"). Such rows
// get their own bucket key so they can never collide with the plain species.
const CONTINUATION_TOKENS = new Set(["×", "x", "agg.", "sect.", "subg.", "convar."]);

function bucketKey(scientificName, rank) {
  const tokens = String(scientificName).trim().split(/\s+/);
  const marker = { variety: "var.", subspecies: "subsp.", form: "f.", forma: "f." }[String(rank ?? "").toLowerCase()];
  let canonical;
  if (marker) canonical = tokens.slice(0, 4).join(" ");
  else if (String(rank ?? "").toLowerCase() === "genus") canonical = tokens[0] ?? "";
  else canonical = tokens.slice(0, 2).join(" ");
  const next = tokens[canonical.split(" ").length];
  if (next && CONTINUATION_TOKENS.has(next.toLowerCase())) {
    // continuation name: key on the full scientific name (unique per row)
    return "named:" + String(scientificName).toLowerCase();
  }
  return canonical.toLowerCase();
}

export function buildDyntaxaIndex(taxonRows, vernacularRows) {
  const byId = new Map();
  const byCanonical = new Map();
  const genusRows = new Map();
  for (const row of taxonRows) {
    byId.set(row.taxonId, row);
    const rank = String(row.taxonRank ?? "").toLowerCase();
    const canonical = bucketKey(row.scientificName, rank);
    if (rank === "genus") {
      if (!genusRows.has(canonical)) genusRows.set(canonical, []);
      genusRows.get(canonical).push(row);
      continue;
    }
    if (!byCanonical.has(canonical)) byCanonical.set(canonical, []);
    byCanonical.get(canonical).push(row);
  }
  const sweByTaxon = new Map();
  for (const v of vernacularRows) {
    const lang = String(v.language ?? "").toLowerCase();
    if (lang !== "sv" && lang !== "swe") continue;
    if (!sweByTaxon.has(v.taxonId)) sweByTaxon.set(v.taxonId, { preferred: [], all: [] });
    const entry = sweByTaxon.get(v.taxonId);
    entry.all.push(v.vernacularName);
    if (String(v.isPreferredName ?? "").toLowerCase() === "true") entry.preferred.push(v.vernacularName);
  }
  return { byId, byCanonical, genusRows, sweByTaxon };
}

export function resolveDyntaxa(index, jnintySpecies) {
  const isAggregate = /\s+spp\.$/.test(jnintySpecies);
  const genusKey = authoredGenus(jnintySpecies);
  const sweOf = (row) => {
    const swe = index.sweByTaxon.get(row.taxonId);
    return {
      recommendedSwedishName: swe?.preferred?.[0] ?? null,
      otherSwedishNames: swe?.all?.slice().sort() ?? null,
    };
  };
  const base = (matchType) => ({
    matchType,
    id: null,
    scientificName: null,
    canonicalName: null,
    acceptedName: null,
    acceptedId: null,
    taxonomicStatus: null,
    rank: null,
    recommendedSwedishName: null,
    otherSwedishNames: null,
    synonyms: null,
  });

  if (isAggregate) {
    const rows = index.genusRows.get(genusKey) ?? [];
    const accepted = rows.find((r) => ACCEPTED.has(String(r.taxonomicStatus ?? "").toLowerCase()));
    if (!accepted) return base("absent");
    return {
      ...base("genus-level"),
      id: accepted.taxonId,
      scientificName: accepted.scientificName,
      canonicalName: genusKey,
      taxonomicStatus: accepted.taxonomicStatus,
      rank: accepted.taxonRank,
      ...sweOf(accepted),
    };
  }

  const key = authoredCanonical(jnintySpecies);
  let rows = index.byCanonical.get(key) ?? [];
  if (rows.length === 0) rows = index.byCanonical.get(hybridInsensitiveKey(key)) ?? [];
  if (rows.length === 0) return base("absent");

  const acceptedRows = rows.filter((r) => ACCEPTED.has(String(r.taxonomicStatus ?? "").toLowerCase()));
  if (acceptedRows.length !== 1) return base(acceptedRows.length === 0 ? "absent" : "ambiguous");
  const a = acceptedRows[0];
  return {
    ...base("exact"),
    id: a.taxonId,
    scientificName: a.scientificName,
    canonicalName: sourceCanonical(a.scientificName, a.taxonRank),
    taxonomicStatus: a.taxonomicStatus,
    rank: a.taxonRank,
    ...sweOf(a),
  };
}
