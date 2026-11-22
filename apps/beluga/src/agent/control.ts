/**
 * What an agent's requests do, on top of what the main process offers. No
 * Electron here: the main process passes in its state and its actions.
 */
import { readFile, stat } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

import { parseGlossary } from "../core/glossary.ts";
import type { RemoteResult } from "../core/ipc.ts";
import type { ModelId } from "../core/models.ts";
import { MAX_LABEL, type Preferences } from "../core/preferences.ts";
import { checkTuning } from "../core/settings.ts";
import { transcriptPage } from "../core/transcript.ts";
import type { BelugaStatus, Control, GlossaryResult, Options, StartResult, TranscriptRead } from "./server.ts";

/** how often a waiting read looks whether the transcript has grown */
const WAIT_POLL_MS = 250;

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
        // a session that is starting takes it once it runs
        appliedNow: live !== null || deps.phase() === "starting",
        notListenedFor: live ?? deps.notListenedFor(p.model, entries),
      };
    },

    async setOptions(options: Options): Promise<BelugaStatus> {
      const phase = deps.phase();
      if (phase !== "idle") {
        throw new Error(
          `Beluga is ${phase}, and the options hold for a whole session. They can change once it has stopped; the glossary can change at any time.`,
        );
      }
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

    async readTranscript(given, limit, wait = 0, quiet = 0, of): Promise<TranscriptRead> {
      let path = deps.transcriptPath();
      if (!path) throw new Error("There is no transcript yet: no session has run since Beluga started.");
      // `after` counts in the file the agent read last; a new session's file starts again at line 1
      let after = of !== undefined && of !== path ? 0 : given;
      const deadline = Date.now() + wait * 1000;
      // a read that sees a session stop answers at once; one that finds Beluga stopped waits for the next session
      let running = deps.phase() !== "idle";
      // Beluga appends whole lines, so the file's modification time is when the last one came
      let seen: { mtimeMs: number; size: number } | null = null;
      let page = transcriptPage("", after, limit);
      for (;;) {
        const newest = deps.transcriptPath();
        if (newest && newest !== path) {
          // a new session began while the read waited: its file, from the start
          path = newest;
          after = 0;
          seen = null;
        }
        const file = await stat(path);
        if (!seen || file.mtimeMs !== seen.mtimeMs || file.size !== seen.size) {
          page = transcriptPage(await readFile(path, "utf8"), after, limit);
          seen = file;
        }
        const phase = deps.phase();
        if (phase !== "idle") running = true;
        const at = Date.now();
        const settled = page.lines.length > 0 && (page.more || at - file.mtimeMs >= quiet * 1000);
        const stopped = phase === "idle" && running;
        if (settled || stopped || at >= deadline) return { transcript: path, phase, ...page };
        await sleep(Math.min(WAIT_POLL_MS, deadline - at));
      }
    },
  };
}
