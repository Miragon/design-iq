/**
 * "Add todo" dialog — anchors the new todo to the elements selected on the
 * canvas at open time, or files it on the whole model (a process, a Wardley
 * Map, a document, …) when nothing is selected. The todo is filed with one of the repo's types (#313): its issue
 * templates and/or the built-in `Todo`; with a single type there is no picker,
 * and the built-in alone looks as the dialog always did. Required fields are
 * flagged inline by the check the server runs too (lib/todo-form.ts). Server
 * errors (501 "no tracker configured", permission) surface inline — their
 * messages are actionable. Mounted on open, so state resets by unmounting.
 */
import { isBuiltInTodoType, type TodoField, type TodoFieldValues } from "@designiq/contracts/todo-types";
import { Badge } from "@designiq/ui-kit/components/badge";
import { Button } from "@designiq/ui-kit/components/button";
import { cn } from "@designiq/ui-kit/lib/utils";
import { useEffect, useId, useState } from "react";

import { dialogBackdrop, dialogPanel, fieldClass } from "@/components/dialog-shell";
import type { TodoElementWire, TodoModelRef } from "@/lib/api";
import { useCreateTodo, useTodoTypes } from "@/lib/queries";
import {
  defaultTodoType,
  fieldFlags,
  formFields,
  initialFieldValues,
  todoTypeRequest,
  toggleOption,
} from "@/lib/todo-form";

const labelClass = "mt-3 block text-xs font-medium";
const optional = <span className="text-muted-foreground font-normal">(optional)</span>;

function OptionList({
  id,
  field,
  value,
  invalid,
  describedBy,
  onChange,
}: {
  id: string;
  field: TodoField;
  value: string | string[] | undefined;
  invalid: boolean;
  describedBy?: string;
  onChange: (value: string[]) => void;
}) {
  const checked = Array.isArray(value) ? value : [];
  return (
    <div
      id={id}
      className="mt-1 space-y-1"
      role="group"
      aria-labelledby={`${id}-label`}
      aria-invalid={invalid}
      aria-describedby={describedBy}
    >
      {field.options.map((option) => (
        <label key={option.label} className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="accent-primary mt-0.5 size-4 shrink-0"
            checked={checked.includes(option.label)}
            onChange={(e) => onChange(toggleOption(value, option.label, e.target.checked))}
          />
          <span>
            {option.label}
            {option.required && <span className="text-muted-foreground"> (required)</span>}
          </span>
        </label>
      ))}
    </div>
  );
}

function TodoFieldInput({
  field,
  id,
  value,
  flag,
  onChange,
}: {
  field: TodoField;
  id: string;
  value: string | string[] | undefined;
  flag: string | undefined;
  onChange: (value: string | string[]) => void;
}) {
  const flagId = `${id}-flag`;
  const describedBy = flag ? flagId : undefined;
  const text = typeof value === "string" ? value : "";
  const inputProps = {
    id,
    className: fieldClass,
    "aria-invalid": flag !== undefined,
    "aria-describedby": describedBy,
  };
  const isList = field.kind === "checkboxes" || (field.kind === "dropdown" && field.multiple);
  return (
    <div>
      <label id={`${id}-label`} className={labelClass} htmlFor={isList ? undefined : id}>
        {field.label} {!field.required && field.kind !== "checkboxes" && optional}
      </label>
      {field.description && <p className="text-muted-foreground mt-0.5 text-xs">{field.description}</p>}
      {isList ? (
        <OptionList
          id={id}
          field={field}
          value={value}
          invalid={flag !== undefined}
          describedBy={describedBy}
          onChange={onChange}
        />
      ) : field.kind === "dropdown" ? (
        <select {...inputProps} value={text} onChange={(e) => onChange(e.target.value)}>
          <option value="">Choose…</option>
          {field.options.map((option) => (
            <option key={option.label} value={option.label}>
              {option.label}
            </option>
          ))}
        </select>
      ) : field.kind === "textarea" ? (
        <textarea
          {...inputProps}
          rows={4}
          placeholder={field.placeholder ?? undefined}
          value={text}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <input
          {...inputProps}
          placeholder={field.placeholder ?? undefined}
          value={text}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      {flag && (
        <p id={flagId} className="text-destructive mt-1 text-xs">
          {flag}
        </p>
      )}
    </div>
  );
}

export function TodoCreateDialog({
  repo,
  model,
  noun,
  docPath,
  elements,
  onClose,
}: {
  repo: string;
  /** the model the todo is filed on */
  model: TodoModelRef;
  /** how the model is called ("process", "Wardley Map", "document", …) */
  noun: string;
  /** repo-relative path of the open model document (the todo's anchor file) */
  docPath: string;
  /** canvas selection at open time — empty ⇒ a todo on the whole model */
  elements: TodoElementWire[];
  onClose: () => void;
}) {
  const idPrefix = useId();
  const [title, setTitle] = useState("");
  const [typeId, setTypeId] = useState<string | null>(null);
  const [edited, setEdited] = useState<TodoFieldValues | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const types = useTodoTypes(repo);
  const create = useCreateTodo(repo);

  const allTypes = types.data ?? [];
  const type = allTypes.find((t) => t.id === typeId) ?? defaultTodoType(allTypes);
  const values = edited ?? (type ? initialFieldValues(type) : {});
  const flags = submitted && type ? fieldFlags(type, values) : {};
  const fieldId = (field: TodoField) => `${idPrefix}-${field.id}`;

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const chooseType = (id: string) => {
    create.reset();
    setTypeId(id);
    setEdited(null);
    setSubmitted(false);
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = title.trim();
    if (!trimmed || !type || create.isPending) return;
    setSubmitted(true);
    const flagged = fieldFlags(type, values);
    const firstFlagged = formFields(type).find((f) => flagged[f.id]);
    if (firstFlagged) {
      const control = document.getElementById(fieldId(firstFlagged));
      (control?.querySelector("input") ?? control)?.focus();
      return;
    }
    create.mutate(
      {
        title: trimmed,
        ...todoTypeRequest(type, values),
        anchor: {
          notation: model.notation,
          model: model.id,
          file: docPath,
          ...(elements.length > 0 ? { elements } : {}),
        },
      },
      { onSuccess: onClose },
    );
  };

  return (
    <div className={dialogBackdrop} onClick={onClose}>
      <form
        noValidate
        className={cn(dialogPanel, "flex max-h-[85vh] max-w-md flex-col")}
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
      >
        <h2 className="text-base font-semibold">Create todo</h2>
        {elements.length > 0 ? (
          <div className="mt-1.5 flex flex-wrap items-center gap-1">
            <span className="text-muted-foreground text-xs">Anchored to:</span>
            {elements.map((el) => (
              <Badge key={el.id} variant="outline" className="max-w-48" title={el.id}>
                <span className="truncate">{el.name ?? el.id}</span>
              </Badge>
            ))}
          </div>
        ) : (
          <p className="text-muted-foreground mt-1.5 text-xs">
            No element selected — the todo applies to the {noun} "{model.id}".
          </p>
        )}
        <div className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1 pb-1">
          {allTypes.length > 1 && type && (
            <>
              <label className={labelClass} htmlFor={`${idPrefix}-type`}>
                Type
              </label>
              <select
                id={`${idPrefix}-type`}
                className={fieldClass}
                value={type.id}
                onChange={(e) => chooseType(e.target.value)}
              >
                {allTypes.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </>
          )}
          {allTypes.length === 1 && type && !isBuiltInTodoType(type) && (
            <p className="text-muted-foreground mt-3 text-xs">Filed as {type.name}</p>
          )}
          <label className={labelClass} htmlFor="todo-title">
            Title
          </label>
          <input
            id="todo-title"
            className={fieldClass}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="What needs to be done?"
            autoFocus
            required
          />
          {types.isPending && <p className="text-muted-foreground mt-3 text-sm">Loading the todo types…</p>}
          {types.error && <p className="text-destructive mt-3 text-sm">{types.error.message}</p>}
          {type &&
            formFields(type).map((field) => (
              <TodoFieldInput
                key={`${type.id}:${field.id}`}
                field={field}
                id={fieldId(field)}
                value={values[field.id]}
                flag={flags[field.id]}
                onChange={(value) => {
                  create.reset();
                  setEdited({ ...values, [field.id]: value });
                }}
              />
            ))}
        </div>
        {create.error && <p className="text-destructive mt-3 text-sm whitespace-pre-line">{create.error.message}</p>}
        <div className="mt-6 flex justify-end gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={create.isPending || !type || title.trim().length === 0}>
            {create.isPending ? "Creating…" : "Create todo"}
          </Button>
        </div>
      </form>
    </div>
  );
}
