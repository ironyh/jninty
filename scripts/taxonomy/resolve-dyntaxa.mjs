// CLI: resolve all Jninty species against the pinned Dyntaxa DwC-A snapshot.
// Offline — performs no network requests.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { lines } from "./lib/lines.mjs";
import { extractEntry } from "./lib/zipExtract.mjs";
import { buildDyntaxaIndex, resolveDyntaxa } from "./lib/resolve-dyntaxa.mjs";
import { authoredCanonical, hybridInsensitiveKey, sourceCanonical } from "./lib/names.mjs";

const dir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(dir, "../..");
const cache = path.join(root, ".taxonomy-cache");
const SOURCE = { file: "dyntaxa-dwca.zip" };

async function main() {
  const zipPath = path.join(cache, SOURCE.file);
  if (!fs.existsSync(zipPath)) {
    console.error(`Dyntaxa snapshot missing: ${zipPath}. Run the source refresh first (see data/taxonomy/README.md).`);
    process.exit(1);
  }

  const input = JSON.parse(fs.readFileSync(path.join(cache, "input-species.json"), "utf8"));
  const overridesDoc = JSON.parse(fs.readFileSync(path.join(root, "data/taxonomy/overrides.json"), "utf8"));
  const pinnedIds = new Set((overridesDoc.overrides ?? []).flatMap((o) => Object.values(o.sources ?? {}).map((s) => s.id)).filter(Boolean));
  const targets = new Set();
  const genusTargets = new Set();
  for (const s of input.species) {
    const canonical = authoredCanonical(s);
    targets.add(canonical);
    targets.add(hybridInsensitiveKey(canonical));
    genusTargets.add(canonical.split(" ")[0]);
  }

  const taxonCsv = path.join(cache, "Taxon.csv");
  const vernacularCsv = path.join(cache, "VernacularName.csv");
  if (!fs.existsSync(taxonCsv)) await extractEntry(zipPath, "Taxon.csv", taxonCsv);
  if (!fs.existsSync(vernacularCsv)) await extractEntry(zipPath, "VernacularName.csv", vernacularCsv);

  // Pass 1: taxon core — keep genus rows and rows canonically matching a target.
  const taxonRows = [];
  let header = false;
  for await (const line of lines(taxonCsv)) {
    if (!header) {
      header = true; // human header row; meta.xml fixes the field order
      continue;
    }
    const f = line.split("\t");
    const row = {
      taxonId: f[0] ?? "",
      acceptedNameUsageID: f[1] ?? "",
      scientificName: f[3] ?? "",
      taxonRank: f[4] ?? "",
      taxonomicStatus: f[6] ?? "",
      genus: f[14] ?? "",
      species: f[15] ?? "",
    };
    const rank = row.taxonRank.toLowerCase();
    if (rank === "genus") {
      if (genusTargets.has(row.genus.toLowerCase())) taxonRows.push(row);
      continue;
    }
    const canonical = sourceCanonical(row.scientificName, rank);
    if (targets.has(canonical) || targets.has(hybridInsensitiveKey(canonical)) || pinnedIds.has(row.taxonId)) taxonRows.push(row);
  }

  // Pass 2: Swedish vernacular names for the collected taxa.
  const collectedIds = new Set(taxonRows.map((r) => r.taxonId));
  const vernacularRows = [];
  let vHeader = false;
  for await (const line of lines(vernacularCsv)) {
    if (!vHeader) {
      vHeader = true;
      continue;
    }
    const f = line.split("\t");
    const row = { taxonId: f[0] ?? "", vernacularName: f[1] ?? "", language: f[2] ?? "", isPreferredName: f[5] ?? "" };
    if (collectedIds.has(row.taxonId) && ["sv", "swe"].includes(row.language.toLowerCase())) vernacularRows.push(row);
  }

  const index = buildDyntaxaIndex(taxonRows, vernacularRows);
  const dyntaxaResults = new Map();
  for (const s of input.species) dyntaxaResults.set(s, resolveDyntaxa(index, s));

  // Rows pinned by overrides (for offline staleness checks + enrichment).
  const overrideById = {};
  for (const id of pinnedIds) {
    const row = index.byId.get(id);
    if (!row) {
      overrideById[id] = null; // pinned id absent from this snapshot → stale
      continue;
    }
    const swe = index.sweByTaxon.get(id);
    overrideById[id] = {
      taxonId: row.taxonId,
      scientificName: row.scientificName,
      taxonRank: row.taxonRank,
      taxonomicStatus: row.taxonomicStatus,
      canonicalName: sourceCanonical(row.scientificName, row.taxonRank),
      recommendedSwedishName: swe?.preferred?.[0] ?? null,
      otherSwedishNames: swe?.all?.slice().sort() ?? null,
    };
  }

  const outDir = path.join(cache, "out");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "dyntaxa.json"), JSON.stringify({
    source: SOURCE.file,
    resolvedAt: new Date().toISOString(),
    results: [...dyntaxaResults.entries()].map(([jnintySpecies, dyntaxa]) => ({ jnintySpecies, dyntaxa })),
    overrideById,
  }, null, 1));
  console.log(`Dyntaxa: ${dyntaxaResults.size} species resolved -> .taxonomy-cache/out/dyntaxa.json`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
