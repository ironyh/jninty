// Taxonomy-derived search aliases for built-in PlantKnowledge search.
//
// Consumes the committed data/taxonomy/taxonomy.json artifact (generated
// offline by scripts/taxonomy from pinned WFO + Dyntaxa snapshots). This
// module is synchronous and fully offline; it never contacts a network,
// never writes to PouchDB, and never changes stored plant names.
//
// Failure behaviour: if the artifact is missing or malformed, the alias
// index is empty and searchKnowledge() behaves exactly as before.
import taxonomyJson from "../../data/taxonomy/taxonomy.json";

interface WfoBlock {
  matchType?: string;
  acceptedName?: string | null;
  matchedName?: string | null;
}
interface DyntaxaBlock {
  matchType?: string;
  scientificName?: string | null;
  acceptedName?: string | null;
  recommendedSwedishName?: string | null;
  otherSwedishNames?: string[] | null;
}
interface TaxonRow {
  jnintySpecies?: string;
  wfo?: WfoBlock | null;
  dyntaxa?: DyntaxaBlock | null;
}

export interface TaxonomyAliasEntry {
  /** Alias exactly as recorded in the source data. */
  alias: string;
  /** Lowercase, whitespace-collapsed form. */
  normalized: string;
  /** Diacritic- and hybrid-marker-folded form for tolerant matching. */
  folded: string;
  /** Provenance of the alias (diagnostics only; not user-facing). */
  source: string;
}

/** normalized alias -> entries (deterministically ordered) */
export type TaxonomyAliasIndex = Map<string, TaxonomyAliasEntry[]>;

const fold = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
const stripHybridMarker = (s: string) => s.replace(/×\s*/g, "").replace(/\bx\s+/gi, " ");
const base = (s: string) => String(s ?? "").replace(/\s+/g, " ").trim();
const normalized = (s: string) => base(s).toLowerCase();
const foldedKey = (s: string) => fold(stripHybridMarker(normalized(s)));

function isTaxonomyArtifact(value: unknown): value is { taxa: TaxonRow[] } {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { taxa?: unknown };
  return Array.isArray(candidate.taxa);
}

/**
 * Build the alias index from a taxonomy artifact. Pure and deterministic.
 * Conservative inclusion policy — an alias is indexed only when its own
 * evidence is unambiguous, regardless of the row's overall review status:
 *   - WFO acceptedName when matchType is "accepted" or "synonym"
 *   - WFO matchedName when matchType is "synonym" (the explicit synonym spelling)
 *   - the genus name for genus-only matches (authored aggregates)
 *   - Dyntaxa scientificName / acceptedName for exact matches
 *   - Swedish names for exact and manual-override matches
 * Never indexed: ambiguous candidate names, unresolved/unreviewed values,
 * IDs, review notes, cultivar data, or Jninty's own authored species string
 * (that string is already matched by the existing species field).
 */
export function buildTaxonomyAliasIndex(artifact: unknown): TaxonomyAliasIndex {
  const index: TaxonomyAliasIndex = new Map();
  if (!isTaxonomyArtifact(artifact)) return index;

  const add = (alias: string, source: string, bucket: TaxonomyAliasIndex) => {
    const normalizedForm = normalized(alias);
    if (!normalizedForm) return;
    const entry: TaxonomyAliasEntry = { alias, normalized: normalizedForm, folded: foldedKey(alias), source };
    if (!bucket.has(normalizedForm)) bucket.set(normalizedForm, []);
    bucket.get(normalizedForm)!.push(entry);
  };

  const genusOf = (scientificName: string) =>
    base(scientificName).split(" ")[0] ?? "";

  for (const taxon of artifact.taxa) {
    if (typeof taxon.jnintySpecies !== "string" || !taxon.jnintySpecies) continue;
    const species = taxon.jnintySpecies;
    const wfo = taxon.wfo ?? null;
    const dyntaxa = taxon.dyntaxa ?? null;

    // WFO-derived aliases are staged separately: when the WFO row itself is
    // ambiguous, its candidate names must never enter the index (a conflict
    // taints WFO-derived names only — independent Dyntaxa/manual/authored
    // evidence stays usable).
    const wfoBucket: TaxonomyAliasIndex = new Map();
    const otherBucket: TaxonomyAliasIndex = new Map();

    if (wfo) {
      if (wfo.matchType === "accepted" || wfo.matchType === "synonym") {
        if (wfo.acceptedName) add(wfo.acceptedName, "wfo.acceptedName", wfoBucket);
        if (wfo.matchType === "synonym" && wfo.matchedName &&
            normalized(wfo.matchedName) !== normalized(species)) {
          add(wfo.matchedName, "wfo.synonymName", wfoBucket);
        }
      } else if (wfo.matchType === "genus-only" && wfo.acceptedName) {
        add(genusOf(wfo.acceptedName), "wfo.genusName", wfoBucket);
      }
      // ambiguous / unresolved / unreviewed / error: nothing staged
    }

    if (dyntaxa) {
      if (dyntaxa.matchType === "exact") {
        if (dyntaxa.scientificName) add(dyntaxa.scientificName, "dyntaxa.scientificName", otherBucket);
        if (dyntaxa.acceptedName) add(dyntaxa.acceptedName, "dyntaxa.acceptedName", otherBucket);
      }
      if (dyntaxa.matchType === "exact" || dyntaxa.matchType === "manual") {
        if (dyntaxa.recommendedSwedishName) add(dyntaxa.recommendedSwedishName, "dyntaxa.swedish.preferred", otherBucket);
        for (const name of dyntaxa.otherSwedishNames ?? []) add(name, "dyntaxa.swedish.other", otherBucket);
      }
      if (dyntaxa.matchType === "manual" && dyntaxa.scientificName) {
        add(dyntaxa.scientificName, "override.dyntaxa", otherBucket);
      }
      // absent / genus-level / ambiguous: nothing indexed
    }

    const taintedWfo = wfo?.matchType === "ambiguous";
    for (const [key, entries] of wfoBucket) {
      if (taintedWfo) continue;
      if (!index.has(key)) index.set(key, []);
      index.get(key)!.push(...entries);
    }
    for (const [key, entries] of otherBucket) {
      if (!index.has(key)) index.set(key, []);
      index.get(key)!.push(...entries);
    }
  }

  // Deterministic ordering: sort each bucket by normalized form then source.
  for (const entries of index.values()) {
    entries.sort((a, b) => a.normalized.localeCompare(b.normalized) || a.source.localeCompare(b.source));
  }
  return index;
}

let cachedIndex: TaxonomyAliasIndex | null = null;
let cacheInitialized = false;

/** Memoized alias index over the bundled artifact; empty map on any failure. */
export function getTaxonomyAliasIndex(): TaxonomyAliasIndex {
  if (!cacheInitialized) {
    try {
      cachedIndex = buildTaxonomyAliasIndex(taxonomyJson);
    } catch {
      cachedIndex = new Map<string, TaxonomyAliasEntry[]>(); // graceful fallback
    }
    cacheInitialized = true;
  }
  // module-level `let` can't be narrowed across the guard above
  return cachedIndex ?? new Map<string, TaxonomyAliasEntry[]>();
}

/** Authored species -> alias strings, for diagnostics and tests. */
export function getTaxonomyAliasesBySpecies(): Map<string, string[]> {
  if (!speciesMapInitialized) buildSpeciesMap();
  return speciesMap;
}

let speciesMap: Map<string, string[]> = new Map();
let speciesMapInitialized = false;

function buildSpeciesMap(): void {
  // The alias index alone is alias-keyed; derive the species map from the
  // artifact through the same guarded path and inclusion policy.
  try {
    if (!isTaxonomyArtifact(taxonomyJson)) return;
    for (const taxon of taxonomyJson.taxa) {
      if (typeof taxon.jnintySpecies !== "string" || !taxon.jnintySpecies) continue;
      const species = taxon.jnintySpecies;
      const names: string[] = [];
      if (taxon.wfo) {
        if (wfoSafe(taxon.wfo.matchType) && taxon.wfo.acceptedName) names.push(taxon.wfo.acceptedName);
        if (taxon.wfo.matchType === "synonym" && taxon.wfo.matchedName &&
            normalized(taxon.wfo.matchedName) !== normalized(species)) names.push(taxon.wfo.matchedName);
        if (taxon.wfo.matchType === "genus-only" && taxon.wfo.acceptedName) names.push(genusName(taxon.wfo.acceptedName));
      }
      if (taxon.dyntaxa) {
        if (taxon.dyntaxa.matchType === "exact") {
          if (taxon.dyntaxa.scientificName) names.push(taxon.dyntaxa.scientificName);
          if (taxon.dyntaxa.acceptedName) names.push(taxon.dyntaxa.acceptedName);
        }
        if (taxon.dyntaxa.matchType === "exact" || taxon.dyntaxa.matchType === "manual") {
          if (taxon.dyntaxa.recommendedSwedishName) names.push(taxon.dyntaxa.recommendedSwedishName);
          for (const name of taxon.dyntaxa.otherSwedishNames ?? []) names.push(name);
        }
        if (taxon.dyntaxa.matchType === "manual" && taxon.dyntaxa.scientificName) names.push(taxon.dyntaxa.scientificName);
      }
      const unique = [...new Set(names.map((n) => normalized(n)))].filter((n) => n.length > 0);
      if (unique.length > 0) speciesMap.set(foldedKey(species), unique);
    }
  } catch {
    speciesMap = new Map(); // graceful fallback
  } finally {
    speciesMapInitialized = true;
  }
}

function wfoSafe(matchType?: string) {
  return matchType === "accepted" || matchType === "synonym";
}
function genusName(acceptedName: string) {
  return base(acceptedName).split(" ")[0] ?? "";
}

/**
 * Match a search query against taxonomy aliases.
 * Returns authored species strings ordered by match strength:
 *   1. exact (diacritic-preserving) alias
 *   2. exact diacritic/hybrid-folded alias
 *   3. normalized prefix
 *   4. folded prefix / normalized substring
 * Ambiguous candidates and unresolved values are never in the index, so
 * they can never be returned. Deterministic.
 */
export function matchTaxonomyAliases(query: string): string[] {
  if (!speciesMapInitialized) getTaxonomyAliasesBySpecies();
  const exact = normalized(query);
  const toler = foldedKey(query);
  if (!exact) return [];

  const best = new Map<string, number>(); // species -> tier
  const consider = (species: string, tier: number) => {
    const cur = best.get(species);
    if (cur === undefined || tier < cur) best.set(species, tier);
  };

  for (const [species, aliases] of speciesMap) {
    let tier: number | null = null;
    for (const aliasNorm of aliases) {
      if (tier != null && tier <= 3) continue; // already a strong match
      let candidateTier: number | null = null;
      if (aliasNorm === exact) candidateTier = 1;
      else {
        const aliasFolded = fold(aliasNorm);
        if (aliasFolded === toler) candidateTier = 2;
        else if (aliasNorm.startsWith(exact)) candidateTier = 3;
        else if (aliasFolded.startsWith(toler)) candidateTier = 4;
        else if (aliasNorm.includes(exact) && exact.length >= 3) candidateTier = 5;
        else if (aliasFolded.includes(toler) && toler.length >= 3) candidateTier = 6;
      }
      if (candidateTier != null && (tier === null || candidateTier < tier)) tier = candidateTier;
    }
    if (tier != null) consider(species, tier);
  }

  return [...best.entries()]
    .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
    .map(([species]) => species);
}
