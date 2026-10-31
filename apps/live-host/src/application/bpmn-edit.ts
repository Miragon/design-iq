/**
 * Semantic BPMN editing on LIVE documents (ADR 0009): an agent sends operations
 * or a layout request instead of the whole XML, and @miragon/bpmn-cli — the
 * editing engine — computes the new XML, diagram included. The ordinary content
 * save (validation + CAS + minimal-diff write) stores it. Because the change is
 * semantic, a document that moved on between the read and the write is no
 * reason to give up: the change is applied again to the current text, up to
 * MAX_ATTEMPTS times — unless the caller pinned a baseVersion.
 *
 * Validation runs twice, on purpose: inside the engine's transaction the
 * platform validator (checkModel, the save gate's own check) refuses a change
 * that ADDS an error; the save then gates the whole document like every other
 * save. A dry run asks the save gate too (checkContent), so it never says ok
 * to a save the gate would refuse.
 *
 * Adapter implementations are injected (the content read/write/check of
 * content.ts), never imported — the use-cases only know the engine and the
 * port they are handed.
 */
import type { ContentWire, PutContentResultWire } from "@designiq/contracts/live-host";
import { AppError } from "@designiq/http-kit";
import {
  applyToXml,
  BpmnError,
  type Change,
  type EditOptions,
  type EditResult,
  findXml,
  FORMAT_OP_NAMES,
  type FormatResult,
  KINDS,
  kindsJson,
  layoutXml,
  type MutationSummary,
  mutationSummary,
  type NamedValidator,
  OPS_SCHEMA,
  showXml,
  type ValidatorFinding,
  type Warning,
} from "@miragon/bpmn-cli";
import { checkModel } from "@miragon/design-iq-validator";

import type { PutOutcome, SaveCheck } from "./content.ts";

export type Lint = "block" | "warn";

export interface BpmnEditIo {
  read(path: string): Promise<Pick<ContentWire, "path" | "content" | "baseVersion">>;
  write(path: string, body: { content: string; baseVersion: string; lint?: Lint }): Promise<PutOutcome>;
  /** the save gate's verdict without saving (checkContent) — dry runs and the outline */
  check(path: string, body: { content: string; lint?: Lint }): Promise<SaveCheck>;
  /** the repository's model ids per notation — the link checks of the validator */
  modelIds(): Promise<ReadonlyMap<string, ReadonlySet<string>> | undefined>;
}

/** attempts in all (the first one and the re-applications on a concurrent change) before the tool reports a conflict */
export const MAX_ATTEMPTS = 3;

export interface ChangeOptions {
  /** compute and report, but do not save */
  dryRun?: boolean;
  /** the save gate's mode (lintArg); "warn" also lets the engine pass the validator's errors */
  lint?: Lint;
  /** apply only to this version of the document: a newer one is a conflict, never re-applied */
  baseVersion?: string;
}

/** what a change did — the engine's report, never the XML */
export interface BpmnChangeWire {
  /** `userTask userTask_packGoods "Pack goods" - after Task_fulfill_order`, in the order of creation */
  created: string[];
  /** batch aliases ("as": "$name") → the final id */
  aliases?: Record<string, string>;
  /** `sequenceFlow Flow_to_invoice - Task_fulfill_order -> userTask_packGoods (was -> CallActivity_x)` */
  changed: string[];
  /** ids the change renamed: old → new (a flow whose id, in element-id-naming's form, named its old ends) */
  renamed?: Record<string, string>;
  removed: string[];
  /** findings the change ADDED (`CODE element: message (hint)`); those the document already had are not repeated */
  warnings: string[];
  /** what the engine noted: where a node was spliced in, a re-application */
  notes: string[];
  /** what each format op (place, align, color, label, route, space, tidy, compact, order) did to the drawing */
  format?: string[];
  /** the layout that ran; its score counts layout problems (lower is better) */
  layout: MutationSummary["layout"] & { reason?: string };
}

export type BpmnEditResult =
  | {
      ok: true;
      /** false on a dry run and when the change left the text as it was */
      written: boolean;
      /** the change left the document byte for byte as it was (nothing to save) */
      unchanged?: true;
      attempts: number;
      path: string;
      /** the document's token after the save (the one the change was computed on, when nothing was written) */
      baseVersion: string;
      change: BpmnChangeWire;
      /** the save's findings for the whole document (save_bpmn_xml's warnings / errors) */
      save?: Pick<PutContentResultWire, "warnings" | "errors">;
      /** a dry run */
      dryRun?: true;
      /** a dry run: whether the save gate would take the result */
      wouldSave?: boolean;
      /** a dry run the save gate would refuse: why */
      refused?: string;
    }
  | { ok: false; conflict: true; attempts: number; message: string };

/** the tool a change comes from — the refusal tells each how to go on */
type Tool = "edit" | "layout";

/** One read → compute → CAS write cycle, repeated on a conflict. */
async function changeLive(
  io: BpmnEditIo,
  path: string,
  tool: Tool,
  compute: (xml: string, engine: EditOptions) => Promise<EditResult>,
  options: ChangeOptions,
): Promise<BpmnEditResult> {
  const modelIds = await io.modelIds();
  let current = await io.read(path);
  if (options.baseVersion !== undefined && options.baseVersion !== current.baseVersion) {
    return conflict(1, "the document changed since your baseVersion; read it again and send operations for it");
  }
  for (let attempt = 1; ; attempt++) {
    let edit: EditResult;
    try {
      edit = await engine(() => compute(current.content, engineOptions(current, modelIds, options)));
    } catch (e) {
      // the ops fitted the document the caller read; a co-editor's change made them fail
      if (attempt > 1 && e instanceof AppError && e.status < 500) {
        return conflict(
          attempt,
          "the document changed while this call ran and your operations no longer apply to it; read it again " +
            `(get_process_outline) and send operations for the current version. The engine said: ${e.message}`,
        );
      }
      throw e;
    }
    const change = changeOf(edit);
    if (attempt > 1) {
      change.notes.push(
        `applied to a newer version of the document (attempt ${attempt}): someone changed it while this call ran`,
      );
    }
    const base = { ok: true as const, attempts: attempt, path: current.path, change };
    // nothing to save: no verdict to report, like the save itself would not run
    if (edit.unchanged) {
      return {
        ...base,
        written: false,
        unchanged: true,
        baseVersion: current.baseVersion,
        ...(options.dryRun ? { dryRun: true as const } : {}),
      };
    }
    if (options.dryRun) {
      const verdict = await io.check(current.path, { content: edit.xml, lint: options.lint });
      return {
        ...base,
        written: false,
        baseVersion: current.baseVersion,
        dryRun: true,
        wouldSave: verdict.ok,
        ...(verdict.ok
          ? { save: { warnings: verdict.warnings, ...(verdict.errors ? { errors: verdict.errors } : {}) } }
          : { refused: refusal(tool, verdict.code, verdict.message, edit) }),
      };
    }
    let out: PutOutcome;
    try {
      out = await io.write(current.path, {
        content: edit.xml,
        baseVersion: current.baseVersion,
        lint: options.lint,
      });
    } catch (e) {
      if (e instanceof AppError && e.code === "content/invalid-model") {
        // computed on a co-editor's newer version: its errors are not the caller's to repair
        if (attempt > 1) {
          return conflict(
            attempt,
            "the document changed while this call ran, and the save gate refuses the newer version with your " +
              "operations applied; read it again (get_process_outline) before you go on. The save gate said: " +
              e.message,
          );
        }
        throw new AppError("bpmn-edit/invalid-model", refusal(tool, e.code, e.message, edit), {
          status: 422,
          expose: true,
        });
      }
      throw e;
    }
    if (out.ok) {
      const { warnings, errors } = out.result;
      return {
        ...base,
        written: true,
        baseVersion: out.result.baseVersion,
        save: { warnings, ...(errors ? { errors } : {}) },
      };
    }
    if (options.baseVersion !== undefined || attempt >= MAX_ATTEMPTS) {
      return conflict(
        attempt,
        options.baseVersion !== undefined
          ? "the document changed since your baseVersion; read it again and send operations for it"
          : `the document kept changing during ${MAX_ATTEMPTS} attempts; send the same request again`,
      );
    }
    current = { path: out.conflict.path, content: out.conflict.currentContent, baseVersion: out.conflict.baseVersion };
  }
}

const conflict = (attempts: number, message: string): BpmnEditResult => ({
  ok: false,
  conflict: true,
  attempts,
  message,
});

/**
 * The engine's options for one attempt. The platform follows the document:
 * a model no process of which is executable is a design model whatever
 * platform the modeler declared, so no engine profile (the Camunda 7 / 8
 * warnings) is reported, and a decision link keeps the file's spelling: a
 * task's own camunda:decisionRef or zeebe:calledDecision is updated in place,
 * a new link takes the engine spelling all the file's other links share, else
 * it is the unprefixed calledDecision. The engine has no copy of the save
 * gate: design-iq's validator is the only check of design-iq's rules inside it.
 */
function engineOptions(
  current: { path: string; content: string },
  modelIds: ReadonlyMap<string, ReadonlySet<string>> | undefined,
  options: ChangeOptions,
): EditOptions {
  return {
    file: current.path,
    platform: /\bisExecutable\s*=\s*["']true["']/.test(current.content) ? "auto" : "none",
    validators: [designIqValidator(current.path, modelIds, options.lint ?? "block")],
  };
}

/** `ops`: bpmn-cli's batch (an array of {op, …}); checked by the engine */
export function editProcess(
  io: BpmnEditIo,
  path: string,
  ops: unknown,
  options: ChangeOptions = {},
): Promise<BpmnEditResult> {
  return changeLive(
    io,
    path,
    "edit",
    (xml, engineOpts) => engine(() => applyToXml(xml, ops, engineOpts), ops),
    options,
  );
}

export type LayoutMode = "tidy" | "redraw";

export interface LayoutRequest {
  /** tidy: keep the drawing, remove overlaps and gaps; redraw: draw the whole diagram anew */
  mode: LayoutMode;
  /** redraw: sub-processes to draw expanded */
  expand?: string[];
  /** redraw: sub-processes to draw collapsed */
  collapse?: string[];
}

export function layoutProcess(
  io: BpmnEditIo,
  path: string,
  request: LayoutRequest,
  options: ChangeOptions = {},
): Promise<BpmnEditResult> {
  if (request.mode === "tidy" && (request.expand?.length || request.collapse?.length)) {
    throw usage("`expand` and `collapse` redraw the diagram: use them with mode 'redraw'");
  }
  return changeLive(
    io,
    path,
    "layout",
    (xml, engineOpts) =>
      layoutXml(xml, {
        ...engineOpts,
        ...(request.mode === "tidy" ? { tidy: true } : {}),
        ...(request.expand?.length ? { expand: request.expand } : {}),
        ...(request.collapse?.length ? { collapse: request.collapse } : {}),
      }),
    options,
  );
}

export interface OutlineRequest {
  /** only the neighbourhood of this element */
  around?: string;
  /** with `around`: flow steps from it (default 2) */
  depth?: number;
  /** one element in its context: where it sits, its lane, before / after, what catches it */
  element?: string;
  /** only this process, pool or sub-process */
  scope?: string;
  /** the elements whose id, name, annotation text or vendor value contains this text */
  find?: string;
}

export interface OutlineWire {
  path: string;
  baseVersion: string;
  /** bpmn-cli's `show` text (or one line per hit of `find`): ids, kinds, names, lanes, links, flows */
  outline: string;
  /**
   * the save gate on the document as it is: its findings (an edit is saved
   * only when there are no errors, lint "block"), or why it refuses any save
   */
  saveGate?: { errors?: string[]; warnings: string[] } | { refused: string };
}

/** the model as text (bpmn-cli's `show`, or `find`): no XML, no geometry */
export async function outlineProcess(io: BpmnEditIo, path: string, request: OutlineRequest): Promise<OutlineWire> {
  const views = (["around", "element", "scope", "find"] as const).filter((k) => request[k] !== undefined);
  if (views.length > 1) throw usage(`\`${views.join("` and `")}\` exclude each other: pick one view`);
  if (request.depth !== undefined && request.around === undefined) throw usage("`depth` goes only with `around`");
  const current = await io.read(path);
  const outline =
    request.find !== undefined
      ? findLines(await engine(() => findXml(current.content, request.find!)), request.find)
      : await engine(() =>
          showXml(current.content, {
            ...(request.element !== undefined ? { id: request.element, context: true } : {}),
            ...(request.around !== undefined ? { around: request.around } : {}),
            ...(request.depth !== undefined ? { depth: request.depth } : {}),
            ...(request.scope !== undefined ? { scope: request.scope } : {}),
          }),
        );
  const gate = await io.check(current.path, { content: current.content, lint: "warn" });
  const saveGate = !gate.ok
    ? { refused: gate.message }
    : gate.errors?.length || gate.warnings.length
      ? { ...(gate.errors?.length ? { errors: gate.errors } : {}), warnings: gate.warnings }
      : undefined;
  return { path: current.path, baseVersion: current.baseVersion, outline, ...(saveGate ? { saveGate } : {}) };
}

/** `userTask Task_check "Check order" (in order-to-cash)` per hit */
function findLines(hits: Awaited<ReturnType<typeof findXml>>, text: string): string {
  if (hits.length === 0) return `no element's id, name, text or vendor value contains "${text}"`;
  return hits
    .map(
      (h) =>
        `${h.kind} ${h.id}${h.name ? ` "${h.name}"` : ""}${h.scope ? ` (in ${h.scope})` : ""}` +
        (h.match ? ` [${h.match}]` : ""),
    )
    .join("\n");
}

// ── the platform validator inside the engine's transaction ───────────────────

/**
 * A counted finding after the change is the one before when its count stayed,
 * or shrank without reaching the expected one: 3 start events to 2 is the same
 * problem, to 0 (no start at all) or to 4 a new one.
 */
const sameProblem = (count: number, before: number | undefined): boolean =>
  before !== undefined && (count === before || (count > 1 && count < before));

/** design-iq messages that carry a count: the count changes while the problem stays the same one */
const COUNTED = [
  /^(expected exactly one start event in .+, found )(\d+)$/,
  /^(.+ has )(\d+)( start events)$/,
  /^()(\d+)( activities — .*)$/,
];

/**
 * design-iq's checkModel as a bpmn-cli validator: the engine runs it on the
 * document before and after the change, and refuses errors the change ADDS
 * (lint "block"; with "warn" its errors are only reported, like the save does).
 * A design-iq finding names no element, so the engine tells an old finding from
 * a new one by its message — and a counted message ("found 3" start events)
 * keeps its identity while its count does not grow: improving 3 to 2 adds no
 * error, 3 to 4 does.
 */
export function designIqValidator(
  path: string,
  modelIds: ReadonlyMap<string, ReadonlySet<string>> | undefined,
  lint: Lint = "block",
): NamedValidator {
  const before = new Map<string, number>();
  return {
    name: "design-iq",
    detail: "the save gate of designIQ",
    validate: (xml, ctx): ValidatorFinding[] => {
      if (ctx.phase === "before") before.clear();
      return (checkModel(xml, { path, notation: "bpmn", ...(modelIds ? { modelIds } : {}) }) ?? []).map((f) => {
        const finding: ValidatorFinding = {
          severity: lint === "warn" ? "WARN" : f.severity,
          ruleId: f.ruleId,
          message: f.message,
        };
        for (const re of COUNTED) {
          const m = re.exec(f.message);
          if (!m) continue;
          const key = `${f.ruleId}:${m[1]}#${m[3] ?? ""}`;
          const count = Number(m[2]);
          if (ctx.phase === "before") {
            before.set(key, count);
            finding.key = key;
          } else if (sameProblem(count, before.get(key))) {
            finding.key = key;
          }
          break;
        }
        return finding;
      });
    },
  };
}

// ── results and errors ────────────────────────────────────────────────────────

/** `userTask Task_x "Name" - detail` */
const changeLine = (c: Change): string =>
  `${c.kind} ${c.id}${c.name ? ` "${c.name}"` : ""}${c.detail ? ` - ${toolWords(c.detail)}` : ""}`;

const warningLine = (w: Warning & { validator?: string }): string =>
  `${w.validator ? `[${w.validator}] ` : ""}${w.code}${w.element ? ` ${w.element}` : ""}: ${toolWords(w.message)}` +
  (w.hint ? ` (${toolWords(w.hint)})` : "");

function changeOf(edit: EditResult): BpmnChangeWire {
  const r = edit.result;
  const { aliases, renamed, layout } = mutationSummary(r);
  const created = new Set(r.created.map((c) => c.id));
  return {
    created: r.created.map(changeLine),
    ...(aliases ? { aliases } : {}),
    // an element the batch created is listed once, as created
    changed: r.changed.filter((c) => !created.has(c.id)).map(changeLine),
    ...(renamed ? { renamed } : {}),
    removed: r.removed.map(changeLine),
    warnings: r.warnings.added.map(warningLine),
    notes: r.notes.map(toolWords),
    ...(r.layout.format?.length ? { format: r.layout.format.map(formatLine) } : {}),
    layout: { ...layout, ...(r.layout.reason ? { reason: r.layout.reason } : {}) },
  };
}

/** `tidy #2: moved Task_a, Task_b; rerouted Flow_x` — or what the op noted when it did nothing */
function formatLine(f: FormatResult): string {
  const parts = (
    [
      ["moved", f.moved],
      ["rerouted", f.rerouted],
      ["reshaped", f.reshaped],
      ["colored", f.colored],
      ["labels placed", f.labels],
    ] as const
  ).flatMap(([what, ids]) => (ids?.length ? [`${what} ${ids.join(", ")}`] : []));
  const notes = (f.notes ?? []).map(toolWords);
  return `${f.op} #${f.index}: ${[...parts, ...notes].join("; ") || "nothing to do"}`;
}

/**
 * Why the save gate refuses the result. With lint "block" it refuses a model
 * with ANY error; the engine already refused errors the change would add, so
 * what is left was in the document before — say so, and how to go on.
 */
function refusal(tool: Tool, code: string, message: string, edit: EditResult): string {
  if (code !== "content/invalid-model") return message;
  const old = (edit.result.validation.validators ?? []).flatMap((v) => v.preexisting);
  const listed =
    old.length > 0
      ? "the save gate refuses a model with errors (lint 'block'), and the document had these before your change " +
        `(${tool === "edit" ? "your operations added none" : "the layout added none"}):\n` +
        old.map((f) => `- [${f.code}] ${f.message}`).join("\n")
      : message;
  const repair =
    tool === "edit"
      ? "Repair them in the same call (add the operations that fix them)"
      : "Repair them first (edit_process)";
  return `${listed}\n${repair}, or pass lint 'warn' if the user wants to save the model with its errors.`;
}

/** runs the engine; its BpmnError becomes an AppError with an agent-readable message */
async function engine<T>(run: () => Promise<T>, ops?: unknown): Promise<T> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof BpmnError) throw engineError(e, ops);
    throw e;
  }
}

const STATUS: Record<BpmnError["category"], number> = { usage: 400, model: 422, layout: 422, io: 422, internal: 500 };

/** the remedy of a refusal the CLI answers with --force, which the tools do not have */
const REMEDY: Record<string, string> = {
  E_IMPORT_LOSSY:
    "the engine would lose the listed content of this document; its XML needs that fixed first (save_bpmn_xml)",
  E_PARSE: "the engine cannot read this document as BPMN; its XML needs a fix first (save_bpmn_xml)",
  E_WOULD_DROP_CONTENT:
    "the engine does not delete content as a side effect: remove or move the listed elements first (in the same call)",
};

/**
 * `E_NOT_FOUND in ops[1] (Task_Aa): No element with id "Task_Aa" (did you mean: Task_A?)`
 * plus the engine's details: the candidates, a room-making op, the errors a
 * change would add, the hint — in tool words (toolWords).
 */
export function engineError(e: BpmnError, ops?: unknown): AppError {
  const d = e.details;
  const where = [d.op !== undefined ? `in ops[${d.op}]` : "", d.element ? `(${d.element})` : ""].filter(Boolean);
  const lines = [`${e.code}${where.length > 0 ? ` ${where.join(" ")}` : ""}: ${toolWords(e.message)}`];
  const errors =
    e.code === "E_VALIDATION" && Array.isArray(d.errors) ? (d.errors as (Warning & { validator?: string })[]) : [];
  for (const f of errors) lines.push(`- ${warningLine({ ...f, hint: undefined })}`);
  // what a lossy import would drop
  if (e.code === "E_IMPORT_LOSSY" && Array.isArray(d.warnings))
    for (const w of d.warnings) lines.push(`- ${String(w)}`);
  // a message that asks "did you mean" names them already
  if (d.candidates?.length && !/did you mean/i.test(e.message)) lines.push(`candidates: ${d.candidates.join(", ")}`);
  if (d.ops !== undefined) lines.push(`send this op first, in the same call: ${JSON.stringify(d.ops)}`);
  const remedy =
    e.code === "E_VALIDATION"
      ? "complete the change in the same call (a boundary event together with the path after it, a gateway with its " +
        "branches)" +
        (errors.some((f) => f.validator === "design-iq")
          ? ", or pass lint 'warn' if the user wants to save the model with these errors"
          : "")
      : [diagramOpAdvice(e, ops), REMEDY[e.code] ?? (d.hint ? toolWords(d.hint) : undefined)].filter(Boolean).join(" ");
  if (remedy) lines.push(`hint: ${remedy}`);
  return new AppError(`bpmn-edit/${kebab(e.code)}`, lines.join("\n"), { status: STATUS[e.category], expose: true });
}

/**
 * Since bpmn-cli 0.9 a diagram-only op runs where it stands in the batch, so it
 * cannot name what a later op adds. Said only when a later op can add an
 * element at all, and as a condition: a typo, or an id an earlier op removed or
 * renamed, would otherwise be sent looking for an op that does not exist.
 */
function diagramOpAdvice(e: BpmnError, ops: unknown): string | undefined {
  const index = e.details.op;
  if (e.code !== "E_NOT_FOUND" || !Array.isArray(ops) || index === undefined) return undefined;
  const name = opName(ops[index]);
  if (!name || !(FORMAT_OP_NAMES as readonly string[]).includes(name)) return undefined;
  if (!ops.slice(index + 1).some((op) => ADDING_OPS.has(opName(op) ?? ""))) return undefined;
  return (
    `${name} is a diagram-only op and sees only what the ops before it made: if a later op adds ` +
    `${e.details.element ?? "the element"}, put ${name} after that op.`
  );
}

const opName = (op: unknown): string | undefined => {
  const name = (op as { op?: unknown } | null | undefined)?.op;
  return typeof name === "string" ? name : undefined;
};

/** E_NOT_FOUND → not-found (the house AppError codes are `<area>/<kebab>`) */
const kebab = (code: string): string =>
  code
    .replace(/^[EW]_/, "")
    .toLowerCase()
    .replaceAll("_", "-");

const usage = (message: string): AppError =>
  new AppError("bpmn-edit/usage", `E_USAGE: ${message}`, { status: 400, expose: true });

/**
 * The engine's texts are written for its CLI; its reading and checking commands
 * have tools of their own here. An op command (`bpmn move <file> X --lane L`)
 * stays: edit_process's description maps a flag onto its op key.
 */
const CLI_WORDS: ReadonlyArray<readonly [RegExp, string]> = [
  [/`bpmn show\b[^`]*` or `bpmn find\b[^`]*`/g, "get_process_outline (or its `find`)"],
  [/`bpmn find\b[^`]*`/g, "get_process_outline with `find`"],
  [/`bpmn show\b[^`]*--layout[^`]*`/g, "the diagram part of get_bpmn_xml"],
  [/`bpmn show\b[^`]*`/g, "get_process_outline"],
  [/`bpmn kinds\b[^`]*`/g, "the kinds in edit_process's description"],
  [/`bpmn validate\b[^`]*`/g, "validate_bpmn"],
  [/`bpmn apply\b[^`]*`/g, "one edit_process call"],
  [/`bpmn layout\b[^`]*--tidy[^`]*`/g, "layout_process with mode 'tidy'"],
  [/`bpmn layout\b[^`]*`/g, "layout_process with mode 'redraw'"],
  [/`bpmn new\b[^`]*`/g, "create_process"],
  [/`bpmn (?:metrics|render)\b[^`]*`/g, "the layout part of an edit_process result"],
  [/,? or (?:pass |use )?--force\b[^.;)]*/g, ""],
];

export function toolWords(text: string): string {
  return CLI_WORDS.reduce((t, [re, words]) => t.replace(re, words), text);
}

// ── tool copy derived from the engine (it follows the engine's version) ──────

interface OpDef {
  properties?: Record<string, unknown>;
  required?: string[];
}

const DEFS = OPS_SCHEMA.$defs as Record<string, OpDef>;

/** the ops of bpmn-cli's batch, in the schema's order */
export const OP_NAMES = (DEFS.op as unknown as { oneOf: { $ref: string }[] }).oneOf.map((r) =>
  r.$ref.split("/").at(-1)!,
) as [string, ...string[]];

/** the ops that can add an element: they take an `as` alias or the id of a flow they make */
const ADDING_OPS = new Set(
  OP_NAMES.filter((name) => DEFS[name]?.properties?.as !== undefined || DEFS[name]?.properties?.flowId !== undefined),
);

/** `add      kind* name id as …` — one line per semantic op, `*` = required; the format ops on one line */
export function opsTable(): string {
  const format = new Set<string>(FORMAT_OP_NAMES);
  const width = Math.max(...OP_NAMES.map((n) => n.length));
  const keys = (name: string) => {
    const def = DEFS[name] ?? {};
    return Object.keys(def.properties ?? {})
      .filter((k) => k !== "op")
      .map((k) => (def.required?.includes(k) ? `${k}*` : k))
      .join(" ");
  };
  const semantic = OP_NAMES.filter((n) => !format.has(n)).map((n) => `${n.padEnd(width)}  ${keys(n)}`);
  const drawing = OP_NAMES.filter((n) => format.has(n)).map((n) => `${n} (${keys(n)})`);
  return [...semantic, `diagram only: ${drawing.join("; ")}`].join("\n");
}

/** `task, userTask, …` — the element kinds an op names */
export function kindsList(): string {
  return KINDS.map((k) => k.kind).join(", ");
}

/** `message (message), timer (timer, timerKind), …, terminate` — the event triggers with their op keys */
export function triggersList(): string {
  const triggers = kindsJson().triggers as Record<string, { keys?: string[] }>;
  return Object.entries(triggers)
    .filter(([name]) => name !== "none")
    .map(([name, t]) => (t.keys?.length ? `${name} (${t.keys.join(", ")})` : name))
    .join(", ");
}
