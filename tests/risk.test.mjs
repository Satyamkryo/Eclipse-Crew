import assert from "node:assert/strict";
import test from "node:test";

import { ACTION_CLASSES, classLabel, classifyAction, isIrreversible } from "../lib/agent/risk.ts";

const click = (controlName, expect = "") => classifyAction({ intentKind: "click", controlName, expect });

test("both mock-portal layouts classify the invoice action as a download", () => {
  assert.equal(click("Download PDF", "control_present: Apply filter"), "download");
  assert.equal(click("Get invoice", "invoice PDF is saved"), "download");
});

test("send, post, delete, purchase and submit controls are classified by code", () => {
  assert.equal(click("Send report"), "send");
  assert.equal(click("Share with team"), "send");
  assert.equal(click("Invite member"), "send");
  assert.equal(click("Forward email"), "send");
  assert.equal(click("Reply"), "send");
  assert.equal(click("Publish post"), "post");
  assert.equal(click("Add comment"), "post");
  assert.equal(click("Delete invoice"), "delete");
  assert.equal(click("Remove member"), "delete");
  assert.equal(click("Unsubscribe"), "delete");
  assert.equal(click("Buy now"), "purchase");
  assert.equal(click("Checkout"), "purchase");
  assert.equal(click("Place order"), "purchase");
  assert.equal(click("Donate"), "purchase");
  assert.equal(click("Submit"), "submit");
  assert.equal(click("Confirm and pay"), "purchase");
  assert.equal(click("Approve request"), "submit");
  assert.equal(click("Accept terms"), "submit");
  assert.equal(click("Sign contract"), "submit");
  assert.equal(click("Apply filter"), "submit");
});

test("payment wording and punctuated names classify like the plain words", () => {
  assert.equal(click("Payment hand-off"), "purchase");
  assert.equal(click("Place your order"), "purchase");
  assert.equal(click("Check out"), "purchase");
  assert.equal(click("Delete..."), "delete");
  assert.equal(click("Send!"), "send");
  assert.equal(click("Replying"), "none");
});

test("only send, delete, purchase and post count as irreversible", () => {
  for (const risk of ["send", "delete", "purchase", "post"]) assert.equal(isIrreversible(risk), true, risk);
  for (const risk of ["submit", "download", "none"]) assert.equal(isIrreversible(risk), false, risk);
});

test("only clicks are classified; typing, keys and scrolling are none", () => {
  for (const intentKind of ["type", "key", "scroll", "wait", "read_document", "deliver_file"]) {
    assert.equal(classifyAction({ intentKind, controlName: "Download PDF", expect: "invoice downloads" }), "none", intentKind);
  }
});

test("expect text may raise none to a class but never lowers a class the control name implies", () => {
  assert.equal(click("Button", "the invoice is saved"), "download");
  assert.equal(click("Button", "email sent"), "send");
  assert.equal(click("Download PDF", "email sent"), "download");
  assert.equal(click("Delete account", "download the receipt"), "delete");
  assert.equal(click("Take action", "nothing risky"), "none");
});

test("an expected result only raises a class when it describes a finished act, not a page's nouns", () => {
  for (const expect of ["the email inbox opens", "the blog post is shown", "the payment page loads", "comments are visible", "the order history page opens", "search results for share prices", "the sign in page opens", "Apply filter panel visible"]) {
    assert.equal(click("Open link", expect), "none", expect);
  }
  assert.equal(click("OK", "the message was sent"), "send");
  assert.equal(click("OK", "the file was deleted"), "delete");
  assert.equal(click("OK", "your post is published"), "post");
  assert.equal(click("OK", "payment confirmed"), "purchase");
  assert.equal(click("Email"), "send", "a control's own name keeps the full list");
  assert.equal(click("Post"), "post");
});

test("keyword matching uses whole words and stays deterministic", () => {
  assert.equal(click("Display options"), "none");
  assert.equal(click("Repayment plan"), "none");
  assert.equal(click("Download history"), "download");
  for (const actionClass of ACTION_CLASSES) assert.equal(typeof classLabel(actionClass), "string");
  assert.equal(classLabel("none"), "None");
});
