// Taxonomic name helpers shared by the resolvers and tests.
// Jninty's authored species strings are clean (no authorship); source
// scientific names carry authorship, so canonical forms are rebuilt from
// rank-aware token positions or structured columns — never by author
// stripping heuristics.

const RANK_MARKERS = ["var.", "subsp.", "f.", "forma"];

/** Classify an authored Jninty species string. */
export function speciesKind(name) {
  if (/\s+spp\.$/.test(name)) return "aggregate";
  if (/\s+(var\.|subsp\.|f\.|forma)\s+/.test(name)) return "infraspecific";
  if (name.includes("×")) return "hybrid";
  return "binomial";
}

/**
 * Canonical key for an authored Jninty species string: lowercased, with
 * rank markers preserved and aggregates reduced to the genus.
 * "Brassica oleracea var. capitata" -> "brassica oleracea var. capitata"
 * "Rosa spp."                       -> "rosa"
 */
export function authoredCanonical(name) {
  const base = name.replace(/\s+spp\.$/, "").trim().toLowerCase();
  return base.replace(/\s+/g, " ");
}

/** Genus (first token) of an authored string, aggregates included. */
export function authoredGenus(name) {
  return authoredCanonical(name).split(" ")[0];
}

const RANK_MARKER_FOR = {
  variety: "var.",
  subspecies: "subsp.",
  form: "f.",
  forma: "f.",
};

/**
 * Canonical key for a source scientificName + rank. Rebuilds the name from
 * leading tokens so authorship is dropped deterministically:
 *   "Malus × domestica" (species)          -> "malus × domestica"
 *   "Brassica oleracea var. capitata L." (variety) -> "brassica oleracea var. capitata"
 *   "Rosmarinus officinalis L." (species)  -> "rosmarinus officinalis"
 */
export function sourceCanonical(scientificName, rank) {
  const tokens = String(scientificName).trim().split(/\s+/);
  const marker = RANK_MARKER_FOR[String(rank ?? "").toLowerCase()];
  if (marker) {
    // genus epithet marker infraepithet [authorship...]
    return tokens.slice(0, 4).join(" ").toLowerCase();
  }
  if (String(rank ?? "").toLowerCase() === "genus") {
    return (tokens[0] ?? "").toLowerCase();
  }
  // species and unranked: genus + epithet (epithet may carry a hybrid ×)
  return tokens.slice(0, 2).join(" ").toLowerCase();
}

/**
 * Hybrid-insensitive secondary key: the hybrid marker "×" is dropped, so
 * Jninty's "Malus domestica" can be matched to a source "Malus × domestica"
 * explicitly (and flagged for review rather than silently treated as clean).
 */
export function hybridInsensitiveKey(canonical) {
  return canonical.replace(/×\s*/g, "").replace(/\s+/g, " ");
}
