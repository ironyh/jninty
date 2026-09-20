import type { Planting } from "../validation/planting.schema.ts";
import type { PlantInstance } from "../validation/plantInstance.schema.ts";
import { getCompanions, loadKnowledgeBase } from "./knowledgeBase.ts";

// ─── Types ───

export interface CompanionPairing {
  plantA: { id: string; name: string };
  plantB: { id: string; name: string };
  tag: string; // the companion tag that matched (e.g. "basil")
}

export interface CompanionSuggestion {
  forPlant: { id: string; name: string };
  suggestedCompanion: string; // common name tag (e.g. "basil")
}

export interface CompanionReport {
  goodPairings: CompanionPairing[];
  badPairings: CompanionPairing[];
  suggestions: CompanionSuggestion[];
}

export type PlantTokenStatus = {
  status: "good" | "bad" | "neutral";
  messages: string[];
};

// ─── Group name expansion ───

const COMPANION_GROUP_MEMBERS: Record<string, string[]> = {
  brassicas: [
    "broccoli",
    "cabbage",
    "kale",
    "cauliflower",
    "brussels sprout",
    "kohlrabi",
    "collard",
    "bok choy",
  ],
  alliums: ["onion", "garlic", "leek", "chive", "shallot", "scallion"],
  legumes: ["bean", "pea", "lentil", "chickpea"],
  nightshades: ["tomato", "pepper", "eggplant", "potato"],
  cucurbits: ["cucumber", "squash", "melon", "pumpkin", "zucchini", "gourd"],
  "aromatic herbs": [
    "basil",
    "oregano",
    "rosemary",
    "thyme",
    "sage",
    "mint",
    "dill",
    "cilantro",
    "parsley",
  ],
};

// ─── Helpers ───

import type { PlantKnowledge } from "../validation/plantKnowledge.schema.ts";

/** Cached species-to-KB-entry index. Rebuilt when the KB cache changes. */
let speciesIndex: Map<string, PlantKnowledge> | null = null;
let speciesIndexSource: PlantKnowledge[] | null = null;

function getSpeciesIndex(): Map<string, PlantKnowledge> {
  const kb = loadKnowledgeBase();
  if (speciesIndex && speciesIndexSource === kb) return speciesIndex;
  const idx = new Map<string, PlantKnowledge>();
  for (const entry of kb) {
    const key = entry.species.toLowerCase();
    if (!idx.has(key)) {
      idx.set(key, entry);
    }
  }
  speciesIndex = idx;
  speciesIndexSource = kb;
  return idx;
}

function getDisplayName(plant: PlantInstance): string {
  return plant.nickname ?? plant.species;
}

/**
 * Case-insensitive whole-word phrase test: does `name` contain the exact token
 * sequence of `phrase` (tokens split on non-alphanumeric boundaries)?
 */
function wholeWordMatch(name: string, phrase: string): boolean {
  const nameTokens = name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const phraseTokens = phrase.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (phraseTokens.length === 0 || phraseTokens.length > nameTokens.length) return false;
  outer: for (let i = 0; i <= nameTokens.length - phraseTokens.length; i++) {
    for (let j = 0; j < phraseTokens.length; j++) {
      if (nameTokens[i + j] !== phraseTokens[j]) continue outer;
    }
    return true;
  }
  return false;
}

/**
 * Audited final-token plural variant of a group-member phrase
 * (e.g. "brussels sprout" → "brussels sprouts"). No other inflection.
 */
function withFinalTokenPlural(phrase: string): string {
  const tokens = phrase.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (tokens.length === 0) return phrase;
  return [...tokens.slice(0, -1), tokens[tokens.length - 1] + "s"].join(" ");
}

/**
 * Checks if a companion tag matches a plant's common name.
 * Strict deterministic matching: case-insensitive exact or whole-word match,
 * plus group-name expansion over declared members with a final-token plural
 * tolerance. No substring fallback — the documented substring accidents
 * (rose→Rosemary, melon→Watermelon, grass→Lemongrass) are intentionally not matched.
 */
function companionTagMatchesPlant(
  tag: string,
  plantSpecies: string,
  index: Map<string, PlantKnowledge>,
): boolean {
  const plantEntry = index.get(plantSpecies.toLowerCase());
  if (!plantEntry) return false;

  const commonNameLower = plantEntry.commonName.toLowerCase();
  const tagLower = tag.toLowerCase();

  // Exact normalized match
  if (commonNameLower === tagLower) return true;

  // Whole-word match against commonName
  if (wholeWordMatch(commonNameLower, tagLower)) return true;

  // Group name expansion: the tag is a declared group name; the plant matches
  // any member exactly, as a whole word, or as a final-token plural.
  const groupMembers = COMPANION_GROUP_MEMBERS[tagLower];
  if (groupMembers) {
    return groupMembers.some(
      (member) =>
        wholeWordMatch(commonNameLower, member) ||
        wholeWordMatch(commonNameLower, withFinalTokenPlural(member)),
    );
  }

  return false;
}

function makePairKey(idA: string, idB: string, tag: string): string {
  const sorted = [idA, idB].sort();
  return `${sorted[0]}|${sorted[1]}|${tag}`;
}

// ─── Core analysis ───

/**
 * Analyzes companion planting relationships for all plants in a bed.
 * Returns good pairings, bad pairings (conflicts), and suggestions.
 */
export function analyzeBedCompanions(
  bedId: string,
  plantings: Planting[],
  plantsMap: Map<string, PlantInstance>,
): CompanionReport {
  const bedPlantings = plantings.filter((p) => p.bedId === bedId);

  const goodPairings: CompanionPairing[] = [];
  const badPairings: CompanionPairing[] = [];
  const suggestions: CompanionSuggestion[] = [];
  const seenPairKeys = new Set<string>();
  const index = getSpeciesIndex();

  // Build a list of plants in this bed with their species
  const bedPlants: Array<{ planting: Planting; plant: PlantInstance }> = [];
  for (const planting of bedPlantings) {
    const plant = plantsMap.get(planting.plantInstanceId);
    if (plant) {
      bedPlants.push({ planting, plant });
    }
  }

  // Check every pair of plants
  for (let i = 0; i < bedPlants.length; i++) {
    const entryA = bedPlants[i]!;
    const companionsA = getCompanions(entryA.plant.species);

    for (let j = i + 1; j < bedPlants.length; j++) {
      const entryB = bedPlants[j]!;

      // Check if B is a good companion for A
      for (const goodTag of companionsA.good) {
        if (companionTagMatchesPlant(goodTag, entryB.plant.species, index)) {
          const key = makePairKey(
            entryA.plant.id,
            entryB.plant.id,
            goodTag,
          );
          if (!seenPairKeys.has(key)) {
            seenPairKeys.add(key);
            goodPairings.push({
              plantA: {
                id: entryA.plant.id,
                name: getDisplayName(entryA.plant),
              },
              plantB: {
                id: entryB.plant.id,
                name: getDisplayName(entryB.plant),
              },
              tag: goodTag,
            });
          }
        }
      }

      // Check if B is a bad companion for A
      for (const badTag of companionsA.bad) {
        if (companionTagMatchesPlant(badTag, entryB.plant.species, index)) {
          const key = makePairKey(
            entryA.plant.id,
            entryB.plant.id,
            badTag,
          );
          if (!seenPairKeys.has(key)) {
            seenPairKeys.add(key);
            badPairings.push({
              plantA: {
                id: entryA.plant.id,
                name: getDisplayName(entryA.plant),
              },
              plantB: {
                id: entryB.plant.id,
                name: getDisplayName(entryB.plant),
              },
              tag: badTag,
            });
          }
        }
      }

      // Also check the reverse: A is a good/bad companion for B
      const companionsB = getCompanions(entryB.plant.species);

      for (const goodTag of companionsB.good) {
        if (companionTagMatchesPlant(goodTag, entryA.plant.species, index)) {
          const key = makePairKey(
            entryA.plant.id,
            entryB.plant.id,
            goodTag,
          );
          if (!seenPairKeys.has(key)) {
            seenPairKeys.add(key);
            goodPairings.push({
              plantA: {
                id: entryB.plant.id,
                name: getDisplayName(entryB.plant),
              },
              plantB: {
                id: entryA.plant.id,
                name: getDisplayName(entryA.plant),
              },
              tag: goodTag,
            });
          }
        }
      }

      for (const badTag of companionsB.bad) {
        if (companionTagMatchesPlant(badTag, entryA.plant.species, index)) {
          const key = makePairKey(
            entryA.plant.id,
            entryB.plant.id,
            badTag,
          );
          if (!seenPairKeys.has(key)) {
            seenPairKeys.add(key);
            badPairings.push({
              plantA: {
                id: entryB.plant.id,
                name: getDisplayName(entryB.plant),
              },
              plantB: {
                id: entryA.plant.id,
                name: getDisplayName(entryA.plant),
              },
              tag: badTag,
            });
          }
        }
      }
    }

    // Generate suggestions for good companions not present in the bed.
    // Only for small beds (≤3 plants) to keep suggestions actionable.
    if (bedPlants.length <= 3) {
      let suggestionCount = 0;

      for (const goodTag of companionsA.good) {
        if (suggestionCount >= 3) break;

        // Check if any plant in the bed already matches this tag
        const alreadyPresent = bedPlants.some((bp) =>
          companionTagMatchesPlant(goodTag, bp.plant.species, index),
        );
        if (alreadyPresent) continue;

        // Don't suggest if the tag matches the plant's own species
        if (companionTagMatchesPlant(goodTag, entryA.plant.species, index))
          continue;

        suggestions.push({
          forPlant: {
            id: entryA.plant.id,
            name: getDisplayName(entryA.plant),
          },
          suggestedCompanion: goodTag,
        });
        suggestionCount++;
      }
    }
  }

  // Deduplicate suggestions (same companion tag for different plants)
  const uniqueSuggestions: CompanionSuggestion[] = [];
  const seenSuggestionTags = new Set<string>();
  for (const s of suggestions) {
    if (!seenSuggestionTags.has(s.suggestedCompanion.toLowerCase())) {
      seenSuggestionTags.add(s.suggestedCompanion.toLowerCase());
      uniqueSuggestions.push(s);
    }
  }

  return {
    goodPairings,
    badPairings,
    suggestions: uniqueSuggestions.slice(0, 3),
  };
}

/**
 * Returns per-plant companion status for token rendering.
 * Bad overrides good — a plant with both a conflict and a benefit shows "bad".
 * Accepts an optional pre-computed report to avoid redundant analysis.
 */
export function getPlantTokenStatuses(
  bedId: string,
  plantings: Planting[],
  plantsMap: Map<string, PlantInstance>,
  precomputedReport?: CompanionReport | undefined,
): Map<string, PlantTokenStatus> {
  const report =
    precomputedReport ?? analyzeBedCompanions(bedId, plantings, plantsMap);
  const statusMap = new Map<string, PlantTokenStatus>();

  // Collect messages per plant
  const plantMessages = new Map<
    string,
    { good: string[]; bad: string[] }
  >();

  function ensureEntry(id: string) {
    if (!plantMessages.has(id)) {
      plantMessages.set(id, { good: [], bad: [] });
    }
    return plantMessages.get(id)!;
  }

  for (const pairing of report.goodPairings) {
    const entryA = ensureEntry(pairing.plantA.id);
    entryA.good.push(
      `Good companion with ${pairing.plantB.name}`,
    );
    const entryB = ensureEntry(pairing.plantB.id);
    entryB.good.push(
      `Good companion with ${pairing.plantA.name}`,
    );
  }

  for (const pairing of report.badPairings) {
    const entryA = ensureEntry(pairing.plantA.id);
    entryA.bad.push(
      `Conflict with ${pairing.plantB.name}`,
    );
    const entryB = ensureEntry(pairing.plantB.id);
    entryB.bad.push(
      `Conflict with ${pairing.plantA.name}`,
    );
  }

  // Determine final status: bad overrides good
  for (const [id, msgs] of plantMessages) {
    if (msgs.bad.length > 0) {
      statusMap.set(id, {
        status: "bad",
        messages: [...msgs.bad, ...msgs.good],
      });
    } else if (msgs.good.length > 0) {
      statusMap.set(id, { status: "good", messages: msgs.good });
    }
  }

  return statusMap;
}
