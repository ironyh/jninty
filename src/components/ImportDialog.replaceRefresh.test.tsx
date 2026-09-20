// R3 boundary tests for ImportDialog completion recovery.
//
// Contract under test: after a Replace attempt FINISHES (success or failure —
// destroyAndRecreate runs at the start of executeImportReplace, so the DB is
// re-created either way), closing the dialog through ANY acknowledgement path
// (Done button, Escape, backdrop click) must reload the app so stale mounted
// queries/settings/listeners reinitialize. The completion summary/errors stay
// visible until that acknowledgement and are never erased by an automatic
// reload. Merge imports and pre-import closes remain ordinary closes; while
// an import is running, dismissal is blocked.
//
// Real component, real zips, real parse/import services over the REAL PouchDB
// client (fake-indexeddb). Only two narrow seams are mocked:
//   - ../lib/reloadApp — the reload boundary itself (the behavior under test);
//   - executeImportReplace for the failure/inflight cases only (deterministic
//     control; the real Replace lifecycle is covered by the R2 suite in
//     jninty-replace-query-lifecycle-wt).
import "fake-indexeddb/auto";

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import JSZip from "jszip";

const replaceRef = vi.hoisted(() => ({
  impl: null as null | ((
    parsed: unknown,
    onProgress?: unknown,
  ) => Promise<unknown>),
}));

vi.mock("../lib/reloadApp", () => ({ reloadApp: vi.fn() }));

vi.mock("../services/importer", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../services/importer")>();
  return {
    ...actual,
    executeImportReplace: (
      parsed: Parameters<typeof actual.executeImportReplace>[0],
      onProgress?: Parameters<typeof actual.executeImportReplace>[1],
    ) =>
      replaceRef.impl
        ? replaceRef.impl(parsed, onProgress)
        : actual.executeImportReplace(parsed, onProgress),
  };
});

import { reloadApp } from "../lib/reloadApp";
import ImportDialog from "./ImportDialog";
import { taskRepository } from "../db/index.ts";
import { destroyAndRecreate } from "../db/pouchdb/client.ts";
import { exportAll } from "../services/exporter.ts";

const LONG = 20000;

async function seedTask(title: string): Promise<void> {
  await taskRepository.create({
    title,
    dueDate: "2026-09-21",
    priority: "normal",
    isCompleted: false,
  });
}

async function buildBackupFile(
  mutate?: (zip: JSZip) => Promise<void>,
): Promise<File> {
  const blob = await exportAll();
  const zip = await JSZip.loadAsync(blob);
  if (mutate) await mutate(zip);
  const out = await zip.generateAsync({ type: "blob" });
  return new File([out], "backup.zip", { type: "application/zip" });
}

async function chooseFile(
  view: ReturnType<typeof render>,
  file: File,
): Promise<void> {
  const input = view.container.querySelector(
    'input[type="file"]',
  ) as HTMLInputElement;
  expect(input).not.toBeNull();
  fireEvent.change(input, { target: { files: [file] } });
  // Wait for parse to finish and the preview step to appear.
  await waitFor(() => {
    expect(view.getByText("Import Mode")).toBeTruthy();
  }, { timeout: LONG });
}

/** Drive the dialog from file-select to a finished Replace (complete step). */
async function runReplaceToComplete(
  view: ReturnType<typeof render>,
  user: ReturnType<typeof userEvent.setup>,
  file: File,
): Promise<void> {
  await chooseFile(view, file);
  await user.click(
    view.container.querySelector('input[value="replace"]') as HTMLInputElement,
  );
  await user.click(view.getByRole("button", { name: "Next" }));
  await waitFor(() => {
    expect(view.getByPlaceholderText("Type DELETE")).toBeTruthy();
  }, { timeout: LONG });
  await user.type(view.getByPlaceholderText("Type DELETE"), "DELETE");
  await user.click(view.getByRole("button", { name: "Delete & Replace" }));
  await waitFor(() => {
    // Either the success heading or the partial-failure heading.
    const done =
      view.queryByText("Import Complete") ??
      view.queryByText("Import finished with errors");
    expect(done).toBeTruthy();
  }, { timeout: LONG });
}

/** Drive the dialog from file-select through a finished Merge. */
async function runMergeToComplete(
  view: ReturnType<typeof render>,
  user: ReturnType<typeof userEvent.setup>,
  file: File,
): Promise<void> {
  await chooseFile(view, file);
  await user.click(view.getByRole("button", { name: "Import" }));
  await waitFor(() => {
    expect(view.getByText("Import Complete")).toBeTruthy();
  }, { timeout: LONG });
}

beforeEach(async () => {
  cleanup();
  vi.mocked(reloadApp).mockClear();
  replaceRef.impl = null;
  await destroyAndRecreate();
});

afterEach(() => {
  cleanup();
});

describe("ImportDialog Replace completion boundary (R3)", () => {
  it("successful Replace: Done acknowledges with an app reload and the refresh note is shown", async () => {
    const user = userEvent.setup();
    await seedTask("BEFORE");
    const onClose = vi.fn();
    const view = render(<ImportDialog open onClose={onClose} />);

    const file = await buildBackupFile((zip) => {
      return zip.file("data/tasks.json")!.async("string").then((raw) => {
        const tasks = JSON.parse(raw) as Array<Record<string, unknown>>;
        for (const t of tasks) t["title"] = "RESTORED";
        zip.file("data/tasks.json", JSON.stringify(tasks));
      });
    });
    await runReplaceToComplete(view, user, file);

    // Plain-language refresh note is part of the completion summary.
    expect(view.getByText(/app will refresh/i)).toBeTruthy();
    expect(view.getByText("Import Complete")).toBeTruthy();
    expect(vi.mocked(reloadApp)).not.toHaveBeenCalled();

    await user.click(view.getByRole("button", { name: "Done" }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(vi.mocked(reloadApp)).toHaveBeenCalledTimes(1);
  });

  it("successful Replace: Escape acknowledges with an app reload", async () => {
    const user = userEvent.setup();
    await seedTask("BEFORE");
    const onClose = vi.fn();
    const view = render(<ImportDialog open onClose={onClose} />);

    await runReplaceToComplete(view, user, await buildBackupFile());
    vi.mocked(reloadApp).mockClear();

    await user.keyboard("{Escape}");

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(vi.mocked(reloadApp)).toHaveBeenCalledTimes(1);
  });

  it("successful Replace: backdrop click acknowledges with an app reload", async () => {
    const user = userEvent.setup();
    await seedTask("BEFORE");
    const onClose = vi.fn();
    const view = render(<ImportDialog open onClose={onClose} />);

    await runReplaceToComplete(view, user, await buildBackupFile());
    vi.mocked(reloadApp).mockClear();

    // Click the backdrop itself (the outermost fixed overlay div).
    const backdrop = view.container.firstElementChild as HTMLElement;
    await user.click(backdrop);

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(vi.mocked(reloadApp)).toHaveBeenCalledTimes(1);
  });

  it("failed Replace: errors stay visible, nothing reloads automatically, acknowledgement reloads", async () => {
    const user = userEvent.setup();
    await seedTask("BEFORE");
    replaceRef.impl = async () => {
      throw new Error("Simulated mid-replace failure");
    };
    const onClose = vi.fn();
    const view = render(<ImportDialog open onClose={onClose} />);

    await runReplaceToComplete(view, user, await buildBackupFile());

    // Error summary is readable and no automatic reload occurred.
    expect(view.getByText("Import finished with errors")).toBeTruthy();
    expect(view.getByText(/Simulated mid-replace failure/)).toBeTruthy();
    expect(view.getByText(/app will refresh/i)).toBeTruthy();
    await new Promise((r) => setTimeout(r, 500));
    expect(vi.mocked(reloadApp)).not.toHaveBeenCalled();

    await user.keyboard("{Escape}");

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(vi.mocked(reloadApp)).toHaveBeenCalledTimes(1);
  });

  it("dismissal is blocked while a Replace is importing, then acknowledgement reloads", async () => {
    const user = userEvent.setup();
    await seedTask("BEFORE");
    let resolveReplace!: () => void;
    replaceRef.impl = (_parsed, onProgress) =>
      new Promise<{ inserted: number; skipped: number; errors: string[] }>(
        (resolve) => {
          (
            onProgress as
              | ((s: string, d: number, t: number) => void)
              | undefined
          )?.("Importing tasks", 0, 1);
          resolveReplace = () =>
            resolve({ inserted: 1, skipped: 0, errors: [] });
        },
      );
    const onClose = vi.fn();
    const view = render(<ImportDialog open onClose={onClose} />);

    await chooseFile(view, await buildBackupFile());
    await user.click(
      view.container.querySelector('input[value="replace"]') as HTMLInputElement,
    );
    await user.click(view.getByRole("button", { name: "Next" }));
    await waitFor(() => {
      expect(view.getByPlaceholderText("Type DELETE")).toBeTruthy();
    }, { timeout: LONG });
    await user.type(view.getByPlaceholderText("Type DELETE"), "DELETE");
    await user.click(view.getByRole("button", { name: "Delete & Replace" }));

    // Inflight: the importing indicator is up, Escape and backdrop do nothing.
    await waitFor(() => {
      expect(view.getByText("Importing tasks")).toBeTruthy();
    }, { timeout: LONG });
    await user.keyboard("{Escape}");
    await user.click(view.container.firstElementChild as HTMLElement);
    expect(view.getByText("Importing tasks")).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
    expect(vi.mocked(reloadApp)).not.toHaveBeenCalled();

    // Finish, then the normal acknowledgement path reloads.
    resolveReplace();
    await waitFor(() => {
      expect(view.getByText("Import Complete")).toBeTruthy();
    }, { timeout: LONG });
    await user.click(view.getByRole("button", { name: "Done" }));
    expect(vi.mocked(reloadApp)).toHaveBeenCalledTimes(1);
  });
});

describe("ImportDialog Merge and pre-import closes stay ordinary (R3)", () => {
  it("successful Merge: Done closes without any reload and shows no refresh note", async () => {
    const user = userEvent.setup();
    await seedTask("BEFORE");
    const onClose = vi.fn();
    const view = render(<ImportDialog open onClose={onClose} />);

    const file = await buildBackupFile((zip) => {
      return zip.file("data/tasks.json")!.async("string").then((raw) => {
        const tasks = JSON.parse(raw) as Array<Record<string, unknown>>;
        tasks.push({
          ...tasks[0]!,
          id: crypto.randomUUID(),
          title: "MERGED-IN",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
        zip.file("data/tasks.json", JSON.stringify(tasks));
      });
    });
    await runMergeToComplete(view, user, file);

    expect(view.queryByText(/app will refresh/i)).toBeNull();
    await user.click(view.getByRole("button", { name: "Done" }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(vi.mocked(reloadApp)).not.toHaveBeenCalled();
  });

  it("cancelling before any import never reloads (select step and preview step)", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const view = render(<ImportDialog open onClose={onClose} />);

    await user.click(view.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(vi.mocked(reloadApp)).not.toHaveBeenCalled();

    // Re-open and cancel from the preview step (file parsed, nothing imported).
    view.rerender(<ImportDialog open onClose={onClose} />);
    await chooseFile(view, await buildBackupFile());
    await user.click(view.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(vi.mocked(reloadApp)).not.toHaveBeenCalled();
  });
});
