// Wizard integration test for the per-schedule sowing method: the choice is
// committed to wizard state the moment it is made, so it survives Back
// navigation BEFORE the preview (review round 1 gap), survives preview-back,
// is kept on switches to varieties that still support it, resets on switches
// to varieties that do not, and drives preview AND persisted schedule
// (preview/save parity). Mocking pattern mirrors
// sowingMethodPersistence.test.ts (memory PouchDB).
import { describe, it, expect, beforeAll, vi } from "vitest";
import PouchDB from "pouchdb";
import PouchDBFind from "pouchdb-find";
import PouchDBAdapterMemory from "pouchdb-adapter-memory";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

PouchDB.plugin(PouchDBFind);
PouchDB.plugin(PouchDBAdapterMemory);

let testDB: PouchDB.Database;

vi.mock("../../db/pouchdb/client.ts", () => ({
  get localDB() {
    return testDB;
  },
  async destroyAndRecreate() {
    testDB = new PouchDB(`sowing-wizard-${crypto.randomUUID()}`, {
      adapter: "memory",
    });
  },
  setupSync: vi.fn(),
  stopSync: vi.fn(),
  getSyncStatus: () => "disabled" as const,
  subscribeSyncStatus: () => () => {},
  getLastSyncedAt: () => null,
  testConnection: vi.fn(),
}));

vi.mock("../../db/pouchdb/originalsStore.ts", () => ({
  saveOriginal: vi.fn(),
  getOriginal: vi.fn(),
  removeOriginal: vi.fn(),
  destroyAndRecreateOriginals: vi.fn(),
}));

vi.mock("../../db/pouchdb/search.ts", () => ({
  rebuildIndex: vi.fn().mockResolvedValue(0),
  startListening: vi.fn(),
  stopListening: vi.fn(),
  handleChange: vi.fn(),
  addToIndex: vi.fn(),
  removeFromIndex: vi.fn(),
  search: vi.fn().mockReturnValue([]),
  serializeIndex: vi.fn(),
  loadIndex: vi.fn().mockResolvedValue(false),
  _resetIndex: vi.fn(),
}));

vi.mock("../../services/syncConfigStore.ts", () => ({
  getSyncConfig: vi.fn().mockReturnValue(null),
  saveSyncConfig: vi.fn(),
  clearSyncConfig: vi.fn(),
}));

import StartingFlowWizard from "./StartingFlowWizard.tsx";
import { ToastProvider } from "../ui/Toast.tsx";
import {
  plantingScheduleRepository,
  scheduleTaskRepository,
} from "../../db/index.ts";
import { destroyAndRecreate } from "../../db/pouchdb/client.ts";

const INDOORS_RADIO = /Indoors, transplant later/;
const DIRECT_RADIO = /Directly outdoors/;

function renderWizard(onClose: () => void) {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <StartingFlowWizard onClose={onClose} />
      </ToastProvider>
    </MemoryRouter>,
  );
}

async function pickCropAndVariety(
  user: ReturnType<typeof userEvent.setup>,
  crop: string,
  variety: string,
) {
  // Expand the Vegetable category, then pick crop and variety. Variety
  // buttons carry extra badge text in their accessible name, so match by
  // prefix.
  await user.click(screen.getByText("Vegetable"));
  await user.click(await screen.findByRole("button", { name: crop }));
  await user.click(
    await screen.findByRole("button", { name: new RegExp(`^${variety}`) }),
  );
}

async function openDateStep(
  user: ReturnType<typeof userEvent.setup>,
  variety: string,
) {
  // From the variety step, (re-)enter the date step for the given variety.
  await user.click(
    await screen.findByRole("button", { name: new RegExp(`^${variety}`) }),
  );
  expect(await screen.findByText("Where will you sow?")).toBeDefined();
}

async function setDateAndPreview(
  user: ReturnType<typeof userEvent.setup>,
  date: string,
) {
  const dateInput = screen.getByLabelText("Date");
  fireEvent.change(dateInput, { target: { value: date } });
  await user.click(screen.getByRole("button", { name: "Preview Timeline" }));
  await screen.findByText("Preview Timeline");
}

function previewDateInput(label: string): HTMLInputElement {
  // The label appears twice (visual dot row + editable list); the editable
  // row is the one whose container holds the date input.
  for (const el of screen.getAllByText(label)) {
    const row = el.closest("div");
    const input = row?.querySelector("input");
    if (input) return input as HTMLInputElement;
  }
  throw new Error(`preview row ${label} not found`);
}

describe("StartingFlowWizard sowing method", () => {
  beforeAll(async () => {
    await destroyAndRecreate();
  });

  it("commits the choice immediately: survives Back BEFORE preview, keyboard selection, and drives preview + saved schedule", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderWizard(onClose);

    await pickCropAndVariety(user, "Broccoli", "Calabrese");

    // Dual-method variety offers the choice with the legacy default seeded,
    // so the visible radio matches the committed state from the start.
    expect(await screen.findByText("Where will you sow?")).toBeDefined();
    expect(screen.getByRole("radio", { name: INDOORS_RADIO })).toBeChecked();

    // Keyboard semantics: arrow down inside the radio group selects Direct.
    await user.click(screen.getByRole("radio", { name: INDOORS_RADIO }));
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("radio", { name: DIRECT_RADIO })).toBeChecked();

    // THE ROUND-1 GAP: go Back BEFORE the preview and re-enter — the choice
    // must still be Direct, asserted before any other interaction.
    await user.click(screen.getByRole("button", { name: /Back/ }));
    await openDateStep(user, "Calabrese");
    expect(screen.getByRole("radio", { name: DIRECT_RADIO })).toBeChecked();

    await setDateAndPreview(user, "2026-04-15");

    // Preview reflects the direct branch: no transplant milestones.
    expect(screen.queryByText("Transplant")).toBeNull();
    expect(screen.queryByText("Seed Start")).toBeNull();
    const harvestInput = previewDateInput("Harvest");
    expect(harvestInput.value).toBe("2026-06-19"); // 2026-04-15 + 65

    // Back from the preview also keeps the choice.
    await user.click(screen.getByRole("button", { name: /Back/ }));
    expect(screen.getByRole("radio", { name: DIRECT_RADIO })).toBeChecked();
    await setDateAndPreview(user, "2026-04-15");

    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(screen.getByRole("button", { name: "No bed" }));

    // Confirmation shows the method in plain language.
    expect(await screen.findByText("Method")).toBeDefined();
    expect(screen.getByText("Direct sow")).toBeDefined();

    await user.click(screen.getByRole("button", { name: "Create Planting" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());

    // The saved schedule matches the preview exactly, and its tasks carry
    // the method snapshot shown in the task detail popover.
    const schedules = await plantingScheduleRepository.getAll();
    const saved = schedules.find(
      (s) => s.varietyId === "builtin-brassica-oleracea-var-italica-calabrese",
    );
    expect(saved).toBeDefined();
    expect(saved!.sowingMethod).toBe("direct");
    expect(saved!.transplantDate).toBeUndefined();
    expect(saved!.seedStartDate).toBeUndefined();
    expect(saved!.harvestStartDate).toBe(harvestInput.value);
    const tasks = await scheduleTaskRepository.getByScheduleId(saved!.id);
    expect(tasks.length).toBeGreaterThan(0);
    for (const task of tasks) {
      expect(task.sowingMethod).toBe("direct");
    }
  });

  it("keeps the choice on supported variety switches, resets it on unsupported ones, and saves legacy without a fabricated method", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderWizard(onClose);

    await pickCropAndVariety(user, "Broccoli", "Calabrese");
    expect(await screen.findByText("Where will you sow?")).toBeDefined();
    await user.click(screen.getByRole("radio", { name: DIRECT_RADIO }));

    // Back BEFORE preview, then switch to another dual-method variety:
    // the supported choice is kept.
    await user.click(screen.getByRole("button", { name: /Back/ }));
    await openDateStep(user, "De Cicco");
    expect(screen.getByRole("radio", { name: DIRECT_RADIO })).toBeChecked();

    // Switch to an indoor-only variety: no method choice is offered and the
    // previously selected "direct" must not leak into preview or save.
    await user.click(screen.getByRole("button", { name: /Back/ })); // date → variety
    await user.click(screen.getByRole("button", { name: /Back to crops/ }));
    await user.click(await screen.findByRole("button", { name: "Tomato" }));
    await user.click(
      await screen.findByRole("button", { name: /^Cherry/ }),
    );
    expect(screen.queryByText("Where will you sow?")).toBeNull();

    await setDateAndPreview(user, "2026-04-15");
    // Labels render in both the dot row and the editable list.
    expect(screen.getAllByText("Transplant").length).toBeGreaterThan(0); // legacy indoor branch
    expect(screen.getAllByText("Seed Start").length).toBeGreaterThan(0);

    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(screen.getByRole("button", { name: "No bed" }));
    expect(screen.queryByText("Method")).toBeNull(); // no fabricated method
    await user.click(screen.getByRole("button", { name: "Create Planting" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());

    const schedules = await plantingScheduleRepository.getAll();
    const saved = schedules.find(
      (s) => s.varietyId === "builtin-solanum-lycopersicum-cherry",
    );
    expect(saved).toBeDefined();
    expect(saved!.sowingMethod).toBeUndefined();
    expect(saved!.transplantDate).toBe("2026-05-27"); // Apr 15 + 42 (Cherry's dTT)
    const tasks = await scheduleTaskRepository.getByScheduleId(saved!.id);
    for (const task of tasks) {
      expect(task.sowingMethod).toBeUndefined();
    }
  });
});
