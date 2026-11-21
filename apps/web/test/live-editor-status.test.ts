/**
 * The live editor's connection state (src/components/live-editor.tsx): the
 * hint that a room is slow to sync never stands over a refusal. A room the
 * host refused (access, or a board it cannot open without losing content) or
 * closed before it synced is Offline, next to the banner that says why, and
 * stays so after the 10 s hint, which has nothing left to wait for.
 *
 * The shell needs Monaco and a socket, so the hint's state update is read
 * from its source and run here.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

type Status = "connecting" | "slow" | "live" | "error";

const source = readFileSync(fileURLToPath(new URL("../src/components/live-editor.tsx", import.meta.url)), "utf8");

/** the 10 s hint's update of the status, as a function of the status it finds */
function slowHint(): (now: Status) => Status {
  const timer = /const slow = setTimeout\(\(\) => \{([\s\S]*?)\}, 10_000\);/.exec(source);
  assert.ok(timer?.[1], "live-editor.tsx sets the slow hint with a 10 s timer");
  const update = /setStatus\(([\s\S]*)\);\s*$/.exec(timer[1].trim());
  assert.ok(update?.[1], "the timer sets the status");
  const argument = update[1].trim();
  // a plain value replaces whatever the status is by then
  if (/^["']/.test(argument)) return () => JSON.parse(argument.replaceAll("'", '"')) as Status;
  // an updater: plain JavaScript as written (no types in it)
  return new Function(`return ${argument};`)() as (now: Status) => Status;
}

test("the slow hint shows while the room still connects, and never over a refusal or a close", () => {
  const hint = slowHint();
  assert.equal(hint("connecting"), "slow");
  assert.equal(hint("error"), "error", "Offline stays, next to the banner that says why");
});
