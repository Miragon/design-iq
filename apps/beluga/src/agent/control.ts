/**
 * What an agent's requests do, on top of what the main process offers. No
 * Electron here: the main process passes in its state and its actions.
 */
import { readFile } from "node:fs/promises";

import { parseGlossary } from "../core/glossary.ts";
import type { RemoteResult } from "../core/ipc.ts";
import type { ModelId } from "../core/models.ts";
import type { Preferences } from "../core/preferences.ts";
import { checkTuning } from "../core/settings.ts";
import { transcriptPage } from "../core/transcript.ts";
import type { BelugaStatus, Control, GlossaryResult, Options, StartResult } from "./server.ts";

/** a label longer than this is no name for a channel (as in the window) */
const MAX_LABEL = 40;

export interface ControlDeps {
  preferences(): Preferences;
  /** keeps the change and shows it in the window */
  updatePreferences(change: Partial<Preferences>): void;
  phase(): BelugaStatus["phase"];
  /** the running session's transcript, or the last session's */
  transcriptPath(): string | null;
  behind(): number | null;
  installed(model: ModelId): boolean;
  /** the entries a model would not listen for */
  notListenedFor(model: ModelId, entries: string[]): string[];
  /** hands a new glossary to the running session and answers what it does not listen for; null when none runs */
  glossaryToSession(entries: string[]): Promise<string[] | null>;
  /** what the running session does not listen for; null when none runs */
  sessionLeft(): string[] | null;
  /** asks the window to start or stop listening, as if the person had clicked */
  remote(action: "start" | "stop"): Promise<RemoteResult>;
  /** settles when a session that is finishing has finished */
  whenStopped(): Promise<void>;
}

export function createControl(deps: ControlDeps): Control {
  const status = (): BelugaStatus => {
    const p = deps.preferences();
    const entries = parseGlossary(p.glossary);
    const phase = deps.phase();
    return {
      phase,
      transcript: deps.transcriptPath(),
      behindSeconds: phase === "listening" ? deps.behind() : null,
      model: p.model,
      modelInstalled: deps.installed(p.model),
      language: p.language,
      systemAudio: p.withSystem,
      labels: p.labels,
      glossary: {
        entries: entries.length,
        notListenedFor: deps.sessionLeft() ?? deps.notListenedFor(p.model, entries),
      },
      settings: p.settings,
    };
  };

  return {
    status,

    async setGlossary(given, mode): Promise<GlossaryResult> {
      const p = deps.preferences();
      const before = mode === "add" ? parseGlossary(p.glossary) : [];
      const entries = parseGlossary([...before, ...given].join("\n"));
      deps.updatePreferences({ glossary: entries.join("\n") });
      const live = await deps.glossaryToSession(entries);
      return {
        entries: entries.length,
        appliedNow: live !== null,
        notListenedFor: live ?? deps.notListenedFor(p.model, entries),
      };
    },

    async setOptions(options: Options): Promise<BelugaStatus> {
      const p = deps.preferences();
      const labels = { ...p.labels, ...options.labels };
      if (labels.mic.length > MAX_LABEL || labels.system.length > MAX_LABEL) {
        throw new Error(`A channel label has at most ${MAX_LABEL} characters.`);
      }
      deps.updatePreferences({
        ...(options.model ? { model: options.model } : {}),
        ...(options.language ? { language: options.language } : {}),
        ...(options.systemAudio !== undefined ? { withSystem: options.systemAudio } : {}),
        labels,
        settings: {
          tuning: checkTuning({ ...p.settings.tuning, ...options.tuning }),
          mic: { ...p.settings.mic, ...options.mic },
        },
      });
      return status();
    },

    async start(): Promise<StartResult> {
      const phase = deps.phase();
      if (phase !== "idle") throw new Error(`Beluga is not idle but ${phase}.`);
      const { model } = deps.preferences();
      if (!deps.installed(model)) {
        throw new Error(
          `The model ${model} is not downloaded. The person at the computer downloads it in Beluga's window.`,
        );
      }
      const result = await deps.remote("start");
      if (!result.ok) throw new Error(result.message);
      return {
        transcript: deps.transcriptPath() ?? "",
        channels: result.channels,
        notice: result.notice,
        notListenedFor: deps.sessionLeft() ?? [],
      };
    },

    async stop() {
      switch (deps.phase()) {
        case "idle":
          break;
        case "starting":
          throw new Error("Beluga is still starting the session. Try again in a moment.");
        case "stopping":
          await deps.whenStopped();
          break;
        case "listening": {
          const result = await deps.remote("stop");
          if (!result.ok) throw new Error(result.message);
        }
      }
      return { transcript: deps.transcriptPath() };
    },

    async readTranscript(after, limit) {
      const path = deps.transcriptPath();
      if (!path) throw new Error("There is no transcript yet: no session has run since Beluga started.");
      return { transcript: path, ...transcriptPage(await readFile(path, "utf8"), after, limit) };
    },
  };
}
