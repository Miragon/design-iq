/**
 * The shell of the model dialogs (rename, duplicate, move, delete — #208–#210):
 * dimmed backdrop, a centered form panel, header + blurb, right-aligned footer.
 * Escape and a backdrop click close it — never while the action runs (an
 * unmounted dialog would drop the mutation's onSuccess). Mounted on open, so
 * state resets by unmounting (create-dialog convention). Its backdrop, panel
 * and field classes are every dialog's — the create, release, sync and todo
 * dialogs keep their own markup, not their own look.
 *
 * ModalDialog is the modal frame of this shell and of the release, todo and
 * history diff dialogs: a native <dialog> shown with showModal(), so the page
 * behind it is inert. A Tab, a click or a key from it reaches neither the
 * editor's toolbar nor its source nor its canvas, where a key would edit the
 * shared document under an open dialog (guide §8: the focus stays in the
 * dialog and goes back afterwards).
 */
import { Button } from "@designiq/ui-kit/components/button";
import { cn } from "@designiq/ui-kit/lib/utils";
import { type ReactNode, useEffect, useId, useLayoutEffect, useRef } from "react";

/** every dialog's backdrop (CI §8): --cd-schwarz dimmed, the page softly blurred behind it */
export const dialogBackdrop = "bg-overlay fixed inset-0 z-50 flex items-center justify-center p-4 backdrop-blur-sm";

/** every dialog's panel: a popover surface, radius lg, the popover/dialog elevation */
export const dialogPanel = "bg-popover text-popover-foreground w-full rounded-lg border p-6 shadow-lg";

/** a dialog's native text field — the kit Input's look: kontur frame, focus = blue frame + blue-soft halo */
export const fieldClass =
  "border-input bg-background placeholder:text-muted-foreground focus-visible:border-primary focus-visible:ring-accent mt-1 w-full rounded-md border px-3 py-2 text-sm shadow-xs transition-[color,border-color,box-shadow] outline-none focus-visible:ring-[3px]";

/** the <dialog> is the backdrop itself, so the browser's own ::backdrop stays
 *  clear, and a closed one shows nothing (`flex` outranks the browser's
 *  display: none) */
const modalBackdrop = cn(
  dialogBackdrop,
  "m-0 h-full max-h-none w-full max-w-none outline-none not-open:hidden backdrop:bg-transparent",
);

/**
 * A modal dialog named by `labelledBy`. It takes the focus as it opens: the
 * element marked `data-autofocus`, else the dialog itself (React's autoFocus
 * would run while the <dialog> is still closed, and the browser's own choice
 * is whatever control comes first). As it closes the browser gives the focus
 * back to the element that had it before. `onDismiss` runs on Escape and on a
 * click on the backdrop; the parent closes the dialog by unmounting it.
 */
export function ModalDialog({
  labelledBy,
  onDismiss,
  children,
}: {
  labelledBy: string;
  onDismiss: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog) return undefined;
    dialog.showModal();
    (dialog.querySelector<HTMLElement>("[data-autofocus]") ?? dialog).focus();
    return () => dialog.close();
  }, []);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // the browser's own Escape would close the dialog behind React's back,
      // also while the action runs, when onDismiss keeps it open
      event.preventDefault();
      onDismiss();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onDismiss]);

  return (
    <dialog
      ref={ref}
      tabIndex={-1}
      aria-modal="true"
      aria-labelledby={labelledBy}
      className={modalBackdrop}
      onClick={(event) => {
        if (event.target === event.currentTarget) onDismiss();
      }}
      onCancel={(event) => {
        event.preventDefault();
        onDismiss();
      }}
    >
      {children}
    </dialog>
  );
}

export function DialogShell({
  title,
  blurb,
  pending,
  error,
  submitLabel,
  pendingLabel,
  submitDisabled,
  destructive = false,
  wide = false,
  onSubmit,
  onClose,
  children,
}: {
  title: ReactNode;
  blurb?: ReactNode;
  pending: boolean;
  error?: Error | null;
  submitLabel: string;
  pendingLabel: string;
  submitDisabled?: boolean;
  /** the primary action destroys something — red, never the default blue */
  destructive?: boolean;
  wide?: boolean;
  onSubmit: () => void;
  onClose: () => void;
  children?: ReactNode;
}) {
  const titleId = useId();
  const close = () => {
    if (!pending) onClose();
  };

  return (
    <ModalDialog labelledBy={titleId} onDismiss={close}>
      <form
        className={cn(dialogPanel, "flex max-h-[85vh] flex-col", wide ? "max-w-lg" : "max-w-md")}
        onSubmit={(e) => {
          e.preventDefault();
          if (!pending && !submitDisabled) onSubmit();
        }}
      >
        <h2 id={titleId} className="text-base font-semibold">
          {title}
        </h2>
        {blurb && <p className="text-muted-foreground mt-1.5 text-xs">{blurb}</p>}
        {children}
        {error && (
          <p className="text-destructive mt-3 text-sm" role="alert">
            {error.message}
          </p>
        )}
        <div className="mt-6 flex justify-end gap-2">
          {/* a destructive dialog opens on Cancel (guide §8) */}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onClose}
            disabled={pending}
            data-autofocus={destructive || undefined}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            size="sm"
            variant={destructive ? "destructive" : "default"}
            disabled={pending || submitDisabled}
          >
            {pending ? pendingLabel : submitLabel}
          </Button>
        </div>
      </form>
    </ModalDialog>
  );
}

/** one consequence line of a dialog — icon + text, muted unless it warns */
export function Consequence({
  icon: Icon,
  tone = "muted",
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  tone?: "muted" | "warning" | "danger";
  children: ReactNode;
}) {
  return (
    <li
      className={cn(
        "flex gap-2 text-xs",
        tone === "muted" && "text-muted-foreground",
        tone === "warning" && "text-foreground",
        tone === "danger" && "text-destructive",
      )}
    >
      <Icon
        className={cn(
          "mt-px size-3.5 shrink-0",
          tone === "warning" && "text-warning",
          tone === "danger" && "text-destructive",
        )}
      />
      <span className="min-w-0">{children}</span>
    </li>
  );
}
