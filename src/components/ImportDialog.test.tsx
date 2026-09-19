import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  parseZip,
  executeImportMerge,
  executeImportReplace,
  type ParsedImport,
} from "../services/importer.ts";
import ImportDialog from "./ImportDialog.tsx";

vi.mock("../services/importer.ts", () => ({
  parseZip: vi.fn(),
  executeImportMerge: vi.fn(),
  executeImportReplace: vi.fn(),
}));

const mockParseZip = vi.mocked(parseZip);
const mockExecuteImportMerge = vi.mocked(executeImportMerge);
const mockExecuteImportReplace = vi.mocked(executeImportReplace);

function makeParsed(overrides?: Partial<ParsedImport>): ParsedImport {
  return {
    valid: true,
    errors: [],
    counts: {
      plantInstances: 1,
      journalEntries: 0,
      tasks: 0,
      gardenBeds: 0,
      settings: 0,
      photos: 0,
      seasons: 0,
      plantings: 0,
      seeds: 0,
      taskRules: 0,
      userPlantKnowledge: 0,
    },
    data: { plantInstances: [{ id: "plant-1" }] },
    zip: null,
    ...overrides,
  };
}

async function selectBackupFile() {
  const input = document.querySelector(
    'input[type="file"]',
  ) as HTMLInputElement;
  expect(input).not.toBeNull();
  await userEvent.upload(
    input,
    new File(["zip-bytes"], "backup.zip", { type: "application/zip" }),
  );
  await screen.findByText("Backup Contents");
}

beforeEach(() => {
  vi.clearAllMocks();
  mockExecuteImportMerge.mockResolvedValue({ inserted: 1, skipped: 0, errors: [] });
  mockExecuteImportReplace.mockResolvedValue({ inserted: 1, skipped: 0, errors: [] });
});

describe("ImportDialog", () => {
  it("blocks replace but allows merge when the backup has validation errors", async () => {
    mockParseZip.mockResolvedValue(
      makeParsed({
        valid: false,
        errors: ["plantInstances.json[1]: species: required"],
      }),
    );

    render(<ImportDialog open onClose={vi.fn()} />);
    await selectBackupFile();

    // Validation errors remain visible in the preview
    expect(screen.getByText(/Validation Warnings \(1\)/)).toBeInTheDocument();
    expect(
      screen.getByText(/plantInstances\.json\[1\]: species: required/),
    ).toBeInTheDocument();

    // Replace is unavailable and explains why
    const replaceRadio = screen.getByRole("radio", { name: /^Replace/ });
    expect(replaceRadio).toBeDisabled();
    expect(
      screen.getByText(/Unavailable for this backup: it contains validation/),
    ).toBeInTheDocument();

    // Merge stays available and works
    const mergeRadio = screen.getByRole("radio", { name: /^Merge/ });
    expect(mergeRadio).toBeEnabled();
    await userEvent.click(mergeRadio);

    const importButton = screen.getByRole("button", { name: "Import" });
    expect(importButton).toBeEnabled();
    await userEvent.click(importButton);

    await waitFor(() =>
      expect(mockExecuteImportMerge).toHaveBeenCalledTimes(1),
    );
    expect(mockExecuteImportReplace).not.toHaveBeenCalled();
    await screen.findByText("Import Complete");
  });

  it("allows replace with DELETE confirmation for a valid backup", async () => {
    mockParseZip.mockResolvedValue(makeParsed());

    render(<ImportDialog open onClose={vi.fn()} />);
    await selectBackupFile();

    const replaceRadio = screen.getByRole("radio", { name: /^Replace/ });
    expect(replaceRadio).toBeEnabled();
    await userEvent.click(replaceRadio);

    await userEvent.click(screen.getByRole("button", { name: "Next" }));

    // Confirmation step requires typing DELETE before replace can run
    await screen.findByText(/This will delete all existing data/i);
    const confirmInput = screen.getByPlaceholderText("Type DELETE");
    const replaceButton = screen.getByRole("button", {
      name: "Delete & Replace",
    });
    expect(replaceButton).toBeDisabled();
    await userEvent.type(confirmInput, "DELETE");
    expect(replaceButton).toBeEnabled();
    await userEvent.click(replaceButton);

    await waitFor(() =>
      expect(mockExecuteImportReplace).toHaveBeenCalledTimes(1),
    );
    expect(mockExecuteImportMerge).not.toHaveBeenCalled();
    await screen.findByText("Import Complete");
  });
});
