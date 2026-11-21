/**
 * The release of a model node (EmbeddedEditor.release): before an armed model becomes a preview
 * again, or goes while armed, nothing stays selected, open or focused in its editor. The product
 * editors have no call for it (MountedEditor, @miragon/modeler-api 2.0.0: `interaction` only
 * reports a gesture, `elements` selects but never clears), so it is done through the DOM, as a
 * person would do it, and only inside the node's element:
 * - an Escape keyup on the document: diagram-js ends a running drag or tool on it
 * - a click on the empty canvas of every diagram-js editor: it drops the selection and closes the
 *   context pad
 * - a blur of what has the focus: it commits an open label editor or decision-table cell
 * - the text selection inside removed
 * The same release the modeler suite measured on its seven modelers (its host package's
 * releaseDiagramJs), and designIQ's board before it. Events are made in the element's own window.
 */
export function releaseDiagramJs(element: HTMLElement): void {
  const doc = element.ownerDocument;
  const view = doc.defaultView;
  if (!view) return;
  doc.dispatchEvent(new view.KeyboardEvent("keyup", { key: "Escape", bubbles: true, cancelable: true }));
  for (const canvas of element.querySelectorAll(".djs-container > svg")) {
    canvas.dispatchEvent(new view.MouseEvent("click", { bubbles: true, cancelable: true, view, button: 0 }));
  }
  const active = doc.activeElement;
  const focusable = active instanceof view.HTMLElement || active instanceof view.SVGElement;
  if (focusable && element.contains(active)) active.blur();
  const selection = doc.getSelection();
  if (selection?.anchorNode && element.contains(selection.anchorNode)) selection.removeAllRanges();
}
