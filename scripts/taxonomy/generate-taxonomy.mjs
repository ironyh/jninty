// CLI: build data/taxonomy/taxonomy.json from the pinned cached snapshots.
// Offline after the source snapshots are in .taxonomy-cache/.
// Steps: write input species -> run both resolvers -> apply overrides ->
// classify review status -> write the artifact.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { authoredCanonical, speciesKind } from "./lib/names.mjs";
import { buildTaxonomyArtifact } from "./lib/generate.mjs";
import { sourceCanonical } from "./lib/names.mjs";

const dir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(dir, "../..");
const cache = path.join(root, ".taxonomy-cache");
const outDir = path.join(cache, "out");

function readSpecies() {
  const species = new Set();
  for (const file of ["vegetables", "herbs", "fruits", "flowers"]) {
    const rows = JSON.parse(fs.readFileSync(path.join(root, "data/plants", `${file}.json`), "utf8"));
    for (const row of rows) species.add(row.species);
  }
  return [...species].sort();
}

function writeInputSpecies(species) {
  const byKind = { binomial: [], infraspecific: [], hybrid: [], aggregate: [] };
  for (const s of species) (byKind[speciesKind(s)] ??= []).push(s);
  fs.writeFileSync(
    path.join(cache, "input-species.json"),
    JSON.stringify({ totalEntries: null, uniqueSpecies: species.length, speciesByKind: Object.fromEntries(Object.entries(byKind).map(([k, v]) => [k, v.length])), species }, null, 2),
  );
}

function applyOverrideCheck(ov) {
  // Offline staleness: compare pinned ids against the fresh resolver outputs.
  const wfoById = JSON.parse(fs.readFileSync(path.join(outDir, "wfo.json"), "utf8")).overrideById ?? {};
  const dynById = JSON.parse(fs.readFileSync(path.join(outDir, "dyntaxa.json"), "utf8")).overrideById ?? {};
  let stale = null;
  let manualDyntaxa = null;
  let manualWfo = null;
  for (const [source, pin] of Object.entries(ov.sources ?? {})) {
    const table = source === "wfo" ? wfoById : source === "dyntaxa" ? dynById : null;
    if (!table) {
      stale = `unknown override source '${source}'`;
      continue;
    }
    const row = table[pin.id];
    if (!row) {
      stale = `stale-override (pinned ${source} id ${pin.id} not found in the pinned snapshot)`;
      continue;
    }
    const canonical = row.canonicalName ?? sourceCanonical(row.scientificName, row.taxonRank);
    if (canonical !== pin.expectAcceptedName.toLowerCase()) {
      stale = `stale-override (expected '${pin.expectAcceptedName}', snapshot now says '${canonical}')`;
      continue;
    }
    if (source === "dyntaxa") {
      manualDyntaxa = {
        matchType: "manual",
        id: row.taxonId,
        scientificName: row.scientificName,
        canonicalName: canonical,
        acceptedName: null,
        acceptedId: null,
        taxonomicStatus: row.taxonomicStatus,
        rank: row.taxonRank,
        recommendedSwedishName: row.recommendedSwedishName ?? null,
        otherSwedishNames: row.otherSwedishNames ?? null,
      };
    } else {
      manualWfo = {
        matchType: "manual",
        id: row.taxonID,
        matchedName: row.scientificName,
        acceptedName: row.scientificName,
        acceptedWfoId: row.taxonID,
        status: row.taxonomicStatus,
        rank: row.taxonRank,
        candidates: null,
      };
    }
  }
  const wfo = manualWfo;
  const dyntaxa = manualDyntaxa;
  return { stale, wfo, dyntaxa };
}

function main() {
  const species = readSpecies();
  fs.mkdirSync(cache, { recursive: true });
  writeInputSpecies(species);

  execFileSync(process.execPath, [path.join(dir, "resolve-wfo.mjs")], { stdio: "inherit" });
  execFileSync(process.execPath, [path.join(dir, "resolve-dyntaxa.mjs")], { stdio: "inherit" });

  const wfoParsed = JSON.parse(fs.readFileSync(path.join(outDir, "wfo.json"), "utf8"));
  const dynParsed = JSON.parse(fs.readFileSync(path.join(outDir, "dyntaxa.json"), "utf8"));
  const sources = JSON.parse(fs.readFileSync(path.join(root, "data/taxonomy/sources.json"), "utf8"));
  const overridesDoc = JSON.parse(fs.readFileSync(path.join(root, "data/taxonomy/overrides.json"), "utf8"));

  const artifact = buildTaxonomyArtifact({
    species,
    wfoResults: new Map(wfoParsed.results.map((r) => [r.jnintySpecies, r.wfo])),
    dyntaxaResults: new Map(dynParsed.results.map((r) => [r.jnintySpecies, r.dyntaxa])),
    overridesDoc,
    sources: {
      jnintySpeciesSource: "data/plants/*.json (authored strings, byte-for-byte)",
      wfo: {
        release: sources.wfo.release,
        releaseUrl: sources.wfo.releaseUrl,
        sha256: sources.wfo.sha256,
        retrievedAt: sources.wfo.retrievedAt,
        license: sources.wfo.license,
      },
      dyntaxa: {
        dataset: sources.dyntaxa.dataset,
        datasetKey: sources.dyntaxa.datasetKey,
        datasetDoi: sources.dyntaxa.datasetDoi,
        license: sources.dyntaxa.datasetLicense,
        sha256: sources.dyntaxa.sha256,
        retrievedAt: sources.dyntaxa.retrievedAt,
      },
      overrides: { file: "data/taxonomy/overrides.json", schemaVersion: overridesDoc.schemaVersion },
    },
    generatedAt: new Date().toISOString(),
    applyOverrideCheck,
  });

  const outPath = path.join(root, "data/taxonomy/taxonomy.json");
  fs.writeFileSync(outPath, JSON.stringify(artifact, null, 2) + "\n");
  console.log(`taxonomy.json written: ${artifact.taxa.length} taxa | review: ${JSON.stringify(artifact.summary.reviewStatuses)}`);
}

main();
