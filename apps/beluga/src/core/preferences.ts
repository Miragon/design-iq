/**
 * What Beluga keeps between sessions: the choices in the window, the glossary,
 * the advanced settings and whether an agent may control it. The main process
 * owns them (the window and an agent both change them) and keeps them in a file
 * in the app's data folder, on this computer.
 */
import { DEFAULT_MODEL, type Language, type ModelId, MODELS } from "./models.ts";
import { DEFAULT_SETTINGS, readSettings, type Settings } from "./settings.ts";
import { DEFAULT_LABELS, type SpeakerLabels } from "./transcript.ts";

export interface Preferences {
  model: ModelId;
  /** what Whisper is told to expect */
  language: Language;
  labels: SpeakerLabels;
  /** whether a session also hears what the computer plays */
  withSystem: boolean;
  /** where transcripts go */
  folder: string;
  /** the glossary as typed: one entry per line */
  glossary: string;
  settings: Settings;
  /** whether an agent may control Beluga over MCP */
  agent: boolean;
}

/** a label longer than this is no name for a channel */
export const MAX_LABEL = 40;
/** the glossary text: room for 1000 entries of 60 characters */
export const MAX_GLOSSARY_TEXT = 100_000;
const LANGUAGES: readonly Language[] = ["de", "en", "auto"];

export const defaultPreferences = (folder: string): Preferences => ({
  model: DEFAULT_MODEL,
  language: "de",
  labels: { ...DEFAULT_LABELS },
  withSystem: true,
  folder,
  glossary: "",
  settings: DEFAULT_SETTINGS,
  agent: false,
});

const isLabel = (value: unknown): value is string => typeof value === "string" && value.length <= MAX_LABEL;

/** a part of the preferences, checked: what does not fit is left out */
export function checkPreferences(value: unknown): Partial<Preferences> {
  if (typeof value !== "object" || value === null) return {};
  const given = value as Record<string, unknown>;
  const out: Partial<Preferences> = {};
  if (MODELS.some((m) => m.id === given.model)) out.model = given.model as ModelId;
  if (LANGUAGES.includes(given.language as Language)) out.language = given.language as Language;
  const labels = given.labels as Record<string, unknown> | undefined;
  if (typeof labels === "object" && labels !== null && isLabel(labels.mic) && isLabel(labels.system)) {
    out.labels = { mic: labels.mic, system: labels.system };
  }
  if (typeof given.withSystem === "boolean") out.withSystem = given.withSystem;
  if (typeof given.folder === "string" && given.folder.length > 0) out.folder = given.folder;
  if (typeof given.glossary === "string" && given.glossary.length <= MAX_GLOSSARY_TEXT) out.glossary = given.glossary;
  if (given.settings !== undefined) out.settings = readSettings(given.settings);
  if (typeof given.agent === "boolean") out.agent = given.agent;
  return out;
}

/** the preferences read back from their file: whatever is missing or broken is the default */
export function readPreferences(stored: unknown, folder: string): Preferences {
  return { ...defaultPreferences(folder), ...checkPreferences(stored) };
}
