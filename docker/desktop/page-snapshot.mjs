// TASK-025: lists the visible, clickable controls of the focused page with exact screen positions.
// The page is untrusted: everything read here is data, size-limited, and re-validated by controller-schema.mjs.
export const MAX_ELEMENTS = 150;
export const SCREEN = { width: 1024, height: 768 };
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

// Runs inside the page. Returns viewport coordinates of at most `limit` visible, unobstructed controls.
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

// `move(x, y)` puts the real X pointer on a screen point. The page then reports where it saw that pointer,
// and the difference between screen and viewport coordinates is the viewport's exact place on the screen.
export async function takeSnapshot({ page, move, fail }) {
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
  const scan = await page.evaluate(scanPage, { originX: origin.x, originY: origin.y, screenWidth: SCREEN.width, screenHeight: SCREEN.height, limit: MAX_ELEMENTS });
  return { ...scan, url: page.url() };
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
