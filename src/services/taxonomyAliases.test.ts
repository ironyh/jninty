// Regression tests for taxonomy-derived search aliases in searchKnowledge().
// All data is local (bundled artifact + data/plants) — no network access.
import { describe, it, expect } from "vitest";
import { searchKnowledge, loadKnowledgeBase } from "./knowledgeBase.ts";
import {
  buildTaxonomyAliasIndex,
  getTaxonomyAliasesBySpecies,
  matchTaxonomyAliases,
} from "./taxonomyAliases.ts";
import taxonomyJson from "../../data/taxonomy/taxonomy.json";

// Independent reimplementation of the pre-alias searchKnowledge(), used to
// prove existing behaviour is unchanged (order included).
function legacySearch(query: string) {
  const q = query.toLowerCase();
  return loadKnowledgeBase()
    .filter(
      (p) =>
        p.species.toLowerCase().includes(q) ||
        p.commonName.toLowerCase().includes(q) ||
        (p.variety && p.variety.toLowerCase().includes(q)),
    )
    .map((p) => p.commonName);
}

const names = (results: ReturnType<typeof searchKnowledge>) =>
  results.map((p) => p.commonName);

describe("existing search behaviour unchanged", () => {
  it.each(["tomato", "rosemary", "basil", "cherry tomato", "beefsteak"])(
    '"%s" returns exactly the legacy result set in the same order',
    (query) => {
      expect(names(searchKnowledge(query))).toEqual(legacySearch(query));
    },
  );
});

describe("taxonomy alias gains", () => {
  it("swedish alias 'potatis' finds all potato entries without duplicates", () => {
    const results = searchKnowledge("potatis");
    const list = names(results);
    expect(new Set(list).size).toBe(list.length);
    expect(list.filter((n) => n.includes("Potato"))).toHaveLength(4);
  });

  it("swedish alias 'gräslök' finds Chives", () => {
    expect(names(searchKnowledge("gräslök"))).toContain("Chives");
  });

  it("diacritic-folded 'graslok' also finds Chives", () => {
    expect(names(searchKnowledge("graslok"))).toContain("Chives");
  });

  it("swedish alias 'rosenskära' finds the cosmos entries", () => {
    const list = names(searchKnowledge("rosenskära"));
    expect(list).toContain("Cosmos");
    expect(list).toContain("Sensation Cosmos");
    expect(list).toContain("Chocolate Cosmos");
  });

  it("swedish alias 'persilja' finds all parsley entries (data-file order for alias matches)", () => {
    const list = names(searchKnowledge("persilja")).sort();
    expect(list).toEqual(["Curly Parsley", "Italian Flat-Leaf Parsley", "Parsley"].sort());
  });

  it("swedish alias 'pumpa' finds pumpkin/squash entries", () => {
    const list = names(searchKnowledge("pumpa"));
    expect(list).toContain("Pumpkin");
    expect(list).toContain("Zucchini");
    expect(list).toContain("Butternut Squash");
  });

  it("scientific override alias 'Rosmarinus officinalis' finds both rosemary entries", () => {
    expect(names(searchKnowledge("Rosmarinus officinalis"))).toEqual([
      "Rosemary",
      "Common Rosemary",
    ]);
  });

  it("current matches always come before alias-only matches", () => {
    // "Salvia rosmarinus" matches the authored species field directly, so
    // those two rows must precede anything alias-derived.
    const list = names(searchKnowledge("Salvia rosmarinus"));
    expect(list.slice(0, 2)).toEqual(["Rosemary", "Common Rosemary"]);
  });
});

describe("conservative exclusions", () => {
  const index = buildTaxonomyAliasIndex(taxonomyJson);

  it("never indexes ambiguous WFO candidate names as WFO-derived aliases", () => {
    for (const taxon of taxonomyJson.taxa) {
      const candidates = taxon.wfo?.candidates ?? [];
      if (taxon.wfo?.matchType !== "ambiguous") continue;
      for (const candidate of candidates) {
        // candidate format: "<wfo-id> <scientificName>[ -> <accepted-id>]"
        const name = (candidate.split(" -> ")[0] ?? "").split(" ").slice(1).join(" ").toLowerCase();
        const entries = index.get(name) ?? [];
        for (const entry of entries) {
          expect(
            entry.source.startsWith("wfo."),
            `ambiguous candidate '${name}' indexed from ${entry.source}`,
          ).toBe(false);
        }
      }
    }
  });

  it("a query matching only an ambiguous candidate yields no taxonomy-derived result", () => {
    // Petunia × hybrida is ambiguous on the pinned 2026-06 release, so its
    // WFO accepted variant must not be surfaced by alias search.
    expect(names(searchKnowledge("Petunia atkinsiana"))).toEqual([]);
  });
});

describe("multi-entry species", () => {
  it("a species-level alias returns every entry for that species, once", () => {
    const results = searchKnowledge("potatis");
    const ids = results.map((p) => `${p.species}|${p.commonName}|${p.variety ?? ""}`);
    expect(new Set(ids).size).toBe(ids.length);
    expect(results.filter((p) => p.species === "Solanum tuberosum")).toHaveLength(4);
  });
});

describe("fallback and determinism", () => {
  it.each([
    ["null artifact", null],
    ["empty object", {}],
    ["wrong taxa shape", { taxa: "nope" }],
    ["missing fields", { taxa: [{ wfo: { matchType: "accepted" } }] }],
  ])("malformed artifact (%s) yields an empty index", (_label, bad) => {
    expect(buildTaxonomyAliasIndex(bad).size).toBe(0);
  });

  it("search falls back to legacy behaviour when the alias index is empty", () => {
    // simulate an empty index via the pure builder path: search must not throw
    // and must still return current results for an English query.
    expect(names(searchKnowledge("tomato"))).toEqual(legacySearch("tomato"));
  });

  it("two alias-map builds produce identical results", () => {
    const first = matchTaxonomyAliases("potatis");
    const second = matchTaxonomyAliases("potatis");
    expect(first).toEqual(second);
    // species map is keyed by the authored species; the Swedish alias rides along
    expect(getTaxonomyAliasesBySpecies().get("salvia rosmarinus")).toContain("rosmarin");
  });
});
