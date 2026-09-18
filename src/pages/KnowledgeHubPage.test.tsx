import "fake-indexeddb/auto";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { clearPouchDB } from "../db/pouchdb/testUtils.ts";
import { userPlantKnowledgeRepository } from "../db/index.ts";
import KnowledgeHubPage from "./KnowledgeHubPage.tsx";

// page render + pouch query + debounce need more than the default 5 s here
vi.setConfig({ testTimeout: 20000 });

async function seedCustomEntry(input: {
  commonName: string;
  species: string;
  variety?: string;
}) {
  await userPlantKnowledgeRepository.create({
    commonName: input.commonName,
    species: input.species,
    ...(input.variety != null ? { variety: input.variety } : {}),
    plantType: "vegetable",
    isPerennial: false,
    cropGroup: input.species.toLowerCase().replace(/\s+/g, "-"),
    sunNeeds: "full_sun",
    waterNeeds: "moderate",
  });
}

beforeEach(async () => {
  await clearPouchDB();
  await seedCustomEntry({ commonName: "Dwarf Basil", species: "Ocimum basilicum", variety: "Dwarf" });
  await seedCustomEntry({ commonName: "Heirloom Lettuce", species: "Lactuca sativa", variety: "Heirloom" });
  await seedCustomEntry({ commonName: "My Special Pepper", species: "Capsicum annuum" });
  await seedCustomEntry({ commonName: "Mystery Melon", species: "Cucumis mysteriosus" });
});

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/knowledge"]}>
      <KnowledgeHubPage />
    </MemoryRouter>,
  );
}

async function search(query: string) {
  // wait for the knowledge base to load (search input renders after loading;
  // loading can take >1 s with fake-indexeddb). Note: type="search" has the
  // ARIA role "searchbox", not "textbox".
  const input = await screen.findByPlaceholderText(/search by name, species/i, {}, { timeout: 5000 });
  await userEvent.clear(input);
  await userEvent.type(input, query);
  // debounce (250 ms) + rerender
  await new Promise((r) => setTimeout(r, 400));
}

/** Href order of the visible /knowledge/ result cards (excludes category cards, hidden while searching). */
function resultHrefs(): string[] {
  return [...screen.queryAllByRole("link")]
    .map((a) => a.getAttribute("href") ?? "")
    .filter((h) => h.startsWith("/knowledge/") && !h.endsWith("/knowledge") && !h.includes("/knowledge/plants/") && !h.includes("/knowledge/new") && !h.includes("/edit"));
}

describe("KnowledgeHubPage search", () => {
  it("lists builtin and custom entries on the hub", async () => {
    renderPage();
    expect(await screen.findByText("Dwarf Basil")).toBeInTheDocument();
    expect(screen.getByText("Mystery Melon")).toBeInTheDocument();
    expect(screen.getByText(/141 entries/)).toBeInTheDocument(); // 137 builtin + 4 custom
  });

  it("existing query 'tomato' returns the builtin tomato rows alphabetically", async () => {
    renderPage();
    await search("tomato");
    const hrefs = resultHrefs();
    expect(hrefs).toHaveLength(6);
    // alphabetical by commonName: Beefsteak, Brandywine, Cherry, Roma, San Marzano, Sun Gold
    expect(hrefs.map((h) => h.replace("/knowledge/", ""))).toEqual([
      "builtin-solanum-lycopersicum-beefsteak",
      "builtin-solanum-lycopersicum-brandywine",
      "builtin-solanum-lycopersicum-cherry",
      "builtin-solanum-lycopersicum-roma",
      "builtin-solanum-lycopersicum-san-marzano",
      "builtin-solanum-lycopersicum-sun-gold",
    ]);
  });

  it.each(["rosemary", "Brandywine"])(
    "existing query '%s' is unchanged",
    async (query) => {
      renderPage();
      await search(query);
      const hrefs = resultHrefs();
      for (const h of hrefs) expect(h).toMatch(/^\/knowledge\/builtin-/);
      expect(hrefs.length).toBe(query === "rosemary" ? 2 : 1);
    },
  );

  it("swedish alias 'potatis' finds the builtin potato rows", async () => {
    renderPage();
    await search("potatis");
    const hrefs = resultHrefs();
    expect(hrefs).toHaveLength(4);
    for (const h of hrefs) expect(h).toContain("solanum-tuberosum");
  });

  it("swedish alias 'basilika' finds builtin basil rows and the custom entry via species inheritance", async () => {
    renderPage();
    await search("basilika");
    const hrefs = resultHrefs();
    expect(hrefs).toHaveLength(5);
    const customHrefs = hrefs.filter((h) => !h.includes("builtin-"));
    expect(customHrefs).toHaveLength(1); // custom Dwarf Basil inherits via Ocimum basilicum
  });

  it("swedish alias 'sallat' finds builtin lettuce rows and the custom entry via species inheritance", async () => {
    renderPage();
    await search("sallat");
    expect(resultHrefs()).toHaveLength(6); // 5 builtin Lactuca sativa rows + custom Heirloom Lettuce
    expect(screen.getByText("Heirloom Lettuce")).toBeInTheDocument();
  });

  it("folded 'graslok' finds Chives", async () => {
    renderPage();
    await search("graslok");
    expect(resultHrefs()).toHaveLength(1);
    expect(screen.getByText("Chives")).toBeInTheDocument();
  });

  it("swedish alias 'rosenskära' finds the cosmos entries", async () => {
    renderPage();
    await search("rosenskära");
    expect(resultHrefs()).toHaveLength(3);
  });

  it("scientific alias 'Rosmarinus officinalis' finds both rosemary entries", async () => {
    renderPage();
    await search("Rosmarinus officinalis");
    expect(resultHrefs()).toHaveLength(2);
    expect(screen.getByText("Rosemary")).toBeInTheDocument();
    expect(screen.getByText("Common Rosemary")).toBeInTheDocument();
  });

  it("custom commonName search still works", async () => {
    renderPage();
    await search("My Special Pepper");
    expect(screen.getByText("My Special Pepper")).toBeInTheDocument();
    expect(resultHrefs()).toHaveLength(1);
  });

  it("custom species absent from taxonomy still finds the custom entry", async () => {
    renderPage();
    await search("Cucumis mysteriosus");
    expect(screen.getByText("Mystery Melon")).toBeInTheDocument();
    expect(resultHrefs()).toHaveLength(1);
  });

  it("custom substring search still works", async () => {
    renderPage();
    await search("mystery");
    expect(screen.getByText("Mystery Melon")).toBeInTheDocument();
  });

  it("mixed query keeps builtin and custom results together without duplicates", async () => {
    renderPage();
    await search("Ocimum basilicum");
    const hrefs = resultHrefs();
    expect(hrefs).toHaveLength(5); // 4 builtin basil + custom Dwarf Basil
    expect(new Set(hrefs).size).toBe(hrefs.length);
    expect(screen.getByText("Dwarf Basil")).toBeInTheDocument();
  });

  it("ambiguous-only candidate names do not surface results", () => {
    // Ambiguous WFO candidates are never indexed; a name that exists only as
    // a candidate (not authored, not a safe alias) must return nothing.
    // Verified at the service level in taxonomyAliases.test.ts; here we pin
    // one concrete Hub behaviour: the archived Petunia accepted-variant name.
    renderPage();
    return search("Petunia atkinsiana").then(() => {
      expect(resultHrefs()).toHaveLength(0);
    });
  });
});
