// CLI: maintainer-side source refresh (the ONLY network-touching step).
// Downloads the pinned snapshots listed in data/taxonomy/sources.json,
// verifies their sha256, then regenerates the artifact and runs checks.
// Generation itself (taxonomy:generate / taxonomy:check) stays offline.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(dir, "../..");
const cache = path.join(root, ".taxonomy-cache");
fs.mkdirSync(cache, { recursive: true });

const sources = JSON.parse(fs.readFileSync(path.join(root, "data/taxonomy/sources.json"), "utf8"));

async function download(url, dest) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const out = fs.createWriteStream(dest);
  await new Promise((resolve, reject) => {
    res.body.pipe(out);
    res.body.on("error", reject);
    out.on("error", reject);
    out.on("finish", resolve);
  });
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

async function main() {
  for (const key of ["wfo", "dyntaxa"]) {
    const pin = sources[key];
    const dest = path.join(cache, pin.file);
    console.log(`refreshing ${key}: ${pin.release ?? pin.dataset} …`);
    await download(pin.sourceUrl ?? pin.releaseUrl, dest);
    const hash = sha256(dest);
    if (hash !== pin.sha256) {
      console.error(
        `sha256 mismatch for ${key} snapshot:\n  expected ${pin.sha256}\n  actual   ${hash}\n` +
        `If the upstream release changed intentionally, update sources.json (URL/sha256/retrievedAt) and re-run.`,
      );
      process.exit(1);
    }
    console.log(`  verified ${pin.file} (${pin.sha256.slice(0, 12)}…)`);

    // record the retrieval date in the pin metadata (part of provenance)
    pin.retrievedAt = new Date().toISOString().slice(0, 10);
  }
  fs.writeFileSync(path.join(root, "data/taxonomy/sources.json"), JSON.stringify(sources, null, 2) + "\n");

  execFileSync(process.execPath, [path.join(dir, "generate-taxonomy.mjs")], { stdio: "inherit" });
  execFileSync(process.execPath, [path.join(dir, "check-taxonomy.mjs")], { stdio: "inherit" });
  console.log("taxonomy:refresh complete.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
