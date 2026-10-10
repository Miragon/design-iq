/**
 * "New folder" dialog — creates a folder under the repo's models root,
 * inside the folder currently shown in the table. Server errors (409 exists,
 * 400 invalid name) surface inline. Mounted on open, so state resets by
 * unmounting.
 */
import { Button } from "@designiq/ui-kit/components/button";
import { cn } from "@designiq/ui-kit/lib/utils";
import { useEffect, useState } from "react";

import { dialogBackdrop, dialogPanel, fieldClass } from "@/components/dialog-shell";
import { useCreateFolder } from "@/lib/queries";

/** mirror of the backend's segment rule — inline feedback, server re-checks */
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function CreateFolderDialog({
  repo,
  parent,
  onClose,
  onCreated,
}: {
  repo: string;
  /** processes-root-relative folder the table currently shows ("" = root) */
  parent: string;
  onClose: () => void;
  onCreated: (path: string) => void;
}) {
  const [name, setName] = useState("");
  const create = useCreateFolder(repo);

  // no close while the create runs — an unmounted dialog would drop the
  // mutation's onSuccess (cache seeding + the caller's toast), same as
  // SyncRepoDialog
  const close = () => {
    if (!create.isPending) onClose();
  };
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !create.isPending) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, create.isPending]);

  const trimmed = name.trim();
  const valid = SEGMENT.test(trimmed) && trimmed !== "node_modules" && trimmed.length <= 64;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid || create.isPending) return;
    create.mutate(parent ? `${parent}/${trimmed}` : trimmed, { onSuccess: (r) => onCreated(r.path) });
  };

  return (
    <div className={dialogBackdrop} onClick={close}>
      <form className={cn(dialogPanel, "max-w-md")} onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2 className="text-base font-semibold">New folder</h2>
        <p className="text-muted-foreground mt-1.5 text-xs">
          {parent ? (
            <>
              Created inside <code className="bg-muted rounded-sm px-1">{parent}/</code>.
            </>
          ) : (
            "Created at the root of the models folder."
          )}
        </p>
        <label className="mt-3 block text-xs font-medium" htmlFor="folder-name">
          Name
        </label>
        <input
          id="folder-name"
          className={fieldClass}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. sales"
          autoFocus
          required
        />
        {trimmed.length > 0 && !valid && (
          <p className="text-muted-foreground mt-1.5 text-xs">
            Use letters, digits, "-", "_" or "." (not leading) — no spaces or slashes.
          </p>
        )}
        {create.error && <p className="text-destructive mt-3 text-sm">{create.error.message}</p>}
        <div className="mt-6 flex justify-end gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={create.isPending}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={create.isPending || !valid}>
            {create.isPending ? "Creating…" : "Create folder"}
          </Button>
        </div>
      </form>
    </div>
  );
}
