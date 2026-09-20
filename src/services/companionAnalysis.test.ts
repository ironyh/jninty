import { describe, it, expect, beforeEach } from "vitest";
import { clearKnowledgeBaseCache } from "./knowledgeBase.ts";
import {
  analyzeBedCompanions,
  getPlantTokenStatuses,
} from "./companionAnalysis.ts";
import type { Planting } from "../validation/planting.schema.ts";
import type { PlantInstance } from "../validation/plantInstance.schema.ts";

// ─── Test helpers ───

const now = new Date().toISOString();

function makePlant(
  overrides: Partial<PlantInstance> & { id: string; species: string },
): PlantInstance {
  return {
    type: "vegetable",
    isPerennial: false,
    source: "seed",
    status: "active",
    tags: [],
    version: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makePlanting(
  overrides: Partial<Planting> & {
    id: string;
    plantInstanceId: string;
    bedId: string;
  },
): Planting {
  return {
    seasonId: "season-1",
    version: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function buildMap(plants: PlantInstance[]): Map<string, PlantInstance> {
  const m = new Map<string, PlantInstance>();
  for (const p of plants) {
    m.set(p.id, p);
  }
  return m;
}

// ─── Tests ───

beforeEach(() => {
  clearKnowledgeBaseCache();
});

describe("analyzeBedCompanions", () => {
  it("detects good pairings (tomato + basil)", () => {
    const tomato = makePlant({
      id: "p1",
      species: "Solanum lycopersicum",
      nickname: "Tomato",
    });
    const basil = makePlant({
      id: "p2",
      species: "Ocimum basilicum",
      nickname: "Basil",
      type: "herb",
    });

    const plantings: Planting[] = [
      makePlanting({ id: "pl1", plantInstanceId: "p1", bedId: "bed-1" }),
      makePlanting({ id: "pl2", plantInstanceId: "p2", bedId: "bed-1" }),
    ];

    const report = analyzeBedCompanions(
      "bed-1",
      plantings,
      buildMap([tomato, basil]),
    );

    expect(report.goodPairings.length).toBeGreaterThan(0);
    const hasBasilPairing = report.goodPairings.some(
      (p) =>
        (p.plantA.id === "p1" && p.plantB.id === "p2") ||
        (p.plantA.id === "p2" && p.plantB.id === "p1"),
    );
    expect(hasBasilPairing).toBe(true);
  });

  it("detects bad pairings (tomato + fennel)", () => {
    const tomato = makePlant({
      id: "p1",
      species: "Solanum lycopersicum",
      nickname: "Tomato",
    });
    const fennel = makePlant({
      id: "p2",
      species: "Foeniculum vulgare",
      nickname: "Fennel",
      type: "herb",
    });

    const plantings: Planting[] = [
      makePlanting({ id: "pl1", plantInstanceId: "p1", bedId: "bed-1" }),
      makePlanting({ id: "pl2", plantInstanceId: "p2", bedId: "bed-1" }),
    ];

    const report = analyzeBedCompanions(
      "bed-1",
      plantings,
      buildMap([tomato, fennel]),
    );

    expect(report.badPairings.length).toBeGreaterThan(0);
    const hasFennelConflict = report.badPairings.some(
      (p) =>
        (p.plantA.id === "p1" && p.plantB.id === "p2") ||
        (p.plantA.id === "p2" && p.plantB.id === "p1"),
    );
    expect(hasFennelConflict).toBe(true);
  });

  it("returns empty report for empty bed", () => {
    const report = analyzeBedCompanions("bed-1", [], new Map());
    expect(report.goodPairings).toEqual([]);
    expect(report.badPairings).toEqual([]);
    expect(report.suggestions).toEqual([]);
  });

  it("generates suggestions for solo plants", () => {
    const tomato = makePlant({
      id: "p1",
      species: "Solanum lycopersicum",
      nickname: "Tomato",
    });

    const plantings: Planting[] = [
      makePlanting({ id: "pl1", plantInstanceId: "p1", bedId: "bed-1" }),
    ];

    const report = analyzeBedCompanions(
      "bed-1",
      plantings,
      buildMap([tomato]),
    );

    expect(report.suggestions.length).toBeGreaterThan(0);
    expect(report.suggestions.length).toBeLessThanOrEqual(3);
    expect(report.suggestions[0]!.forPlant.id).toBe("p1");
  });

  it("handles plants with no knowledge base entry gracefully", () => {
    const unknown = makePlant({
      id: "p1",
      species: "Nonexistus plantus",
      nickname: "Unknown",
    });

    const plantings: Planting[] = [
      makePlanting({ id: "pl1", plantInstanceId: "p1", bedId: "bed-1" }),
    ];

    const report = analyzeBedCompanions(
      "bed-1",
      plantings,
      buildMap([unknown]),
    );

    expect(report.goodPairings).toEqual([]);
    expect(report.badPairings).toEqual([]);
    expect(report.suggestions).toEqual([]);
  });

  it("suggests rose for solo hibiscus and suppresses it once rose is present in the bed", () => {
    const hibiscus = makePlant({ id: "p1", species: "Hibiscus moscheutos", nickname: "Hibiscus" });
    const soloPlantings: Planting[] = [
      makePlanting({ id: "pl1", plantInstanceId: "p1", bedId: "bed-1" }),
    ];

    const solo = analyzeBedCompanions("bed-1", soloPlantings, buildMap([hibiscus]));
    expect(solo.suggestions[0]).toMatchObject({
      forPlant: { id: "p1" },
      suggestedCompanion: "rose",
    });

    const rose = makePlant({ id: "p2", species: "Rosa spp.", nickname: "Rose" });
    const bedPlantings: Planting[] = [
      makePlanting({ id: "pl1", plantInstanceId: "p1", bedId: "bed-1" }),
      makePlanting({ id: "pl2", plantInstanceId: "p2", bedId: "bed-1" }),
    ];

    const withRose = analyzeBedCompanions("bed-1", bedPlantings, buildMap([hibiscus, rose]));
    expect(withRose.suggestions.every((s) => s.suggestedCompanion !== "rose")).toBe(true);
  });

  it("caps suggestions at three when more eligible companions exist", () => {
    const rose = makePlant({ id: "p1", species: "Rosa spp.", nickname: "Rose" });
    const plantings: Planting[] = [makePlanting({ id: "pl1", plantInstanceId: "p1", bedId: "bed-1" })];

    const report = analyzeBedCompanions("bed-1", plantings, buildMap([rose]));

    // Rose lists five good companions, none matching itself; the per-plant cap binds.
    expect(report.suggestions).toHaveLength(3);
    const roseGood = new Set(["garlic", "chives", "lavender", "marigold", "parsley"]);
    for (const s of report.suggestions) {
      expect(roseGood.has(s.suggestedCompanion)).toBe(true);
      expect(s.forPlant.id).toBe("p1");
    }
  });


  it("no longer matches documented substring accidents", () => {
    const apple = makePlant({ id: "p1", species: "Malus domestica", nickname: "Apple" });
    const lemongrass = makePlant({ id: "p2", species: "Cymbopogon citratus", nickname: "Lemongrass" });
    const cucumber = makePlant({ id: "p3", species: "Cucumis sativus", nickname: "Cucumber" });
    const watermelon = makePlant({ id: "p4", species: "Citrullus lanatus", nickname: "Watermelon" });
    const parsley = makePlant({ id: "p5", species: "Petroselinum crispum", nickname: "Parsley" });
    const rosemary = makePlant({ id: "p6", species: "Salvia rosmarinus", nickname: "Rosemary" });

    const grassBed = analyzeBedCompanions(
      "b1",
      [makePlanting({ id: "q1", plantInstanceId: "p1", bedId: "b1" }), makePlanting({ id: "q2", plantInstanceId: "p2", bedId: "b1" })],
      buildMap([apple, lemongrass]),
    );
    const melonBed = analyzeBedCompanions(
      "b2",
      [makePlanting({ id: "q3", plantInstanceId: "p3", bedId: "b2" }), makePlanting({ id: "q4", plantInstanceId: "p4", bedId: "b2" })],
      buildMap([cucumber, watermelon]),
    );
    const roseBed = analyzeBedCompanions(
      "b3",
      [makePlanting({ id: "q5", plantInstanceId: "p5", bedId: "b3" }), makePlanting({ id: "q6", plantInstanceId: "p6", bedId: "b3" })],
      buildMap([parsley, rosemary]),
    );

    // Apple lists grass as bad, Cucumber lists melon as bad, Parsley lists rose
    // as good: none of these may pair now that the substring accidents
    // (grass→Lemongrass, melon→Watermelon, rose→Rosemary) are removed.
    for (const report of [grassBed, melonBed, roseBed]) {
      expect(report.badPairings.some((p) => ["grass", "melon"].includes(p.tag))).toBe(false);
      expect(report.goodPairings.some((p) => p.tag === "rose")).toBe(false);
    }
  });

  it("retains the brassicas group match with Brussels Sprouts via final-token plural", () => {
    const tomato = makePlant({ id: "p1", species: "Solanum lycopersicum", nickname: "Tomato" });
    const brussels = makePlant({ id: "p2", species: "Brassica oleracea var. gemmifera", nickname: "Brussels Sprouts" });
    const plantings: Planting[] = [
      makePlanting({ id: "pl1", plantInstanceId: "p1", bedId: "bed-1" }),
      makePlanting({ id: "pl2", plantInstanceId: "p2", bedId: "bed-1" }),
    ];

    const report = analyzeBedCompanions("bed-1", plantings, buildMap([tomato, brussels]));

    // Tomato lists brassicas as bad; the member "brussels sprout" must still match
    // "Brussels Sprouts" through the audited final-token plural rule.
    expect(report.badPairings.some((p) => p.tag === "brassicas" && p.plantB.id === "p2")).toBe(true);
  });

  it("suggests rose for hibiscus beside rosemary (accident removal unblocks the suggestion)", () => {
    const hibiscus = makePlant({ id: "p1", species: "Hibiscus moscheutos", nickname: "Hibiscus" });
    const rosemary = makePlant({ id: "p2", species: "Salvia rosmarinus", nickname: "Rosemary" });
    const plantings: Planting[] = [
      makePlanting({ id: "pl1", plantInstanceId: "p1", bedId: "bed-1" }),
      makePlanting({ id: "pl2", plantInstanceId: "p2", bedId: "bed-1" }),
    ];

    const report = analyzeBedCompanions("bed-1", plantings, buildMap([hibiscus, rosemary]));

    // Positive control placed FIRST so the three-suggestion cap cannot hide it:
    // Hibiscus lists rose first and Rosemary no longer suppresses it (the substring
    // accident is gone), so rose must be the first suggestion for Hibiscus.
    expect(report.suggestions[0]).toMatchObject({
      forPlant: { id: "p1" },
      suggestedCompanion: "rose",
    });
    // And the false good pairing rose→Rosemary must be gone.
    expect(report.goodPairings.some((p) => p.tag === "rose")).toBe(false);
  });
  it("deduplicates symmetric pairings", () => {
    // Tomato says basil is good, basil says tomato is good —
    // should only appear once
    const tomato = makePlant({
      id: "p1",
      species: "Solanum lycopersicum",
      nickname: "Tomato",
    });
    const basil = makePlant({
      id: "p2",
      species: "Ocimum basilicum",
      nickname: "Basil",
      type: "herb",
    });

    const plantings: Planting[] = [
      makePlanting({ id: "pl1", plantInstanceId: "p1", bedId: "bed-1" }),
      makePlanting({ id: "pl2", plantInstanceId: "p2", bedId: "bed-1" }),
    ];

    const report = analyzeBedCompanions(
      "bed-1",
      plantings,
      buildMap([tomato, basil]),
    );

    // Check that the "basil" tag pairing only appears once
    const basilPairings = report.goodPairings.filter(
      (p) => p.tag === "basil",
    );
    expect(basilPairings.length).toBe(1);

    // And the "tomato" tag pairing only appears once
    const tomatoPairings = report.goodPairings.filter(
      (p) => p.tag === "tomato",
    );
    expect(tomatoPairings.length).toBe(1);
  });

  it("only includes plantings for the specified bed", () => {
    const tomato = makePlant({
      id: "p1",
      species: "Solanum lycopersicum",
      nickname: "Tomato",
    });
    const basil = makePlant({
      id: "p2",
      species: "Ocimum basilicum",
      nickname: "Basil",
      type: "herb",
    });

    const plantings: Planting[] = [
      makePlanting({ id: "pl1", plantInstanceId: "p1", bedId: "bed-1" }),
      makePlanting({ id: "pl2", plantInstanceId: "p2", bedId: "bed-2" }), // different bed
    ];

    const report = analyzeBedCompanions(
      "bed-1",
      plantings,
      buildMap([tomato, basil]),
    );

    expect(report.goodPairings).toEqual([]);
    expect(report.badPairings).toEqual([]);
  });
  it("detects bad pairings via group name expansion (brassicas)", () => {
    // Tomato has badCompanions: ["brassicas"], broccoli is a brassica
    const tomato = makePlant({
      id: "p1",
      species: "Solanum lycopersicum",
      nickname: "Tomato",
    });
    const broccoli = makePlant({
      id: "p2",
      species: "Brassica oleracea var. italica",
      nickname: "Broccoli",
    });

    const plantings: Planting[] = [
      makePlanting({ id: "pl1", plantInstanceId: "p1", bedId: "bed-1" }),
      makePlanting({ id: "pl2", plantInstanceId: "p2", bedId: "bed-1" }),
    ];

    const report = analyzeBedCompanions(
      "bed-1",
      plantings,
      buildMap([tomato, broccoli]),
    );

    expect(report.badPairings.length).toBeGreaterThan(0);
    const hasBrassicaConflict = report.badPairings.some(
      (p) => p.tag === "brassicas",
    );
    expect(hasBrassicaConflict).toBe(true);
  });
});

describe("getPlantTokenStatuses", () => {
  it("returns good status for beneficial pairings", () => {
    const tomato = makePlant({
      id: "p1",
      species: "Solanum lycopersicum",
      nickname: "Tomato",
    });
    const basil = makePlant({
      id: "p2",
      species: "Ocimum basilicum",
      nickname: "Basil",
      type: "herb",
    });

    const plantings: Planting[] = [
      makePlanting({ id: "pl1", plantInstanceId: "p1", bedId: "bed-1" }),
      makePlanting({ id: "pl2", plantInstanceId: "p2", bedId: "bed-1" }),
    ];

    const statuses = getPlantTokenStatuses(
      "bed-1",
      plantings,
      buildMap([tomato, basil]),
    );

    const tomatoStatus = statuses.get("p1");
    expect(tomatoStatus).toBeDefined();
    expect(tomatoStatus!.status).toBe("good");
    expect(tomatoStatus!.messages.length).toBeGreaterThan(0);
  });

  it("returns bad status for conflict pairings", () => {
    const tomato = makePlant({
      id: "p1",
      species: "Solanum lycopersicum",
      nickname: "Tomato",
    });
    const fennel = makePlant({
      id: "p2",
      species: "Foeniculum vulgare",
      nickname: "Fennel",
      type: "herb",
    });

    const plantings: Planting[] = [
      makePlanting({ id: "pl1", plantInstanceId: "p1", bedId: "bed-1" }),
      makePlanting({ id: "pl2", plantInstanceId: "p2", bedId: "bed-1" }),
    ];

    const statuses = getPlantTokenStatuses(
      "bed-1",
      plantings,
      buildMap([tomato, fennel]),
    );

    const tomatoStatus = statuses.get("p1");
    expect(tomatoStatus).toBeDefined();
    expect(tomatoStatus!.status).toBe("bad");
  });

  it("bad overrides good when plant has both", () => {
    // Tomato with basil (good) and fennel (bad)
    const tomato = makePlant({
      id: "p1",
      species: "Solanum lycopersicum",
      nickname: "Tomato",
    });
    const basil = makePlant({
      id: "p2",
      species: "Ocimum basilicum",
      nickname: "Basil",
      type: "herb",
    });
    const fennel = makePlant({
      id: "p3",
      species: "Foeniculum vulgare",
      nickname: "Fennel",
      type: "herb",
    });

    const plantings: Planting[] = [
      makePlanting({ id: "pl1", plantInstanceId: "p1", bedId: "bed-1" }),
      makePlanting({ id: "pl2", plantInstanceId: "p2", bedId: "bed-1" }),
      makePlanting({ id: "pl3", plantInstanceId: "p3", bedId: "bed-1" }),
    ];

    const statuses = getPlantTokenStatuses(
      "bed-1",
      plantings,
      buildMap([tomato, basil, fennel]),
    );

    const tomatoStatus = statuses.get("p1");
    expect(tomatoStatus).toBeDefined();
    expect(tomatoStatus!.status).toBe("bad");
    // Should include both bad and good messages
    expect(
      tomatoStatus!.messages.some((m) => m.includes("Conflict")),
    ).toBe(true);
    expect(
      tomatoStatus!.messages.some((m) => m.includes("Good companion")),
    ).toBe(true);
  });

  it("returns empty map for unknown species", () => {
    const unknown = makePlant({
      id: "p1",
      species: "Nonexistus plantus",
      nickname: "Unknown",
    });

    const plantings: Planting[] = [
      makePlanting({ id: "pl1", plantInstanceId: "p1", bedId: "bed-1" }),
    ];

    const statuses = getPlantTokenStatuses(
      "bed-1",
      plantings,
      buildMap([unknown]),
    );

    expect(statuses.size).toBe(0);
  });
});
