import { describe, it, expect } from "vitest";
import { builtInEntryId, legacyEntryId } from "./knowledgeBase.ts";
import type { PlantKnowledge } from "../validation/plantKnowledge.schema.ts";

import vegetablesData from "../../data/plants/vegetables.json";
import herbsData from "../../data/plants/herbs.json";
import fruitsData from "../../data/plants/fruits.json";
import flowersData from "../../data/plants/flowers.json";
import manifest from "../../data/plants/knowledge-ids.json";

const files: Record<string, PlantKnowledge[]> = {
  "vegetables.json": vegetablesData as PlantKnowledge[],
  "herbs.json": herbsData as PlantKnowledge[],
  "fruits.json": fruitsData as PlantKnowledge[],
  "flowers.json": flowersData as PlantKnowledge[],
};

const entries: Array<{ file: string; entry: PlantKnowledge }> = [];
for (const [file, list] of Object.entries(files)) {
  for (const entry of list) {
    entries.push({ file, entry });
  }
}

const storedIds = entries.map(({ entry }) => entry.knowledgeId);

describe("knowledge identity registry", () => {
  it("every bundled entry has a non-empty knowledgeId", () => {
    for (const { file, entry } of entries) {
      expect(
        entry.knowledgeId,
        `${file}: entry ${entry.species} '${entry.variety ?? "base"}' has no knowledgeId`,
      ).toBeTruthy();
    }
  });

  it("knowledgeIds are unique across all files", () => {
    expect(new Set(storedIds).size).toBe(storedIds.length);
  });

  it("manifest.currentIds matches stored ids exactly", () => {
    expect([...manifest.currentIds].sort()).toEqual([...storedIds].sort());
  });

  it("manifest.currentIds is sorted for stable diffs", () => {
    expect(manifest.currentIds).toEqual([...manifest.currentIds].sort());
  });

  it("current and retired ids are disjoint and no stored id is retired", () => {
    const current = new Set(manifest.currentIds);
    for (const retired of manifest.retiredIds) {
      expect(current.has(retired)).toBe(false);
    }
    for (const id of storedIds) {
      expect(manifest.retiredIds).not.toContain(id);
    }
  });
});

describe("builtInEntryId", () => {
  it("prefers the stored knowledgeId over name derivation", () => {
    expect(
      builtInEntryId({
        species: "Solanum lycopersicum",
        variety: "Cherry",
        knowledgeId: "builtin-frozen-id",
      }),
    ).toBe("builtin-frozen-id");
  });

  it("falls back to legacy derivation when no knowledgeId is stored", () => {
    expect(builtInEntryId({ species: "Solanum lycopersicum" })).toBe(
      "builtin-solanum-lycopersicum",
    );
  });
});

// Pin the initial migration: seeded ids must equal the legacy name
// derivation. Remove this block once the first intentional id change
// (merge/rename) ships — stored ids may then legitimately diverge.
describe("initial seed cohort", () => {
  it("stored knowledgeId equals the legacy derivation", () => {
    for (const { file, entry } of entries) {
      expect(
        entry.knowledgeId,
        `${file}: ${entry.species} '${entry.variety ?? "base"}'`,
      ).toBe(legacyEntryId(entry.species, entry.variety));
    }
  });
});

// ─── Seed cohort accounting (permanent) ───
// The 137 ids minted when knowledgeId was introduced. Frozen history:
// this baseline is what makes entry removals detectable. When an entry is
// deliberately removed, its id must move from currentIds to retiredIds —
// it may never disappear from the registry entirely, and it can never be
// reassigned (enforced by the retired-id tests above).
const SEED_COHORT: ReadonlySet<string> = new Set([
  "builtin-abelmoschus-esculentus", "builtin-allium-cepa", "builtin-allium-cepa-red", "builtin-allium-cepa-white",
  "builtin-allium-cepa-yellow", "builtin-allium-sativum", "builtin-allium-sativum-hardneck", "builtin-allium-sativum-softneck",
  "builtin-allium-schoenoprasum", "builtin-anethum-graveolens", "builtin-anethum-graveolens-bouquet", "builtin-apium-graveolens",
  "builtin-artemisia-dracunculus", "builtin-asparagus-officinalis", "builtin-beta-vulgaris", "builtin-brassica-oleracea-var-botrytis",
  "builtin-brassica-oleracea-var-capitata", "builtin-brassica-oleracea-var-gemmifera", "builtin-brassica-oleracea-var-italica", "builtin-brassica-oleracea-var-italica-calabrese",
  "builtin-brassica-oleracea-var-italica-de-cicco", "builtin-brassica-oleracea-var-sabellica", "builtin-brassica-oleracea-var-sabellica-curly", "builtin-brassica-oleracea-var-sabellica-lacinato",
  "builtin-brassica-rapa", "builtin-capsicum-annuum-banana", "builtin-capsicum-annuum-bell", "builtin-capsicum-annuum-habanero",
  "builtin-capsicum-annuum-jalapeno", "builtin-citrullus-lanatus", "builtin-citrus-limon", "builtin-coriandrum-sativum",
  "builtin-coriandrum-sativum-santo", "builtin-coriandrum-sativum-slow-bolt", "builtin-cosmos-bipinnatus", "builtin-cosmos-bipinnatus-chocolate",
  "builtin-cosmos-bipinnatus-sensation", "builtin-cucumis-melo", "builtin-cucumis-sativus", "builtin-cucumis-sativus-english",
  "builtin-cucumis-sativus-pickling", "builtin-cucumis-sativus-slicing", "builtin-cucurbita-maxima", "builtin-cucurbita-moschata-butternut",
  "builtin-cucurbita-pepo", "builtin-cucurbita-pepo-black-beauty", "builtin-cucurbita-pepo-golden", "builtin-cymbopogon-citratus",
  "builtin-dahlia-spp", "builtin-daucus-carota", "builtin-daucus-carota-chantenay", "builtin-daucus-carota-danvers",
  "builtin-daucus-carota-nantes", "builtin-echinacea-purpurea", "builtin-ficus-carica", "builtin-foeniculum-vulgare",
  "builtin-fragaria-ananassa", "builtin-fragaria-ananassa-albion", "builtin-fragaria-ananassa-earliglow", "builtin-fragaria-ananassa-ozark-beauty",
  "builtin-helianthus-annuus", "builtin-helianthus-annuus-autumn-beauty", "builtin-helianthus-annuus-mammoth", "builtin-helianthus-annuus-teddy-bear",
  "builtin-hibiscus-moscheutos", "builtin-hydrangea-macrophylla", "builtin-ipomoea-batatas", "builtin-ipomoea-purpurea",
  "builtin-lactuca-sativa", "builtin-lactuca-sativa-butterhead", "builtin-lactuca-sativa-iceberg", "builtin-lactuca-sativa-red-leaf",
  "builtin-lactuca-sativa-romaine", "builtin-lathyrus-odoratus", "builtin-lavandula-angustifolia", "builtin-malus-domestica",
  "builtin-matricaria-chamomilla", "builtin-mentha-spp", "builtin-mentha-spp-peppermint", "builtin-mentha-spp-spearmint",
  "builtin-ocimum-basilicum", "builtin-ocimum-basilicum-purple", "builtin-ocimum-basilicum-sweet", "builtin-ocimum-basilicum-thai",
  "builtin-origanum-vulgare", "builtin-petroselinum-crispum", "builtin-petroselinum-crispum-curly", "builtin-petroselinum-crispum-italian-flat-leaf",
  "builtin-petunia-hybrida", "builtin-phaseolus-vulgaris-bush", "builtin-phaseolus-vulgaris-lima", "builtin-phaseolus-vulgaris-pole",
  "builtin-pisum-sativum-snow", "builtin-pisum-sativum-sugar-snap", "builtin-prunus-avium", "builtin-prunus-persica",
  "builtin-raphanus-sativus", "builtin-rosa-spp", "builtin-rubus-fruticosus", "builtin-rubus-idaeus",
  "builtin-rubus-idaeus-heritage", "builtin-rubus-idaeus-latham", "builtin-rudbeckia-hirta", "builtin-salvia-officinalis",
  "builtin-salvia-rosmarinus", "builtin-salvia-rosmarinus-common", "builtin-solanum-lycopersicum-beefsteak", "builtin-solanum-lycopersicum-brandywine",
  "builtin-solanum-lycopersicum-cherry", "builtin-solanum-lycopersicum-roma", "builtin-solanum-lycopersicum-san-marzano", "builtin-solanum-lycopersicum-sun-gold",
  "builtin-solanum-melongena", "builtin-solanum-tuberosum", "builtin-solanum-tuberosum-red", "builtin-solanum-tuberosum-russet",
  "builtin-solanum-tuberosum-yukon-gold", "builtin-spinacia-oleracea", "builtin-spinacia-oleracea-bloomsdale", "builtin-spinacia-oleracea-space",
  "builtin-tagetes-spp", "builtin-tagetes-spp-african", "builtin-tagetes-spp-french", "builtin-thymus-vulgaris",
  "builtin-thymus-vulgaris-common", "builtin-tropaeolum-majus", "builtin-tropaeolum-majus-jewel-mix", "builtin-vaccinium-corymbosum",
  "builtin-vaccinium-corymbosum-bluecrop", "builtin-vaccinium-corymbosum-duke", "builtin-vitis-vinifera", "builtin-zea-mays",
  "builtin-zea-mays-popcorn", "builtin-zinnia-elegans", "builtin-zinnia-elegans-giant-dahlia", "builtin-zinnia-elegans-profusion",
  "builtin-zinnia-elegans-state-fair",
]);

describe("seed cohort accounting", () => {
  it("every seeded id is either current or retired — removal without retirement fails", () => {
    const current = new Set<string>(manifest.currentIds);
    const retired = new Set<string>(manifest.retiredIds);
    for (const id of SEED_COHORT) {
      expect(
        current.has(id) !== retired.has(id),
        `seed id ${id} must be in exactly one of currentIds / retiredIds`,
      ).toBe(true);
    }
  });
});
