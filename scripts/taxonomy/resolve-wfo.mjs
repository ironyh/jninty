// CLI: resolve all Jninty species against the pinned WFO backbone snapshot.
// Requires the pinned release in .taxonomy-cache/ (see data/taxonomy/README.md).
// Offline — performs no network requests.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { lines, splitDelimited } from "./lib/lines.mjs";
import { extractEntry } from "./lib/zipExtract.mjs";
import { buildWfoIndex, resolveWfo } from "./lib/resolve-wfo.mjs";
import { authoredCanonical } from "./lib/names.mjs";

const dir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(dir, "../..");
const cache = path.join(root, ".taxonomy-cache");

// The WFO pin (file, release) is authored in data/taxonomy/sources.json so
// advancing to a new release is a data change, not a code change.
const pin = JSON.parse(fs.readFileSync(path.join(root, "data/taxonomy/sources.json"), "utf8")).wfo;
const SOURCE = {
  file: pin.file,
  entry: "classification.csv",
  extracted: `wfo-${pin.release.replace(/[^a-z0-9]+/gi, "-")}-classification.csv`,
};

const RANK_MARKER = { variety: " var. ", subspecies: " subsp. ", form: " f. ", forma: " f. " };

async function main() {
  const zipPath = path.join(cache, SOURCE.file);
  if (!fs.existsSync(zipPath)) {
    console.error(`WFO snapshot missing: ${zipPath}. Run the source refresh first (see data/taxonomy/README.md).`);
    process.exit(1);
  }
  const csvPath = path.join(cache, SOURCE.extracted);
  if (!fs.existsSync(csvPath)) {
    console.log("Extracting WFO classification.csv from pinned snapshot…");
    await extractEntry(zipPath, SOURCE.entry, csvPath);
  }

  // Column map for WFO classification.csv (verified against the pinned release).
  const COLS = ["taxonID", "scientificNameID", "localID", "scientificName", "taxonRank", "parentNameUsageID", "scientificNameAuthorship", "family", "subfamily", "tribe", "subtribe", "genus", "subgenus", "specificEpithet", "infraspecificEpithet", "verbatimTaxonRank", "nomenclaturalStatus", "namePublishedIn", "taxonomicStatus", "acceptedNameUsageID", "originalNameUsageID", "nameAccordingToID", "taxonRemarks", "created", "modified", "references", "source", "majorGroup", "tplID"];

  // Gather the target set so the 900 MB core is streamed once, keeping only
  // rows that can possibly match.
  const input = JSON.parse(fs.readFileSync(path.join(root, ".taxonomy-cache", "input-species.json"), "utf8"));
  const overridesDoc = JSON.parse(fs.readFileSync(path.join(root, "data/taxonomy/overrides.json"), "utf8"));
  const pinnedIds = new Set((overridesDoc.overrides ?? []).flatMap((o) => Object.values(o.sources ?? {}).map((s) => s.id)).filter((id) => String(id).startsWith("wfo-")));
  const targets = new Set();
  const genusTargets = new Set();
  for (const s of input.species) {
    targets.add(authoredCanonical(s));
    targets.add(hybridKey(authoredCanonical(s)));
    genusTargets.add(authoredCanonical(s).split(" ")[0]);
  }

  const rows = [];
  let header = null;
  const unquote = (v) =>
    v.length >= 2 && v.startsWith('"') && v.endsWith('"')
      ? v.slice(1, -1).replace(/""/g, '"')
      : v;
  for await (const line of lines(csvPath)) {
    if (!header) {
      header = splitDelimited(line, "\t").map(unquote);
      continue;
    }
    const f = splitDelimited(line, "\t").map(unquote);
    const row = {};
    for (let i = 0; i < COLS.length; i++) row[COLS[i]] = f[i] ?? "";
    const rank = String(row.taxonRank ?? "").toLowerCase();
    if (pinnedIds.has(row.taxonID)) {
      rows.push(row);
      continue;
    }
    if (rank === "genus") {
      if (genusTargets.has(String(row.genus ?? "").toLowerCase())) rows.push(row);
      continue;
    }
    const canonical = row.genus && row.specificEpithet
      ? `${row.genus} ${row.specificEpithet}${row.infraspecificEpithet ? (RANK_MARKER[row.taxonRank.toLowerCase()] ?? " var. ") + row.infraspecificEpithet : ""}`.toLowerCase()
      : "";
    // collect both the exact canonical and its hybrid-stripped form so
    // "Malus × domestica" rows can be found for authored "Malus domestica"
    if (targets.has(canonical) || targets.has(hybridKey(canonical))) rows.push(row);
  }

  const index = buildWfoIndex(rows);
  const wfoResults = new Map();
  for (const s of input.species) wfoResults.set(s, resolveWfo(index, s));

  const overrideById = {};
  for (const id of pinnedIds) {
    const row = index.byId.get(id);
    overrideById[id] = row
      ? {
          taxonID: row.taxonID,
          scientificName: row.scientificName,
          taxonRank: row.taxonRank,
          taxonomicStatus: row.taxonomicStatus,
        }
      : null; // pinned id absent from this snapshot → stale
  }

  const outDir = path.join(cache, "out");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "wfo.json"), JSON.stringify({
    source: SOURCE.file,
    resolvedAt: new Date().toISOString(),
    results: [...wfoResults.entries()].map(([jnintySpecies, wfo]) => ({ jnintySpecies, wfo })),
    overrideById,
  }, null, 1));
  console.log(`WFO: ${wfoResults.size} species resolved -> .taxonomy-cache/out/wfo.json`);
}

function hybridKey(canonical) {
  return canonical.replace(/×\s*/g, "").replace(/\s+/g, " ");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
