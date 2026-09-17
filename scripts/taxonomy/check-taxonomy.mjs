// CI-style validation of data/taxonomy/taxonomy.json.
// Fails on: coverage gaps, duplicates, stale/broken overrides, ambiguous
// rows marked clean, species-level matches for aggregates, schema shape,
// and drift between the committed artifact and regeneration from the pinned
// cache (determinism check; volatile timestamps excluded).
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const dir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(dir, "../..");
const cache = path.join(root, ".taxonomy-cache");
const artifactPath = path.join(root, "data/taxonomy/taxonomy.json");

function readSpecies() {
  const species = new Set();
  for (const file of ["vegetables", "herbs", "fruits", "flowers"]) {
    const rows = JSON.parse(fs.readFileSync(path.join(root, "data/plants", `${file}.json`), "utf8"));
    for (const row of rows) species.add(row.species);
  }
  return species;
}

function stripVolatile(artifact) {
  const copy = JSON.parse(JSON.stringify(artifact));
  delete copy.generatedAt;
  if (copy.inputs?.wfo) delete copy.inputs.wfo.retrievedAt;
  if (copy.inputs?.dyntaxa) delete copy.inputs.dyntaxa.retrievedAt;
  return copy;
}

const failures = [];
const errors = (msgs) => msgs.forEach((m) => failures.push(m));

let artifact;
try {
  artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
} catch (e) {
  console.error(`FAIL: taxonomy.json unreadable: ${e.message}`);
  process.exit(1);
}

// 7. schema shape
const shapeErrors = [];
if (artifact.schemaVersion !== 1) shapeErrors.push("schemaVersion must be 1");
if (!Array.isArray(artifact.taxa)) shapeErrors.push("taxa must be an array");
for (const t of artifact.taxa ?? []) {
  if (typeof t.jnintySpecies !== "string" || t.jnintySpecies.length === 0) shapeErrors.push("taxon missing jnintySpecies");
  if (!["binomial", "infraspecific", "hybrid", "aggregate"].includes(t.speciesKind)) shapeErrors.push(`${t.jnintySpecies}: invalid speciesKind`);
  if (!["clean", "needs-review", "manual-override", "stale-override"].includes(t.review?.status)) shapeErrors.push(`${t.jnintySpecies}: invalid review status`);
  if (t.wfo && typeof t.wfo.matchType !== "string") shapeErrors.push(`${t.jnintySpecies}: wfo.matchType missing`);
  if (t.dyntaxa && typeof t.dyntaxa.matchType !== "string") shapeErrors.push(`${t.jnintySpecies}: dyntaxa.matchType missing`);
}
errors(shapeErrors);

const speciesInPlants = readSpecies();
const rows = artifact.taxa ?? [];
const rowIds = rows.map((t) => t.jnintySpecies);

// 1. coverage
errors([...speciesInPlants].filter((s) => !rowIds.includes(s)).map((s) => `species missing from taxonomy.json: ${s}`));
// 2. extras
errors(rowIds.filter((s) => !speciesInPlants.has(s)).map((s) => `taxonomy.json contains species no longer in data/plants: ${s}`));
// 3. duplicates
const seen = new Set();
for (const id of rowIds) {
  if (seen.has(id)) errors(`duplicate jnintySpecies row: ${id}`);
  seen.add(id);
}

// 6. ambiguous must never be clean; aggregates must not be species-level exact
for (const t of rows) {
  if (t.wfo?.matchType === "ambiguous" && t.review.status === "clean") errors(`${t.jnintySpecies}: ambiguous WFO result marked clean`);
  if (t.speciesKind === "aggregate" && t.wfo && !["genus-only", "unresolved-aggregate", "ambiguous"].includes(t.wfo.matchType)) {
    errors(`${t.jnintySpecies}: aggregate must not have a species-level WFO match (${t.wfo.matchType})`);
  }
}

// overrides: unknown species refs + stale overrides
const overridesDoc = JSON.parse(fs.readFileSync(path.join(root, "data/taxonomy/overrides.json"), "utf8"));
for (const ov of overridesDoc.overrides ?? []) {
  if (!speciesInPlants.has(ov.jnintySpecies)) errors(`override references unknown Jninty species: ${ov.jnintySpecies}`);
}
for (const t of rows) {
  if (t.review.status === "stale-override") errors(`${t.jnintySpecies}: override is stale — ${t.review.notes.join("; ")}`);
}
for (const id of artifact.overridesApplied ?? []) {
  if (!rowIds.includes(id)) errors(`overridesApplied references unknown row: ${id}`);
}

  // determinism + integrity (requires the pinned cache)
  if (fs.existsSync(path.join(cache, "out", "wfo.json")) && fs.existsSync(path.join(cache, "out", "dyntaxa.json"))) {
    // cache integrity vs pins
    const sources = JSON.parse(fs.readFileSync(path.join(root, "data/taxonomy/sources.json"), "utf8"));
    for (const key of ["wfo", "dyntaxa"]) {
      const pin = sources[key];
      const file = path.join(cache, pin.file);
      if (!fs.existsSync(file)) {
        errors(`${key}: pinned snapshot missing from cache (${pin.file}) — run the refresh workflow`);
        continue;
      }
      const sha = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
      if (sha !== pin.sha256) errors(`${key}: cached snapshot sha256 mismatch (${sha} != ${pin.sha256}) — re-verify the pinned source`);
      // informational only (never fails): report pin age against expected cadence
      const pinDate = new Date(pin.publicationDate ?? pin.retrievedAt ?? Date.now());
      const ageMonths = Math.floor((Date.now() - pinDate.getTime()) / (1000 * 60 * 60 * 24 * 30.4));
      const cadenceMonths = key === "wfo" ? 6 : 3; // WFO ~biannually; Dyntaxa daily export
      if (ageMonths > cadenceMonths) {
        console.warn(`note: ${key} pin is ~${ageMonths} months old (published ${pin.publicationDate ?? pin.retrievedAt}); a newer upstream release may exist — consider taxonomy:refresh`);
      }
    }

  // determinism: regenerate and compare, excluding volatile timestamps
  const before = stripVolatile(artifact);
  execFileSync(process.execPath, [path.join(dir, "generate-taxonomy.mjs")], { stdio: "pipe" });
  const after = stripVolatile(JSON.parse(fs.readFileSync(artifactPath, "utf8")));
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    errors("determinism check failed: committed taxonomy.json differs from regeneration using the pinned inputs — run taxonomy:generate and review the diff");
  }
} else {
  console.warn("note: .taxonomy-cache/out resolver outputs not present — determinism/integrity checks skipped (run taxonomy:refresh first)");
}

if (failures.length > 0) {
  console.error(`taxonomy:check FAILED with ${failures.length} problem(s):`);
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}
console.log(`taxonomy:check OK — ${rows.length} taxa validated (schema, coverage, overrides, review classification${fs.existsSync(path.join(cache, "out", "wfo.json")) ? ", determinism, snapshot integrity" : ""})`);
