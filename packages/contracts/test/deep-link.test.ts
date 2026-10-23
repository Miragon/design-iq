/**
 * Pins the web-app deep-link URL shapes — three surfaces build them (issue
 * bodies, open_modeler results, the widget button), so a drift here is a
 * broken link on all of them. The expectations mirror the pre-extraction
 * behaviour pinned in apps/live-host/test/todo-issues.test.ts.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { fileDeepLink, modelDeepLink, processDeepLink, repoDeepLink } from "../src/deep-link.ts";

test("processDeepLink: /r/<owner>/<repo>/p/<id>, trailing slash stripped, segments encoded", () => {
  assert.equal(
    processDeepLink("https://design.example/", "acme/bpm-processes", "order-to-cash"),
    "https://design.example/r/acme/bpm-processes/p/order-to-cash",
  );
  // ?element= rides encoded; ids may carry spaces (imported models)
  assert.equal(
    processDeepLink("https://design.example", "acme/bpm-processes", "order-to-cash", "Gateway 1"),
    "https://design.example/r/acme/bpm-processes/p/order-to-cash?element=Gateway%201",
  );
});

test("processDeepLink: the repo splits at the FIRST slash (GitLab subgroups stay in the repo segment)", () => {
  assert.equal(
    processDeepLink("https://design.example", "group/sub/name", "order-to-cash"),
    "https://design.example/r/group/sub%2Fname/p/order-to-cash",
  );
});

test("fileDeepLink: /r/<owner>/<repo>/f/<path> — slashes keep separating the splat segments", () => {
  assert.equal(
    fileDeepLink("https://design.example", "acme/bpm-processes", "processes/rabatt.dmn"),
    "https://design.example/r/acme/bpm-processes/f/processes/rabatt.dmn",
  );
  // a segment with reserved characters is encoded WITHIN its segment
  assert.equal(
    fileDeepLink("https://design.example", "acme/bpm-processes", "processes/preis rabatt.dmn"),
    "https://design.example/r/acme/bpm-processes/f/processes/preis%20rabatt.dmn",
  );
});

test("fileDeepLink: an element rides along as ?element=, encoded like the process route's", () => {
  assert.equal(
    fileDeepLink("https://design.example", "acme/x", "maps/tea shop.owm", "component tea"),
    "https://design.example/r/acme/x/f/maps/tea%20shop.owm?element=component%20tea",
  );
});

test("modelDeepLink: a process opens on its process route, any other model on the file route", () => {
  const base = "https://design.example";
  assert.equal(
    modelDeepLink(base, "acme/x", { notation: "bpmn", id: "order", file: "processes/sub/order.bpmn" }, "Task_1"),
    "https://design.example/r/acme/x/p/order?element=Task_1",
  );
  assert.equal(
    modelDeepLink(base, "acme/x", { notation: "event-storming", id: "checkout", file: "boards/checkout.storm" }, "e1"),
    "https://design.example/r/acme/x/f/boards/checkout.storm?element=e1",
  );
  assert.equal(
    modelDeepLink(base, "acme/x", { notation: "wardley", id: "tea", file: null }),
    "https://design.example/r/acme/x",
    "no file to open: the repository overview",
  );
});

test("repoDeepLink: /r/<owner>/<repo> — the same base the editor routes extend", () => {
  assert.equal(
    repoDeepLink("https://design.example/", "acme/bpm-processes"),
    "https://design.example/r/acme/bpm-processes",
  );
  assert.equal(repoDeepLink("https://design.example", "group/sub/name"), "https://design.example/r/group/sub%2Fname");
});
