// WFO resolution against a pinned backbone release (classification.csv rows).
// Conservative match policy:
//   - exactly one "accepted" row for a canonical key  -> accepted
//   - no accepted rows, synonym rows present          -> synonym (accepted name
//     followed via acceptedNameUsageID; disagreement between synonyms -> ambiguous)
//   - more than one accepted row                      -> ambiguous (never auto-picked)
//   - only unreviewed rows (Unchecked/Unplaced/...)   -> unreviewed (needs-review)
//   - authored "X spp." aggregates resolve at genus rank only
import { authoredCanonical, authoredGenus, hybridInsensitiveKey, sourceCanonical } from "./names.mjs";

const ACCEPTED = new Set(["accepted"]);
const SYNONYM = new Set(["synonym"]);

const RANK_MARKER = { variety: " var. ", subspecies: " subsp. ", form: " f. ", forma: " f. " };

export function buildWfoIndex(rows) {
  const byCanonical = new Map();
  const genusRows = new Map();
  const byId = new Map();
  for (const row of rows) {
    byId.set(row.taxonID, row);
    const rank = String(row.taxonRank ?? "").toLowerCase();
    if (rank === "genus") {
      const key = String(row.genus ?? row.scientificName ?? "").toLowerCase();
      if (!genusRows.has(key)) genusRows.set(key, []);
      genusRows.get(key).push(row);
      continue;
    }
    const species = row.species ?? "";
    const infra = row.infraspecificEpithet ?? "";
    const marker = row.infraspecificEpithet ? (RANK_MARKER[rank] ?? " var. ") : "";
    // Prefer structured columns; fall back to rank-aware rebuild for rows
    // missing epithet columns.
    const canonical = row.genus && row.specificEpithet
      ? `${row.genus} ${row.specificEpithet}${marker}${infra}`.trim()
      : sourceCanonical(row.scientificName, row.taxonRank);
    const key = canonical.toLowerCase();
    if (!byCanonical.has(key)) byCanonical.set(key, []);
    byCanonical.get(key).push(row);
  }
  return { byCanonical, genusRows, byId };
}

function status(row) {
  return String(row.taxonomicStatus ?? "").toLowerCase();
}

export function resolveWfo(index, jnintySpecies) {
  const isAggregate = /\s+spp\.$/.test(jnintySpecies);
  if (isAggregate) {
    const rows = index.genusRows.get(authoredGenus(jnintySpecies)) ?? [];
    const accepted = rows.find((r) => ACCEPTED.has(status(r)));
    if (!accepted) return { matchType: "unresolved-aggregate",
      needsReview: true, id: null, matchedName: null, acceptedName: null, acceptedWfoId: null, status: null, rank: null, candidates: null };
    return {
      matchType: "genus-only",
      needsReview: true,
      id: accepted.taxonID,
      matchedName: accepted.scientificName,
      acceptedName: accepted.scientificName,
      acceptedWfoId: accepted.taxonID,
      status: accepted.taxonomicStatus,
      rank: accepted.taxonRank,
      candidates: null,
    };
  }

  const key = authoredCanonical(jnintySpecies);
  let rows = index.byCanonical.get(key) ?? [];
  let hybridNote = null;
  if (rows.length === 0) {
    // hybrid-marker tolerant secondary lookup (e.g. Jninty "Malus domestica"
    // vs WFO "Malus × domestica"); recorded as a note, never silent.
    rows = index.byCanonical.get(hybridInsensitiveKey(key)) ?? [];
    if (rows.length > 0) hybridNote = "source name carries the hybrid marker ×; Jninty's authored string omits it";
  }
  if (rows.length === 0) return { matchType: "unresolved",
      needsReview: true, id: null, matchedName: null, acceptedName: null, acceptedWfoId: null, status: null, rank: null, candidates: null };

  const notes = [];
  if (hybridNote) notes.push(hybridNote);
  const acceptedRows = rows.filter((r) => ACCEPTED.has(status(r)));
  if (acceptedRows.length === 1) {
    const a = acceptedRows[0];
    const others = rows.filter((r) => r.taxonID !== a.taxonID);
    // Synonyms pointing AT the accepted row are its own homotypic synonyms —
    // benign. Synonyms pointing elsewhere, or unreviewed rows, are conflicts.
    const disagreeing = others.filter((r) => SYNONYM.has(status(r)) && r.acceptedNameUsageID !== a.taxonID);
    const unreviewed = others.filter((r) => !ACCEPTED.has(status(r)) && !SYNONYM.has(status(r)));
    const notes = [];
    if (hybridNote) notes.push(hybridNote);
    const info = [];
    if (others.length > 0) info.push(`${others.length} backbone row(s) share this canonical name (accepted: ${a.taxonID})`);
    if (unreviewed.length > 0) info.push(`${unreviewed.length} unreviewed row(s) share this canonical name`);
    return {
      matchType: "accepted",
      needsReview: disagreeing.length > 0,
      id: a.taxonID,
      matchedName: a.scientificName,
      acceptedName: a.scientificName,
      acceptedWfoId: a.taxonID,
      status: a.taxonomicStatus,
      rank: a.taxonRank,
      candidates: disagreeing.length > 0 ? disagreeing.map((r) => `${r.taxonID} ${r.scientificName} -> ${r.acceptedNameUsageID}`).sort() : null,
      notes,
      info,
    };
  }
  if (acceptedRows.length > 1) {
    return {
      matchType: "ambiguous",
      needsReview: true,
      id: null, matchedName: null, acceptedName: null, acceptedWfoId: null, status: null, rank: null,
      candidates: acceptedRows.map((r) => `${r.taxonID} ${r.scientificName}`).sort(),
    };
  }
  const synonymRows = rows.filter((r) => SYNONYM.has(status(r)));
  if (synonymRows.length > 0) {
    const acceptedIds = [...new Set(synonymRows.map((r) => r.acceptedNameUsageID).filter(Boolean))].sort();
    if (acceptedIds.length === 1) {
      const a = index.byId.get(acceptedIds[0]);
      if (a) {
        return {
          matchType: "synonym",
          needsReview: true,
          id: synonymRows[0].taxonID,
          matchedName: synonymRows[0].scientificName,
          acceptedName: a.scientificName,
          acceptedWfoId: a.taxonID,
          status: synonymRows[0].taxonomicStatus,
          rank: synonymRows[0].taxonRank,
          candidates: notes.length ? notes : null,
        };
      }
    }
    return {
      matchType: "ambiguous",
      needsReview: true,
      id: null, matchedName: null, acceptedName: null, acceptedWfoId: null, status: null, rank: null,
      candidates: synonymRows.map((r) => `${r.taxonID} ${r.scientificName} -> ${r.acceptedNameUsageID ?? "?"}`).sort(),
    };
  }
  return {
    matchType: "unreviewed",
      needsReview: true,
    id: rows[0].taxonID,
    matchedName: rows[0].scientificName,
    acceptedName: null,
    acceptedWfoId: null,
    status: rows[0].taxonomicStatus,
    rank: rows[0].taxonRank,
    candidates: null,
    notes: [],
  };
}
