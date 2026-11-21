/**
 * The transcript Beluga writes: plain text, one line per utterance, appended as
 * the meeting goes. This format is the whole contract with whoever reads along
 * (an assistant working by the collaborative-modeling skill, a person, a script):
 *
 *     # Beluga transcript, started 2026-11-21 14:30
 *     14:32:07 Me: we start with the order process
 *     14:32:15 Others: fine, the trigger is the incoming order
 *
 * A line is never rewritten once it is in the file, so a reader can keep its place
 * by byte offset or line count.
 */

/** the two sources Beluga hears: the machine's microphone and what the machine plays */
export type Channel = "mic" | "system";

export interface Utterance {
  channel: Channel;
  /** when the utterance began, milliseconds since the epoch */
  startedAt: number;
  text: string;
}

/** who is heard on which channel, as the transcript names them */
export type SpeakerLabels = Record<Channel, string>;

export const DEFAULT_LABELS: SpeakerLabels = { mic: "Me", system: "Others" };

const two = (n: number): string => String(n).padStart(2, "0");

/** local wall-clock time, `14:32:07` */
export function clock(at: number): string {
  const d = new Date(at);
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

/** local date and time to the minute, `2026-11-21 14:30` */
export function stamp(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

/**
 * A label as it may stand before the colon of a line: one line, no colon of its
 * own (a reader splits at the first ": "), never empty.
 */
export function cleanLabel(label: string, fallback: string): string {
  const cleaned = label
    .replace(/[\r\n:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || fallback;
}

/** the text of an utterance on one line */
export function cleanText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function headerLine(startedAt: number): string {
  return `# Beluga transcript, started ${stamp(startedAt)}`;
}

/** one transcript line without its newline, or null when the utterance holds no text */
export function formatLine(utterance: Utterance, labels: SpeakerLabels): string | null {
  const text = cleanText(utterance.text);
  if (!text) return null;
  const speaker = cleanLabel(labels[utterance.channel], DEFAULT_LABELS[utterance.channel]);
  return `${clock(utterance.startedAt)} ${speaker}: ${text}`;
}

/**
 * The file name of a session, `beluga-2026-11-21-1430.txt`. One file per session:
 * when a second session starts in the same minute, its `attempt` 2 is
 * `beluga-2026-11-21-1430-2.txt`.
 */
export function fileName(startedAt: number, attempt = 1): string {
  const base = `beluga-${stamp(startedAt).replace(" ", "-").replace(":", "")}`;
  return attempt > 1 ? `${base}-${attempt}.txt` : `${base}.txt`;
}
