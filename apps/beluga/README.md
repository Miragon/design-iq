# Beluga

A small desktop app that listens to a meeting on your machine and writes down what is said.
It hears the microphone and, if you want, the sound your computer plays (the other side of
an online meeting), transcribes both locally and appends the transcript line by line to a
text file. An assistant reads that file along, for example one working by the
`collaborative-modeling` skill.

No audio leaves the machine and no meeting bot joins the call. Nothing in the platform
depends on Beluga: designIQ takes a transcript from any source.

Status: prototype. The pipeline is tested on Linux with a simulated microphone
(`pnpm test:e2e`). Capture on a real Mac or Windows machine has not been tried yet, and
the computer's sound on macOS is the part most likely to need work (see below).

## The transcript

```
# Beluga transcript, started 2026-11-21 14:30
14:32:07 Me: we start with the order process
14:32:15 Others: fine, the trigger is the incoming order
```

One line per utterance: local time, speaker, text. A line is written when the speaker
pauses and is never changed afterwards. The speaker is the channel, not the person: the
microphone is one name, the computer's sound another. Both names are yours to set. Who of
several people in a room said something, Beluga does not know.

The file goes to `Documents/Beluga` unless you choose another folder, one file per session
(`beluga-2026-11-21-1430.txt`; a second session in the same minute gets `-2`).

## Run it

```
pnpm install
pnpm --filter @designiq/beluga dev
```

The first start of Electron downloads its binary. In the app, download a speech model once
(Parakeet v3, about 670 MB), then start listening. The model files come from the
sherpa-onnx model repositories on Hugging Face at a fixed revision, the pause detector from
a sherpa-onnx release. Each file is checked against its SHA-256, and a download that breaks
off resumes with the files still missing. They are kept in the app's data folder (on
macOS `~/Library/Application Support/Beluga/models`).

On macOS the sound of the computer needs a packaged app: the permission for system audio
recording belongs to the app that asks, and an app started from a terminal has no entry for
it. Build one and start that:

```
pnpm --filter @designiq/beluga run package
open apps/beluga/release/mac-arm64/Beluga.app
```

macOS 14.2 or newer. The build is signed ad hoc, for your own machine only. The first start
asks for the microphone, the first session with the computer's sound for system audio
recording (System Settings, Privacy & Security, Screen & System Audio Recording; on
macOS 14 the pane is called Screen Recording). Beluga
offers its own window as the video track the browser API insists on, so it should not ask
to record the screen. This has not been tried on a Mac yet.

After a rebuild macOS may still hold the old permissions: reset them with
`tccutil reset Microphone de.miragon.designiq.beluga` and
`tccutil reset AudioCapture de.miragon.designiq.beluga`. A build copied to another Mac is
refused as damaged; it needs a Developer ID signature, or on a test machine
`xattr -dr com.apple.quarantine Beluga.app`.

## Things to know

- **Use headphones in an online meeting.** Without them the microphone hears the others
  from the speakers, and their sentences appear twice.
- **"No sound" next to a meter** means the channel has been silent for 15 seconds. For the
  computer's sound that is how a missing permission shows: macOS raises no error, it
  delivers silence.
- **A sentence appears when it is finished**, after a pause of half a second. Someone who
  talks for 20 seconds without one is cut there, mid-word if need be, and goes on in the
  next line.
- **Models**: Parakeet v3 is the default, fast and good in 25 European languages. Whisper
  large-v3-turbo knows more languages, is a download of about 1 GB and is about ten times
  slower on a CPU: with both channels busy it falls behind. Beluga says when the transcript
  runs more than 5 seconds behind, and Stop, closing the window and quitting all wait until
  the engine has caught up. Both run
  through [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx); neither takes a glossary
  here, so names and technical terms are corrected by whoever reads the transcript.
- **The times are the times the words were heard**, also after the laptop slept during a
  break. A line is written when its utterance ends, so a long statement on one channel
  can follow a shorter, later one on the other.

## Layout

| Path            | What it is                                                                                                                                                   |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/core/`     | The transcript format, the model list, the message types. No Electron, no engine.                                                                            |
| `src/engine/`   | The speech engine: pause detection, recognition, the clock of the samples. Only `sherpa.ts` knows sherpa-onnx; `files.ts` checks a model on disk without it. |
| `src/main/`     | Electron main process: window, permissions, model download, the transcript file. The engine runs in a process of its own (`engine-host.ts`).                 |
| `src/preload/`  | The bridge into the page, `window.beluga`.                                                                                                                   |
| `src/renderer/` | The window: capture of both channels, level meters, the running transcript.                                                                                  |

Another speech runtime (whisper.cpp, a hosted service) is another class with the `Engine`
interface of `src/engine/sherpa.ts`.

## Tests

```
pnpm --filter @designiq/beluga test                      # format and clock; the engine tests are skipped without models
BELUGA_MODELS_DIR=<models> pnpm --filter @designiq/beluga test       # plus the engine on a German recording
BELUGA_MODELS_DIR=<models> pnpm --filter @designiq/beluga test:e2e   # the whole app with a simulated microphone
```

`<models>` is a folder that holds the Parakeet model and `silero_vad.onnx`, for example the
app's own models folder after a download in the app (the download brings the German
sample the tests play). `test:e2e` needs a display (`xvfb-run -a` on a headless machine)
and runs the app with Chromium's sandbox on.

A new version of `sherpa-onnx-node` or `electron` is taken by hand: CI runs neither the
engine nor the app, so run both tests against the models and check
`src/engine/sherpa-onnx-node.d.ts` against the package's `types.js`.
