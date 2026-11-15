/**
 * A short text that is edited where it stands: a group's name, an arrow's label. Double-click
 * opens an input in its place; Enter, Escape and leaving the input all commit, once.
 *
 * While the input is open it carries React Flow's four opt-out classes (react-flow.md 3.6): a
 * drag inside it selects text, a wheel scrolls nothing of the board, and no key reaches the board.
 */
import { type MouseEvent, useEffect, useRef, useState } from "react";

/** keeps a click out of the node's or edge's own click handling */
const stop = (event: MouseEvent): void => event.stopPropagation();

interface InlineEditProps {
  value: string;
  /** shown, quietly, in place of an empty value */
  placeholder: string;
  /** what the input is, for a screen reader */
  label: string;
  className: string;
  /** set both to open the input from outside (an arrow's label opens by a double-click on its line) */
  editing?: boolean;
  onEditing?: (editing: boolean) => void;
  /** called once per edit, and only when the text changed */
  onCommit: (value: string) => void;
}

export function InlineEdit({ value, placeholder, label, className, editing, onEditing, onCommit }: InlineEditProps) {
  const [own, setOwn] = useState(false);
  const open = editing ?? own;
  const setOpen = (next: boolean): void => {
    setOwn(next);
    onEditing?.(next);
  };
  if (!open) {
    return (
      <span
        className={className}
        data-empty={value === ""}
        title="Double-click to edit"
        onDoubleClick={(event) => {
          event.stopPropagation();
          setOpen(true);
        }}
      >
        {value === "" ? placeholder : value}
      </span>
    );
  }
  return (
    <InlineInput
      value={value}
      label={label}
      className={className}
      onDone={(next, opened) => {
        setOpen(false);
        // against what the input opened with: a peer may have changed the text meanwhile, and an
        // input nobody typed in must not write its old text over that
        if (next !== opened) onCommit(next);
      }}
    />
  );
}

interface InlineInputProps {
  value: string;
  label: string;
  className: string;
  /** what the input holds at the end, and what it held when it opened */
  onDone: (value: string, opened: string) => void;
}

const sizeFor = (text: string): number => Math.max(6, text.length + 1);

function InlineInput({ value, label, className, onDone }: InlineInputProps) {
  const input = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  /** the value the input was mounted with: `value` follows a peer's change while the input is open */
  const opened = useRef(value);
  useEffect(() => {
    // preventScroll: a focus inside the scaled viewport would otherwise scroll the board's container
    input.current?.focus({ preventScroll: true });
    input.current?.select();
  }, []);
  const finish = (): void => {
    // Enter blurs, and the blur is the commit: one path, one write
    if (done.current) return;
    done.current = true;
    onDone(input.current?.value.trim() ?? opened.current, opened.current);
  };
  return (
    <input
      ref={input}
      className={`${className} board-inline-input nodrag nopan nowheel nokey`}
      defaultValue={value}
      size={sizeFor(value)}
      aria-label={label}
      spellCheck={false}
      onInput={(event) => (event.currentTarget.size = sizeFor(event.currentTarget.value))}
      onBlur={finish}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter" || event.key === "Escape") {
          event.preventDefault();
          event.currentTarget.blur();
        }
      }}
      onClick={stop}
      onDoubleClick={stop}
    />
  );
}
