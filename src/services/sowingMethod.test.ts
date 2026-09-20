// Sowing-method tests for computeTaskDates and isSowingMethodSupported.
//
// The explicit sowing method must (a) be rejected when the variety's existing
// scheduling fields cannot support it, (b) override the legacy branch when
// supported, and (c) leave the legacy branch selection EXACTLY unchanged when
// absent. Field values are taken from the real built-in data:
// Calabrese Broccoli (dual), Cherry Tomato (indoor-only), Nantes carrot
// (direct-only).
import { describe, it, expect } from "vitest";
import {
  computeTaskDates,
  buildTaskInputs,
  isSowingMethodSupported,
  type SchedulingDateFields,
} from "./schedulingService.ts";

const dual: SchedulingDateFields = {
  daysToMaturity: 65,
  daysToTransplant: 35,
  bedPrepLeadDays: 7,
  harvestWindowDays: 21,
  indoorStart: true,
  directSow: true,
};

const indoorOnly: SchedulingDateFields = {
  daysToMaturity: 70,
  daysToTransplant: 42,
  bedPrepLeadDays: 7,
  harvestWindowDays: 30,
  indoorStart: true,
  directSow: false,
};

const directOnly: SchedulingDateFields = {
  daysToMaturity: 70,
  daysToTransplant: null,
  bedPrepLeadDays: 0,
  harvestWindowDays: 30,
  indoorStart: false,
  directSow: true,
};

describe("isSowingMethodSupported", () => {
  it("allows indoor only when indoorStart and daysToTransplant are present", () => {
    expect(isSowingMethodSupported(dual, "indoor")).toBe(true);
    expect(isSowingMethodSupported(indoorOnly, "indoor")).toBe(true);
    expect(isSowingMethodSupported(directOnly, "indoor")).toBe(false);
  });

  it("allows direct only when directSow is set", () => {
    expect(isSowingMethodSupported(dual, "direct")).toBe(true);
    expect(isSowingMethodSupported(indoorOnly, "direct")).toBe(false);
    expect(isSowingMethodSupported(directOnly, "direct")).toBe(true);
  });
});

describe("computeTaskDates with explicit sowing method", () => {
  it("absent method reproduces the legacy branch selection exactly", () => {
    // Dual variety: legacy picks the transplant branch.
    const legacy = computeTaskDates(dual, "2026-03-15", "forward");
    const explicitUndefined = computeTaskDates(
      dual,
      "2026-03-15",
      "forward",
      undefined,
    );
    expect(explicitUndefined).toEqual(legacy);
    expect(legacy.seedStartDate).toBe("2026-03-15");
    expect(legacy.transplantDate).toBe("2026-04-19");

    // Direct-only variety: legacy picks the direct branch.
    const legacyDirect = computeTaskDates(directOnly, "2026-04-15", "forward");
    expect(
      computeTaskDates(directOnly, "2026-04-15", "forward", undefined),
    ).toEqual(legacyDirect);
    expect(legacyDirect.seedStartDate).toBeUndefined();
    expect(legacyDirect.transplantDate).toBeUndefined();
  });

  it("explicit indoor forces the transplant branch (forward)", () => {
    const dates = computeTaskDates(dual, "2026-03-15", "forward", "indoor");
    expect(dates.seedStartDate).toBe("2026-03-15");
    expect(dates.transplantDate).toBe("2026-04-19"); // +35
    expect(dates.bedPrepDate).toBe("2026-04-12"); // transplant - 7
    expect(dates.cultivateStartDate).toBe("2026-04-26"); // transplant + 7
    expect(dates.harvestStartDate).toBe("2026-06-23"); // transplant + 65
    expect(dates.harvestEndDate).toBe("2026-07-14"); // harvest start + 21
  });

  it("explicit indoor forces the transplant branch (backward from harvest end)", () => {
    const dates = computeTaskDates(dual, "2026-08-01", "backward", "indoor");
    expect(dates.harvestEndDate).toBe("2026-08-01"); // backward still anchors at harvest END
    expect(dates.harvestStartDate).toBe("2026-07-11"); // -21
    expect(dates.transplantDate).toBe("2026-05-07"); // harvest start - 65
    expect(dates.bedPrepDate).toBe("2026-04-30"); // transplant - 7
    expect(dates.cultivateStartDate).toBe("2026-05-14"); // transplant + 7
    expect(dates.seedStartDate).toBe("2026-04-02"); // transplant - 35
  });

  it("explicit direct forces the direct branch (forward)", () => {
    const dates = computeTaskDates(dual, "2026-04-15", "forward", "direct");
    expect(dates.seedStartDate).toBeUndefined();
    expect(dates.transplantDate).toBeUndefined();
    expect(dates.bedPrepDate).toBeUndefined();
    expect(dates.cultivateStartDate).toBe("2026-04-22"); // +7
    expect(dates.harvestStartDate).toBe("2026-06-19"); // +65
    expect(dates.harvestEndDate).toBe("2026-07-10"); // +21
  });

  it("explicit direct forces the direct branch (backward from harvest end)", () => {
    const dates = computeTaskDates(dual, "2026-08-01", "backward", "direct");
    expect(dates.harvestEndDate).toBe("2026-08-01");
    expect(dates.harvestStartDate).toBe("2026-07-11"); // -21
    expect(dates.cultivateStartDate).toBe("2026-05-14"); // sow (May 7) + 7
    expect(dates.seedStartDate).toBeUndefined();
    expect(dates.transplantDate).toBeUndefined();
  });

  it("explicit indoor on a direct-only variety is rejected", () => {
    expect(() =>
      computeTaskDates(directOnly, "2026-04-15", "forward", "indoor"),
    ).toThrow(/not supported/);
  });

  it("explicit direct on an indoor-only variety is rejected", () => {
    expect(() =>
      computeTaskDates(indoorOnly, "2026-04-15", "forward", "direct"),
    ).toThrow(/not supported/);
  });
});

describe("buildTaskInputs sowing method stamping", () => {
  const dates = computeTaskDates(dual, "2026-03-15", "forward", "indoor");

  it("stamps an explicit method on every created task input", () => {
    const tasks = buildTaskInputs(dates, "sched-1", "Broccoli", "Calabrese", undefined, undefined, "indoor");
    expect(tasks.length).toBeGreaterThan(0);
    for (const task of tasks) {
      expect(task.sowingMethod).toBe("indoor");
    }
  });

  it("leaves task inputs unstamped when no method is given (legacy)", () => {
    const tasks = buildTaskInputs(dates, "sched-1", "Broccoli", "Calabrese");
    for (const task of tasks) {
      expect(task.sowingMethod).toBeUndefined();
    }
  });
});
