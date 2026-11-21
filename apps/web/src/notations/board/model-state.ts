/**
 * What a model node says about its file, in its own element: the board has no loading look and
 * no retry, so the node says it waits, that its file is gone, that its text cannot be shown, or
 * that it could not be opened. The state is also written as `data-model-state` on the element,
 * which board.css draws. Node-loadable.
 */
export type ModelState = "loading" | "ready" | "gone" | "invalid" | "failed";

export const MODEL_STATE_TEXT: Readonly<Record<Exclude<ModelState, "ready">, string>> = {
  loading: "Loading…",
  gone: "This model is not in the repository. The board keeps its place.",
  invalid: "This model cannot be shown as it is. Open it on its own page to repair it.",
  failed: "This model could not be opened.",
};

export interface ModelStateLine {
  /** `detail`: the reason, after the line of a failed node and as the title of an invalid one */
  show(state: ModelState, detail?: string): void;
  current(): ModelState;
  /** takes the line and the attribute off the element */
  remove(): void;
}

export function modelStateLine(element: HTMLElement): ModelStateLine {
  const line = element.ownerDocument.createElement("div");
  line.className = "board-model-state";
  line.setAttribute("role", "status");
  element.append(line);
  let now: ModelState = "loading";
  return {
    show(state, detail) {
      now = state;
      element.dataset.modelState = state;
      line.hidden = state === "ready";
      if (state === "ready") line.textContent = "";
      else if (state === "failed" && detail) line.textContent = `${MODEL_STATE_TEXT.failed} ${detail}`;
      else line.textContent = MODEL_STATE_TEXT[state];
      // what the editor said of the text, for whoever repairs it
      if (state === "invalid" && detail) line.title = detail;
      else line.removeAttribute("title");
    },
    current: () => now,
    remove() {
      line.remove();
      delete element.dataset.modelState;
    },
  };
}
