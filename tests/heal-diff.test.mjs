import assert from "node:assert/strict";
import test from "node:test";

import { affectedCount, diffSteps } from "../lib/replay/diff.ts";

const click = (idx, name, expect = "control_present: Apply filter") => ({ idx, action: "click", role: "link", name, expect });

test("a changed control is one removed line and one added line; the rest stays the same", () => {
  const rows = diffSteps([click(1, "Open portal"), click(2, "Download PDF")], [click(1, "Open portal"), click(2, "Get invoice")]);
  assert.deepEqual(rows.map((row) => row.kind), ["same", "removed", "added"]);
  assert.equal(rows[0].newIdx, 1);
  assert.equal(rows[1].text, "Click link “Download PDF”");
  assert.equal(rows[2].text, "Click link “Get invoice”");
  assert.equal(rows[1].expect, "control_present: Apply filter");
  assert.equal(affectedCount(rows), 2);
});

test("a changed expected result is a change; identical steps are all same", () => {
  const changed = diffSteps([click(1, "Open portal", "control_present: A")], [click(1, "Open portal", "url_path: /next")]);
  assert.deepEqual(changed.map((row) => row.kind), ["removed", "added"]);
  assert.equal(changed[1].expect, "url_path: /next");

  const same = diffSteps([click(1, "A"), click(2, "B")], [click(1, "A"), click(2, "B")]);
  assert.deepEqual(same.map((row) => row.kind), ["same", "same"]);
  assert.equal(affectedCount(same), 0);
});
