import "fake-indexeddb/auto";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { formatISO, addDays, subDays } from "date-fns";
import { clearPouchDB } from "../db/pouchdb/testUtils.ts";
import {
  taskRepository,
  plantRepository,
  seasonRepository,
} from "../db/index.ts";
import { SettingsProvider } from "../hooks/useSettings.tsx";
import { ToastProvider } from "../components/ui/Toast.tsx";
import TasksPage from "./TasksPage.tsx";

beforeEach(async () => {
  await clearPouchDB();
  vi.clearAllMocks();
});

function futureDate(days: number): string {
  return formatISO(addDays(new Date(), days), { representation: "date" });
}

function pastDate(days: number): string {
  return formatISO(subDays(new Date(), days), { representation: "date" });
}

function renderPage() {
  return render(
    <SettingsProvider>
      <ToastProvider>
        <MemoryRouter initialEntries={["/tasks"]}>
          <TasksPage />
        </MemoryRouter>
      </ToastProvider>
    </SettingsProvider>,
  );
}

describe("TasksPage", () => {
  it("renders empty state when no tasks exist", async () => {
    renderPage();

    await waitFor(() => {
      expect(screen.getByText("No tasks yet")).toBeInTheDocument();
    });
    expect(
      screen.getByText("Add your first task with the + button below."),
    ).toBeInTheDocument();
  });

  it("shows pending tasks with title, due date, and priority badge", async () => {
    await taskRepository.create({
      title: "Water tomatoes",
      dueDate: futureDate(2),
      priority: "urgent",
      isCompleted: false,
    });
    await taskRepository.create({
      title: "Prune roses",
      dueDate: futureDate(5),
      priority: "low",
      isCompleted: false,
    });

    renderPage();

    await waitFor(() => {
      expect(screen.getByText("Water tomatoes")).toBeInTheDocument();
    });
    expect(screen.getByText("Prune roses")).toBeInTheDocument();
    expect(screen.getByText("Urgent")).toBeInTheDocument();
    expect(screen.getByText("Low")).toBeInTheDocument();
    expect(screen.getByText("2 pending")).toBeInTheDocument();
  });

  it("marks a task as complete when checkbox is clicked", async () => {
    await taskRepository.create({
      title: "Fertilize garden",
      dueDate: futureDate(1),
      priority: "normal",
      isCompleted: false,
    });

    const user = userEvent.setup();
    renderPage();

    await waitFor(() => {
      expect(screen.getByText("Fertilize garden")).toBeInTheDocument();
    });

    // Should be in pending list
    expect(screen.getByText("1 pending")).toBeInTheDocument();

    // Click the checkbox
    const checkbox = screen.getByLabelText("Mark complete");
    await user.click(checkbox);

    // Should now be in completed section
    await waitFor(() => {
      expect(screen.getByText("0 pending")).toBeInTheDocument();
    });
    expect(screen.getByText("Completed")).toBeInTheDocument();
    expect(screen.getByText("(1)")).toBeInTheDocument();
  });

  it("highlights overdue tasks with red accent", async () => {
    await taskRepository.create({
      title: "Overdue task",
      dueDate: pastDate(3),
      priority: "normal",
      isCompleted: false,
    });

    renderPage();

    await waitFor(() => {
      expect(screen.getByText("Overdue task")).toBeInTheDocument();
    });

    // Verify overdue indicator text is present
    expect(screen.getByText(/Overdue \u2014/)).toBeInTheDocument();
    expect(screen.getByText("(1 overdue)")).toBeInTheDocument();
  });

  it("shows task description and actions on expand", async () => {
    await taskRepository.create({
      title: "Detailed task",
      description: "This has extra details",
      dueDate: futureDate(2),
      priority: "normal",
      isCompleted: false,
    });

    const user = userEvent.setup();
    renderPage();

    await waitFor(() => {
      expect(screen.getByText("Detailed task")).toBeInTheDocument();
    });

    // Description should not be visible initially
    expect(
      screen.queryByText("This has extra details"),
    ).not.toBeInTheDocument();

    // Click task to expand
    await user.click(screen.getByText("Detailed task"));

    // Description and actions should now be visible
    await waitFor(() => {
      expect(
        screen.getByText("This has extra details"),
      ).toBeInTheDocument();
    });
    expect(screen.getByText("Edit")).toBeInTheDocument();
    expect(screen.getByText("Delete")).toBeInTheDocument();
  });

  it("creates a new task via the form modal", async () => {
    const user = userEvent.setup();
    renderPage();

    await waitFor(() => {
      expect(screen.getByText("No tasks yet")).toBeInTheDocument();
    });

    // Click FAB
    await user.click(screen.getByLabelText("Add task"));

    // Modal should appear
    await waitFor(() => {
      expect(screen.getByText("New Task")).toBeInTheDocument();
    });

    // Fill in form
    await user.type(screen.getByLabelText(/Title/), "Plant basil");
    const dateInput = screen.getByLabelText(/Due Date/);
    await user.clear(dateInput);
    await user.type(dateInput, futureDate(3));

    // Submit
    await user.click(screen.getByText("Create Task"));

    // Task should appear in the list
    await waitFor(() => {
      expect(screen.getByText("Plant basil")).toBeInTheDocument();
    });
    expect(screen.getByText("1 pending")).toBeInTheDocument();
  });

  it("shows linked plant name on task", async () => {
    const plant = await plantRepository.create({
      species: "Tomato",
      type: "vegetable",
      isPerennial: false,
      source: "seed",
      status: "active",
      tags: [],
      nickname: "Big Boy",
    });

    await taskRepository.create({
      title: "Water the tomato",
      dueDate: futureDate(1),
      priority: "normal",
      isCompleted: false,
      plantInstanceId: plant.id,
    });

    renderPage();

    await waitFor(() => {
      expect(screen.getByText("Water the tomato")).toBeInTheDocument();
    });
    // Plant name loads asynchronously via a separate PouchDB query
    await waitFor(
      () => {
        expect(screen.getByText(/Big Boy/)).toBeInTheDocument();
      },
      { timeout: 3000 },
    );
  });

  it("deletes a task when delete action is confirmed", async () => {
    await taskRepository.create({
      title: "Task to delete",
      dueDate: futureDate(1),
      priority: "normal",
      isCompleted: false,
    });

    vi.spyOn(window, "confirm").mockReturnValue(true);
    const user = userEvent.setup();
    renderPage();

    await waitFor(() => {
      expect(screen.getByText("Task to delete")).toBeInTheDocument();
    });

    // Expand the task
    await user.click(screen.getByText("Task to delete"));

    // Click delete
    await waitFor(() => {
      expect(screen.getByText("Delete")).toBeInTheDocument();
    });
    await user.click(screen.getByText("Delete"));

    // Task should be gone
    await waitFor(() => {
      expect(screen.queryByText("Task to delete")).not.toBeInTheDocument();
    });
  });

  it("sorts overdue tasks before upcoming tasks", async () => {
    await taskRepository.create({
      title: "Future task",
      dueDate: futureDate(5),
      priority: "urgent",
      isCompleted: false,
    });
    await taskRepository.create({
      title: "Overdue task",
      dueDate: pastDate(2),
      priority: "low",
      isCompleted: false,
    });

    renderPage();

    await waitFor(() => {
      expect(screen.getByText("Overdue task")).toBeInTheDocument();
    });

    // Both should be visible
    const overdue = screen.getByText("Overdue task");
    const future = screen.getByText("Future task");

    // Overdue task should appear before the future task in the DOM
    expect(
      overdue.compareDocumentPosition(future) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});

describe("TasksPage season filter empty state", () => {
  async function seedActiveSeason() {
    return seasonRepository.create({
      name: "2026 Growing Season",
      year: 2026,
      startDate: "2026-01-01",
      endDate: "2026-12-31",
      isActive: true,
    });
  }

  it("keeps the original empty state when an active season exists but no tasks do", async () => {
    await seedActiveSeason();

    renderPage();

    await waitFor(() => {
      expect(screen.getByText("No tasks yet")).toBeInTheDocument();
    });
    expect(
      screen.getByText("Add your first task with the + button below."),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("No tasks in this season"),
    ).not.toBeInTheDocument();
  });

  it("shows a season-specific message when all tasks belong to another season", async () => {
    await seedActiveSeason();
    const otherSeason = await seasonRepository.create({
      name: "2025 Growing Season",
      year: 2025,
      startDate: "2025-01-01",
      endDate: "2025-12-31",
      isActive: false,
    });
    await taskRepository.create({
      title: "Last year's task",
      dueDate: futureDate(1),
      priority: "normal",
      isCompleted: false,
      seasonId: otherSeason.id,
    });

    renderPage();

    await waitFor(() => {
      expect(screen.getByText("No tasks in this season")).toBeInTheDocument();
    });
    expect(
      screen.getByText("Switch to All Seasons to see them."),
    ).toBeInTheDocument();
    expect(screen.queryByText("No tasks yet")).not.toBeInTheDocument();
    expect(screen.queryByText("Last year's task")).not.toBeInTheDocument();

    // Switching the season filter to All Seasons reveals the hidden task
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText("Filter by season"), "");
    await waitFor(() => {
      expect(screen.getByText("Last year's task")).toBeInTheDocument();
    });
  });

  it("does not show the season advice when the Schedule filter hides an in-season manual task", async () => {
    const activeSeason = await seedActiveSeason();
    await taskRepository.create({
      title: "This season task",
      dueDate: futureDate(1),
      priority: "normal",
      isCompleted: false,
      seasonId: activeSeason.id,
    });

    const user = userEvent.setup();
    renderPage();

    await waitFor(() => {
      expect(screen.getByText("This season task")).toBeInTheDocument();
    });

    // Origin filter Schedule hides the manual task — the season filter does not
    await user.click(screen.getByRole("button", { name: "Schedule" }));

    // Ordinary empty state: the season advice would misattribute the hiding
    await waitFor(() => {
      expect(screen.getByText("No tasks yet")).toBeInTheDocument();
    });
    expect(
      screen.getByText("Add your first task with the + button below."),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("No tasks in this season"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("Switch to All Seasons to see them."),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("This season task")).not.toBeInTheDocument();
  });
});
