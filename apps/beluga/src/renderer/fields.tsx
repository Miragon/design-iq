import { focusRing } from "@designiq/ui-kit/components/button";
import { cn } from "@designiq/ui-kit/lib/utils";
import { CircleAlert, TriangleAlert } from "lucide-react";
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

/** a group of settings on a card of its own, named by its title */
export function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  const titleId = useId();
  return (
    <section aria-labelledby={titleId} className="bg-card flex flex-col gap-4 rounded-md border p-4">
      <div className="flex flex-col gap-0.5">
        <h2 id={titleId} className="text-sm font-semibold">
          {title}
        </h2>
        {hint ? <p className="text-muted-foreground text-xs">{hint}</p> : null}
      </div>
      {children}
    </section>
  );
}

const TONES = {
  danger: { box: "border-destructive bg-destructive-soft", mark: "text-destructive", Icon: CircleAlert },
  warning: { box: "border-warning bg-warning-soft", mark: "text-warning", Icon: TriangleAlert },
} as const;

/** a status box (CI §8): the tint under the text, the status in the border and the icon */
export function Callout({ tone, children }: { tone: keyof typeof TONES; children: ReactNode }) {
  const { box, mark, Icon } = TONES[tone];
  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      className={cn("flex gap-2 rounded-md border border-l-4 px-3 py-2.5 text-sm", box)}
    >
      <Icon className={cn("mt-0.5 size-4 shrink-0", mark)} aria-hidden />
      <p className="min-w-0">{children}</p>
    </div>
  );
}
