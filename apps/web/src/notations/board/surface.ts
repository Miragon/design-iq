/** What a strategy's surface gets from the model node's frame and what it gives the board back. */
import type { EditorProbe, ModelNotation } from "./types.ts";

export interface SurfaceProps {
  nodeId: string;
  notation: ModelNotation;
  file: string;
  armed: boolean;
  /** inner size of the node body in flow units (= CSS px at board zoom 1) */
  width: number;
  height: number;
}

/** what a surface registers with the board context for the hooks */
export interface SurfaceApi {
  ready: Promise<void>;
  probe?: EditorProbe;
  engine?: unknown;
  frameName?: string;
  /** resolves once the armed surface takes input */
  whenInteractive(): Promise<void>;
}
