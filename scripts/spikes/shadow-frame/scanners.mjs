// Shadow DOM and iframe grounding spike: scanner A (DOM walk) and scanner B (accessibility tree).
// Imported by probe.mjs, which runs inside the throwaway desktop container. Nothing here touches the host.
// Every control a scanner returns is in SCREEN coordinates, clipped to what is really visible.

export const SCREEN = { width: 1024, height: 768 };
export const LIMIT = 150;
export const MAX_SHADOW_DEPTH = 10;
export const CANDIDATE_CAP = 600;
export const PAYMENT_PATTERN = /stripe|braintree|adyen|checkout|payment|card/i;
export const INTERACTIVE_ROLES = new Set(["button", "link", "checkbox", "radio", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "option",
  "switch", "textbox", "searchbox", "combobox", "slider", "spinbutton", "treeitem"]);

export const clean = (value, max) => String(value ?? "").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
const short = (cause) => String(cause?.message ?? cause ?? "").replace(/\s+/g, " ").slice(0, 120);

// Runs inside the page (serialised by Playwright), so it must not use anything outside its own body.
// It is scanPage's rule set plus three differences, all recorded in the spike report:
// the selector runs on each open shadow root, the accessible-name id lookup is shadow-including,
// and the hit test follows shadowRoot.elementFromPoint down the chain.
export function scanDomFrame(args) {
  const { limit, maxDepth, candidateCap } = args;
  // Serialised into the page, so everything it needs is declared here, including the selector.
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
  // Shadow-including id lookup: an aria-labelledby in a shadow tree may point at a light-DOM node.
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
  // The first shadow root under a host is "open"; anything deeper is "nested". A closed root is never reached.
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
    candidates.push({ role: roleOf(element), name, x: left, y: top, width, height, shadow: shadowOf(depth), element });
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
  // A wrapper that only repeats the name of the control inside it is not a second control.
  const listed = candidates.filter((item) => !candidates.some((other) => other !== item && other.name === item.name && item.element.contains(other.element)));
  return {
    controls: listed.slice(0, limit).map((item) => ({ role: item.role, name: item.name, x: item.x, y: item.y,
      width: item.width, height: item.height, shadow: item.shadow })),
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
    let url = "", name = "", sameOrigin = false;
    try { url = frame.url(); } catch { /* detached */ }
    try { name = frame.name(); } catch { /* detached */ }
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
    // scanPage aims at the centre of the box the user can actually see, so a control half past the screen edge
    // is still clickable in its visible part. Aim at the unclipped centre instead and that control vanishes.
    const centreX = clippedX + Math.floor(width / 2), centreY = clippedY + Math.floor(height / 2);
    out.push({ role: control.role, name: control.name, x: clippedX, y: clippedY, width, height,
      frame: info.kind, shadow: control.shadow ?? "unreported", centreX, centreY,
      topCentreX: centreX - origin.x, topCentreY: centreY - origin.y,
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

export async function scanA({ page, origin, screen = SCREEN, limit = LIMIT }) {
  const started = performance.now();
  const infos = await collectFrames(page);
  const controls = [];
  let paymentFrames = 0, scannedFrames = 0, truncated = false, shadowNodes = 0, deepestShadowDepth = 0;
  const errors = [];
  for (const info of infos) {
    if (info.isPayment) { paymentFrames++; continue; }
    let local;
    try { local = await info.frame.evaluate(scanDomFrame, { limit: limit * 4, maxDepth: MAX_SHADOW_DEPTH, candidateCap: CANDIDATE_CAP }); }
    catch (cause) { errors.push(`${info.kind}:${short(cause)}`); continue; }
    scannedFrames++;
    shadowNodes += local.shadowNodes;
    deepestShadowDepth = Math.max(deepestShadowDepth, local.deepestShadowDepth);
    truncated = truncated || local.truncated;
    const mapped = finalize(local.controls, info, origin, screen);
    const clear = await occlusionFilter(infos, info, mapped).catch(() => []);
    for (const control of clear) {
      if (controls.length >= limit) { truncated = true; break; }
      controls.push(control);
    }
    if (controls.length >= limit) break;
  }
  for (const info of infos) await info.element?.dispose().catch(() => {});
  return { scanner: "A", controls, frames: infos.length, scannedFrames, paymentFrames, truncated, shadowNodes, deepestShadowDepth,
    errors: errors.slice(0, 12), ms: Math.round(performance.now() - started) };
}

const boxOfQuads = (quads) => {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const quad of quads) {
    for (let index = 0; index + 1 < quad.length; index += 2) {
      minX = Math.min(minX, quad[index]); maxX = Math.max(maxX, quad[index]);
      minY = Math.min(minY, quad[index + 1]); maxY = Math.max(maxY, quad[index + 1]);
    }
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
};

export { boxOfQuads };

const SENSITIVE_AUTOCOMPLETE = ["one-time-code", "current-password", "new-password"];
const SENSITIVE_WORDS = /password|passwd|passcode|(?:^|[\s_-])(?:otp|totp)(?:$|[\s_-])|one[-_ ]?time|verification[-_ ]?code|security[-_ ]?code/i;

// The accessibility tree carries no field semantics, so the sensitive rules run over the node's own markup.
export function sensitiveFromMarkup(markup, name) {
  const attribute = (key) => { const found = new RegExp(`(?:^|\\s)${key}="([^"]*)"`, "i").exec(markup); return found ? found[1] : ""; };
  if (attribute("type").toLowerCase() === "password") return true;
  const autocomplete = attribute("autocomplete").toLowerCase().split(/\s+/);
  const semantics = [attribute("name"), attribute("id"), attribute("aria-label"), attribute("placeholder"), name].join(" ");
  const maxLength = Number(attribute("maxlength"));
  const numericCode = attribute("inputmode").toLowerCase() === "numeric" && Number.isFinite(maxLength) && maxLength >= 4 && maxLength <= 8;
  return autocomplete.some((value) => SENSITIVE_AUTOCOMPLETE.includes(value)) || SENSITIVE_WORDS.test(semantics) || numericCode;
}

export async function scanB({ context, page, origin, screen = SCREEN, limit = LIMIT }) {
  const started = performance.now();
  const infos = await collectFrames(page);
  const controls = [];
  const seen = new Set();
  let paymentFrames = 0, scannedFrames = 0, noCoordinates = 0, markupUnknown = 0, duplicates = 0, axNodes = 0;
  const errors = [];
  for (const info of infos) {
    if (info.isPayment) { paymentFrames++; continue; }
    let session = null;
    try {
      session = await context.newCDPSession(info.frame);
      await session.send("DOM.enable");
      await session.send("Accessibility.enable");
      await session.send("DOM.getDocument", { depth: -1, pierce: true });
      const { nodes } = await session.send("Accessibility.getFullAXTree");
      scannedFrames++;
      axNodes += (nodes ?? []).length;
      const interactive = (nodes ?? []).filter((node) => !node.ignored && node.role?.value && INTERACTIVE_ROLES.has(node.role.value));
      for (const node of interactive) {
        const name = clean(node.name?.value ?? "", 80);
        if (!name) continue;
        let box = null;
        try {
          const { quads } = await session.send("DOM.getContentQuads", { backendNodeId: node.backendDOMNodeId });
          box = boxOfQuads(quads ?? []);
        } catch (cause) { errors.push(`quads:${short(cause)}`); continue; }
        if (!box || box.width < 1 || box.height < 1) { noCoordinates++; continue; }
        if (["textbox", "searchbox", "combobox", "spinbutton"].includes(node.role.value)) {
          let markup = "";
          try { markup = (await session.send("DOM.getOuterHTML", { backendNodeId: node.backendDOMNodeId })).outerHTML ?? ""; }
          catch (cause) { errors.push(`markup:${short(cause)}`); }
          // Fail closed: a text field whose markup cannot be read is never offered.
          if (!markup) { markupUnknown++; continue; }
          if (sensitiveFromMarkup(markup, name)) continue;
        }
        const mapped = finalize([{ role: node.role.value, name, x: Math.round(box.x), y: Math.round(box.y),
          width: Math.round(box.width), height: Math.round(box.height) }], info, origin, screen);
        for (const control of mapped) {
          const key = `${control.name}|${control.x}|${control.y}`;
          if (seen.has(key)) { duplicates++; continue; }
          seen.add(key);
          if (controls.length >= limit) break;
          controls.push(control);
        }
        if (controls.length >= limit) break;
      }
    } catch (cause) {
      errors.push(`${info.kind}:${short(cause)}`);
    } finally {
      await session?.detach().catch(() => {});
    }
    if (controls.length >= limit) break;
  }
  for (const info of infos) await info.element?.dispose().catch(() => {});
  return { scanner: "B", controls, frames: infos.length, scannedFrames, paymentFrames, noCoordinates, markupUnknown, duplicates, axNodes,
    truncated: controls.length >= limit, errors: errors.slice(0, 12), ms: Math.round(performance.now() - started) };
}

// The image's own scanner, used unchanged as the baseline column. It returns screen coordinates already.
export function scanCurrent({ scanPage, page, origin, screen = SCREEN, limit = LIMIT }) {
  const started = performance.now();
  return page.evaluate(scanPage, { originX: origin.x, originY: origin.y, screenWidth: screen.width, screenHeight: screen.height, limit })
    .then((scan) => ({
      scanner: "current",
      controls: (scan.elements ?? []).map((element) => ({ role: element.role, name: element.name, x: element.x, y: element.y,
        width: element.width, height: element.height, frame: "top", shadow: "unreported", centreOffscreen: false,
        centreX: Math.round(element.x + element.width / 2), centreY: Math.round(element.y + element.height / 2) })),
      frames: scan.frames ?? 0, scannedFrames: 1, paymentFrames: 0, truncated: (scan.elements ?? []).length >= limit,
      ms: Math.round(performance.now() - started),
    }));
}
