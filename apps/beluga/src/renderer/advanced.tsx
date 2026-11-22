/**
 * Advanced: what the facilitator may tune. Each value is picked from a list, so
 * nothing can be out of range; the default is marked in each. A value an agent
 * set between the choices is listed as well.
 */
import { Button, focusRing } from "@designiq/ui-kit/components/button";
import { cn } from "@designiq/ui-kit/lib/utils";
import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";

import {
  DEFAULT_SETTINGS,
  DEFAULT_TUNING,
  type MicProcessing,
  type Settings,
  type Tuning,
  TUNING_CHOICES,
} from "../core/settings.ts";
import { checkboxClass, Field, selectClass } from "./fields.tsx";

interface Props {
  settings: Settings;
  /** the processor cores of this machine */
  cores: number;
  disabled: boolean;
  /** Whisper takes no glossary */
  whisper: boolean;
  onChange(settings: Settings): void;
  /** more under Advanced that the defaults do not cover */
  children?: ReactNode;
}

function Choice({
  label,
  hint,
  name,
  values,
  unit,
  notes,
  tuning,
  disabled,
  onChange,
}: {
  label: string;
  hint: string;
  name: keyof Tuning;
  values: readonly number[];
  unit?: string;
  /** a word on the ends of the range */
  notes?: Partial<Record<number, string>>;
  tuning: Tuning;
  disabled: boolean;
  onChange(tuning: Tuning): void;
}) {
  // an agent may set a value between the choices: it is listed too, so the window shows what holds
  const shown = values.includes(tuning[name]) ? values : [...values, tuning[name]].sort((a, b) => a - b);
  return (
    <Field label={label} hint={hint}>
      <select
        className={selectClass}
        value={tuning[name]}
        disabled={disabled}
        onChange={(e) => onChange({ ...tuning, [name]: Number(e.target.value) })}
      >
        {shown.map((value) => {
          const note = value === DEFAULT_TUNING[name] ? "default" : notes?.[value];
          return (
            <option key={value} value={value}>
              {`${value}${unit ?? ""}${note ? ` (${note})` : ""}`}
            </option>
          );
        })}
      </select>
    </Field>
  );
}

const MIC_OPTIONS: { key: keyof MicProcessing; label: string; hint: string }[] = [
  { key: "noiseSuppression", label: "Noise suppression", hint: "Takes out hum and fan noise." },
  { key: "autoGainControl", label: "Automatic level", hint: "Raises quiet speakers, lowers loud ones." },
  {
    key: "echoCancellation",
    label: "Echo cancellation",
    hint: "For a call on speakers without headphones. In a room it can swallow quiet voices.",
  },
];

export function Advanced({ settings, cores, disabled, whisper, onChange, children }: Props) {
  const { tuning, mic } = settings;
  const setTuning = (next: Tuning): void => onChange({ ...settings, tuning: next });
  const threads = Array.from({ length: Math.max(cores, tuning.threads) }, (_, i) => i + 1);
  const common = { tuning, disabled, onChange: setTuning };

  return (
    <details className="group text-sm">
      <summary
        className={cn(
          "flex w-fit cursor-pointer list-none items-center gap-1.5 rounded-sm font-medium [&::-webkit-details-marker]:hidden",
          focusRing,
        )}
      >
        <ChevronRight className="size-4 transition-transform group-open:rotate-90" aria-hidden />
        Advanced
      </summary>
      <div className="mt-3 flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-3">
          <Choice
            label="Glossary weight"
            hint={whisper ? "Parakeet only." : "Higher finds more terms, and may replace a word that sounds alike."}
            name="glossaryWeight"
            values={TUNING_CHOICES.glossaryWeight}
            {...common}
            disabled={disabled || whisper}
          />
          <Choice
            label="Pause that ends a line"
            hint="Longer gives the model more context; the line comes later."
            name="pause"
            values={TUNING_CHOICES.pause}
            unit=" s"
            {...common}
          />
          <Choice
            label="Longest line"
            hint="Talk without a pause is cut here."
            name="longestLine"
            values={TUNING_CHOICES.longestLine}
            unit=" s"
            {...common}
          />
          <Choice
            label="Speech detection"
            hint="Lower hears quiet voices, higher ignores more noise."
            name="speechThreshold"
            values={TUNING_CHOICES.speechThreshold}
            notes={{ 0.3: "sensitive", 0.7: "strict" }}
            {...common}
          />
          <Choice
            label="Processor cores"
            hint="More is quicker, and leaves less for the meeting app."
            name="threads"
            values={threads}
            {...common}
          />
        </div>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 font-medium">Microphone</legend>
          {MIC_OPTIONS.map(({ key, label, hint }) => (
            <label key={key} className="flex items-start gap-2">
              <input
                type="checkbox"
                className={cn(checkboxClass, "mt-0.5")}
                checked={mic[key]}
                disabled={disabled}
                onChange={(e) => onChange({ ...settings, mic: { ...mic, [key]: e.target.checked } })}
              />
              <span>
                {label}
                <span className="text-muted-foreground block text-xs">{hint}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <Button
          variant="link"
          size="sm"
          className="h-auto w-fit p-0"
          disabled={disabled}
          onClick={() => onChange({ tuning: { ...DEFAULT_SETTINGS.tuning }, mic: { ...DEFAULT_SETTINGS.mic } })}
        >
          Back to the defaults
        </Button>
        {children}
      </div>
    </details>
  );
}
