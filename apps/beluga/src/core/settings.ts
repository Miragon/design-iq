/**
 * What the facilitator may tune under Advanced. The defaults are the measured
 * ones; each choice lists the values the window offers. What an agent sets is
 * checked against the limits, which are a little wider, and what comes back
 * from the stored preferences is read the same way.
 */

export interface Tuning {
  /**
   * How hard Parakeet leans towards a glossary entry, per piece. Measured on
   * German sentences with names and terms, clean and in noise, with up to 1000
   * entries: from 2.5 on it found the most terms. At 3 a name that sounds almost
   * like an everyday word replaced it ("zwei" became "Zweig"), from 4 on
   * entries that were not said at all showed up.
   */
  glossaryWeight: number;
  /** a pause this long ends a line, in seconds: longer gives the model more context, the line comes later */
  pause: number;
  /**
   * The longest line, in seconds: someone who talks this long without a pause is
   * cut here. Whisper drops everything after 30 seconds of one piece, hence the limit.
   */
  longestLine: number;
  /** how sure the detector must be that someone speaks, 0 to 1: lower hears quiet voices, higher ignores more noise */
  speechThreshold: number;
  /** the processor cores the recognizer uses */
  threads: number;
}

export const DEFAULT_TUNING: Tuning = {
  glossaryWeight: 2.5,
  pause: 0.5,
  longestLine: 20,
  speechThreshold: 0.5,
  threads: 4,
};

/** the values the window offers; the threads go from 1 to the machine's cores */
export const TUNING_CHOICES = {
  glossaryWeight: [1, 1.5, 2, 2.5, 3, 3.5, 4],
  pause: [0.3, 0.4, 0.5, 0.6, 0.8, 1, 1.2, 1.5],
  longestLine: [10, 15, 20, 25],
  speechThreshold: [0.3, 0.4, 0.5, 0.6, 0.7],
} as const satisfies Record<Exclude<keyof Tuning, "threads">, readonly number[]>;

/** what an agent may set, and what the stored preferences may hold */
const LIMITS: Record<keyof Tuning, readonly [min: number, max: number]> = {
  glossaryWeight: [0.5, 5],
  pause: [0.2, 2],
  longestLine: [5, 25],
  speechThreshold: [0.1, 0.9],
  threads: [1, 64],
};

const valid = (key: keyof Tuning, value: unknown): value is number => {
  const [min, max] = LIMITS[key];
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= min &&
    value <= max &&
    (key !== "threads" || Number.isInteger(value))
  );
};

const KEYS = Object.keys(DEFAULT_TUNING) as (keyof Tuning)[];

/** the tuning an agent's set_options carries, checked: a value outside its limits is refused, a missing one is the default */
export function checkTuning(value: unknown): Tuning {
  if (value === undefined) return { ...DEFAULT_TUNING };
  if (typeof value !== "object" || value === null) throw new Error("The advanced settings are not readable.");
  const given = value as Record<string, unknown>;
  const tuning = { ...DEFAULT_TUNING };
  for (const key of KEYS) {
    if (given[key] === undefined) continue;
    if (!valid(key, given[key])) throw new Error(`The advanced setting ${key} is out of range.`);
    tuning[key] = given[key];
  }
  return tuning;
}

/** how the window treats the microphone before Beluga hears it (the browser's own processing) */
export interface MicProcessing {
  noiseSuppression: boolean;
  autoGainControl: boolean;
  /** off by default: it is tuned for calls and eats quiet speakers in a room */
  echoCancellation: boolean;
}

export const DEFAULT_MIC: MicProcessing = { noiseSuppression: true, autoGainControl: true, echoCancellation: false };

/** everything under Advanced, as the window keeps it between sessions */
export interface Settings {
  tuning: Tuning;
  mic: MicProcessing;
}

export const DEFAULT_SETTINGS: Settings = { tuning: DEFAULT_TUNING, mic: DEFAULT_MIC };

/**
 * Settings read back from storage: whatever is missing or no longer valid
 * (another version wrote it, someone edited it) is the default again.
 */
export function readSettings(stored: unknown): Settings {
  const given = (typeof stored === "object" && stored !== null ? stored : {}) as Partial<
    Record<keyof Settings, unknown>
  >;
  const tuning = (typeof given.tuning === "object" && given.tuning !== null ? given.tuning : {}) as Record<
    string,
    unknown
  >;
  const mic = (typeof given.mic === "object" && given.mic !== null ? given.mic : {}) as Record<string, unknown>;
  const settings: Settings = { tuning: { ...DEFAULT_TUNING }, mic: { ...DEFAULT_MIC } };
  for (const key of KEYS) if (valid(key, tuning[key])) settings.tuning[key] = tuning[key];
  for (const key of Object.keys(DEFAULT_MIC) as (keyof MicProcessing)[]) {
    if (typeof mic[key] === "boolean") settings.mic[key] = mic[key];
  }
  return settings;
}
