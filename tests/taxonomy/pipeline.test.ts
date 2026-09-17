// Tests for the taxonomy build pipeline (scripts/taxonomy/lib/*).
// All fixture data is synthetic — no external services are contacted.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  buildWfoIndex,
  resolveWfo,
} from "../../scripts/taxonomy/lib/resolve-wfo.mjs";
import {
  buildDyntaxaIndex,
  resolveDyntaxa,
} from "../../scripts/taxonomy/lib/resolve-dyntaxa.mjs";
import { buildTaxonomyArtifact } from "../../scripts/taxonomy/lib/generate.mjs";
import { speciesKind } from "../../scripts/taxonomy/lib/names.mjs";

function wfoRow(taxonID, scientificName, status, opts = {}) {
  const tokens = scientificName.split(" ");
  return {
    taxonID,
    scientificName,
    taxonRank: opts.rank ?? "species",
    taxonomicStatus: status,
    acceptedNameUsageID: opts.accepted ?? taxonID,
    genus: tokens[0] ?? "",
    specificEpithet: tokens[1] ?? "",
    infraspecificEpithet: tokens[3] ?? "",
  };
}

function dyRow(taxonId, scientificName, status, opts = {}) {
  return {
    taxonId,
    scientificName,
    taxonRank: opts.rank ?? "species",
    taxonomicStatus: status,
    acceptedNameUsageID: opts.accepted ?? taxonId,
  };
}

describe("speciesKind", () => {
  it("classifies authored strings", () => {
    expect(speciesKind("Allium cepa")).toBe("binomial");
    expect(speciesKind("Brassica oleracea var. capitata")).toBe("infraspecific");
    expect(speciesKind("Fragaria × ananassa")).toBe("hybrid");
    expect(speciesKind("Rosa spp.")).toBe("aggregate");
  });
});

describe("resolveWfo", () => {
  const index = buildWfoIndex([
    // accepted row + its own homotypic synonym (shares canonical spelling)
    wfoRow("wfo-1", "Allium cepa L.", "Accepted"),
    wfoRow("wfo-2", "Allium cepa", "Synonym", { accepted: "wfo-1" }),
    // synonym resolution
    wfoRow("wfo-10", "Pisum sativum L.", "Synonym", { accepted: "wfo-11" }),
    wfoRow("wfo-11", "Lathyrus oleraceus", "Accepted"),
    // two accepted rows for one canonical name -> ambiguous
    wfoRow("wfo-20", "Zinnia elegans", "Accepted"),
    wfoRow("wfo-21", "Zinnia elegans", "Accepted"),
    // accepted row + synonym pointing ELSEWHERE -> conflict
    wfoRow("wfo-30", "Anethum graveolens L.", "Accepted"),
    wfoRow("wfo-31", "Anethum graveolens", "Synonym", { accepted: "wfo-99" }),
    // genus row for aggregates
    wfoRow("wfo-40", "Rosa L.", "Accepted", { rank: "genus" }),
  ]);

  it("resolves an accepted match", () => {
    const r = resolveWfo(index, "Allium cepa");
    expect(r.matchType).toBe("accepted");
    expect(r.id).toBe("wfo-1");
    expect(r.needsReview).toBe(false);
  });

  it("resolves a synonym to its accepted name", () => {
    const r = resolveWfo(index, "Pisum sativum");
    expect(r.matchType).toBe("synonym");
    expect(r.acceptedName).toBe("Lathyrus oleraceus");
    expect(r.acceptedWfoId).toBe("wfo-11");
    expect(r.needsReview).toBe(true);
  });

  it("treats an accepted row plus its homotypic synonyms as unambiguous", () => {
    const r = resolveWfo(index, "Allium cepa");
    expect(r.matchType).toBe("accepted");
    expect(r.needsReview).toBe(false);
  });

  it("never auto-resolves multiple accepted candidates", () => {
    const r = resolveWfo(index, "Zinnia elegans");
    expect(r.matchType).toBe("ambiguous");
    expect(r.id).toBeNull();
    expect(r.candidates?.length).toBe(2);
    expect(r.needsReview).toBe(true);
  });

  it("flags synonyms that point to a different accepted taxon", () => {
    const r = resolveWfo(index, "Anethum graveolens");
    expect(r.matchType).toBe("accepted");
    expect(r.needsReview).toBe(true);
    expect(r.candidates?.join(" ")).toContain("wfo-99");
  });

  it("resolves aggregates at genus rank only", () => {
    const r = resolveWfo(index, "Rosa spp.");
    expect(r.matchType).toBe("genus-only");
    expect(r.rank).toBe("genus");
    expect(r.id).toBe("wfo-40");
  });

  it("reports unresolved names", () => {
    expect(resolveWfo(index, "Monstera deliciosa").matchType).toBe("unresolved");
  });
});

describe("resolveDyntaxa", () => {
  const taxonRows = [
    dyRow("urn:lsid:dyntaxa.se:Taxon:219736", "Allium cepa L.", "accepted"),
    dyRow("urn:lsid:dyntaxa.se:Taxon:221789", "Rosmarinus officinalis L.", "accepted"),
    dyRow("urn:lsid:dyntaxa.se:Taxon:223045", "Malus domestica Borkh.", "accepted"),
    // hybrid continuation name must NOT collide with the plain species
    dyRow("urn:lsid:dyntaxa.se:Taxon:265380", "Malus domestica × sylvestris", "accepted"),
    dyRow("urn:lsid:dyntaxa.se:Taxon:6005223", "Rubus fruticosus agg.", "accepted", { rank: "speciesAggregate" }),
  ];
  const vernacularRows = [
    { taxonId: "urn:lsid:dyntaxa.se:Taxon:219736", vernacularName: "lök", language: "sv", isPreferredName: "true" },
    { taxonId: "urn:lsid:dyntaxa.se:Taxon:221789", vernacularName: "rosmarin", language: "sv", isPreferredName: "true" },
  ];
  const index = buildDyntaxaIndex(taxonRows, vernacularRows);

  it("resolves an exact match with the recommended Swedish name", () => {
    const r = resolveDyntaxa(index, "Allium cepa");
    expect(r.matchType).toBe("exact");
    expect(r.id).toBe("urn:lsid:dyntaxa.se:Taxon:219736");
    expect(r.recommendedSwedishName).toBe("lök");
  });

  it("reports absent for taxa outside the Swedish register", () => {
    expect(resolveDyntaxa(index, "Abelmoschus esculentus").matchType).toBe("absent");
  });

  it("does not collide hybrid continuation names with the plain species", () => {
    const plain = resolveDyntaxa(index, "Malus domestica");
    expect(plain.matchType).toBe("exact");
    expect(plain.id).toBe("urn:lsid:dyntaxa.se:Taxon:223045");
  });

  it("resolves the Salvia override target by pinned id", () => {
    const r = resolveDyntaxa(index, "Rosmarinus officinalis");
    expect(r.matchType).toBe("exact");
    expect(r.id).toBe("urn:lsid:dyntaxa.se:Taxon:221789");
    expect(r.recommendedSwedishName).toBe("rosmarin");
  });

  it("resolves aggregates at genus level or reports absence", () => {
    const indexWithGenus = buildDyntaxaIndex(
      [...taxonRows, dyRow("urn:lsid:dyntaxa.se:Taxon:1005796", "Dahlia", "accepted", { rank: "genus" })],
      [],
    );
    expect(resolveDyntaxa(indexWithGenus, "Dahlia spp.").matchType).toBe("genus-level");
    expect(resolveDyntaxa(index, "Monstera spp.").matchType).toBe("absent");
  });
});

describe("buildTaxonomyArtifact", () => {
  const species = ["Zinnia elegans", "Allium cepa"];
  const wfoResults = new Map([
    ["Zinnia elegans", { matchType: "ambiguous", id: null, matchedName: null, acceptedName: null, acceptedWfoId: null, status: null, rank: null, candidates: ["wfo-a", "wfo-b"], needsReview: true }],
    ["Allium cepa", { matchType: "accepted", needsReview: false, id: "wfo-1", matchedName: "Allium cepa L.", acceptedName: "Allium cepa L.", acceptedWfoId: "wfo-1", status: "Accepted", rank: "species", candidates: null }],
  ]);
  const dyntaxaResults = new Map([
    ["Zinnia elegans", { matchType: "absent", id: null, scientificName: null }],
    ["Allium cepa", { matchType: "exact", id: "dy-1", scientificName: "Allium cepa L.", canonicalName: "allium cepa", taxonomicStatus: "accepted", rank: "species", recommendedSwedishName: "lök", otherSwedishNames: ["lök"] }],
  ]);
  const emptyOverrides = { schemaVersion: 1, overrides: [] };

  it("sorts rows deterministically by jnintySpecies", () => {
    const a = buildTaxonomyArtifact({
      species, wfoResults, dyntaxaResults, overridesDoc: emptyOverrides, sources: {}, generatedAt: "t1", applyOverrideCheck: () => ({ stale: null }),
    });
    expect(a.taxa.map((t) => t.jnintySpecies)).toEqual(["Allium cepa", "Zinnia elegans"]);
  });

  it("is identical across runs except generatedAt", () => {
    const opts = { species, wfoResults, dyntaxaResults, overridesDoc: emptyOverrides, sources: {} };
    const a = buildTaxonomyArtifact({ ...opts, generatedAt: "t1", applyOverrideCheck: () => ({ stale: null }) });
    const b = buildTaxonomyArtifact({ ...opts, generatedAt: "t2", applyOverrideCheck: () => ({ stale: null }) });
    const strip = (x) => { const c = { ...x }; delete c.generatedAt; return c; };
    expect(strip(a)).toEqual(strip(b));
  });

  it("marks ambiguous WFO rows needs-review with their candidates", () => {
    const a = buildTaxonomyArtifact({
      species, wfoResults, dyntaxaResults, overridesDoc: emptyOverrides, sources: {}, generatedAt: "t", applyOverrideCheck: () => ({ stale: null }),
    });
    const z = a.taxa.find((t) => t.jnintySpecies === "Zinnia elegans");
    expect(z.review.status).toBe("needs-review");
    expect(z.review.notes.join(" ")).toContain("not auto-resolved");
  });

  it("applies an override without hiding the live result", () => {
    const overridesDoc = {
      schemaVersion: 1,
      overrides: [{
        jnintySpecies: "Zinnia elegans",
        sources: { dyntaxa: { id: "dy-z", expectAcceptedName: "Zinnia violetta", decision: "test" } },
      }],
    };
    const a = buildTaxonomyArtifact({
      species, wfoResults, dyntaxaResults, overridesDoc, sources: {}, generatedAt: "t",
      applyOverrideCheck: () => ({
        stale: null,
        dyntaxa: { matchType: "manual", id: "dy-z", scientificName: "Zinnia violetta", taxonomicStatus: "accepted", rank: "species", recommendedSwedishName: null, otherSwedishNames: null },
      }),
    });
    const z = a.taxa.find((t) => t.jnintySpecies === "Zinnia elegans");
    expect(z.review.status).toBe("manual-override");
    expect(z.dyntaxa.matchType).toBe("manual");
    expect(z.dyntaxa.liveQueryResult.matchType).toBe("absent"); // live result preserved
  });

  it("flags a stale override when the pinned id no longer matches", () => {
    const overridesDoc = {
      schemaVersion: 1,
      overrides: [{
        jnintySpecies: "Zinnia elegans",
        sources: { dyntaxa: { id: "dy-z", expectAcceptedName: "Zinnia oldname", decision: "test" } },
      }],
    };
    const a = buildTaxonomyArtifact({
      species, wfoResults, dyntaxaResults, overridesDoc, sources: {}, generatedAt: "t",
      applyOverrideCheck: () => ({ stale: "stale-override (expected 'Zinnia oldname', snapshot now says 'Zinnia elegans')", dyntaxa: null }),
    });
    const z = a.taxa.find((t) => t.jnintySpecies === "Zinnia elegans");
    expect(z.review.status).toBe("stale-override");
  });
});

// Committed artifact consistency — offline checks against the real files.
describe("committed taxonomy artifact", () => {
  const artifact = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "../../data/taxonomy/taxonomy.json"), "utf8"),
  );

  function authoredSpecies() {
    const species = new Set();
    for (const file of ["vegetables", "herbs", "fruits", "flowers"]) {
      const rows = JSON.parse(
        fs.readFileSync(path.resolve(__dirname, `../../data/plants/${file}.json`), "utf8"),
      );
      for (const row of rows) species.add(row.species);
    }
    return species;
  }

  it("covers every authored species exactly once", () => {
    const expected = [...authoredSpecies()].sort();
    const actual = artifact.taxa.map((t) => t.jnintySpecies).sort();
    expect(actual).toEqual(expected);
  });

  it("never auto-resolves ambiguous taxa to clean", () => {
    for (const t of artifact.taxa) {
      if (t.wfo?.matchType === "ambiguous") {
        expect(t.review.status).not.toBe("clean");
      }
      if (t.speciesKind === "aggregate" && t.wfo) {
        expect(t.wfo.matchType).toBe("genus-only");
      }
    }
  });

  it("reports a needs-review or manual-override status for known authority divergences", () => {
    for (const name of ["Salvia rosmarinus", "Pisum sativum", "Hibiscus moscheutos"]) {
      const t = artifact.taxa.find((x) => x.jnintySpecies === name);
      expect(t?.review.status).not.toBe("clean");
    }
  });
});
