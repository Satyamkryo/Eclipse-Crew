export const MASK_SELECTOR = 'input,textarea,select,[contenteditable],[data-sensitive],[data-private],[autocomplete],iframe,canvas,video,img,svg';
// Deliberately exclude arbitrary DOM text, values, accessible names and URL paths.
export function safeEvent(command) {
  const event = { operation: command.operation, source_tag: 'web', untrusted: true };
  if (command.operation === 'input.type') return { ...event, redacted: true, length: command.text.length };
  if (command.operation === 'input.key') return /^(Enter|Tab|Escape|Backspace|Delete|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Home|End|PageUp|PageDown)$/.test(command.key) ? { ...event, key:command.key } : { ...event, redacted:true };
  for (const name of ['x','y','toX','toY','button','direction','count']) if (command[name] !== undefined) event[name] = command[name];
  return event;
}
export async function safePage(context, selected) {
  const pages = context.pages();
  if (pages.length > 32) throw Error('unsupported_surface');
  let page = selected;
  if (!page) {
    const focused = [];
    for (const candidate of pages) if (await candidate.evaluate(() => document.hasFocus())) focused.push(candidate);
    if (focused.length !== 1) throw Error('unknown_focus');
    page = focused[0];
  }
  if (!pages.includes(page) || page.isClosed() || !/^https?:$/.test(new URL(page.url()).protocol)) throw Error('unsupported_surface');
  if (page.frames().length !== 1) throw Error('unsupported_frames');
  const cdp = await context.newCDPSession(page);
  try {
    // Includes closed shadow roots, invisible to ordinary DOM traversal.
    await cdp.send('Runtime.enable');
    const proto = await cdp.send('Runtime.evaluate', { expression: 'ShadowRoot.prototype' });
    if (!proto.result.objectId) throw Error('unsupported_shadow');
    const roots = await cdp.send('Runtime.queryObjects', { prototypeObjectId: proto.result.objectId });
    const result = await cdp.send('Runtime.callFunctionOn', { objectId: roots.objects.objectId, functionDeclaration: 'function(){return this.length}', returnByValue: true });
    if (result.result.value !== 0) throw Error('unsupported_shadow');
  } finally { await cdp.detach(); }
  const gate = await page.evaluate(() => {
    if (!document.hasFocus() || document.visibilityState !== 'visible') return 'unknown_focus';
    if (document.querySelector('dialog[open],[role="dialog"],[role="alertdialog"],object,embed')) return 'unsupported_surface';
    const semantics = [...document.querySelectorAll('input,form,[role],iframe')].map(e => [e.getAttribute('type'),e.getAttribute('autocomplete'),e.getAttribute('name'),e.getAttribute('id'),e.getAttribute('aria-label'),e.getAttribute('action'),e.getAttribute('src')].join(' ')).join(' ');
    const visibleText = document.body?.innerText ?? '';
    if (visibleText.length > 100000) return 'unsupported_surface';
    if (/password|passwd|passcode|\botp\b|\btotp\b|one.time|captcha|sign.in|log.in|verification.code|security.code/i.test(semantics + ' ' + location.pathname + ' ' + visibleText)) return 'sensitive_surface';
    if ([...document.querySelectorAll('input')].some(e => e.inputMode === 'numeric' && e.maxLength >= 4 && e.maxLength <= 8)) return 'sensitive_surface';
    return null;
  });
  if (gate) throw Error(gate);
  return page;
}
export async function sanitizedFrame(context, selected) {
  const page = await safePage(context, selected);
  const stamp = await page.evaluate(() => {
    if (!window.__eclipseTeachGuard) {
      const guard = { revision: 0, origin: null };
      // Mask overlays are installed by Playwright itself. Observe privacy-relevant
      // transitions rather than rejecting its harmless overlay DOM mutations.
      new MutationObserver(records => {
        const unsafe = /password|passwd|passcode|otp|totp|one.time|captcha|sign.in|log.in|verification.code|security.code/i;
        for (const record of records) {
          if (record.type === 'characterData' && unsafe.test([record.oldValue,record.target.textContent].join(' '))) guard.revision++;
          if (record.type === 'attributes' && unsafe.test([record.oldValue,record.target.getAttribute(record.attributeName)].join(' '))) guard.revision++;
          for (const node of record.addedNodes) if (node.nodeType === 1) {
            if (unsafe.test(node.textContent ?? '')) guard.revision++;
            if (node.matches('iframe,frame,object,embed,dialog,[role="dialog"],[role="alertdialog"]') || node.querySelector('iframe,frame,object,embed,dialog,[role="dialog"],[role="alertdialog"]')) guard.revision++;
            for (const element of [node,...node.querySelectorAll('input,form,[role]')]) if (unsafe.test(['type','autocomplete','name','id','aria-label','action'].map(name=>element.getAttribute(name)).join(' '))) guard.revision++;
          }
        }
      }).observe(document, { subtree:true, childList:true, attributes:true, attributeOldValue:true, characterData:true, characterDataOldValue:true });
      document.addEventListener('pointermove', event => { if (event.isTrusted) guard.origin = { x:event.screenX-event.clientX, y:event.screenY-event.clientY }; }, true);
      document.addEventListener('pointerdown', event => { if (event.isTrusted) guard.origin = { x:event.screenX-event.clientX, y:event.screenY-event.clientY }; }, true);
      window.__eclipseTeachGuard = guard;
    }
    return window.__eclipseTeachGuard.revision;
  });
  const png = await page.screenshot({ type: 'png', animations: 'allow', caret: 'initial', mask: [page.locator(MASK_SELECTOR)], maskColor: '#000000', timeout: 2500, fullPage: false });
  await safePage(context, page);
  const guard = await page.evaluate(() => window.__eclipseTeachGuard);
  if (!guard || guard.revision !== stamp) throw Error('surface_changed');
  if (png.length < 33 || png.readUInt32BE(16) > 1024 || png.readUInt32BE(20) > 768) throw Error('unsupported_dimensions');
  return { page, png, viewportOrigin:guard.origin, width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}
