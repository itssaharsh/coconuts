#!/usr/bin/env python3
"""foldcheck.py - measure the first screen a judge sees, instead of asserting it.

  python3 foldcheck.py <url> [--action "text=Run the night"] [--result ".verdict"] [--out shots/]
                             [--wait 4000] [--sizes 1440x900 390x844] [--device both|desktop|phone]
                             [--promise India "housing society"]
                             [--storage-state state.json | --init-script "localStorage.setItem('session','demo')"]

Opens the URL with no input at each size and reports, per size:
  action     the primary action and where it sits. FAIL when the action named with --action is missing, hidden
             or below the fold. Without --action the control is guessed, and a guess can only WARN.
             --action takes a CSS selector, or text=<the button's label>.
  result     (--result) the element that shows the product's work; FAIL when it is not on the first screen.
             A CSS selector, or text=<words in it>.
  wall       FAIL when the first screen is a sign-in wall
  blank      FAIL when nothing renders
  overflow   FAIL when the page scrolls sideways (WARN when the overflow is clipped and cannot scroll)
  unhidden   FAIL when an element carrying the hidden attribute still renders anywhere on the page, not only on
             the first screen (a CSS display rule overrides it, so "Log in" and "Log out" show together)
  setup      WARN when a credentials or setup form (3+ fields) sits above the primary action
  covered    WARN when a dialog or banner sits on top of the primary action
  overlap    WARN when a canvas sits over the headline
  dead       WARN for disabled buttons or "coming soon" on the first screen
  promise    (--promise) WARN when a word the name or tagline promises is not in the first screen's content;
             the product's own name and headline do not count
  type       the smallest and the median text size on the first screen (WARN under 12 px)
  late       WARN when a named action or result takes more than five seconds to appear
and saves a screenshot per size and foldcheck.json (to --out, or to a temporary folder it prints).

Exit codes: 0 pass, 1 a FAIL above, 2 the check could not run or could not measure a size (Playwright or
Chromium missing, bad arguments, a page that keeps navigating or is too busy to answer). 2 is never a pass.

Needs Playwright for Python and a Chromium. On your own machine: `pip install playwright` then
`python3 -m playwright install chromium`. In Claude's cloud workspace Chromium is already installed: never run
`playwright install` there, and add the Python package (`pip install playwright`) only if the import fails.
Read-only: it loads the page and never clicks, types or signs in. To see the signed-in screens, hand it a session
with --storage-state or --init-script and run it a second time: a defect can show only after sign-in (field notes H61:
"Log in" and "Sign up" stayed on screen beside "Log out" once signed in, and a signed-out check passed).
"""
import argparse
import asyncio
import json
import os
import re
import sys
import tempfile

PROBE = r"""
([actionSel, resultSel, promise]) => {
  const vw = window.innerWidth, vh = window.innerHeight, sy = Math.round(window.scrollY);
  const box = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect(), s = getComputedStyle(el);
    if (r.width < 4 || r.height < 4 || s.visibility === 'hidden' || s.display === 'none' || +s.opacity < 0.05) return null;
    // x, y, bottom are measured in the window as it opened; docY is the position in the whole page
    return {x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height),
            bottom: Math.round(r.bottom), docY: Math.round(r.top + window.scrollY)};
  };
  const full = (el) => ((el.innerText || el.value || el.getAttribute('aria-label') || '') + '').trim().replace(/\s+/g, ' ');
  const text = (el) => full(el).slice(0, 60);
  const deep = (sel, root = document) => {
    let out = [...root.querySelectorAll(sel)];
    for (const h of root.querySelectorAll('*')) if (h.shadowRoot) out = out.concat(deep(sel, h.shadowRoot));
    return out;
  };
  let badSelector = false;
  const q = (sel) => { try { const all = deep(sel); return all.find(box) || all[0] || null; } catch (e) { badSelector = true; return null; } };
  const byText = (t, any) => {
    t = t.trim().replace(/^["']|["']$/g, '').toLowerCase();
    const pool = deep(any ? 'body *' : 'button, a, [role=button], input[type=submit], input[type=button], summary');
    const all = pool.filter(e => full(e).toLowerCase().includes(t));
    const leaf = all.filter(e => !all.some(o => o !== e && e.contains(o)));       // the innermost element holding the text
    const seen = leaf.filter(box);
    const lead = (s) => s.startsWith(t) && !/[a-z0-9]/i.test(s[t.length] || ' ');      // "run the week", not "runbook"
    const best = (xs) => xs.find(e => full(e).toLowerCase() === t) || xs.find(e => lead(full(e).toLowerCase()))
        || xs.find(e => full(e).toLowerCase().startsWith(t)) || xs[0];
    return best(seen) || best(leaf) || null;
  };
  const pick = (sel, any) => !sel ? null : sel.startsWith('text=') ? byText(sel.slice(5), any) : q(sel);
  // a label on something that is not a button or a link (a clickable <div>): only an exact or leading match counts,
  // so "Run" never lands on a paragraph that says "running"
  const byLabelLoose = (t) => {
    t = t.trim().replace(/^["']|["']$/g, '').toLowerCase();
    const all = deep('body *').filter(e => !e.closest('script, style, noscript, template') && full(e).toLowerCase().startsWith(t)
        && full(e).length <= t.length + 12);
    const leaf = all.filter(e => !all.some(o => o !== e && e.contains(o))).filter(box);
    return leaf.find(e => full(e).toLowerCase() === t) || leaf[0] || null;
  };
  const NAV = /^(home|about|docs|pricing|blog|github|login|log in|sign in|sign up|menu|skip to|view source|star)\b/i;
  const clickables = deep('button, [role=button], input[type=submit], input[type=button], a')
      .map(e => ({e, b: box(e), t: text(e), tag: e.tagName, disabled: e.disabled || e.getAttribute('aria-disabled') === 'true',
                  inNav: !!e.closest('nav, footer')}))
      .filter(c => c.b && c.t);
  const onScreen = (b) => b.y < vh && b.bottom > 0 && b.x < vw && b.x + b.w > 0;
  const buttonish = (c) => c.tag !== 'A' || /btn|button|cta|primary/i.test(c.e.className + '') || c.b.h >= 36;
  let action = pick(actionSel), loose = false;
  if (!action && actionSel && actionSel.startsWith('text=')) { action = byLabelLoose(actionSel.slice(5)); loose = !!action; }
  const how = actionSel ? 'given' : 'guessed';
  if (!action && !actionSel) {
    // a guess: the largest button-like control on the first screen, else the first one below it
    const cands = clickables.filter(c => !c.inNav && !c.e.closest('header nav') && !NAV.test(c.t) && !c.disabled
        && c.t.length <= 40 && buttonish(c));
    const top = cands.filter(c => c.b.bottom <= vh && c.b.y >= 0).sort((a, b) => b.b.w * b.b.h - a.b.w * a.b.h);
    const rest = cands.filter(c => c.b.bottom > vh).sort((a, b) => a.b.y - b.b.y);
    action = (top[0] || rest[0] || {}).e || null;
  }
  const ab = box(action);
  const result = pick(resultSel, true), rb = box(result);
  // what sits on top of the action: a dialog or banner a judge would have to dismiss first
  let cover = null;
  if (action && ab && ab.bottom <= vh && ab.y >= 0) {
    const cx = ab.x + ab.w / 2, cy = ab.y + ab.h / 2;
    let top = document.elementFromPoint(cx, cy);
    while (top && top.shadowRoot) { const inner = top.shadowRoot.elementFromPoint(cx, cy); if (!inner || inner === top) break; top = inner; }
    const within = (anc, el) => { for (let e = el; e; e = e.parentNode || e.host) if (e === anc) return true; return false; };
    if (top && !within(top, action) && !within(action, top)) {
      let host = top;
      while (host.parentElement && host.parentElement !== document.body && !host.matches('[role=dialog], [aria-modal=true], dialog'))
        host = host.parentElement;
      cover = (host.tagName.toLowerCase() + (host.id ? '#' + host.id : '') + ' ' + text(host)).trim().slice(0, 70);
    }
  }
  const inputs = deep('input, textarea, select')
      .filter(e => !['hidden', 'submit', 'button', 'checkbox', 'radio', 'range', 'file'].includes(e.type)).map(e => ({e, b: box(e)})).filter(i => i.b);
  const beforeAction = ab ? inputs.filter(i => i.b.y < ab.y) : inputs;
  const pwFirst = inputs.filter(i => i.e.type === 'password' && onScreen(i.b));
  // text on the first screen, read from text nodes so every element kind is counted
  const skip = 'svg, script, style, noscript, template, [aria-hidden=true]';
  const brand = 'h1, header, nav, footer';
  const sizes = [], content = [], headline = [];
  const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n.nodeValue.trim(), el = n.parentElement;
    if (t.length < 2 || !el || el.closest(skip)) continue;
    const b = box(el);
    if (!b || !onScreen(b)) continue;
    const px = parseFloat(getComputedStyle(el).fontSize);
    if (px > 0) sizes.push([px, t.slice(0, 40)]);
    (el.closest(brand) ? headline : content).push(t);
  }
  for (const e of deep('input, textarea')) { const b = box(e); if (b && onScreen(b) && e.value) content.push(e.value); }
  sizes.sort((a, b) => a[0] - b[0]);
  const has = (hay, w) => new RegExp('(^|[^A-Za-z0-9])' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '($|[^A-Za-z0-9])', 'i').test(hay);
  const contentText = content.join('\n'), headText = headline.join('\n') + '\n' + document.title;
  const h1 = document.querySelector('h1'), hb = box(h1);
  const zOf = (el) => { for (let e = el; e && e !== document.documentElement; e = e.parentElement) {
      const s = getComputedStyle(e); if (s.position !== 'static' && s.zIndex !== 'auto') return +s.zIndex || 0; } return 0; };
  const canvases = [...document.querySelectorAll('canvas')].map(c => ({c, b: box(c)})).filter(x => x.b);
  const overlap = hb ? canvases.some(({c, b}) => b.x < hb.x + hb.w && b.x + b.w > hb.x && b.y < hb.y + hb.h && b.y + b.h > hb.y
                                     && b.w * b.h < vw * vh * 0.98 && zOf(c) >= 0 && zOf(c) >= zOf(h1)) : false;
  const AUTH = /\b(sign[ -]?in|log[ -]?in|sign[ -]?up|register|create (an )?account|continue with \w+)\b/i;
  const CONSENT = /^(accept|agree|allow|got it|ok|reject|decline|close|dismiss|show|hide|forgot)/i;
  const signin = clickables.filter(c => onScreen(c.b) && !c.inNav && !c.e.closest('header nav') && AUTH.test(c.t) && buttonish(c));
  const inPwForm = (e) => { const f = e.closest('form'); return !!(f && f.querySelector('input[type=password]')); };
  const GENERIC = /^(continue|next|submit|go|enter|verify|unlock)\b/i;        // a password form's button says any of these
  const others = clickables.filter(c => onScreen(c.b) && !AUTH.test(c.t) && !CONSENT.test(c.t) && !NAV.test(c.t) && !c.inNav && buttonish(c)
      && !(pwFirst.length && (inPwForm(c.e) || GENERIC.test(c.t.trim()))));
  const hx = getComputedStyle(document.documentElement).overflowX, bx = document.body ? getComputedStyle(document.body).overflowX : 'visible';
  const frames = [...document.querySelectorAll('iframe')].map(box).filter(b => b && onScreen(b) && b.w * b.h > vw * vh * 0.2).length;
  const screenText = ((document.body || document.documentElement).innerText || '').split('\n').map(s => s.trim()).filter(Boolean);
  const words = (contentText + ' ' + headline.join(' ')).split(/\s+/).filter(w => w.length > 1).length;   // not the <title>
  // elements the markup or a script marked hidden that still render anywhere on the page: a CSS display rule
  // (".nav-link { display: flex }") beats the browser's own [hidden] rule. hidden="until-found" is meant to render.
  const selOf = (e) => e.tagName.toLowerCase() + (e.id ? '#' + e.id : '')
      + (typeof e.className === 'string' && e.className.trim() ? '.' + e.className.trim().split(/\s+/)[0] : '');
  const unhidden = deep('[hidden]').filter(e => (e.getAttribute('hidden') || '').trim().toLowerCase() !== 'until-found')
      .filter(e => { const s = getComputedStyle(e);
        return s.display !== 'none' && s.visibility !== 'hidden' && [...e.getClientRects()].some(r => r.width > 0 && r.height > 0); });
  return {
    vw, vh, scrollY: sy, scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight,
    action: action ? (ab ? {text: text(action), how, ...ab, above: ab.bottom <= vh && ab.y >= 0 && ab.x >= 0 && ab.x + ab.w <= vw,
                             offside: ab.bottom <= vh && ab.y >= 0 && !(ab.x >= 0 && ab.x + ab.w <= vw), cover,
                             notControl: loose ? action.tagName.toLowerCase() : null}
                          : {text: text(action), how, hidden: true}) : null,
    result: resultSel ? (result ? (rb ? {...rb, above: Math.min(rb.bottom, vh) - Math.max(rb.y, 0) >= Math.min(rb.h * 0.5, vh * 0.25)
                                                   && rb.x < vw && rb.x + rb.w > 0,
                                         offside: !(rb.x < vw && rb.x + rb.w > 0)}
                                      : {hidden: true}) : {missing: true}) : null,
    badSelector, frames,
    viewportMeta: !!document.querySelector('meta[name="viewport" i][content*="device-width" i]'),
    fieldsBeforeAction: beforeAction.length, passwordFields: pwFirst.length,
    wall: (pwFirst.length > 0 || signin.length > 0) && others.length === 0
          && !(ab && ab.bottom <= vh && how === 'given') && !(rb && rb.y < vh),
    blank: words < 3 && clickables.length === 0 && canvases.length === 0 && frames === 0,
    clipX: ['hidden', 'clip'].includes(hx !== 'visible' ? hx : bx),
    unhidden: {n: unhidden.length, examples: unhidden.slice(0, 3).map(e => { const t = text(e).slice(0, 40);
      return selOf(e) + (t ? ' "' + t + '"' : ''); })},
    dead: clickables.filter(c => onScreen(c.b) && (c.disabled || /coming soon/i.test(c.t))).map(c => c.t).slice(0, 5),
    comingSoon: /coming soon/i.test(contentText),
    h1: h1 ? text(h1) : null, overlap,
    font: sizes.length ? {min: sizes[0][0], sample: sizes[0][1], median: sizes[Math.floor(sizes.length / 2)][0], n: sizes.length} : null,
    promise: (promise || []).map(p => [p, has(contentText, p) ? 'content' : has(headText, p) ? 'headline' : 'missing']),
    firstLines: screenText.slice(0, 8).map(s => s.slice(0, 90)),
  };
}
"""


def judge(m, args):
    """Turn one size's measurements into (level, message) findings."""
    out = []
    a, given = m["action"], bool(args.action)
    hint = ""
    if m.get("badSelector"):
        hint = " (that is not a CSS selector a browser accepts; for a button by its label write text=<label>)"
    elif m.get("frames"):
        hint = f" (the page embeds {m['frames']} frame(s): if the product runs inside one, pass the frame's own URL)"
    if not a:
        out.append(("FAIL" if given else "WARN", f"--action {args.action} is not on the page{hint}" if given else
                    "no button-like control found; name the primary action with --action to check it"))
    elif a.get("hidden"):
        out.append(("FAIL" if given else "WARN", f"primary action \"{a['text']}\" is in the page but not visible with no "
                    "input (hidden, or transparent until the page is scrolled)"))
    elif a.get("offside"):
        out.append(("FAIL" if given else "WARN",
                    f"primary action \"{a['text']}\" is off the side of the window (x={a['x']} to {a['x'] + a['w']} px; "
                    f"the window is {m['vw']} px wide): a clipped slide or an off-canvas panel is not on the first screen"))
    elif not a["above"]:
        # a guessed control is a hint, never a failure: only a named action can fail the check
        out.append(("FAIL" if given else "WARN",
                    f"primary action \"{a['text']}\" ends at y={a['bottom']} px; the first screen is {m['vh']} px tall"
                    + ("" if given else " (guessed: no button was found on the first screen; confirm with --action)")))
    else:
        out.append(("ok", f"primary action \"{a['text']}\" is on the first screen (y={a['y']}, {a['how']})"))
        if a.get("cover"):
            out.append(("WARN", f"primary action \"{a['text']}\" is covered by <{a['cover']}>; a judge has to dismiss "
                        "that before anything works"))
    if a and a.get("notControl"):
        out.append(("WARN", f"\"{a['text']}\" is a <{a['notControl']}>, not a button or a link: a keyboard cannot reach "
                    "it and a screen reader does not announce it as something to press"))
    r = m["result"]
    if r is not None:
        if r.get("missing"):
            out.append(("FAIL", f"--result {args.result} is not on the page with no input{hint}"))
        elif r.get("hidden"):
            out.append(("FAIL", f"--result {args.result} is in the page but not visible with no input"))
        elif r.get("offside"):
            out.append(("FAIL", f"the result is off the side of the window (x={r['x']} px in a {m['vw']} px window)"))
        elif not r["above"]:
            out.append(("FAIL", f"the result starts at y={r['y']} px; with no input the first screen should already show it"))
        else:
            out.append(("ok", f"the result is on the first screen with no input (y={r['y']})"))
    if m["blank"]:
        out.append(("FAIL", "the first screen is blank: nothing rendered (see the page errors, and the screenshot)"))
    if m["wall"]:
        out.append(("FAIL", "the first screen is a sign-in wall; judges do not create accounts"))
    if m["fieldsBeforeAction"] >= 3:
        out.append(("WARN", f"{m['fieldsBeforeAction']} form fields sit above the primary action; a demo deployment "
                    "opens on a finished run, not a setup form"))
    if m["scrollWidth"] > m["vw"] + 2:
        if m.get("clipX"):
            out.append(("WARN", f"content is {m['scrollWidth']} px wide in a {m['vw']} px window; it is clipped, so "
                        "the page does not scroll sideways, but check nothing a judge needs is cut off"))
        else:
            out.append(("FAIL", f"the page is {m['scrollWidth']} px wide in a {m['vw']} px window (it scrolls sideways)"))
    u = m.get("unhidden") or {}
    if u.get("n"):
        n = u["n"]
        out.append(("FAIL", f"{n} element{'s' if n != 1 else ''} with the hidden attribute still render"
                    f"{'s' if n == 1 else ''} on the page ({', '.join(u['examples'])}{', ...' if n > 3 else ''}): a CSS "
                    "display rule overrides the hidden attribute; add `[hidden] { display: none !important; }`"))
    if m["overlap"]:
        out.append(("WARN", "a canvas overlaps the headline; decoration never sits over the words that say what this is"))
    if m["dead"] or m["comingSoon"]:
        out.append(("WARN", "dead or 'coming soon' controls on the first screen: " + (", ".join(m["dead"]) or "'coming soon' text")))
    for word, where in m["promise"]:
        if where == "missing":
            out.append(("WARN", f"\"{word}\" is promised by the name or tagline and is not on the first screen"))
        elif where == "headline":
            out.append(("WARN", f"\"{word}\" appears only in the name or headline; nothing in the first screen's "
                        "content backs it"))
        else:
            out.append(("ok", f"\"{word}\" is in the first screen's content"))
    if m["vw"] < 600 and not m.get("viewportMeta", True) and not m["blank"]:
        out.append(("WARN", "the page has no <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">: this "
                    "check opens a narrow window, but a real phone would show the desktop layout shrunk to fit"))
    if m.get("scrollY"):
        out.append(("WARN", f"the page opens scrolled {m['scrollY']} px down (an autofocus or an anchor); positions are "
                    "measured in the window as it opened"))
    f = m["font"]
    if f:
        out.append(("WARN" if f["min"] < 12 else "ok",
                    f"text on the first screen: smallest {round(f['min'], 1):g} px" + (f" (\"{f['sample']}\")" if f["min"] < 12 else "")
                    + f", median {round(f['median'], 1):g} px"))
    return out


def launch_hint(e):
    return ("foldcheck could not start Chromium (%s). On your own machine: python3 -m playwright install chromium. "
            "In Claude's cloud workspace it is already installed: check PLAYWRIGHT_BROWSERS_PATH instead of "
            "installing." % str(e).split("\n")[0][:200])


PROBE_TRIES, PROBE_TIMEOUT_S, RETRY_MS = 4, 30, 1000


async def probe(page, args):
    """The measurements. Taken again when the page navigates under the probe (a client-side redirect, a reload)
    or is too busy to answer (a heavy WebGL scene on a slow machine); raises RuntimeError when it never answers."""
    last = None
    for _ in range(PROBE_TRIES):
        try:
            return await asyncio.wait_for(page.evaluate(PROBE, [args.action, args.result, args.promise]), PROBE_TIMEOUT_S)
        except asyncio.TimeoutError:
            last = f"the page did not answer in {PROBE_TIMEOUT_S} s"
        except Exception as e:  # noqa: BLE001 - the context was destroyed by a navigation, or the page threw
            last = str(e).split("\n")[0][:160]
        try:
            await page.wait_for_load_state("domcontentloaded", timeout=10000)
        except Exception:  # noqa: BLE001
            pass
        await page.wait_for_timeout(RETRY_MS)
    raise RuntimeError(last or "no answer")


async def run(args):
    from playwright.async_api import async_playwright
    out_dir = args.out or tempfile.mkdtemp(prefix="foldcheck-")
    os.makedirs(out_dir, exist_ok=True)
    report, failed, unmeasured = {"url": args.url, "sizes": {}}, False, False
    named = [s for s in (args.action, args.result) if s]
    async with async_playwright() as p:
        try:
            b = await p.chromium.launch(args=["--no-sandbox", "--use-gl=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist"])
        except Exception as e:  # noqa: BLE001 - a missing browser is not a verdict on the page
            print(launch_hint(e), file=sys.stderr)
            return 2
        for size in args.sizes:
            w, h = (int(x) for x in size.lower().split("x"))
            entry = {"findings": []}
            report["sizes"][size] = entry

            def say(level, msg):
                entry["findings"].append([level, msg])
                print(f"[{size}] {level:5} {msg}")

            # a plain narrow window, not phone emulation: emulation zooms a too-wide page out to fit, which hides
            # the sideways scroll this is here to catch
            kw = {"storage_state": args.storage_state} if args.storage_state else {}
            ctx = await b.new_context(viewport={"width": w, "height": h}, device_scale_factor=1, has_touch=w < 600,
                                      **kw)
            if args.init_script:
                src = args.init_script
                if os.path.isfile(src):
                    with open(src, encoding="utf-8") as fh:
                        src = fh.read()
                await ctx.add_init_script(src)
            page = await ctx.new_page()
            errs, docs = [], []
            page.on("pageerror", lambda e: errs.append(str(e)[:160]))

            def on_response(r, page=page, docs=docs):
                try:
                    if r.request.is_navigation_request() and r.frame == page.main_frame:
                        docs.append(r.status)
                except Exception:  # noqa: BLE001
                    pass
            page.on("response", on_response)
            try:
                resp = await page.goto(args.url, wait_until="domcontentloaded", timeout=60000)
                status = resp.status if resp else None
            except Exception as e:  # noqa: BLE001 - any load failure is the finding
                say("FAIL", f"the page did not load: {str(e).splitlines()[0][:160]} (is the server running and the "
                            "address right? A judge would get the same)")
                failed = True
                await ctx.close()
                continue
            try:
                await page.wait_for_load_state("networkidle", timeout=15000)
            except Exception:  # noqa: BLE001
                pass
            await page.wait_for_timeout(args.wait)
            try:
                m = await probe(page, args)
            except RuntimeError as e:
                say("SKIP", f"this size could not be measured ({e}); open it by hand at {size} and check the first "
                            "screen yourself")
                unmeasured = True
                await ctx.close()
                continue
            waited = args.wait

            def absent(mm):
                return (args.action and (not mm["action"] or mm["action"].get("hidden"))) or (
                    args.result and (mm["result"].get("missing") or mm["result"].get("hidden")))

            while named and absent(m) and waited < args.wait + args.patience:   # a page that renders late
                await page.wait_for_timeout(500)
                waited += 500
                try:
                    m = await probe(page, args)
                except RuntimeError:
                    break   # keep the last measurements that were taken
            shot = os.path.join(out_dir, f"first_{size}.png")
            try:
                await page.screenshot(path=shot, full_page=False, timeout=30000)
            except Exception as e:  # noqa: BLE001 - a scene too busy to capture still has its measurements
                shot = None
                print(f"[{size}] no screenshot at this size ({str(e).splitlines()[0][:120]})")
            entry.update({"measurements": m, "screenshot": shot, "status": status, "final_url": page.url,
                          "page_errors": errs[:5], "waited_ms": waited})
            print(f"[{size}] status {status} | h1: {m['h1']!r} | page height {m['scrollHeight']} px")
            if page.url.rstrip("/") != args.url.rstrip("/"):
                print(f"[{size}]   redirected to {page.url}")
            for line in m["firstLines"][:5]:
                print(f"[{size}]   | {line}")
            if status and status >= 400:
                say("FAIL", f"HTTP {status}" + (" (if this machine reaches the web through a proxy, open the URL from "
                                                "another network before reading this as the page's fault)"
                                                if status >= 500 else ""))
                failed = True
            elif docs and docs[-1] >= 400:
                # the product loaded, then reloaded itself into an error page: what was measured is not the product
                say("SKIP", f"the page loaded, then reloaded into HTTP {docs[-1]}; what is on screen is an error page, so "
                            "this size was not measured. Run it again, and from another network if this one goes "
                            "through a proxy")
                unmeasured = True
                await ctx.close()
                continue
            judged = args.device == "both" or (args.device == "phone") == (w < 600)
            for level, msg in judge(m, args):
                if level == "FAIL" and not judged:
                    level, msg = "WARN", msg + f" (not failing: judges use a {args.device})"
                say(level, msg)
                failed = failed or level == "FAIL"
            if named and not absent(m) and waited > args.wait and waited >= 5000:
                say("WARN", f"the named action or result appeared about {waited / 1000:.0f} s after the page loaded; "
                            "a judge looks at an unfinished screen until then")
            if errs:
                say("WARN", f"{len(errs)} page error(s): {errs[0]}")
            await ctx.close()
        await b.close()
    report["verdict"] = "FAIL" if failed else "NOT MEASURED" if unmeasured else "PASS"
    with open(os.path.join(out_dir, "foldcheck.json"), "w", encoding="utf-8") as f:
        json.dump(report, f, indent=1)
    print(f"foldcheck: {report['verdict']} (screenshots and foldcheck.json in {out_dir}; read the screenshots too: "
          "this measures position, not sense)")
    return 1 if failed else 2 if unmeasured else 0


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("url")
    ap.add_argument("--action", help="the primary action: a CSS selector, or text=<the button's label>")
    ap.add_argument("--result", help="the element that shows the product's work: a CSS selector, or text=<words in it>")
    ap.add_argument("--promise", nargs="*", default=[], help="words the name or tagline promises, to find in the "
                    "first screen's content (the name and headline themselves do not count)")
    ap.add_argument("--sizes", nargs="+", default=["1440x900", "390x844"])
    ap.add_argument("--device", choices=("both", "desktop", "phone"), default="both",
                    help="what judges open it on, when the event says; findings at the other size only warn")
    ap.add_argument("--wait", type=int, default=4000, help="ms to wait after load before measuring")
    ap.add_argument("--storage-state", dest="storage_state",
                    help="a Playwright storage-state JSON (cookies and localStorage) to open the page signed in")
    ap.add_argument("--init-script", dest="init_script",
                    help="JavaScript (or a file of it) run before the page's own scripts, e.g. to put a session in "
                         "localStorage; run once signed out and once signed in, because some defects show only "
                         "after sign-in")
    ap.add_argument("--patience", type=int, default=8000, help="extra ms to keep looking for a named action or "
                    "result that has not rendered yet")
    ap.add_argument("--out", help="folder for screenshots and foldcheck.json (default: a temporary folder)")
    args = ap.parse_args(argv)
    for s in args.sizes:
        if not re.fullmatch(r"\d{3,4}x\d{3,4}", s.lower()):
            ap.error(f"size {s!r} should look like 1440x900")
    widths = [int(s.lower().split("x")[0]) for s in args.sizes]
    if args.device == "phone" and not any(w < 600 for w in widths):
        ap.error("--device phone needs a size under 600 px wide in --sizes")
    if args.device == "desktop" and not any(w >= 600 for w in widths):
        ap.error("--device desktop needs a size 600 px wide or more in --sizes")
    try:
        return asyncio.run(run(args))
    except ImportError:
        print("foldcheck needs Playwright for Python. On your own machine: pip install playwright, then "
              "python3 -m playwright install chromium. In Claude's cloud workspace only `pip install playwright` "
              "(Chromium is already there).", file=sys.stderr)
        return 2
    except Exception as e:  # noqa: BLE001 - a crash is not a verdict on the page
        print(f"foldcheck could not finish ({type(e).__name__}: {str(e).splitlines()[0][:200]}). Nothing was "
              "measured; this is not a pass.", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
