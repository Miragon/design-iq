/**
 * The engine in a process of its own (an Electron utility process). Loading a
 * model blocks for seconds and transcribing an utterance for up to several:
 * here they hold up nothing but the next piece of audio, which waits in a queue.
 * Transcribing runs on a worker thread, so this process stays free to say every
 * second how far it has come. Silence from it means it hangs.
 */
import type { EngineReply, EngineRequest } from "../core/ipc.ts";
import { type Engine, SherpaEngine } from "../engine/sherpa.ts";

const PROGRESS_EVERY_MS = 1000;

const port = process.parentPort;
const reply = (message: EngineReply): void => port.postMessage(message);
const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error));

let engine: Engine | null = null;
/** when the newest piece the engine is through with was captured */
let through: number | null = null;
/** the requests in the order they came: the engine takes one at a time */
let queue: Promise<void> = Promise.resolve();

async function handle(request: EngineRequest): Promise<void> {
  switch (request.type) {
    case "start":
      engine = new SherpaEngine(
        { modelsDir: request.modelsDir, model: request.model, language: request.language },
        (utterance) => reply({ type: "utterance", ...utterance }),
      );
      through = null;
      reply({ type: "ready" });
      break;
    case "audio":
      await engine?.push(request.channel, request.samples, request.at);
      through = request.at;
      break;
    case "stop":
      await engine?.flush();
      engine = null;
      reply({ type: "stopped" });
      break;
  }
}

port.on("message", (event) => {
  const request = event.data as EngineRequest;
  queue = queue.then(() => handle(request)).catch((error: unknown) => reply({ type: "error", message: reason(error) }));
});

setInterval(() => {
  if (engine) reply({ type: "progress", at: through });
}, PROGRESS_EVERY_MS);
