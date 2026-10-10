/**
 * "Load latest from <default branch>" confirmation — shown only when the repo
 * has unreleased live changes the reset would DISCARD (a clean repo syncs
 * without asking). Lists the affected models (processes AND decisions — the
 * reset drops both) so the discard is an informed choice. Mounted on open, so state resets by unmounting; the reset itself
 * (mutation, toast) is owned by the parent (routes/repo.tsx).
 */
import { Badge } from "@designiq/ui-kit/components/badge";
import { Button } from "@designiq/ui-kit/components/button";
import { cn } from "@designiq/ui-kit/lib/utils";
import { useEffect } from "react";

import { dialogBackdrop, dialogPanel } from "@/components/dialog-shell";

export function SyncRepoDialog({
  branch,
  dirtyModels,
  pending,
  error,
  onConfirm,
  onClose,
}: {
  /** the default branch the workspace is reset onto */
  branch: string;
  /** models (processes and decisions) with unreleased live edits the reset
   *  will discard — keyed by path (names may collide across kinds) */
  dirtyModels: Array<{ path: string; name: string }>;
  pending: boolean;
  error: Error | null;
  onConfirm: () => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !pending) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, pending]);

  return (
    <div className={dialogBackdrop} onClick={() => !pending && onClose()}>
      <div className={cn(dialogPanel, "max-w-md")} onClick={(e) => e.stopPropagation()}>
        <h2 className="text-base font-semibold">Load latest from {branch}?</h2>
        <p className="text-muted-foreground mt-2 text-sm">
          This resets the workspace to <code className="bg-muted rounded-sm px-1">{branch}</code> and{" "}
          <strong className="text-foreground">discards the unreleased live changes</strong> in{" "}
          {dirtyModels.length === 1 ? "this model" : `these ${dirtyModels.length} models`}:
        </p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {dirtyModels.map((m) => (
            <Badge key={m.path} variant="warning" className="max-w-64" title={m.path}>
              <span className="truncate">{m.name}</span>
            </Badge>
          ))}
        </div>
        <p className="text-muted-foreground mt-2 text-xs">
          Release them first if you want to keep them. This can't be undone.
        </p>
        {error && <p className="text-destructive mt-3 text-sm">{error.message}</p>}
        <div className="mt-6 flex justify-end gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button type="button" variant="destructive" size="sm" onClick={onConfirm} disabled={pending}>
            {pending ? "Loading…" : "Discard & load latest"}
          </Button>
        </div>
      </div>
    </div>
  );
}
