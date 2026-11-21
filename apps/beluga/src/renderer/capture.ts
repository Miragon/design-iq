/**
 * Capturing the two channels in the page: the microphone, and the sound the
 * machine plays (the other side of an online meeting). Both are brought to
 * 16 kHz mono by the audio context and handed on in pieces of 100 ms.
 */
import type { Channel } from "../core/transcript.ts";
import type { Piece } from "./capture-worklet.ts";
import workletUrl from "./capture-worklet.ts?worker&url";

const SAMPLE_RATE = 16000;

export interface CaptureHandlers {
  /** a piece of audio and the time its last sample was captured */
  onAudio(channel: Channel, samples: Float32Array, at: number): void;
  /** the loudness of the last piece, 0 (silence) to 1 (full scale) */
  onLevel(channel: Channel, level: number): void;
  /** a channel stopped delivering: a device was unplugged, a permission is missing */
  onEnded(channel: Channel): void;
}

export interface Capture {
  /** the channels that are really being heard */
  channels: Channel[];
  /** why the system audio is not among them, when it was asked for */
  systemProblem: string | null;
  stop(): Promise<void>;
}

const isMac = navigator.userAgent.includes("Mac OS");

/** loudness on a scale a meter can show: -60 dB and below is 0, full scale is 1 */
function level(samples: Float32Array): number {
  let sum = 0;
  for (const s of samples) sum += s * s;
  const rms = Math.sqrt(sum / samples.length);
  if (rms <= 0) return 0;
  return Math.min(1, Math.max(0, (20 * Math.log10(rms) + 60) / 60));
}

/** the browser's words for a refused or busy device, as a sentence that says what to do */
function explain(error: unknown, device: "microphone" | "system audio"): Error {
  const name = error instanceof DOMException ? error.name : "";
  const where = isMac
    ? device === "microphone"
      ? "System Settings, Privacy & Security, Microphone"
      : "System Settings, Privacy & Security, Screen & System Audio Recording (on macOS 14: Screen Recording)"
    : "the system's privacy settings";
  if (name === "NotAllowedError") return new Error(`Beluga may not use the ${device}. Allow it in ${where}.`);
  if (name === "NotReadableError") return new Error(`The ${device} is in use or not available. Check ${where}.`);
  if (name === "NotFoundError") return new Error(`No ${device} was found.`);
  return error instanceof Error ? error : new Error(String(error));
}

async function systemStream(): Promise<MediaStream> {
  // the main process answers this request with the loopback audio. A video
  // track is part of the API, not of Beluga: it is stopped before a frame is read
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
  } catch (error) {
    throw explain(error, "system audio");
  }
  for (const track of stream.getVideoTracks()) {
    track.stop();
    stream.removeTrack(track);
  }
  const audio = stream.getAudioTracks()[0];
  // without the permission macOS raises no error: the track arrives already ended
  if (!audio || audio.readyState === "ended") {
    for (const track of stream.getTracks()) track.stop();
    throw new Error(
      isMac
        ? "The system delivered no audio. Check System Settings, Privacy & Security, Screen & System Audio Recording (on macOS 14: Screen Recording)."
        : "The system delivered no audio.",
    );
  }
  return stream;
}

export async function startCapture(withSystem: boolean, handlers: CaptureHandlers): Promise<Capture> {
  let mic: MediaStream;
  try {
    // echo cancellation off: it is tuned for calls and eats quiet speakers in a room
    mic = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: false, noiseSuppression: true, autoGainControl: true },
    });
  } catch (error) {
    throw explain(error, "microphone");
  }
  const streams: Partial<Record<Channel, MediaStream>> = { mic };
  const release = (): void => {
    for (const stream of Object.values(streams)) for (const track of stream.getTracks()) track.stop();
  };
  let systemProblem: string | null = null;
  let context: AudioContext | null = null;
  try {
    if (withSystem) {
      try {
        streams.system = await systemStream();
      } catch (error) {
        systemProblem = error instanceof Error ? error.message : String(error);
      }
    }

    context = new AudioContext({ sampleRate: SAMPLE_RATE });
    await context.audioWorklet.addModule(workletUrl);
    const channels = (Object.keys(streams) as Channel[]).filter((c) => streams[c]);
    for (const channel of channels) {
      const stream = streams[channel] as MediaStream;
      // one input channel: Web Audio mixes a stereo source down, so a voice on
      // the right only is heard too
      const node = new AudioWorkletNode(context, "beluga-capture", {
        numberOfInputs: 1,
        numberOfOutputs: 0,
        channelCount: 1,
        channelCountMode: "explicit",
        channelInterpretation: "speakers",
      });
      node.port.onmessage = (event: MessageEvent<Piece>) => {
        handlers.onLevel(channel, level(event.data.samples));
        handlers.onAudio(channel, event.data.samples, event.data.at);
      };
      context.createMediaStreamSource(stream).connect(node);
      stream.getAudioTracks()[0]?.addEventListener("ended", () => handlers.onEnded(channel));
    }

    const running = context;
    return {
      channels,
      systemProblem,
      async stop() {
        release();
        await running.close();
      },
    };
  } catch (error) {
    // nothing stays open when a later step fails: no microphone light left on
    release();
    void context?.close();
    throw error;
  }
}
