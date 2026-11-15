/**
 * The iframe strategy: the node body IS a same-origin frame that shows board-spike-embed.html,
 * and that page mounts ONE product editor with the product's own mount function (embed-main.ts).
 * The frame is laid out at the body's size in flow units and scaled by the board like any node
 * content. Its document has a coordinate space of its own, so nothing in an engine has to know
 * about the board's zoom.
 *
 * The frame is there from the start, in preview too. Preview: the node body is `inert` and the
 * frame takes no pointer (board-spike.css), so a drag, a wheel and a double-click land on the node.
 * Armed: the frame takes the pointer, and the page in it moves the keyboard focus to its canvas.
 *
 * Focus: arming is the frame's doing (window.focus() and the canvas, embed-main.ts takeInput). A
 * click on the pane, the header or another node moves the focus out by itself, as any click outside
 * a frame does. Only a disarm without such a click (the test hook) leaves it in the frame: then the
 * frame is blurred here and the keys are the board's again.
 */
import { useEffect, useRef } from "react";

import { useBoardContext } from "../../notations/board/board-context.tsx";
import type { SurfaceProps } from "../../notations/board/surface.ts";
import type { FrameLink, ModelHub } from "../model-hub.ts";
import { embedUrl } from "../shared.ts";

/** the board page's clock (ms since the epoch, sub-ms): comparable with a frame's `timeOrigin` */
const now = (): number => performance.timeOrigin + performance.now();

/** `&via=registry` on the board page's URL travels to every frame (embed/product-mount.ts) */
const VIA = new URLSearchParams(location.search).get("via");

export function IframeSurface({ nodeId, notation, file, armed, width, height }: SurfaceProps) {
  const { hub, registerSurface, reportMount, log } = useBoardContext();
  const frame = useRef<HTMLIFrameElement>(null);
  const link = useRef<FrameLink>(undefined);
  /** the frame's answer to the latest arm(true) */
  const interactive = useRef<Promise<void>>(Promise.resolve());
  const frameName = `frame-${nodeId}`;

  useEffect(() => {
    const element = frame.current;
    const target = element?.contentWindow;
    if (!element || !target) return;
    // the frame bridge is the bench hub's own: no host of the board has one
    const attached = (hub as ModelHub).attachFrame(file, target, frameName);
    link.current = attached;
    // one engine mount per page load of the frame: a frame that loads again mounted a second editor
    reportMount(nodeId);
    let loads = 0;
    const onLoad = (): void => {
      if (++loads === 1) return;
      reportMount(nodeId);
      log(`${frameName}: the frame loaded again (${loads} loads)`);
    };
    element.addEventListener("load", onLoad);
    // for the cost measurements: when the frame came into the document and when its editor was ready
    element.dataset.createdAt = String(now());
    delete element.dataset.readyAt;
    attached.ready.then(
      () => void (element.dataset.readyAt = String(now())),
      () => undefined,
    );
    const unregister = registerSurface(nodeId, {
      ready: attached.ready,
      frameName,
      // The frame answers "armed" only after its editor is up. It answers for a failed editor too,
      // and arming such a node then resolves: the failure is in the log, not thrown at whoever armed.
      whenInteractive: () =>
        Promise.all([attached.ready.catch(() => undefined), interactive.current]).then(() => undefined),
    });
    return () => {
      unregister();
      element.removeEventListener("load", onLoad);
      attached.detach();
      link.current = undefined;
    };
  }, [hub, file, nodeId, frameName, registerSurface, reportMount, log]);

  // after the effect above, also when it attached a new link: the link learns what the node is
  useEffect(() => {
    const answered = link.current?.arm(armed);
    if (armed && answered) interactive.current = answered;
    if (armed) return;
    // Disarmed with the focus still in the frame (no click outside moved it): back to the board's
    // document. Not to the node's wrapper: React Flow pans the board to a node that takes the focus
    // (autoPanOnNodeFocus), measured here as a viewport jump on every disarm.
    const element = frame.current;
    if (element && document.activeElement === element) element.blur();
    // A script in the frame can take the focus back although the frame is inert here (measured:
    // diagram-js focuses its canvas when a popup menu closes, which the disarm causes). The window's
    // blur is what the board page sees of that.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const giveBack = (): void => {
      // after the focus change is through: a blur() inside the blur event does nothing (measured)
      timer = setTimeout(() => {
        if (element && document.activeElement === element) element.blur();
      }, 0);
    };
    window.addEventListener("blur", giveBack);
    return () => {
      window.removeEventListener("blur", giveBack);
      clearTimeout(timer);
    };
  }, [armed, hub, file, frameName]);

  // An armed frame takes the pointer, also the moves of a drag that began in the board page (a
  // resize handle, the node's header): the board would see the press and never the rest (measured:
  // a resize stalled after its first tick and its end was never written). A press the board page
  // sees began outside the frame, so the frame stays out of the way until that press is released.
  useEffect(() => {
    const element = frame.current;
    if (!armed || !element) return;
    const shield = (): void => void (element.style.pointerEvents = "none");
    const unshield = (): void => void (element.style.pointerEvents = "");
    window.addEventListener("pointerdown", shield, true);
    window.addEventListener("pointerup", unshield, true);
    window.addEventListener("pointercancel", unshield, true);
    return () => {
      window.removeEventListener("pointerdown", shield, true);
      window.removeEventListener("pointerup", unshield, true);
      window.removeEventListener("pointercancel", unshield, true);
      unshield();
    };
  }, [armed]);

  return (
    <iframe
      ref={frame}
      className="board-frame"
      name={frameName}
      title={file}
      src={`${embedUrl({ frame: frameName, file, notation })}${VIA ? `&via=${encodeURIComponent(VIA)}` : ""}`}
      // flow units: the board's transform scales the frame, its window keeps this size at every zoom
      style={{ width, height }}
      inert={!armed}
    />
  );
}
