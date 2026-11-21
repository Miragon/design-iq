import { focusRing } from "@designiq/ui-kit/components/button";
import { cn } from "@designiq/ui-kit/lib/utils";
import { cloneElement, isValidElement, type ReactElement, type ReactNode, useId } from "react";

export const selectClass = cn(
  "border-input bg-background h-9 rounded-md border px-3 text-sm disabled:cursor-not-allowed disabled:opacity-50",
  focusRing,
);

export const checkboxClass = cn("accent-primary size-4 shrink-0 rounded-sm", focusRing);

/** a control under its label; the hint below describes it and is no part of its name */
export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  const hintId = useId();
  const control =
    hint && isValidElement(children)
      ? cloneElement(children as ReactElement<{ "aria-describedby"?: string }>, { "aria-describedby": hintId })
      : children;
  return (
    <div className="flex flex-col gap-1.5 text-sm">
      <label className="flex flex-col gap-1.5">
        <span className="font-medium">{label}</span>
        {control}
      </label>
      {hint ? (
        <span id={hintId} className="text-muted-foreground text-xs">
          {hint}
        </span>
      ) : null}
    </div>
  );
}
