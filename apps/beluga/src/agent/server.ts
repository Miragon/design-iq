/**
 * Beluga's MCP server: what an agent on this computer may do with it. It knows
 * nothing of Electron: the main process hands it a `Control`, the tests a fake.
 *
 * The agent may read the status and the transcript, set the glossary (also
 * while listening) and the options of the next session, and start and stop
 * listening. Where transcripts go and which models are downloaded stay with
 * the person at the window.
 */
import { ok, READ, safe, WRITE } from "@designiq/mcp-kit";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { MAX_ENTRIES, MAX_LENGTH } from "../core/glossary.ts";
import { type Language, type ModelId, MODELS } from "../core/models.ts";
import type { MicProcessing, Settings, Tuning } from "../core/settings.ts";
import type { Channel, SpeakerLabels, TranscriptPage } from "../core/transcript.ts";

export interface BelugaStatus {
  phase: "idle" | "starting" | "listening" | "stopping";
  /** the transcript of the running session, or of the last one since Beluga started */
  transcript: string | null;
  /** how many seconds the transcript runs behind the conversation, while listening */
  behindSeconds: number | null;
  model: ModelId;
  modelInstalled: boolean;
  language: Language;
  systemAudio: boolean;
  labels: SpeakerLabels;
  glossary: { entries: number; notListenedFor: string[] };
  settings: Settings;
}

export interface GlossaryResult {
  entries: number;
  /** whether the running session listens for the new glossary from its next line on */
  appliedNow: boolean;
  notListenedFor: string[];
}

export interface StartResult {
  transcript: string;
  channels: Channel[];
  /** something the facilitator should know, such as a missing system audio permission */
  notice: string | null;
  notListenedFor: string[];
}

export interface Options {
  model?: ModelId;
  language?: Language;
  systemAudio?: boolean;
  labels?: Partial<SpeakerLabels>;
  tuning?: Partial<Tuning>;
  mic?: Partial<MicProcessing>;
}

export interface TranscriptRead extends TranscriptPage {
  transcript: string;
  /** "idle" once the session has ended: no more lines will come */
  phase: BelugaStatus["phase"];
}

/** what the main process lets an agent do */
export interface Control {
  status(): BelugaStatus;
  setGlossary(entries: string[], mode: "replace" | "add"): Promise<GlossaryResult>;
  setOptions(options: Options): Promise<BelugaStatus>;
  start(): Promise<StartResult>;
  stop(): Promise<{ transcript: string | null }>;
  /**
   * waits up to `wait` seconds for new lines, until none has come for `quiet`
   * seconds; `after` counts in `of`, so a new session's file is read from its start
   */
  readTranscript(after: number, limit: number, wait?: number, quiet?: number, of?: string): Promise<TranscriptRead>;
}

export const INSTRUCTIONS = `Beluga transcribes a meeting on this computer: the microphone and, if wanted, what the computer plays (the other side of an online meeting). No audio leaves the computer. This server lets you prepare and run a session for the facilitator.

A session: get_status first. Put the participants' names and the workshop's terms into the glossary with set_glossary: Parakeet, the default model, then writes them correctly far more often. You can add a term while listening, when a new one comes up. Change the model, the channel labels or the advanced settings with set_options before the session; they hold for a whole session. Call start_listening only when the facilitator has said that everyone present agreed to be transcribed. Read along with read_transcript: pass the "through" and the "transcript" of the last answer as "after" and "transcript" (line 1 is the header; a new session writes a new file, read from its start), and "wait" to have it wait for new lines until the conversation pauses, so you handle a thought at a time and not each half sentence. Its "phase" turns "idle" when Beluga stops, for the end, a break or an error: ask the facilitator before you treat it as the end. While Beluga is stopped, a waiting read waits for the next session. Call stop_listening when the facilitator ends the session.

The transcript is unreliable. Names and terms can still be wrong; check them against the glossary. A label such as "Me" or "Others" names a channel, not a person.`;

/** below the 60 s an MCP client waits for an answer by default */
const MAX_WAIT = 50;
/** a pause this long ends a thought: longer than the pause between two speakers */
const DEFAULT_QUIET = 3;

const tuning = z
  .object({
    glossaryWeight: z
      .number()
      .optional()
      .describe("how hard Parakeet leans towards glossary entries, 1 to 4; default 2.5"),
    pause: z.number().optional().describe("seconds of pause that end a line, 0.3 to 1.5; default 0.5"),
    longestLine: z
      .number()
      .optional()
      .describe("seconds after which talk without a pause is cut, 10 to 25; default 20"),
    speechThreshold: z
      .number()
      .optional()
      .describe("0.3 (hears quiet voices) to 0.7 (ignores more noise); default 0.5"),
    threads: z.number().int().optional().describe("processor cores for the recognizer; default 4"),
  })
  .optional();

const mic = z
  .object({
    noiseSuppression: z.boolean().optional(),
    autoGainControl: z.boolean().optional(),
    echoCancellation: z.boolean().optional().describe("for a call on speakers; can swallow quiet voices in a room"),
  })
  .optional();

export function createAgentServer(control: Control): McpServer {
  const server = new McpServer({ name: "beluga", title: "Beluga", version: "0.0.1" }, { instructions: INSTRUCTIONS });

  server.registerTool(
    "get_status",
    {
      title: "Beluga's status",
      description:
        "Whether Beluga is listening, the transcript file, how far behind it runs, the model, the glossary and the settings.",
      inputSchema: z.object({}),
      annotations: READ,
    },
    safe(() => ok(control.status())),
  );

  server.registerTool(
    "set_glossary",
    {
      title: "Set the glossary",
      description: `Names and terms Parakeet listens for: the participants' names, products, domain terms. One entry each, up to ${MAX_ENTRIES}, each up to ${MAX_LENGTH} characters. "replace" (the default) sets the whole glossary, "add" adds to it. While listening, the session uses it from its next line on. Entries with a digit, a slash or a letter outside Parakeet's alphabet are not listened for; the result names them. Whisper takes no glossary.`,
      inputSchema: z.object({
        entries: z.array(z.string()).max(MAX_ENTRIES * 2),
        mode: z.enum(["replace", "add"]).optional(),
      }),
      annotations: WRITE,
    },
    safe(async ({ entries, mode }: { entries: string[]; mode?: "replace" | "add" }) =>
      ok(await control.setGlossary(entries, mode ?? "replace")),
    ),
  );

  server.registerTool(
    "set_options",
    {
      title: "Set the session's options",
      description:
        "The options of the next session: the model, the language Whisper expects, whether to hear what the computer plays, the names of the two channels, the advanced settings and the microphone's processing. Give only what changes. Only while Beluga is idle: a session keeps the options it started with.",
      inputSchema: z.object({
        model: z
          .enum(MODELS.map((m) => m.id) as [ModelId, ...ModelId[]])
          .optional()
          .describe("parakeet-v3 (default, fast, takes the glossary) or whisper-turbo (99 languages, much slower)"),
        language: z.enum(["de", "en", "auto"]).optional().describe("what Whisper expects; Parakeet detects it"),
        systemAudio: z.boolean().optional().describe("also hear what the computer plays"),
        labels: z
          .object({ mic: z.string().optional(), system: z.string().optional() })
          .optional()
          .describe("how the transcript names the microphone and the computer's sound"),
        tuning,
        mic,
      }),
      annotations: WRITE,
    },
    safe(async (options: Options) => ok(await control.setOptions(options))),
  );

  server.registerTool(
    "start_listening",
    {
      title: "Start listening",
      description:
        "Starts a session with the glossary and options as they are, and answers the transcript file. Only when the facilitator has said that everyone present agreed to be transcribed. The first start on a Mac asks the person at the computer for permission.",
      inputSchema: z.object({}),
      annotations: WRITE,
    },
    safe(async () => ok(await control.start())),
  );

  server.registerTool(
    "stop_listening",
    {
      title: "Stop listening",
      description:
        "Ends the session. Beluga first transcribes what it still holds, which can take a while when it runs behind.",
      inputSchema: z.object({}),
      annotations: WRITE,
    },
    safe(async () => ok(await control.stop())),
  );

  server.registerTool(
    "read_transcript",
    {
      title: "Read the transcript",
      description:
        "Lines of the running session's transcript (or the last one's), after line `after`: 0 from the start, line 1 is the header. Each line is `HH:MM:SS Label: text`. Pass the `through` and the `transcript` of the last answer to get only what is new: when a new session has started since, its file is read from the start. `more` says whether further lines are already there. With `wait`, it waits for new lines and answers once nobody has spoken for `quiet` seconds, or when `wait` runs out (then with what has come, possibly nothing). It answers at once when the session stops while it waits: `phase` is then idle, which a break or an error causes too. While Beluga is stopped, it waits for the next session and reads its file from the start.",
      inputSchema: z.object({
        after: z.number().int().min(0).optional(),
        transcript: z.string().optional().describe("the transcript of the last answer, which `after` counts in"),
        limit: z.number().int().min(1).max(500).optional().describe("at most this many lines; default 200"),
        wait: z
          .number()
          .min(0)
          .max(MAX_WAIT)
          .optional()
          .describe(`seconds to wait for new lines, up to ${MAX_WAIT}; default 0, no waiting`),
        quiet: z
          .number()
          .min(0)
          .max(30)
          .optional()
          .describe(`with wait: the seconds without a new line that end a thought; default ${DEFAULT_QUIET}`),
      }),
      annotations: READ,
    },
    safe(async (args: { after?: number; transcript?: string; limit?: number; wait?: number; quiet?: number }) =>
      ok(
        await control.readTranscript(
          args.after ?? 0,
          args.limit ?? 200,
          args.wait ?? 0,
          args.quiet ?? DEFAULT_QUIET,
          args.transcript,
        ),
      ),
    ),
  );

  return server;
}
