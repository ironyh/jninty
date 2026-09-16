import { z } from "zod";
import { plantKnowledgeSchema } from "../validation/plantKnowledge.schema.ts";
import type { PlantKnowledge } from "../validation/plantKnowledge.schema.ts";

import vegetablesData from "../../data/plants/vegetables.json";
import herbsData from "../../data/plants/herbs.json";
import fruitsData from "../../data/plants/fruits.json";
import flowersData from "../../data/plants/flowers.json";

const plantKnowledgeArraySchema = z.array(plantKnowledgeSchema);

/**
 * Loads and validates the bundled plant knowledge JSON files.
 * Throws if any entry fails Zod validation.
 */
export function loadBuiltinPlantKnowledge(): PlantKnowledge[] {
  const vegetables = plantKnowledgeArraySchema.parse(vegetablesData);
  const herbs = plantKnowledgeArraySchema.parse(herbsData);
  const fruits = plantKnowledgeArraySchema.parse(fruitsData);
  const flowers = plantKnowledgeArraySchema.parse(flowersData);

  return [...vegetables, ...herbs, ...fruits, ...flowers];
}
