import { useState, useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import StepSelectCrop, { type CropChoice } from "./StepSelectCrop.tsx";
import StepSelectVariety from "./StepSelectVariety.tsx";
import StepSetDate from "./StepSetDate.tsx";
import StepPreviewTimeline from "./StepPreviewTimeline.tsx";
import StepSelectBed from "./StepSelectBed.tsx";
import StepConfirm from "./StepConfirm.tsx";
import { useScheduling } from "../../hooks/useScheduling.ts";
import { useToast } from "../ui/Toast.tsx";
import { useModalA11y } from "../../hooks/useModalA11y.ts";
import { useFocusTrap } from "../../hooks/useFocusTrap.ts";
import {
  builtInEntryId,
  getCropGroup,
} from "../../services/knowledgeBase.ts";
import {
  computeTaskDates,
  isSowingMethodSupported,
  type ComputedDates,
  type SchedulingDateFields,
} from "../../services/schedulingService.ts";
import type { PlantKnowledge } from "../../validation/plantKnowledge.schema.ts";
import type {
  ScheduleDirection,
  CropSource,
  SowingMethod,
} from "../../validation/plantingSchedule.schema.ts";

type WizardStep =
  | "crop"
  | "variety"
  | "date"
  | "preview"
  | "bed"
  | "confirm";

const STEP_ORDER: WizardStep[] = [
  "crop",
  "variety",
  "date",
  "preview",
  "bed",
  "confirm",
];

interface WizardState {
  cropId: string;
  cropName: string;
  cropSource: CropSource;
  varietyId: string;
  varietyName: string;
  schedulingFields: SchedulingDateFields | null;
  direction: ScheduleDirection;
  sowingMethod: SowingMethod | null;
  anchorDate: string;
  dates: ComputedDates | null;
  bedId: string | null;
  bedName: string | null;
}

const initialState: WizardState = {
  cropId: "",
  cropName: "",
  cropSource: "builtin",
  varietyId: "",
  varietyName: "",
  schedulingFields: null,
  direction: "forward",
  sowingMethod: null,
  anchorDate: "",
  dates: null,
  bedId: null,
  bedName: null,
};

interface StartingFlowWizardProps {
  onClose: () => void;
}

function extractSchedulingFields(
  entry: PlantKnowledge,
): SchedulingDateFields | null {
  if (!entry.scheduling) return null;
  return {
    daysToMaturity:
      entry.daysToMaturity ?? entry.scheduling.harvestWindowDays,
    daysToTransplant: entry.scheduling.daysToTransplant,
    bedPrepLeadDays: entry.scheduling.bedPrepLeadDays,
    harvestWindowDays: entry.scheduling.harvestWindowDays,
    indoorStart: entry.scheduling.indoorStart,
    directSow: entry.scheduling.directSow,
  };
}

export default function StartingFlowWizard({
  onClose,
}: StartingFlowWizardProps) {
  const [step, setStep] = useState<WizardStep>("crop");
  const [state, setState] = useState<WizardState>(initialState);
  const [saving, setSaving] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);

  const { createSchedule } = useScheduling();
  const { toast } = useToast();
  const navigate = useNavigate();
  useModalA11y(onClose);
  useFocusTrap(dialogRef);

  const currentStepIndex = STEP_ORDER.indexOf(step);

  // Step handlers
  const handleCropSelect = useCallback((choice: CropChoice) => {
    setState((prev) => ({
      ...prev,
      cropId: choice.cropId,
      cropName: choice.cropName,
      cropSource: choice.cropSource,
    }));
    setStep("variety");
  }, []);

  const handleVarietySelect = useCallback(
    (entry: PlantKnowledge) => {
      const fields = extractSchedulingFields(entry);
      setState((prev) => {
        // Keep a choice the new variety still supports; otherwise reset.
        // Dual-method varieties get the legacy default (indoor branch)
        // seeded so the visible radio always matches the committed state.
        const kept =
          prev.sowingMethod && fields &&
          isSowingMethodSupported(fields, prev.sowingMethod)
            ? prev.sowingMethod
            : null;
        const dual = fields != null &&
          isSowingMethodSupported(fields, "indoor") &&
          isSowingMethodSupported(fields, "direct");
        return {
          ...prev,
          varietyId: builtInEntryId(entry.species, entry.variety),
          varietyName: entry.variety ?? entry.commonName,
          schedulingFields: fields,
          sowingMethod: kept ?? (dual ? "indoor" : null),
        };
      });
      setStep("date");
    },
    [],
  );

  const handleSowingMethodChange = useCallback((method: SowingMethod) => {
    setState((prev) => ({ ...prev, sowingMethod: method }));
  }, []);

  const handleDateConfirm = useCallback(
    (date: string, direction: ScheduleDirection) => {
      // Re-lookup the entry from the knowledge base
      const entries = getCropGroup(state.cropId);
      const entry = entries.find(
        (e) => builtInEntryId(e.species, e.variety) === state.varietyId,
      );
      const fields = entry ? extractSchedulingFields(entry) : state.schedulingFields;
      if (!fields) return;
      if (
        state.sowingMethod &&
        !isSowingMethodSupported(fields, state.sowingMethod)
      ) {
        return;
      }

      const dates = computeTaskDates(
        fields,
        date,
        direction,
        state.sowingMethod ?? undefined,
      );
      setState((prev) => ({
        ...prev,
        anchorDate: date,
        direction,
        dates,
      }));
      setStep("preview");
    },
    [state.cropId, state.varietyId, state.schedulingFields, state.sowingMethod],
  );

  const handleDateChange = useCallback((key: string, date: string) => {
    setState((prev) => {
      if (!prev.dates) return prev;
      return {
        ...prev,
        dates: { ...prev.dates, [key]: date },
      };
    });
  }, []);

  const handlePreviewConfirm = useCallback(() => {
    setStep("bed");
  }, []);

  const handleBedSelect = useCallback(
    (bedId: string | null, bedName: string | null) => {
      setState((prev) => ({ ...prev, bedId, bedName }));
      setStep("confirm");
    },
    [],
  );

  const handleConfirm = useCallback(async () => {
    setSaving(true);
    try {
      await createSchedule({
        cropId: state.cropId,
        varietyId: state.varietyId,
        cropSource: state.cropSource,
        cropName: state.cropName,
        varietyName: state.varietyName,
        anchorDate: state.anchorDate,
        direction: state.direction,
        ...(state.sowingMethod ? { sowingMethod: state.sowingMethod } : {}),
        ...(state.bedId ? { bedId: state.bedId } : {}),
        ...(state.bedName ? { bedName: state.bedName } : {}),
      });

      toast(
        `${state.cropName} (${state.varietyName}) planting created${
          state.sowingMethod === "direct"
            ? " — direct sow"
            : state.sowingMethod === "indoor"
              ? " — indoor start"
              : ""
        }!`,
        "success",
      );
      onClose();
      navigate("/calendar");
    } catch (err) {
      toast(
        `Failed: ${err instanceof Error ? err.message : "Unknown error"}`,
        "error",
      );
      setSaving(false);
    }
  }, [state, createSchedule, toast, onClose, navigate]);

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/50 md:items-center">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="New planting wizard"
        className="flex max-h-[calc(100vh-env(safe-area-inset-bottom,0px)-4.5rem)] w-full max-w-lg flex-col rounded-t-2xl bg-surface-elevated md:max-h-[90vh] md:rounded-2xl"
      >
        {/* Header with step dots */}
        <div className="flex shrink-0 items-center justify-between border-b border-border-default px-4 py-3">
          <div className="flex gap-1.5">
            {STEP_ORDER.map((s, i) => (
              <div
                key={s}
                className={`h-1.5 w-6 rounded-full ${
                  i <= currentStepIndex ? "bg-primary" : "bg-border-default"
                }`}
              />
            ))}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-text-secondary transition-colors hover:bg-surface-muted hover:text-text-primary"
            aria-label="Close wizard"
          >
            <svg
              className="h-5 w-5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Step content */}
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4" style={{ WebkitOverflowScrolling: 'touch' }}>
          {step === "crop" && (
            <StepSelectCrop onSelect={handleCropSelect} />
          )}

          {step === "variety" && (
            <StepSelectVariety
              cropId={state.cropId}
              cropName={state.cropName}
              onSelect={handleVarietySelect}
              onBack={() => setStep("crop")}
            />
          )}

          {step === "date" && (
            <StepSetDate
              schedulingFields={state.schedulingFields}
              sowingMethod={state.sowingMethod}
              onSowingMethodChange={handleSowingMethodChange}
              onConfirm={handleDateConfirm}
              onBack={() => setStep("variety")}
            />
          )}

          {step === "preview" && state.dates && (
            <StepPreviewTimeline
              dates={state.dates}
              cropName={state.cropName}
              varietyName={state.varietyName}
              onDateChange={handleDateChange}
              onConfirm={handlePreviewConfirm}
              onBack={() => setStep("date")}
            />
          )}

          {step === "bed" && (
            <StepSelectBed
              selectedBedId={state.bedId}
              onSelect={handleBedSelect}
              onBack={() => setStep("preview")}
            />
          )}

          {step === "confirm" && state.dates && (
            <StepConfirm
              cropName={state.cropName}
              varietyName={state.varietyName}
              bedName={state.bedName}
              sowingMethod={state.sowingMethod}
              dates={state.dates}
              saving={saving}
              onConfirm={handleConfirm}
              onBack={() => setStep("bed")}
            />
          )}
        </div>
      </div>
    </div>
  );
}
