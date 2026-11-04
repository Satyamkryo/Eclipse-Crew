// TASK-025 / TASK-084: lists the visible, clickable controls of the focused page with exact screen positions.
// Scanner A: every Playwright frame plus every open shadow root, each frame's offset added, occluded controls dropped.
// The page is untrusted: everything read here is data, size-limited, and re-validated by controller-schema.mjs.
export const MAX_ELEMENTS = 150;
export const SCREEN = { width: 1024, height: 768 };
export const MAX_SHADOW_DEPTH = 10;
export const CANDIDATE_CAP = 600;
const MAX_FRAMES = 64;
export const PAYMENT_PATTERN = /stripe|braintree|adyen|checkout|payment|card/i;
// Screen points the worker may park the pointer on to measure where the page sits on the screen.
const CALIBRATION_POINTS = [{ x: 512, y: 400 }, { x: 700, y: 520 }, { x: 330, y: 300 }];
const CALIBRATION_WAIT_MS = 600;

// Runs inside the page (serialised by Playwright), so it must not use anything outside its own body.
// `calibrate` is installed first and awaited after the pointer moved, so no page global is created.
export function installCalibration(waitMs) {
  const result = new Promise((resolve) => {
    const finish = (value) => { removeEventListener("mousemove", onMove, true); clearTimeout(timer); resolve(value); };
    const onMove = (event) => finish({ screenX: event.screenX, screenY: event.screenY, clientX: event.clientX, clientY: event.clientY,
      ratio: window.devicePixelRatio, scale: window.visualViewport ? window.visualViewport.scale : 1 });
    const timer = setTimeout(() => finish(null), waitMs);
    addEventListener("mousemove", onMove, true);
  });
  return { result };
}

// The original top-frame scanner is kept for the shadow/frame spike harness (scripts/spikes/shadow-frame/probe.mjs), which
// uses it as its baseline column. Production snapshots use scanDomFrame per frame below.
export function scanPage(args) {
  const { originX, originY, screenWidth, screenHeight, limit } = args;
  const clean = (value, max) => String(value ?? "").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
  const attribute = (element, name) => element.getAttribute(name) ?? "";
  const INTERACTIVE_ROLES = new Set(["button", "link", "checkbox", "radio", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "option",
    "switch", "textbox", "searchbox", "combobox", "slider", "spinbutton", "treeitem"]);
  const SENSITIVE_WORDS = /password|passwd|passcode|(?:^|[\s_-])(?:otp|totp)(?:$|[\s_-])|one[-_ ]?time|verification[-_ ]?code|security[-_ ]?code/i;
  const SENSITIVE_AUTOCOMPLETE = ["one-time-code", "current-password", "new-password"];
  const BUTTON_INPUTS = new Set(["button", "submit", "reset", "image"]);

  const roleOf = (element) => {
    const tag = element.tagName.toLowerCase();
    const explicit = attribute(element, "role").trim().split(/\s+/)[0].toLowerCase();
    if (INTERACTIVE_ROLES.has(explicit)) return explicit;
    if (tag === "a") return "link";
    if (tag === "button" || tag === "summary") return "button";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "input") {
      const type = (element.type || "text").toLowerCase();
      if (BUTTON_INPUTS.has(type)) return "button";
      if (type === "checkbox" || type === "radio") return type;
      if (type === "range") return "slider";
      if (type === "number") return "spinbutton";
      if (type === "search") return "searchbox";
      return "textbox";
    }
    if (element.isContentEditable) return "textbox";
    return "control";
  };
  const labelledText = (element) => {
    const ids = attribute(element, "aria-labelledby").split(/\s+/).filter(Boolean).slice(0, 5);
    return ids.map((id) => document.getElementById(id)).filter(Boolean).map((node) => clean(node.textContent, 160)).join(" ");
  };
  const nameOf = (element) => {
    const tag = element.tagName.toLowerCase();
    const type = tag === "input" ? (element.type || "text").toLowerCase() : "";
    const labels = element.labels ? Array.from(element.labels).slice(0, 3).map((label) => clean(label.textContent, 160)).join(" ") : "";
    const text = ["input", "select", "textarea"].includes(tag) ? "" : clean(element.innerText || element.textContent, 160);
    const alt = tag === "img" ? "" : Array.from(element.querySelectorAll("img[alt]")).slice(0, 3).map((image) => clean(image.alt, 80)).join(" ");
    const own = type === "image" ? attribute(element, "alt") : "";
    const buttonValue = BUTTON_INPUTS.has(type) ? attribute(element, "value") : "";
    return clean(attribute(element, "aria-label") || labelledText(element) || labels || text || alt || own || attribute(element, "title") ||
      attribute(element, "placeholder") || buttonValue || (type === "submit" ? "Submit" : ""), 80);
  };
  // Same idea as the worker's focus check: a field for secrets or one-time codes is never offered by name or position.
  const sensitive = (element, name) => {
    const type = String(element.type ?? "").toLowerCase();
    // Only fields that take typed text; a link or button named "Forgot password?" is fine to offer.
    const takesText = element.isContentEditable || ["textarea", "select"].includes(element.tagName.toLowerCase()) ||
      element.tagName.toLowerCase() === "input" && !["button", "submit", "reset", "image", "checkbox", "radio", "range", "file", "color"].includes(type);
    if (!takesText) return false;
    const autocomplete = attribute(element, "autocomplete").toLowerCase().split(/\s+/);
    const semantics = [attribute(element, "name"), attribute(element, "id"), attribute(element, "aria-label"), attribute(element, "placeholder"), name].join(" ");
    const numericCode = attribute(element, "inputmode").toLowerCase() === "numeric" && element.maxLength >= 4 && element.maxLength <= 8;
    return type === "password" || autocomplete.some((value) => SENSITIVE_AUTOCOMPLETE.includes(value)) || SENSITIVE_WORDS.test(semantics) || numericCode;
  };

  // Visible part of the page that is also on the screen, in viewport coordinates.
  const minX = Math.max(0, -originX), minY = Math.max(0, -originY);
  const maxX = Math.min(window.innerWidth, screenWidth - originX), maxY = Math.min(window.innerHeight, screenHeight - originY);
  const selector = "a[href],button,input,select,textarea,summary,[role],[tabindex],[contenteditable]";
  const candidates = [];
  for (const element of document.querySelectorAll(selector)) {
    if (candidates.length >= 600) break;
    const tag = element.tagName.toLowerCase();
    if (tag === "input" && (element.type || "").toLowerCase() === "hidden") continue;
    if (element.disabled || attribute(element, "aria-disabled") === "true" || element.closest("[inert]")) continue;
    if (element.hasAttribute("tabindex") && Number(attribute(element, "tabindex")) < 0 && !["a", "button", "input", "select", "textarea", "summary"].includes(tag) &&
      !INTERACTIVE_ROLES.has(attribute(element, "role").trim().toLowerCase())) continue;
    if (element.hasAttribute("contenteditable") && !element.isContentEditable && !INTERACTIVE_ROLES.has(attribute(element, "role").trim().toLowerCase())) continue;
    const style = getComputedStyle(element);
    if (style.visibility !== "visible" || style.display === "none" || Number(style.opacity) === 0 || style.pointerEvents === "none") continue;
    const rect = element.getBoundingClientRect();
    const left = Math.ceil(Math.max(rect.left, minX)), right = Math.floor(Math.min(rect.right, maxX));
    const top = Math.ceil(Math.max(rect.top, minY)), bottom = Math.floor(Math.min(rect.bottom, maxY));
    if (right - left < 1 || bottom - top < 1) continue;
    const width = right - left, height = bottom - top;
    const centreX = left + Math.floor(width / 2), centreY = top + Math.floor(height / 2);
    // An element hidden behind another one cannot be clicked; its centre must hit itself, a child, or its own label.
    const hit = document.elementFromPoint(centreX, centreY);
    if (!hit || !(hit === element || element.contains(hit) || (hit.closest && hit.closest("label") && hit.closest("label").control === element))) continue;
    const name = nameOf(element);
    if (sensitive(element, name)) continue;
    candidates.push({ element, role: roleOf(element), name, tag: tag.slice(0, 32), x: left, y: top, width, height });
  }
  // A wrapper that only repeats the name of the control inside it is not a second control.
  const listed = candidates.filter((item) => !candidates.some((other) => other !== item && other.name === item.name && item.element.contains(other.element)));
  return {
    frames: Math.min(64, document.querySelectorAll("iframe,frame").length),
    title: clean(document.title, 200),
    elements: listed.slice(0, limit).map((item, index) => ({ ref: index + 1, role: item.role.slice(0, 32), name: item.name, tag: item.tag, focused: document.hasFocus() && item.element === document.activeElement,
      x: item.x + originX, y: item.y + originY, width: item.width, height: item.height })),
  };
}

// TASK-084 scanner A, one call per frame. It is scanPage's rule set plus three differences recorded in the spike report:
// the selector runs on each open shadow root, the accessible-name id lookup is shadow-including, and the hit test follows
// shadowRoot.elementFromPoint down the chain. Coordinates are frame viewport coordinates.
export function scanDomFrame(args) {
  const { limit, maxDepth, candidateCap } = args;
  const SELECTOR = "a[href],button,input,select,textarea,summary,[role],[tabindex],[contenteditable]";
  const cleanText = (value, max) => String(value ?? "").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
  const attribute = (element, name) => element.getAttribute(name) ?? "";
  const INTERACTIVE = new Set(["button", "link", "checkbox", "radio", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "option",
    "switch", "textbox", "searchbox", "combobox", "slider", "spinbutton", "treeitem"]);
  const SENSITIVE_WORDS = /password|passwd|passcode|(?:^|[\s_-])(?:otp|totp)(?:$|[\s_-])|one[-_ ]?time|verification[-_ ]?code|security[-_ ]?code/i;
  const SENSITIVE_AUTOCOMPLETE = ["one-time-code", "current-password", "new-password"];
  const BUTTON_INPUTS = new Set(["button", "submit", "reset", "image"]);
  const roleOf = (element) => {
    const tag = element.tagName.toLowerCase();
    const explicit = attribute(element, "role").trim().split(/\s+/)[0].toLowerCase();
    if (INTERACTIVE.has(explicit)) return explicit;
    if (tag === "a") return "link";
    if (tag === "button" || tag === "summary") return "button";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "input") {
      const type = (element.type || "text").toLowerCase();
      if (BUTTON_INPUTS.has(type)) return "button";
      if (type === "checkbox" || type === "radio") return type;
      if (type === "range") return "slider";
      if (type === "number") return "spinbutton";
      if (type === "search") return "searchbox";
      return "textbox";
    }
    if (element.isContentEditable) return "textbox";
    return "control";
  };
  const byIdDeep = (id) => {
    const own = document.getElementById(id);
    if (own) return own;
    const queue = [{ root: document, depth: 0 }];
    while (queue.length) {
      const { root, depth } = queue.shift();
      for (const element of root.querySelectorAll("*")) {
        if (element.id === id) return element;
        if (element.shadowRoot && depth < maxDepth) queue.push({ root: element.shadowRoot, depth: depth + 1 });
      }
    }
    return null;
  };
  const labelledText = (element) => attribute(element, "aria-labelledby").split(/\s+/).filter(Boolean).slice(0, 5)
    .map((id) => byIdDeep(id)).filter(Boolean).map((node) => cleanText(node.textContent, 160)).join(" ");
  const nameOf = (element) => {
    const tag = element.tagName.toLowerCase();
    const type = tag === "input" ? (element.type || "text").toLowerCase() : "";
    const labels = element.labels ? Array.from(element.labels).slice(0, 3).map((label) => cleanText(label.textContent, 160)).join(" ") : "";
    const text = ["input", "select", "textarea"].includes(tag) ? "" : cleanText(element.innerText || element.textContent, 160);
    const alt = tag === "img" ? "" : Array.from(element.querySelectorAll("img[alt]")).slice(0, 3).map((image) => cleanText(image.alt, 80)).join(" ");
    const own = type === "image" ? attribute(element, "alt") : "";
    const buttonValue = BUTTON_INPUTS.has(type) ? attribute(element, "value") : "";
    return cleanText(attribute(element, "aria-label") || labelledText(element) || labels || text || alt || own || attribute(element, "title") ||
      attribute(element, "placeholder") || buttonValue || (type === "submit" ? "Submit" : ""), 80);
  };
  const sensitive = (element, name) => {
    const type = String(element.type ?? "").toLowerCase();
    const takesText = element.isContentEditable || ["textarea", "select"].includes(element.tagName.toLowerCase()) ||
      element.tagName.toLowerCase() === "input" && !["button", "submit", "reset", "image", "checkbox", "radio", "range", "file", "color"].includes(type);
    if (!takesText) return false;
    const autocomplete = attribute(element, "autocomplete").toLowerCase().split(/\s+/);
    const semantics = [attribute(element, "name"), attribute(element, "id"), attribute(element, "aria-label"), attribute(element, "placeholder"), name].join(" ");
    const numericCode = attribute(element, "inputmode").toLowerCase() === "numeric" && element.maxLength >= 4 && element.maxLength <= 8;
    return type === "password" || autocomplete.some((value) => SENSITIVE_AUTOCOMPLETE.includes(value)) || SENSITIVE_WORDS.test(semantics) || numericCode;
  };
  const shadowOf = (depth) => (depth === 0 ? "none" : depth === 1 ? "open" : "nested");
  const hitDeep = (x, y) => {
    let hit = document.elementFromPoint(x, y);
    const walked = new Set();
    while (hit && hit.shadowRoot && !walked.has(hit.shadowRoot)) {
      walked.add(hit.shadowRoot);
      const deeper = hit.shadowRoot.elementFromPoint(x, y);
      if (!deeper || deeper === hit) break;
      hit = deeper;
    }
    return hit;
  };
  const deepActive = () => {
    let active = document.activeElement;
    const walked = new Set();
    while (active?.shadowRoot?.activeElement && !walked.has(active.shadowRoot)) {
      walked.add(active.shadowRoot);
      active = active.shadowRoot.activeElement;
    }
    return active;
  };
  const focusedElement = document.hasFocus() ? deepActive() : null;
  const maxX = window.innerWidth, maxY = window.innerHeight;
  const candidates = [];
  let shadowNodes = 0, deepestShadowDepth = 0, truncated = false;
  const consider = (element, depth) => {
    if (candidates.length >= candidateCap) { truncated = true; return; }
    const tag = element.tagName.toLowerCase();
    if (tag === "input" && (element.type || "").toLowerCase() === "hidden") return;
    if (element.disabled || attribute(element, "aria-disabled") === "true" || element.closest("[inert]")) return;
    if (element.hasAttribute("tabindex") && Number(attribute(element, "tabindex")) < 0 && !["a", "button", "input", "select", "textarea", "summary"].includes(tag) &&
      !INTERACTIVE.has(attribute(element, "role").trim().toLowerCase())) return;
    if (element.hasAttribute("contenteditable") && !element.isContentEditable && !INTERACTIVE.has(attribute(element, "role").trim().toLowerCase())) return;
    const style = getComputedStyle(element);
    if (style.visibility !== "visible" || style.display === "none" || Number(style.opacity) === 0 || style.pointerEvents === "none") return;
    const rect = element.getBoundingClientRect();
    const left = Math.ceil(Math.max(rect.left, 0)), right = Math.floor(Math.min(rect.right, maxX));
    const top = Math.ceil(Math.max(rect.top, 0)), bottom = Math.floor(Math.min(rect.bottom, maxY));
    if (right - left < 1 || bottom - top < 1) return;
    const width = right - left, height = bottom - top;
    const centreX = left + Math.floor(width / 2), centreY = top + Math.floor(height / 2);
    const hit = hitDeep(centreX, centreY);
    if (!hit || !(hit === element || element.contains(hit) || (hit.closest && hit.closest("label") && hit.closest("label").control === element))) return;
    const name = nameOf(element);
    if (sensitive(element, name)) return;
    if (depth > 0) shadowNodes++;
    deepestShadowDepth = Math.max(deepestShadowDepth, depth);
    candidates.push({ role: roleOf(element), name, tag: tag.slice(0, 32), x: left, y: top, width, height,
      shadow: shadowOf(depth), focused: focusedElement === element, element });
  };
  const collect = (root, depth) => {
    const hosts = [];
    for (const element of root.querySelectorAll("*")) {
      if (element.matches(SELECTOR)) consider(element, depth);
      if (element.shadowRoot && depth < maxDepth) hosts.push(element.shadowRoot);
    }
    for (const nested of hosts) collect(nested, depth + 1);
  };
  collect(document, 0);
  const listed = candidates.filter((item) => !candidates.some((other) => other !== item && other.name === item.name && item.element.contains(other.element)));
  return {
    controls: listed.slice(0, limit).map((item) => ({ role: item.role, name: item.name, tag: item.tag, x: item.x, y: item.y,
      width: item.width, height: item.height, shadow: item.shadow, focused: item.focused })),
    candidates: candidates.length, shadowNodes, deepestShadowDepth, truncated,
  };
}

// One entry per Playwright frame, top frame first then children in document order, with the offset a control needs.
export async function collectFrames(page) {
  const main = page.mainFrame();
  const mainOrigin = (() => { try { return new URL(main.url()).origin; } catch { return ""; } })();
  const viewport = await main.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight })).catch(() => ({ width: SCREEN.width, height: SCREEN.height }));
  const infos = [];
  const visit = async (frame, parent, depth) => {
    let element = null, box = null, metrics = null;
    if (parent) {
      element = await frame.frameElement().catch(() => null);
      if (!element) return;
      box = await element.boundingBox().catch(() => null);
      metrics = await element.evaluate((node) => {
        const style = getComputedStyle(node);
        return { borderLeft: parseFloat(style.borderLeftWidth) || 0, borderTop: parseFloat(style.borderTopWidth) || 0,
          paddingLeft: parseFloat(style.paddingLeft) || 0, paddingTop: parseFloat(style.paddingTop) || 0,
          src: node.getAttribute("src") ?? "", title: node.getAttribute("title") ?? "" };
      }).catch(() => null);
      if (!box || !metrics) return;
    }
    let url = "";
    try { url = frame.url(); } catch { /* detached */ }
    let name = "";
    try { name = frame.name(); } catch { /* detached */ }
    let sameOrigin = false;
    try { sameOrigin = !url || url === "about:blank" || new URL(url).origin === mainOrigin; } catch { sameOrigin = false; }
    const offset = parent ? { x: Math.round(box.x + metrics.borderLeft + metrics.paddingLeft), y: Math.round(box.y + metrics.borderTop + metrics.paddingTop) }
      : { x: 0, y: 0 };
    const elementBox = parent ? { x: box.x, y: box.y, width: box.width, height: box.height } : { x: 0, y: 0, width: viewport.width, height: viewport.height };
    const parentInfo = parent ? infos.find((info) => info.frame === parent) : null;
    let visibleBox = elementBox;
    if (parentInfo) {
      const area = parentInfo.visibleBox;
      const x = Math.max(elementBox.x, area.x), y = Math.max(elementBox.y, area.y);
      const right = Math.min(elementBox.x + elementBox.width, area.x + area.width);
      const bottom = Math.min(elementBox.y + elementBox.height, area.y + area.height);
      visibleBox = { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
    }
    let isPayment = false;
    if (parent) {
      isPayment = PAYMENT_PATTERN.test(`${name} ${metrics.src} ${metrics.title}`);
      if (!isPayment) isPayment = await frame.evaluate(() => !!document.querySelector('input[autocomplete^="cc-"]')).catch(() => false);
    }
    infos.push({ frame, parent, depth, element, offset, elementBox, visibleBox, url, name, sameOrigin, isPayment,
      kind: depth === 0 ? "top" : depth >= 2 ? "nested" : sameOrigin ? "same-origin" : "cross-site" });
    if (infos.length > MAX_FRAMES) throw Object.assign(new Error("too_many_frames"), { code: "too_many_frames" });
    for (const child of frame.childFrames()) await visit(child, frame, depth + 1);
  };
  await visit(main, null, 0);
  return infos;
}

// Frame coordinates to screen coordinates: clip to the frame's visible box, then to the screen.
export function finalize(controls, info, origin, screen = SCREEN) {
  const out = [];
  const area = info.visibleBox;
  for (const control of controls) {
    const left = control.x + info.offset.x, top = control.y + info.offset.y;
    const right = left + control.width, bottom = top + control.height;
    const x0 = Math.max(left, area.x), y0 = Math.max(top, area.y);
    const x1 = Math.min(right, area.x + area.width), y1 = Math.min(bottom, area.y + area.height);
    if (x1 - x0 < 1 || y1 - y0 < 1) continue;
    const clippedX = Math.max(Math.round(x0 + origin.x), 0), clippedY = Math.max(Math.round(y0 + origin.y), 0);
    const clippedRight = Math.min(Math.round(x1 + origin.x), screen.width), clippedBottom = Math.min(Math.round(y1 + origin.y), screen.height);
    if (clippedRight - clippedX < 1 || clippedBottom - clippedY < 1) continue;
    const width = clippedRight - clippedX, height = clippedBottom - clippedY;
    const centreX = clippedX + Math.floor(width / 2), centreY = clippedY + Math.floor(height / 2);
    out.push({ role: control.role, name: control.name, tag: control.tag, x: clippedX, y: clippedY, width, height,
      frame: info.kind === "top" ? "top" : "child", shadow: control.shadow !== "none", focused: control.focused === true,
      centreX, centreY, topCentreX: centreX - origin.x, topCentreY: centreY - origin.y,
      centreOffscreen: centreX < 0 || centreY < 0 || centreX > screen.width || centreY > screen.height });
  }
  return out;
}

// A control in a child frame counts only while every ancestor still reports that frame element at its point.
async function occlusionFilter(infos, info, controls) {
  if (!info.parent || !controls.length) return controls;
  const alive = controls.map(() => true);
  let current = info;
  let parentInfo = infos.find((entry) => entry.frame === info.parent);
  while (parentInfo) {
    const local = controls.map((control) => [Math.round(control.topCentreX - parentInfo.offset.x), Math.round(control.topCentreY - parentInfo.offset.y)]);
    const hits = await parentInfo.frame.evaluate(([element, entries]) => entries.map(([x, y]) => document.elementFromPoint(x, y) === element),
      [current.element, local]).catch(() => local.map(() => false));
    for (let index = 0; index < alive.length; index++) if (!hits[index]) alive[index] = false;
    current = parentInfo;
    parentInfo = infos.find((entry) => entry.frame === current.parent);
  }
  return controls.filter((_, index) => alive[index]);
}

export async function collectControls({ page, origin, limit = MAX_ELEMENTS }) {
  const infos = await collectFrames(page);
  const controls = [];
  let paymentFrames = 0, shadowNodes = 0, deepestShadowDepth = 0, truncated = false;
  try {
    for (const info of infos) {
      if (info.isPayment) { paymentFrames++; continue; }
      let local;
      try { local = await info.frame.evaluate(scanDomFrame, { limit: limit * 4, maxDepth: MAX_SHADOW_DEPTH, candidateCap: CANDIDATE_CAP }); }
      catch { continue; }
      shadowNodes += local.shadowNodes;
      deepestShadowDepth = Math.max(deepestShadowDepth, local.deepestShadowDepth);
      truncated = truncated || local.truncated;
      const mapped = finalize(local.controls, info, origin);
      const clear = await occlusionFilter(infos, info, mapped).catch(() => []);
      for (const control of clear) {
        if (controls.length >= limit) { truncated = true; break; }
        controls.push(control);
      }
      if (controls.length >= limit) break;
    }
  } finally {
    for (const info of infos) await info.element?.dispose().catch(() => {});
  }
  // Public `frames` means embedded child frames, not the top document; the handoff copy depends on that meaning.
  return { controls, frames: Math.max(0, infos.length - 1), paymentFrames, truncated, shadowNodes, deepestShadowDepth };
}

// `move(x, y)` puts the real X pointer on a screen point. The page then reports where it saw that pointer,
// and the difference between screen and viewport coordinates is the viewport's exact place on the screen.
export async function measureOrigin({ page, move, fail }) {
  let origin = null;
  for (const point of CALIBRATION_POINTS) {
    const calibration = await page.evaluateHandle(installCalibration, CALIBRATION_WAIT_MS);
    let sample;
    try { await move(point.x, point.y); sample = await calibration.evaluate((value) => value.result); }
    finally { await calibration.dispose().catch(() => {}); }
    if (!sample) continue;
    // Zoomed pages and unexpected scaling make screen and page units differ; refuse rather than click the wrong place.
    if (sample.ratio !== 1 || sample.scale !== 1) throw fail("grounding_unavailable");
    if (sample.screenX !== point.x || sample.screenY !== point.y) throw fail("grounding_unavailable");
    origin = { x: sample.screenX - sample.clientX, y: sample.screenY - sample.clientY };
    break;
  }
  if (!origin || !Number.isInteger(origin.x) || !Number.isInteger(origin.y) || origin.x < -SCREEN.width || origin.x > SCREEN.width ||
    origin.y < -SCREEN.height || origin.y > SCREEN.height) throw fail("grounding_unavailable");
  return origin;
}

export async function takeSnapshot({ page, move, fail }) {
  const origin = await measureOrigin({ page, move, fail });
  const scan = await collectControls({ page, origin });
  // Public inventory: stable refs and only the fields the controller schema accepts. Internal
  // fragment-centre fields stay inside this module.
  const elements = scan.controls.map((item, index) => ({
    ref: index + 1, role: item.role.slice(0, 32), name: item.name, tag: item.tag.slice(0, 32),
    frame: item.frame, shadow: item.shadow === true,
    ...(typeof item.focused === "boolean" ? { focused: item.focused } : {}),
    x: item.x, y: item.y, width: item.width, height: item.height,
  }));
  const title = await page.title().catch(() => "");
  return { ...scan, elements, title: String(title).replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").slice(0, 200), url: page.url(), origin };
}

// Closed predicates over the bounded visible-control inventory, never arbitrary page code.
export function verifySnapshot(snapshot, predicate) {
  if (predicate.kind === "url_path") {
    try { return { status: new URL(snapshot.url).pathname === predicate.value ? "pass" : "fail", code: "url_path" }; }
    catch { return { status: "unknown", code: "unsupported_url" }; }
  }
  if (!["control_present", "control_absent"].includes(predicate.kind)) return { status: "unknown", code: "unsupported_expectation" };
  const matches = snapshot.elements.filter((item) => item.name === predicate.value);
  if (matches.length > 1) return { status: "unknown", code: "ambiguous_control" };
  const present = matches.length === 1;
  return { status: (predicate.kind === "control_present" ? present : !present) ? "pass" : "fail", code: "visible_inventory" };
}
