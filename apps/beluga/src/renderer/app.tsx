import { Badge } from "@designiq/ui-kit/components/badge";
import { Button, focusRing } from "@designiq/ui-kit/components/button";
import { Input } from "@designiq/ui-kit/components/input";
import { cn } from "@designiq/ui-kit/lib/utils";
import { CircleAlert, Download, FolderOpen, Mic, MonitorSpeaker, Square } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";

import type { DownloadProgress, InitialState, WrittenLine } from "../core/ipc.ts";
import type { Language, ModelId } from "../core/models.ts";
import type { Channel, SpeakerLabels } from "../core/transcript.ts";
import { type Capture, startCapture } from "./capture.ts";

type Phase = "idle" | "starting" | "listening" | "stopping";

/** seconds of silence on a channel before Beluga says so */
const QUIET_AFTER = 15;
/** the lines kept on screen; the file holds them all */
const SHOWN = 200;
/** seconds the transcript may run behind before Beluga says so */
const BEHIND_AFTER = 5;

/** a line on screen, with a key that stays with it while older lines drop off */
type ShownLine = WrittenLine & { id: number };

const selectClass = cn(
  "border-input bg-background h-9 rounded-md border px-3 text-sm disabled:cursor-not-allowed disabled:opacity-50",
  focusRing,
);

/** the message itself: Electron puts its own words in front of an error from the main process */
const reason = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).replace(
    /^Error invoking remote method '[^']+': (Error: )?/,
    "",
  );

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5 text-sm">
      <span className="font-medium">{label}</span>
      {children}
    </label>
  );
}

function Meter({ icon, name, level, quiet }: { icon: ReactNode; name: string; level: number; quiet: boolean }) {
  return (
    <div className="flex items-center gap-3 text-sm">
      <span className="text-muted-foreground flex w-28 shrink-0 items-center gap-2 truncate">
        {icon}
        {name}
      </span>
      <div
        className="bg-muted h-2 flex-1 overflow-hidden rounded-sm"
        role="meter"
        aria-label={`${name} level`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(level * 100)}
      >
        <div className="bg-brand h-full transition-[width] duration-100" style={{ width: `${level * 100}%` }} />
      </div>
      <span className="w-20 shrink-0 text-right text-xs">
        {quiet ? <Badge variant="warning">No sound</Badge> : null}
      </span>
    </div>
  );
}

export function App() {
  const [state, setState] = useState<InitialState | null>(null);
  const [model, setModel] = useState<ModelId>("parakeet-v3");
  const [language, setLanguage] = useState<Language>("de");
  const [labels, setLabels] = useState<SpeakerLabels>({ mic: "Me", system: "Others" });
  const [folder, setFolder] = useState("");
  const [withSystem, setWithSystem] = useState(true);
  const [phase, setPhase] = useState<Phase>("idle");
  const [file, setFile] = useState<string | null>(null);
  const [lines, setLines] = useState<ShownLine[]>([]);
  const [levels, setLevels] = useState<Record<Channel, number>>({ mic: 0, system: 0 });
  const [quiet, setQuiet] = useState<Record<Channel, boolean>>({ mic: false, system: false });
  const [heard, setHeard] = useState<Channel[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [download, setDownload] = useState<DownloadProgress | null>(null);
  const [behind, setBehind] = useState(0);

  const capture = useRef<Capture | null>(null);
  const lastSound = useRef<Record<Channel, number>>({ mic: 0, system: 0 });
  const transcript = useRef<HTMLOListElement>(null);
  /** whether the transcript follows the newest line: not while the reader has scrolled up */
  const following = useRef(true);
  const nextLine = useRef(0);
  /** the main process ended the session, perhaps while this page was still starting it */
  const ended = useRef(false);

  useEffect(() => {
    void window.beluga.init().then((initial) => {
      setState(initial);
      setModel(initial.model);
      setLabels(initial.labels);
      setFolder(initial.folder);
    });
    const offLine = window.beluga.onLine((line) => {
      const id = nextLine.current++;
      setLines((all) => [...all, { ...line, id }].slice(-SHOWN));
    });
    const offDownload = window.beluga.onDownload(setDownload);
    const offLag = window.beluga.onLag(setBehind);
    // the main process ended the session: the engine failed or the file cannot be written
    const offEnded = window.beluga.onSessionEnded((message) => {
      ended.current = true;
      setError(message);
      void capture.current?.stop();
      capture.current = null;
      setLevels({ mic: 0, system: 0 });
      setPhase("idle");
    });
    // the app is quitting: the main process finishes the session, the window stops listening
    const offFinishing = window.beluga.onFinishing(() => {
      void capture.current?.stop();
      capture.current = null;
      setLevels({ mic: 0, system: 0 });
      setPhase("stopping");
    });
    return () => {
      offLine();
      offDownload();
      offLag();
      offEnded();
      offFinishing();
    };
  }, []);

  // keep the newest line in view, unless the reader has scrolled back
  useEffect(() => {
    const list = transcript.current;
    if (list && following.current) list.scrollTop = list.scrollHeight;
  }, [lines]);

  // a channel that stays silent is the one failure macOS does not report
  useEffect(() => {
    if (phase !== "listening") return;
    const timer = setInterval(() => {
      const now = Date.now();
      setQuiet({
        mic: now - lastSound.current.mic > QUIET_AFTER * 1000,
        system: now - lastSound.current.system > QUIET_AFTER * 1000,
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [phase]);

  const selected = state?.models.find((m) => m.id === model);
  const busy = phase === "starting" || phase === "stopping" || download !== null;
  const running = phase === "listening" || phase === "stopping";

  async function install(): Promise<void> {
    setError(null);
    setDownload({ model, fraction: 0 });
    try {
      await window.beluga.installModel(model);
      setState(await window.beluga.init());
    } catch (e) {
      setError(`The model could not be installed. ${reason(e)}`);
    } finally {
      setDownload(null);
    }
  }

  async function start(): Promise<void> {
    setError(null);
    setNotice(null);
    setLines([]);
    setBehind(0);
    following.current = true;
    ended.current = false;
    setPhase("starting");
    let opened: Capture | null = null;
    try {
      // the model first, then the devices: what is said while the model loads would be lost
      const path = await window.beluga.start({ model, language, labels, folder });
      setFile(path);
      const now = Date.now();
      lastSound.current = { mic: now, system: now };
      setQuiet({ mic: false, system: false });
      opened = await startCapture(withSystem, {
        onAudio: (channel, samples, at) => window.beluga.audio(channel, samples, at),
        onLevel: (channel, value) => {
          if (value > 0.05) lastSound.current[channel] = Date.now();
          setLevels((all) => ({ ...all, [channel]: value }));
        },
        onEnded: (channel) =>
          setNotice(channel === "mic" ? "The microphone stopped delivering audio." : "The system audio stopped."),
      });
      // the session may have ended in the main process while the devices opened
      if (ended.current) {
        void opened.stop();
        return;
      }
      capture.current = opened;
      setHeard(opened.channels);
      if (opened.systemProblem) setNotice(`Listening to the microphone only. ${opened.systemProblem}`);
      setPhase("listening");
    } catch (e) {
      void opened?.stop();
      capture.current = null;
      // a session that heard nothing leaves no file behind
      await window.beluga.stop().catch(() => undefined);
      setFile(null);
      setLevels({ mic: 0, system: 0 });
      setError(reason(e));
      setPhase("idle");
    }
  }

  async function stop(): Promise<void> {
    setPhase("stopping");
    await capture.current?.stop();
    capture.current = null;
    try {
      await window.beluga.stop();
    } catch (e) {
      setError(reason(e));
    }
    setLevels({ mic: 0, system: 0 });
    setBehind(0);
    setPhase("idle");
  }

  if (!state) return null;

  return (
    <main className="bg-background text-foreground flex h-full flex-col gap-5 overflow-y-auto p-5">
      <header className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Beluga</h1>
        {running ? (
          <Badge variant="outline" className="gap-2">
            <span className="bg-success size-2 rounded-full" aria-hidden />
            Listening
          </Badge>
        ) : null}
      </header>

      {/* the settings are fixed while listening: their room goes to the transcript */}
      <section className={cn("flex flex-col gap-4", running && "hidden")} aria-label="Settings">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Microphone is">
            <Input
              value={labels.mic}
              disabled={running || busy}
              onChange={(e) => setLabels({ ...labels, mic: e.target.value })}
            />
          </Field>
          <Field label="System audio is">
            <Input
              value={labels.system}
              disabled={running || busy || !withSystem}
              onChange={(e) => setLabels({ ...labels, system: e.target.value })}
            />
          </Field>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className={cn("accent-primary size-4 rounded-sm", focusRing)}
            checked={withSystem}
            disabled={running || busy}
            onChange={(e) => setWithSystem(e.target.checked)}
          />
          Also listen to what this computer plays (the others in an online meeting)
        </label>
        <div className="grid grid-cols-[1fr_auto] gap-3">
          <Field label="Speech model">
            <select
              className={selectClass}
              value={model}
              disabled={running || busy}
              onChange={(e) => setModel(e.target.value as ModelId)}
            >
              {state.models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Language">
            <select
              className={selectClass}
              value={language}
              disabled={running || busy || model !== "whisper-turbo"}
              title={model === "whisper-turbo" ? undefined : "Parakeet detects the language itself"}
              onChange={(e) => setLanguage(e.target.value as Language)}
            >
              <option value="de">German</option>
              <option value="en">English</option>
              <option value="auto">Detect</option>
            </select>
          </Field>
        </div>
        {selected ? <p className="text-muted-foreground -mt-2 text-xs">{selected.note}</p> : null}
        <Field label="Transcripts go to">
          <div className="flex gap-2">
            <Input value={folder} readOnly className="font-mono text-xs" />
            <Button
              variant="outline"
              size="icon"
              aria-label="Choose folder"
              disabled={running || busy}
              onClick={() => void window.beluga.chooseFolder(folder).then((chosen) => chosen && setFolder(chosen))}
            >
              <FolderOpen />
            </Button>
          </div>
        </Field>
      </section>

      {selected && !selected.installed ? (
        <Button onClick={() => void install()} disabled={busy}>
          <Download />
          {download
            ? `Downloading… ${Math.round(download.fraction * 100)} %`
            : `Download ${selected.label} (${selected.megabytes} MB)`}
        </Button>
      ) : running ? (
        <Button variant="outline" onClick={() => void stop()} disabled={phase === "stopping"}>
          <Square />
          {phase === "stopping"
            ? behind > 1
              ? `Transcribing the last ${behind} seconds…`
              : "Finishing the last sentence…"
            : "Stop"}
        </Button>
      ) : (
        <Button onClick={() => void start()} disabled={busy}>
          <Mic />
          {phase === "starting" ? "Loading the model…" : "Start listening"}
        </Button>
      )}

      {error ? (
        <p className="bg-destructive-soft flex gap-2 rounded-md p-3 text-sm" role="alert">
          <CircleAlert className="text-destructive mt-0.5 size-4 shrink-0" />
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="bg-warning-soft rounded-md p-3 text-sm" role="status">
          {notice}
        </p>
      ) : null}
      {phase === "listening" && behind >= BEHIND_AFTER ? (
        <p className="bg-warning-soft rounded-md p-3 text-sm" role="status">
          The transcript runs {behind} seconds behind the conversation.
          {model === "whisper-turbo" ? " Parakeet keeps up more easily." : " It catches up in the pauses."}
        </p>
      ) : null}

      {running ? (
        <section className="flex flex-col gap-2" aria-label="Levels">
          <Meter icon={<Mic className="size-4" />} name={labels.mic || "Me"} level={levels.mic} quiet={quiet.mic} />
          {heard.includes("system") ? (
            <Meter
              icon={<MonitorSpeaker className="size-4" />}
              name={labels.system || "Others"}
              level={levels.system}
              quiet={quiet.system}
            />
          ) : null}
        </section>
      ) : null}

      <section className="flex min-h-48 flex-1 flex-col gap-2" aria-label="Transcript">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">Transcript</h2>
          {file ? (
            <Button variant="link" size="sm" className="h-auto p-0" onClick={() => window.beluga.showFile(file)}>
              Show file
            </Button>
          ) : null}
        </div>
        <ol
          ref={transcript}
          onScroll={(e) => {
            const list = e.currentTarget;
            following.current = list.scrollHeight - list.scrollTop - list.clientHeight < 24;
          }}
          className="border-border min-h-0 flex-1 overflow-y-auto rounded-md border p-3 font-mono text-xs leading-relaxed"
        >
          {lines.length === 0 ? (
            <li className="text-muted-foreground font-sans text-sm">
              {running
                ? "Nothing said yet. A sentence appears here when the speaker pauses."
                : "Start listening and the transcript appears here, and in a text file an assistant can read along."}
            </li>
          ) : (
            lines.map((entry) => (
              <li key={entry.id} className={entry.channel === "system" ? "text-muted-foreground" : undefined}>
                {entry.line}
              </li>
            ))
          )}
        </ol>
        {file ? <p className="text-muted-foreground truncate font-mono text-xs">{file}</p> : null}
      </section>
    </main>
  );
}
