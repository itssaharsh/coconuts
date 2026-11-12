#!/usr/bin/env python3
"""Cut the demo video from a storyboard: captures of real gameplay, captions beside or over the picture, title and end
cards, the effects the game played and one continuous music bed.

  python3 tools/video/cut.py [qa/video2/storyboard.json] [--plan] [--only=id1,id2]

Reads the storyboard, writes qa/video2/final.mp4 (1920x1080, 30 fps, H.264 + AAC) and qa/video2/contact.jpg (a frame
from the middle of every segment, labelled). --plan resolves every anchor and prints the shots without rendering.
Intermediate files (caption images, segment clips, effects tracks) are cached under qa/video2/build/.
See qa/video2/README.md for the storyboard fields.

Nothing is drawn into the gameplay picture: it is only cropped, scaled, cut and sped up; captions sit on a paper panel
beside it (layout "side") or on a card over it (layout "full").
"""
import hashlib, json, math, os, re, shutil, subprocess, sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))
W, H, FPS = 1920, 1080, 30
DISSOLVE = 0.3  # into and out of cards
XFADE = 0.25  # caption cross-fade
THREADS = '4'
LIBS = '/tmp/claude-1000/-home-saharsh-contri-meta/09352a2d-5dc4-44d6-9385-cc1fa60c8188/scratchpad/libs/root/usr/lib/x86_64-linux-gnu'
FONTS = ('https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,400..800'
         '&family=Instrument+Sans:wght@400..700&family=Limelight&display=swap')

# the product's look (index.html, src/landing/serial.css, src/landing/landing.css)
PAPER, INK, INK2, INK3, ACCENT, WALNUT, NIGHT = '#fbf7f0', '#2b2320', '#5b4a3f', '#86786c', '#e8b75a', '#6b4a2e', '#14100e'
BRUSH = ("url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 200 40' preserveAspectRatio='none'%3E"
         "%3Cpath fill='%23E8B75A' d='M7 21C30 11 78 9 118 11s66 2 77 9c-4 9-42 12-84 12S33 36 10 31C3 29 2 24 7 21z'/%3E"
         "%3Cpath fill='%23D9A23E' opacity='.45' d='M20 27c30 3 90 2 150-3-40 7-110 9-150 3z'/%3E%3C/svg%3E\") center / 100% 100% no-repeat")
MARK = ('<svg viewBox="0 0 26 24" aria-hidden="true"><ellipse cx="13" cy="21.6" rx="11" ry="2.2" fill="#D9C29B"/>'
        '<path d="M2 10.5h22c0 6.2-4.9 10.6-11 10.6S2 16.7 2 10.5z" fill="#7A4B2A"/><path d="M5 13.4c1.4 3.4 4.4 5.4 8 5.4" '
        'fill="none" stroke="#9A6A42" stroke-width="1.4" stroke-linecap="round"/><ellipse cx="13" cy="10.5" rx="11" ry="3.4" '
        'fill="#4A2C18"/><ellipse cx="13" cy="10.6" rx="9.4" ry="2.5" fill="#F6EBD3"/></svg>')


def log(*m):
    print('[cut]', *m, flush=True)


def run(cmd, **kw):
    r = subprocess.run(cmd, **kw)
    if r.returncode != 0:
        raise SystemExit(f'command failed ({r.returncode}): {" ".join(map(str, cmd))[:600]}')
    return r


def ff(*args):
    run(['ffmpeg', '-y', '-hide_banner', '-loglevel', 'error', '-filter_complex_threads', THREADS, '-filter_threads', THREADS, *args])


def digest(*parts) -> str:
    return hashlib.sha1(json.dumps(parts, sort_keys=True, default=str).encode()).hexdigest()[:16]


def esc(s: str) -> str:
    return (s or '').replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')


def marked(s: str) -> str:
    """Escape, and turn *word* into a word with the brush underline (markup only, the copy is unchanged)."""
    return re.sub(r'\*([^*]+)\*', r'<span class="brush">\1</span>', esc(s))


# ---------------------------------------------------------------------------------------------------------- sources
class Source:
    """A capture directory: frames (one per 1/30 s of the show), log.txt (SND lines) and mark.json (the show clock at
    the first captured frame)."""

    def __init__(self, name: str, cfg, build: str):
        cfg = {'dir': cfg} if isinstance(cfg, str) else dict(cfg)
        self.name = name
        self.dir = os.path.join(ROOT, cfg['dir'])
        self.view_override = cfg.get('view')
        self.build = build
        if not os.path.isdir(self.dir):
            raise SystemExit(f'source {name}: no directory {self.dir}')
        mark = json.load(open(os.path.join(self.dir, 'mark.json')))
        self.clock = float(mark['clock'])
        idx = [int(m.group(1)) for f in os.listdir(self.dir) if (m := re.match(r'frame-(\d+)\.jpg$', f))]
        if not idx:
            raise SystemExit(f'source {name}: no frames in {self.dir}')
        self.nframes = max(idx) + 1
        self.events = []
        logp = os.path.join(self.dir, 'log.txt')
        if os.path.exists(logp):
            for line in open(logp, encoding='utf-8', errors='ignore'):
                m = re.search(r'SND (\d+(?:\.\d+)?) (hit|stage|music) (\S+) (\d+(?:\.\d+)?)', line)
                if m:
                    self.events.append((float(m.group(1)), m.group(2), m.group(3)))
        self.events.sort()
        self.story = []  # events.txt: `EVT <show seconds> <text>` (WAIT, CUE, TITLE, STAGE, SET, REEL, PITCH lines)
        evp = os.path.join(self.dir, 'events.txt')
        if os.path.exists(evp):
            for line in open(evp, encoding='utf-8', errors='ignore'):
                m = re.match(r'\s*EVT (\d+(?:\.\d+)?) (.*?)\s*$', line)
                if m:
                    self.story.append((float(m.group(1)), m.group(2)))
        self.story.sort(key=lambda x: x[0])
        self.start = self.clock
        self.end = self.clock + self.nframes / FPS
        self._views = {}

    def frame(self, i: int) -> str:
        return os.path.join(self.dir, 'frame-%05d.jpg' % max(0, min(self.nframes - 1, i)))

    def f(self, show_t: float) -> int:
        return int(round((show_t - self.clock) * FPS))

    def matches(self, name: str):
        parts = name.split()
        if len(parts) == 2:
            return [t for t, k, key in self.events if k == parts[0] and key == parts[1]]
        return [t for t, k, key in self.events if key == parts[0]]

    def evt_matches(self, prefix: str):
        return [t for t, text in self.story if text.startswith(prefix)]

    def resolve(self, a, what='') -> float:
        """An anchor: show seconds (number), "start", "end", {"t": s}, or {"snd": "stage creak" | [first found, else
        next...], "nth": 1 (negative counts from the end), "after": anchor, "before": anchor, "offset": s,
        "else": anchor used when no such sound is in the log}. {"evt": "WAIT cue glass", ...} does the same on events.txt,
        matching the start of the text after the time."""
        if isinstance(a, (int, float)):
            t = float(a)
        elif a in ('start', 'end'):
            t = self.start if a == 'start' else self.end
        elif isinstance(a, dict):
            if 't' in a:
                t = float(a['t'])
            elif a.get('end'):
                t = self.end
            elif a.get('start'):
                t = self.start
            elif 'snd' in a or 'evt' in a:
                kind = 'snd' if 'snd' in a else 'evt'
                names = a[kind] if isinstance(a[kind], list) else [a[kind]]
                find = self.matches if kind == 'snd' else self.evt_matches
                after = self.resolve(a['after'], what) if 'after' in a else None
                before = self.resolve(a['before'], what) if 'before' in a else None
                t = None
                for n in names:
                    ts = [x for x in find(n) if (after is None or x > after + 1e-3) and (before is None or x < before - 1e-3)]
                    if ts:
                        k = int(a.get('nth', 1))
                        if abs(k) > len(ts):
                            raise SystemExit(f'{what}: only {len(ts)} "{n}" in {self.name}, asked for nth {k}')
                        t = ts[k - 1] if k > 0 else ts[k]
                        break
                if t is None:
                    if 'else' in a:  # a fallback anchor, with its own offset
                        return self.resolve(a['else'], what)
                    raise SystemExit(f'{what}: no {names} in the {"log" if kind == "snd" else "events"} of {self.name}')
            else:
                raise SystemExit(f'{what}: anchor {a} has none of t, snd, evt, start, end')
            t += float(a.get('offset', 0.0))
        else:
            raise SystemExit(f'{what}: cannot read anchor {a!r}')
        return max(self.start, min(self.end - 1 / FPS, t))

    def fx(self) -> str:
        """The effects-only track of the capture (tools/video/soundtrack.py --no-music), film time 0 = first frame."""
        logp = os.path.join(self.dir, 'log.txt')
        key = digest(self.dir, self.clock, self.nframes, os.path.getmtime(logp) if os.path.exists(logp) else 0,
                     os.path.getmtime(os.path.join(ROOT, 'tools/video/soundtrack.py')))
        out = os.path.join(self.build, 'fx', f'{self.name}-{key}.wav')
        if not os.path.exists(out):
            os.makedirs(os.path.dirname(out), exist_ok=True)
            if not self.events:
                ff('-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono', '-t', f'{self.nframes / FPS:.3f}', '-c:a', 'pcm_s16le', out)
            else:
                run([sys.executable, os.path.join(ROOT, 'tools/video/soundtrack.py'), logp, out, '--no-music',
                     '--offset', repr(self.clock), '--length', f'{self.nframes / FPS:.3f}'], stdout=subprocess.DEVNULL)
        return out

    def view(self, f0: int, f1: int):
        """The headset view's rectangle (x, y, w, h) in the frames f0..f1: a per-source setting wins, else it is found."""
        if self.view_override == 'whole':
            from PIL import Image
            return (0, 0, *Image.open(self.frame(f0)).size)
        if self.view_override:
            return tuple(int(v) for v in self.view_override)
        key = (f0, f1)
        if key not in self._views:
            cache_p = os.path.join(self.build, 'views.json')
            cache = json.load(open(cache_p)) if os.path.exists(cache_p) else {}
            ck = digest(self.dir, self.nframes, os.path.getmtime(self.frame(f0)), f0, f1)
            if ck not in cache:
                n = 5
                picks = sorted({int(f0 + (f1 - f0) * (i + 0.5) / n) for i in range(n)})
                cache[ck] = detect_view([self.frame(i) for i in picks], f'{self.name} frames {f0}-{f1}')
                json.dump(cache, open(cache_p, 'w'), indent=1)
            self._views[key] = tuple(cache[ck])
        return self._views[key]


def detect_view(paths, what):
    """The page around the headset view is a flat, dark brown gradient; the view's left and right edges are vertical
    lines. Take the strongest vertical edge in each half, then the rows along which both edges exist."""
    import numpy as np
    from PIL import Image
    imgs = [np.asarray(Image.open(p).convert('RGB'), dtype=np.int16) for p in paths]
    h, w, _ = imgs[0].shape
    gx = np.median(np.stack([np.abs(np.diff(a, axis=1)).sum(2) for a in imgs]), axis=0)  # h x (w-1)
    # a capture of the emulator window itself is all view. A page capture has the page in the outer strips: flat (a
    # smooth gradient) and brown (red well over blue); the dark room around a theatre is flat but grey-black.
    l0, l1 = int(w * 0.02), int(w * 0.14)
    strips = [a[int(h * 0.2):int(h * 0.8)] for a in imgs]
    flat, brown = True, True
    for a in strips:
        for part in (a[:, l0:l1], a[:, w - l1:w - l0]):
            g = np.abs(np.diff(part.astype(np.float32), axis=1)).sum(2)
            m = part.reshape(-1, 3).mean(0)
            flat &= float(np.mean(g)) < 3.0
            brown &= (m[0] - m[2]) > 12 and m[0] < 140
    if not (flat and brown):
        log(f'view of {what}: the whole frame ({w}x{h}): no page beside it')
        return [0, 0, w, h]
    band = gx[int(h * 0.2):int(h * 0.8)]
    col = np.median(band, axis=0)
    # the page is smooth: its columns barely change. The view's edge is the first column from either side that does,
    # for most of the band's rows (the theatre inside the view has stronger edges, so never take the strongest).
    page = float(np.median(np.concatenate([col[: max(4, w // 40)], col[-max(4, w // 40):]])))
    thr = max(12.0, 6 * page)
    strong = np.where(col > thr)[0]
    if len(strong) == 0:
        raise SystemExit(f'{what}: cannot find the headset view; set "view": [x, y, w, h] for this source in the storyboard')
    li, ri = int(strong[0]), int(strong[-1])
    if li > w * 0.45 or ri < w * 0.55:
        raise SystemExit(f'{what}: cannot find the headset view (edges at {li}, {ri}); set "view": [x, y, w, h] for this source')
    x0, x1 = li + 1, ri  # the view spans columns x0..x1
    # rows: the view's top and bottom edges are horizontal lines across the view's columns that do not go on into the
    # page beside it (a bar of the page below, spanning the whole width, does)
    gy = np.median(np.stack([np.abs(np.diff(a, axis=0)).sum(2) for a in imgs]), axis=0)  # (h-1) x w
    gxm = np.median(gx[:, x0 + 2:x1 - 1], axis=1)
    inside = np.median(gy[:, x0 + 2:x1 - 1], axis=1)
    cols = [c for c in (list(range(0, max(0, x0 - 6))) + list(range(min(w, x1 + 7), w)))]
    outside = np.median(gy[:, cols], axis=1) if len(cols) > 8 else np.zeros_like(inside)
    line = (inside > thr) & (outside < 0.3 * inside)
    top = [y for y in range(0, h // 2) if line[y]]
    y0 = top[0] + 1 if top else 0
    if top and float(np.median(gxm[: max(1, top[0])])) > thr:  # textured above the line: the view starts at the top
        y0 = 0
    bottom = [y for y in range(h - 2, h // 2, -1) if line[y]]
    y1 = bottom[0] if bottom else h - 1
    # two pixels in from every side: never a sliver of the page or its edge
    x0, y0, x1, y1 = x0 + 2, y0 + 2, x1 - 2, y1 - 2
    rect = [int(x0), int(y0), int(x1 - x0 + 1), int(y1 - y0 + 1)]
    if rect[2] < 0.3 * w or rect[3] < 0.3 * h:
        raise SystemExit(f'{what}: found an implausible view {rect}; set "view": [x, y, w, h] for this source')
    log(f'view of {what}: x {rect[0]} y {rect[1]} {rect[2]}x{rect[3]}')
    return rect


# ------------------------------------------------------------------------------------------------------------ layout
def even(v):
    return int(round(v / 2.0)) * 2


def geometry(view, layout, zoom=1.0, center=None):
    """The crop from the frame and where it goes in the 1920x1080 picture."""
    vx, vy, vw, vh = view
    if center is None:
        cx, cy = 0.5, 0.5
    elif isinstance(center, (int, float)):
        cx, cy = 0.5, float(center)
    else:
        cx, cy = float(center[0]), float(center[1])
    zoom = max(1.0, float(zoom or 1.0))
    if layout in ('full', 'wide'):
        cw = vw / zoom
        ch = cw * H / W
        if ch > vh:
            ch = vh
            cw = ch * W / H
        out_w, out_h = W, H
    else:
        cw, ch = vw / zoom, vh / zoom
        out_h = H
        out_w = even(H * cw / ch)
        if out_w > W - 560:  # keep room for the caption panel
            out_w = W - 560
            cw = ch * out_w / out_h
    cw, ch = int(round(cw)), int(round(ch))
    x = int(round(vx + cx * vw - cw / 2))
    y = int(round(vy + cy * vh - ch / 2))
    x = max(vx, min(vx + vw - cw, x))
    y = max(vy, min(vy + vh - ch, y))
    return {'crop': (cw, ch, x, y), 'size': (out_w, out_h)}


# ------------------------------------------------------------------------------------------------------- HTML -> PNG
BASE_CSS = f"""
*{{box-sizing:border-box;margin:0;padding:0}}
html,body{{width:100%;height:100%;overflow:hidden;background:transparent;-webkit-font-smoothing:antialiased}}
body{{font-family:'Instrument Sans',ui-sans-serif,system-ui,sans-serif;color:{INK}}}
.brush{{position:relative;display:inline-block;z-index:0}}
.brush::after{{content:'';position:absolute;z-index:-1;left:-0.06em;right:-0.1em;bottom:-0.04em;height:0.42em;transform:rotate(-2deg);background:{BRUSH}}}
.kicker{{display:flex;align-items:center;gap:16px;font-weight:600;font-size:28px;line-height:1.2;letter-spacing:.12em;text-transform:uppercase;color:{WALNUT}}}
.kicker::before{{content:'';width:44px;height:5px;flex:none;border-radius:3px;background:linear-gradient(90deg,#b58630,{ACCENT})}}
.title{{font-family:'Bricolage Grotesque',ui-sans-serif,sans-serif;font-weight:800;font-variation-settings:'opsz' 96;line-height:1.02;letter-spacing:-.035em;color:{INK};text-wrap:balance}}
.body{{font-weight:500;line-height:1.36;color:{INK2};text-wrap:pretty}}
"""

FIT_JS = """
(spec) => {
  const out = {};
  for (const [sel, max, min, lines, lh] of spec) {
    const el = document.querySelector(sel);
    if (!el) continue;
    let s = max, n = 0;
    for (; s >= min; s -= 1) {
      el.style.fontSize = s + 'px';
      n = Math.round(el.getBoundingClientRect().height / (s * lh));
      const box = el.closest('.cap');
      const room = box ? parseFloat(getComputedStyle(box).maxWidth) - 68 : el.clientWidth;
      if (n <= lines && el.scrollWidth <= el.clientWidth + 1 && (!box || isNaN(room) || el.scrollWidth <= room)) break;
    }
    if (s < min) { s = min; el.style.fontSize = s + 'px'; n = Math.round(el.getBoundingClientRect().height / (s * lh)); }
    out[sel] = {size: s, lines: n, over: n > lines};
  }
  return out;
}
"""


def page(body_html, css, w, h):
    return (f'<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="{FONTS}">'
            f'<style>{BASE_CSS}{css}html,body{{width:{w}px;height:{h}px}}</style></head><body>{body_html}</body></html>')


def panel_base_html(view_w):
    pw = W - view_w
    css = f"""
body{{background:{PAPER}}}
.panel{{position:absolute;left:{view_w}px;top:0;width:{pw}px;height:{H}px;background:radial-gradient(90% 60% at 0% 0%,#fffdf6 0%,rgba(255,253,246,0) 70%),{PAPER};
  box-shadow:inset 18px 0 26px -20px rgba(43,35,32,.55)}}
.mark{{position:absolute;left:64px;top:54px;display:flex;align-items:center;gap:14px;font-family:'Limelight',Georgia,serif;font-size:30px;color:{INK};letter-spacing:.01em}}
.mark svg{{width:42px;height:39px}}
"""
    return page(f'<div class="panel"><div class="mark">{MARK}<span>Coconuts: the Serial</span></div></div>', css, W, H)


def side_caption_html(cap, view_w):
    pw = W - view_w
    css = f"""
.cap{{position:absolute;left:{view_w + 64}px;width:{pw - 64 - 60}px;top:150px;bottom:110px;display:flex;flex-direction:column;justify-content:center}}
.kicker{{margin-bottom:26px}}
.title{{font-size:96px}}
.body{{margin-top:32px;font-size:40px}}
"""
    parts = []
    if cap.get('kicker'):
        parts.append(f'<div class="kicker">{esc(cap["kicker"])}</div>')
    if cap.get('title'):
        parts.append(f'<div class="title">{marked(cap["title"])}</div>')
    if cap.get('body'):
        parts.append(f'<div class="body">{marked(cap["body"])}</div>')
    fit = [['.title', 96, 54, 3, 1.02], ['.body', 40, 30, 3, 1.36]]
    return page(f'<div class="cap">{"".join(parts)}</div>', css, W, H), fit


POS = {'bl': ('bottom', 'left'), 'br': ('bottom', 'right'), 'tl': ('top', 'left'), 'tr': ('top', 'right'),
       'bottom-left': ('bottom', 'left'), 'bottom-right': ('bottom', 'right'), 'top-left': ('top', 'left'), 'top-right': ('top', 'right'),
       'bottom-center': ('bottom', 'center'), 'top-center': ('top', 'center')}


def card_caption_html(cap, pos='bottom-left'):
    """The caption over the picture ("full" and "wide"): a lower-third card (or a top one) with ONE title line and at
    most one short body line, paper at 94 %, 20 px radius, a soft shadow, placed in a corner or centred."""
    v, hz = POS.get(pos or 'bottom-left', ('bottom', 'left'))
    place = f'{v}:44px;' + ('left:50%;transform:translateX(-50%);' if hz == 'center' else f'{hz}:48px;')
    css = f"""
.cap{{position:absolute;{place}max-width:{int(W * 0.72)}px;padding:20px 34px 24px;border-radius:20px;background:rgba(251,247,240,.94);
  box-shadow:0 2px 4px rgba(43,35,32,.22),0 22px 44px -16px rgba(20,16,14,.6)}}
.kicker{{margin-bottom:10px;font-size:26px}}
.title{{font-size:58px;white-space:nowrap;line-height:1.08;text-wrap:nowrap;letter-spacing:-.025em}}
.body{{margin-top:6px;font-size:32px;white-space:nowrap}}
"""
    parts = []
    if cap.get('kicker'):
        parts.append(f'<div class="kicker">{esc(cap["kicker"])}</div>')
    if cap.get('title'):
        parts.append(f'<div class="title">{marked(cap["title"])}</div>')
    if cap.get('body'):
        parts.append(f'<div class="body">{marked(cap["body"])}</div>')
    fit = [['.title', 58, 44, 1, 1.08], ['.body', 32, 30, 1, 1.36]]
    return page(f'<div class="cap">{"".join(parts)}</div>', css, W, H), fit


def card_html(card):
    style = card.get('style', 'film')
    if style == 'film':
        css = f"""
body{{background:radial-gradient(90% 120% at 50% 0%,#2a211b 0%,{NIGHT} 70%)}}
.rule{{position:absolute;inset:64px;border:2px solid rgba(255,255,255,.82);border-radius:10px;
  box-shadow:0 0 0 9px {NIGHT},0 0 0 11px rgba(255,255,255,.5)}}
.c{{position:absolute;inset:120px 160px;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center}}
h1{{font-family:'Limelight',Georgia,serif;font-weight:400;font-size:132px;line-height:1.06;letter-spacing:.04em;text-transform:uppercase;color:#fff;text-wrap:balance}}
.orn{{display:flex;align-items:center;gap:18px;margin:44px 0 40px}}
.orn i{{display:block;width:120px;height:2px;background:rgba(255,255,255,.7)}}
.orn b{{display:block;width:12px;height:12px;transform:rotate(45deg);border:2px solid rgba(255,255,255,.8)}}
p{{font-family:'Limelight',Georgia,serif;font-size:56px;line-height:1.25;letter-spacing:.02em;color:rgba(255,255,255,.88);text-wrap:balance}}
"""
        sub = f'<div class="orn"><i></i><b></b><i></i></div><p>{esc(card["sub"])}</p>' if card.get('sub') else ''
        return page(f'<div class="rule"></div><div class="c"><h1>{esc(card.get("title", ""))}</h1>{sub}</div>', css, W, H), [['h1', 132, 72, 3, 1.06]]
    css = f"""
body{{background:radial-gradient(80% 70% at 15% 0%,#fffdf6 0%,rgba(255,253,246,0) 70%),{PAPER}}}
.c{{position:absolute;inset:0 140px;display:flex;flex-direction:column;justify-content:center;align-items:center;text-align:center}}
.icon{{width:130px;height:120px;margin-bottom:34px}}
h1{{font-family:'Bricolage Grotesque',sans-serif;font-weight:800;font-variation-settings:'opsz' 96;font-size:136px;line-height:1;letter-spacing:-.035em;color:{INK}}}
.sub{{margin-top:56px;font-size:46px;font-weight:500;color:{INK2}}}
.url{{margin-top:10px;font-family:'Bricolage Grotesque',sans-serif;font-weight:700;font-variation-settings:'opsz' 48;font-size:84px;letter-spacing:-.02em;color:{INK}}}
.url span{{box-shadow:inset 0 -0.22em 0 {ACCENT}}}
.small{{margin-top:22px;font-size:32px;font-weight:500;color:{INK3}}}
.url+.small{{margin-top:64px}}
"""
    title = marked(card.get('title', ''))
    html = (f'<div class="c"><div class="icon">{MARK}</div><h1>{title}</h1>'
            + (f'<div class="sub">{esc(card["sub"])}</div>' if card.get('sub') else '')
            + (f'<div class="url"><span>{esc(card["url"])}</span></div>' if card.get('url') else '')
            + ''.join(f'<div class="small">{esc(x)}</div>' for x in ([card['small']] if isinstance(card.get('small'), str) else card.get('small', [])))
            + '</div>')
    return page(html.replace('<svg ', '<svg style="width:100%;height:100%" '), css, W, H), [['h1', 136, 90, 2, 1.0]]


class Renderer:
    """Renders HTML pages to PNG with headless Chromium, cached by content."""

    def __init__(self, build):
        self.dir = os.path.join(build, 'html')
        os.makedirs(self.dir, exist_ok=True)
        self.jobs = {}
        self.fits = {}

    def want(self, html, fit, transparent=True):
        key = digest(html, fit, transparent)
        out = os.path.join(self.dir, key + '.png')
        meta = os.path.join(self.dir, key + '.json')
        if not os.path.exists(out) or not os.path.exists(meta):
            self.jobs[key] = (html, fit, transparent, out, meta)
        return out, meta

    def flush(self):
        if not self.jobs:
            return
        os.environ['LD_LIBRARY_PATH'] = LIBS + ((':' + os.environ['LD_LIBRARY_PATH']) if os.environ.get('LD_LIBRARY_PATH') else '')
        from playwright.sync_api import sync_playwright
        log(f'rendering {len(self.jobs)} caption/card images')
        with sync_playwright() as p:
            b = p.chromium.launch()
            pg = b.new_page(viewport={'width': W, 'height': H})
            for key, (html, fit, transparent, out, meta) in self.jobs.items():
                pg.set_content(html, wait_until='networkidle')
                missing = pg.evaluate("""async () => {
                  const want = ["800 40px 'Bricolage Grotesque'", "500 40px 'Instrument Sans'", "600 40px 'Instrument Sans'", "40px 'Limelight'"];
                  const bad = [];
                  for (const f of want) { try { const r = await document.fonts.load(f); if (!r.length) bad.push(f); } catch (e) { bad.push(f); } }
                  await document.fonts.ready;
                  return bad;
                }""")
                if missing:
                    log(f'WARNING: fonts did not load ({missing}); the image uses a fallback')
                loaded = sorted({f for f in pg.evaluate("[...document.fonts].filter(f => f.status === 'loaded').map(f => f.family)")})
                res = pg.evaluate(FIT_JS, fit) if fit else {}
                pg.screenshot(path=out, omit_background=transparent)
                json.dump({'fit': res, 'fonts': sorted(set(loaded))}, open(meta, 'w'))
            b.close()
        self.jobs = {}


# ---------------------------------------------------------------------------------------------------------- planning
def plan_segment(seg, sources, what):
    """A segment's shots: (source, t0, t1, speed, layout, zoom, center), split where the speed or layout changes."""
    src = sources[seg['source']] if seg['source'] in sources else None
    if src is None:
        raise SystemExit(f'{what}: unknown source {seg["source"]!r}')
    t0 = src.resolve(seg['from'], what + '.from')
    speed = float(seg.get('speed', 1.0))
    if 'to' in seg:
        t1 = src.resolve(seg['to'], what + '.to')
    elif 'duration' in seg:
        t1 = min(src.end, t0 + float(seg['duration']) * speed)
    else:
        raise SystemExit(f'{what}: needs "to" or "duration"')
    if t1 <= t0 + 0.1:
        raise SystemExit(f'{what}: empty range {t0:.2f}..{t1:.2f}')
    cuts = {t0, t1}
    fast = []
    for i, fr in enumerate(seg.get('fast', [])):
        a, b = src.resolve(fr['from'], f'{what}.fast[{i}].from'), src.resolve(fr['to'], f'{what}.fast[{i}].to')
        a, b = max(a, t0), min(b, t1)
        if b > a:
            fast.append((a, b, float(fr['speed'])))
            cuts |= {a, b}
    switches = []
    for i, sw in enumerate(seg.get('switch', [])):
        at = src.resolve(sw['at'], f'{what}.switch[{i}].at')
        if t0 < at < t1:
            switches.append((at, sw))
            cuts.add(at)
    switches.sort(key=lambda x: x[0])
    edges = sorted(cuts)
    shots = []
    for a, b in zip(edges, edges[1:]):
        if b - a < 0.5 / FPS:
            continue
        sp = speed
        for fa, fb, fs in fast:
            if fa <= a + 1e-6 and b <= fb + 1e-6:
                sp = fs
        lay = {'layout': seg.get('layout', 'auto'), 'zoom': seg.get('zoom', 1.0), 'center': seg.get('center')}
        for at, sw in switches:
            if at <= a + 1e-6:
                lay = {'layout': sw.get('layout', lay['layout']), 'zoom': sw.get('zoom', lay['zoom']), 'center': sw.get('center', lay['center'])}
        f0, f1 = src.f(a), src.f(b)
        n_out = max(1, int(round((f1 - f0) / sp)))
        shots.append({'src': src, 't0': a, 't1': b, 'f0': f0, 'f1': f1, 'speed': sp, 'n': n_out, **lay})
    return shots


def src_w(src):
    from PIL import Image
    return Image.open(src.frame(0)).size[0]


def render_segment(seg, shots, R, build):
    """One clip for the segment: the shots laid out and joined (captions are laid over the whole cut later)."""
    seg_view = shots[0]['src'].view(shots[0]['f0'], max(shots[0]['f0'], shots[-1]['f1'] - 1))  # one view per segment
    for sh in shots:
        src = sh['src']
        view = seg_view
        if sh['layout'] == 'auto':  # a square view on a page: side; the emulator window itself (16:9): wide
            sh['layout'] = 'wide' if view[2] / view[3] > 1.5 else 'side'
        g = geometry(view, sh['layout'], sh['zoom'], sh['center'])
        sh['view'], sh['geo'] = view, g
        if sh['layout'] == 'side':
            sh['base'], _ = R.want(panel_base_html(g['size'][0]), None, transparent=False)
    R.flush()
    key = digest([(s['src'].dir, s['src'].nframes, os.path.getmtime(s['src'].frame(s['f0'])), s['f0'], s['f1'], s['n'], s['speed'], s['geo'], s.get('base')) for s in shots])
    out = os.path.join(build, 'seg', f'{seg["id"]}-{key}.mp4')
    n_total = sum(s['n'] for s in shots)
    if os.path.exists(out):
        return out, n_total
    os.makedirs(os.path.dirname(out), exist_ok=True)
    tmp = os.path.join(build, 'tmp', seg['id'])
    shutil.rmtree(tmp, ignore_errors=True)
    inputs, graph, labels = [], [], []
    for k, sh in enumerate(shots):
        # the frames of the shot, at its speed, as a numbered sequence of links: every output frame is a captured frame
        d = os.path.join(tmp, f's{k}')
        os.makedirs(d)
        for j in range(sh['n']):
            fi = sh['f0'] + int(math.floor(j * sh['speed'] + 1e-6))
            os.symlink(sh['src'].frame(fi), os.path.join(d, 'f-%05d.jpg' % j))
        idx = sum(1 for x in inputs if x == '-i')
        inputs += ['-framerate', str(FPS), '-i', os.path.join(d, 'f-%05d.jpg')]
        cw, ch, cx, cy = sh['geo']['crop']
        ow, oh = sh['geo']['size']
        chain = f'[{idx}:v]crop={cw}:{ch}:{cx}:{cy},scale={ow}:{oh}:flags=lanczos,setsar=1'
        if sh['layout'] == 'side':
            bidx = idx + 1
            inputs += ['-loop', '1', '-framerate', str(FPS), '-t', f'{sh["n"] / FPS:.4f}', '-i', sh['base']]
            graph.append(f'{chain}[p{k}]')
            graph.append(f'[{bidx}:v]format=rgb24[b{k}]')
            graph.append(f'[b{k}][p{k}]overlay=0:0:shortest=1,format=yuv420p,trim=end_frame={sh["n"]},setpts=PTS-STARTPTS[v{k}]')
        else:
            graph.append(f'{chain},format=yuv420p,trim=end_frame={sh["n"]},setpts=PTS-STARTPTS[v{k}]')
        labels.append(f'[v{k}]')
    graph.append(''.join(labels) + f'concat=n={len(labels)}:v=1:a=0,fps={FPS}[out]')
    ff(*inputs, '-filter_complex', ';'.join(graph), '-map', '[out]', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '12',
       '-pix_fmt', 'yuv420p', '-r', str(FPS), '-threads', THREADS, out)
    shutil.rmtree(tmp, ignore_errors=True)
    return out, n_total


def render_card(seg, R, build):
    n = int(round(float(seg.get('duration', 4)) * FPS))
    html, fit = card_html(seg['card'])
    png, meta = R.want(html, fit, transparent=False)
    R.flush()
    out = os.path.join(build, 'seg', f'{seg["id"]}-{digest(png, n)}.mp4')
    if not os.path.exists(out):
        os.makedirs(os.path.dirname(out), exist_ok=True)
        ff('-loop', '1', '-framerate', str(FPS), '-i', png, '-frames:v', str(n), '-vf', 'format=yuv420p', '-c:v', 'libx264',
           '-preset', 'veryfast', '-crf', '12', '-tune', 'stillimage', '-r', str(FPS), '-threads', THREADS, out)
    return out, n, png, meta


# ------------------------------------------------------------------------------------------------------------ main
def source_waiting(d):
    """Why a capture directory cannot be used yet ('' when it can): its recording log must end with `exit 0`."""
    run_log = d.rstrip('/') + '.log'
    if not os.path.isdir(d):
        return 'no directory'
    if os.path.exists(run_log) and not os.path.exists(os.path.join(d, 'film.mp4')):
        lines = [x.strip() for x in open(run_log, errors='ignore') if x.strip()]
        if not lines or lines[-1] != 'exit 0':
            return f'{os.path.basename(run_log)} does not end with exit 0'
    for f in ('log.txt', 'mark.json'):
        if not os.path.exists(os.path.join(d, f)):
            return f'no {f}'
    return ''


def check_reuse(segs, plans):
    """No shot twice: warn when two segments use overlapping stretches of the same capture."""
    used = []
    for s, p in zip(segs, plans):
        for x in p or []:
            for sid, d, a, b in used:
                if d == x['src'].dir and sid != s['id'] and min(b, x['t1']) - max(a, x['t0']) > 0.1 and not s.get('reuse_ok'):
                    log(f'WARNING: {s["id"]} reuses {x["src"].name} {max(a, x["t0"]):.2f}-{min(b, x["t1"]):.2f} already in {sid}')
            used.append((s['id'], x['src'].dir, x['t0'], x['t1']))


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    flags = {a for a in sys.argv[1:] if a.startswith('--')}
    sb_path = os.path.abspath(args[0] if args else os.path.join(ROOT, 'qa/video2/storyboard.json'))
    sb = json.load(open(sb_path))
    out_dir = os.path.dirname(sb_path)
    build = os.path.join(out_dir, 'build')
    os.makedirs(build, exist_ok=True)
    final = os.path.join(out_dir, sb.get('output', {}).get('file', 'final.mp4'))
    contact = os.path.join(out_dir, sb.get('output', {}).get('contact', 'contact.jpg'))
    max_seconds = float(sb.get('output', {}).get('max_seconds', 175))
    cfgs = dict(sb.get('sources', {}))
    only = [f.split('=', 1)[1].split(',') for f in flags if f.startswith('--only=')]
    segs = [dict(s) for s in sb['segments'] if not s.get('skip') or (only and s['id'] in only[0])]
    if only:  # a quick look at a few segments (skipped ones too): preview.mp4 and preview-contact.jpg, final.mp4 untouched
        segs = [s for s in segs if s['id'] in only[0]]
        final = os.path.join(out_dir, 'preview.mp4')
        contact = os.path.join(out_dir, 'preview-contact.jpg')
    for s in segs:
        if 'source' in s and s['source'] not in cfgs:  # a capture directory named directly
            cfgs[s['source']] = s['source']
    sources, waiting = {}, {}
    for name, cfg in cfgs.items():
        d = cfg if isinstance(cfg, str) else cfg['dir']
        why = source_waiting(os.path.join(ROOT, d))
        if why:
            waiting[name] = why
            log(f'source {name} ({d}) is not complete: {why}; its segments are placeholder cards')
        else:
            sources[name] = Source(name, cfg, build)
    # a segment can stand in for another source until it lands: "unless_ready": "<source>" drops it once that source is
    # complete, "if_ready": true drops a segment (instead of a placeholder card) while its own source is not
    segs = [s for s in segs if not (s.get('unless_ready') and s['unless_ready'] in sources)
            and not (s.get('if_ready') and s.get('source') in waiting)]
    for s in segs:
        if s.get('source') in waiting:
            s['card'] = {'style': 'film', 'title': 'Placeholder', 'sub': f'{s["id"]}: waiting for {s["source"]}'}
            s['duration'] = float(s.get('placeholder_seconds', s.get('duration', 5)))
            s['placeholder'] = True

    # plan
    plans = []
    for s in segs:
        what = f'segment {s["id"]}'
        if 'card' in s:
            plans.append(None)
        else:
            plans.append(plan_segment(s, sources, what))
    for s, p in zip(segs, plans):
        if p is None:
            log(f'{s["id"]:>10}  card {s.get("duration", 4)} s  "{s["card"].get("title", "")}"')
        else:
            desc = ', '.join(f'{x["t0"]:.2f}-{x["t1"]:.2f}' + (f' x{x["speed"]:g}' if x['speed'] != 1 else '') + f' {x["layout"]}' for x in p)
            log(f'{s["id"]:>10}  {p[0]["src"].name}  {desc}  -> {sum(x["n"] for x in p) / FPS:.2f} s')
    for s, p in zip(segs, plans):
        if p and s.get('caption_n') and s.get('caption'):  # {N}: seconds between two anchors of the source, one decimal
            src = p[0]['src']
            n = src.resolve(s['caption_n']['to'], s['id']) - src.resolve(s['caption_n']['from'], s['id'])
            s['caption'] = {k: (v.replace('{N}', f'{n:.1f}') if isinstance(v, str) else v) for k, v in s['caption'].items()}
            log(f'{s["id"]}: N = {n:.1f} s')
        if p and s.get('voice'):
            s['voice'] = dict(s['voice'])
            s['voice']['_t'] = p[0]['src'].resolve(s['voice']['at'], f'segment {s["id"]}.voice.at')
            log(f'{s["id"]}: voice {s["voice"]["file"]} at show {s["voice"]["_t"]:.2f}')
    check_reuse(segs, plans)
    for s in segs:
        t = (s.get('caption') or {}).get('title', '')
        if t and len(t.replace('*', '').split()) > 9 and s.get('layout', 'wide') != 'side':
            log(f'WARNING: {s["id"]}: caption title has {len(t.split())} words (at most 9)')
    if '--plan' in flags:
        return 0

    # pictures (every card image rendered in one browser session first)
    R = Renderer(build)
    for s in segs:
        if 'card' in s:
            R.want(*card_html(s['card']), transparent=False)
    R.flush()
    clips = []
    for s, p in zip(segs, plans):
        if p is None:
            path, n, png, meta = render_card(s, R, build)
            fit = json.load(open(meta)).get('fit', {})
            for sel, m in fit.items():
                if m.get('over'):
                    log(f'WARNING {s["id"]}: card {sel} needs more than its lines at {m["size"]} px')
            clips.append({'seg': s, 'path': path, 'n': n, 'card': True, 'shots': []})
        else:
            path, n = render_segment(s, p, R, build)
            clips.append({'seg': s, 'path': path, 'n': n, 'card': False, 'shots': p})
        log(f'segment {s["id"]}: {n / FPS:.2f} s')

    # timeline: hard cuts, except a dissolve into and out of a card
    t = 0.0
    for i, c in enumerate(clips):
        j = c['seg'].get('join')
        auto = sb.get('output', {}).get('card_dissolve', True) and (c['card'] or (i > 0 and clips[i - 1]['card']))
        c['dissolve_in'] = DISSOLVE if i > 0 and (j == 'dissolve' or (j is None and auto)) else 0.0
        if i > 0:
            t -= c['dissolve_in']
        c['start'] = t
        c['dur'] = c['n'] / FPS
        t += c['dur']
    total = t
    for i, c in enumerate(clips):
        c['dissolve_out'] = clips[i + 1]['dissolve_in'] if i + 1 < len(clips) else 0.0

    # captions: one image per run of shots with the same layout; same layout across a cut cross-fades, else switches
    items = []
    for c in clips:
        cap = c['seg'].get('caption')
        if c['card'] or not cap or not any(cap.get(k) for k in ('kicker', 'title', 'body')):
            continue
        tt = c['start']
        runs = []
        for sh in c['shots']:
            d = sh['n'] / FPS
            if runs and runs[-1]['layout'] == sh['layout'] and runs[-1]['geo']['size'] == sh['geo']['size']:
                runs[-1]['b'] += d
            else:
                runs.append({'layout': sh['layout'], 'geo': sh['geo'], 'a': tt, 'b': tt + d})
            tt += d
        for r in runs:
            if r['layout'] == 'side':
                html, fit = side_caption_html(cap, r['geo']['size'][0])
            else:
                html, fit = card_caption_html(cap, c['seg'].get('caption_pos', 'bottom-left'))
            png, meta = R.want(html, fit)
            items.append({'seg': c['seg']['id'], 'layout': r['layout'], 'a': r['a'], 'b': r['b'], 'png': png, 'meta': meta,
                          'clip': c})
    R.flush()
    merged = []
    for it in items:  # the same caption over consecutive segments stays up, without a fade at the cut
        if merged and merged[-1]['png'] == it['png'] and abs(merged[-1]['b'] - it['a']) < 1e-3:
            merged[-1]['b'] = it['b']
            merged[-1]['clip_end'] = it['clip']
        else:
            merged.append(it)
    items = merged
    for it in items:
        for sel, m in json.load(open(it['meta'])).get('fit', {}).items():
            flag = '  WARNING: over its line limit' if m.get('over') else ''
            log(f'caption {it["seg"]} ({it["layout"]}) {sel}: {m["size"]} px, {m["lines"]} lines{flag}')
    for k, it in enumerate(items):
        prev = items[k - 1] if k > 0 else None
        nxt = items[k + 1] if k + 1 < len(items) else None
        it['fi'] = it['fo'] = XFADE
        a, b = it['a'], it['b']
        if prev and abs(prev['b'] - a) < 1e-3 and prev['layout'] == it['layout'] == 'side':
            a -= XFADE / 2  # a cross-fade centred on the cut
        if nxt and abs(nxt['a'] - b) < 1e-3 and nxt['layout'] == it['layout'] == 'side':
            b += XFADE / 2
        elif nxt and abs(nxt['a'] - b) < 1e-3:
            it['fo'] = 0.0  # the layout changes at a hard cut: the old caption goes with its picture
        last = it.get('clip_end', it['clip'])
        if last['dissolve_out'] and abs(b - (last['start'] + last['dur'])) < 1e-3:
            it['fo'] = last['dissolve_out']
        if it['clip']['dissolve_in'] and abs(a - it['clip']['start']) < 1e-3:
            it['fi'] = it['clip']['dissolve_in']
        it['a'], it['b'] = max(0.0, a), min(total, b)

    # sound: the effects of every shot, cut with its picture; one music bed under everything
    fx_stem, music_stem = build_sound(clips, total, sb.get('music', {}), build)
    mix = os.path.join(build, 'mix.wav')
    loud = master(fx_stem, music_stem, mix, sb.get('master', {}))

    # the cut
    log(f'assembling {total:.2f} s')
    inputs, graph = [], []
    for c in clips:
        inputs += ['-i', c['path']]
    cur = None
    cur_len = 0.0
    for i, c in enumerate(clips):
        graph.append(f'[{i}:v]fps={FPS},settb=1/{FPS},format=yuv420p,setsar=1[c{i}]')
        if cur is None:
            cur, cur_len = f'[c{i}]', c['dur']
            continue
        nxt = f'[j{i}]'
        if c['dissolve_in']:
            graph.append(f'{cur}[c{i}]xfade=transition=fade:duration={c["dissolve_in"]:.3f}:offset={cur_len - c["dissolve_in"]:.4f},settb=1/{FPS}{nxt}')
            cur_len += c['dur'] - c['dissolve_in']
        else:
            graph.append(f'{cur}[c{i}]concat=n=2:v=1:a=0,settb=1/{FPS}{nxt}')
            cur_len += c['dur']
        cur = nxt
    base = len(clips)
    for k, it in enumerate(items):
        d = it['b'] - it['a']
        inputs += ['-loop', '1', '-framerate', str(FPS), '-t', f'{d:.4f}', '-i', it['png']]
        fades = ''
        if it['fi'] > 0:
            fades += f',fade=t=in:st=0:d={it["fi"]:.3f}:alpha=1'
        if it['fo'] > 0:
            fades += f',fade=t=out:st={max(0.0, d - it["fo"]):.4f}:d={it["fo"]:.3f}:alpha=1'
        graph.append(f'[{base + k}:v]format=rgba{fades},setpts=PTS-STARTPTS+{it["a"]:.4f}/TB[t{k}]')
        nxt = f'[o{k}]'
        graph.append(f'{cur}[t{k}]overlay=0:0:eof_action=pass:repeatlast=0:enable=\'between(t,{it["a"]:.4f},{it["b"]:.4f})\'{nxt}')
        cur = nxt
    graph.append(f'{cur}format=yuv420p[vout]')
    inputs += ['-i', mix]
    tmp_final = final + '.part.mp4'
    ff(*inputs, '-filter_complex', ';'.join(graph), '-map', '[vout]', '-map', f'{len(clips) + len(items)}:a',
       '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-r', str(FPS),
       '-g', '60', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2', '-t', f'{total:.4f}', '-movflags', '+faststart',
       '-threads', THREADS, tmp_final)
    os.replace(tmp_final, final)

    make_contact(final, clips, contact)
    r = subprocess.run(['ffmpeg', '-hide_banner', '-nostats', '-i', final, '-af', 'ebur128=peak=true', '-f', 'null', '-'], capture_output=True, text=True)
    tail = r.stderr[r.stderr.rindex('Summary:'):]
    loud['final_aac_integrated'] = float(re.search(r'I:\s+(-?[\d.]+) LUFS', tail).group(1))
    loud['final_aac_true_peak'] = float(re.search(r'Peak:\s+(-?[\d.]+) dBFS', tail).group(1))
    log(f'final.mp4 sound: {loud["final_aac_integrated"]} LUFS, true peak {loud["final_aac_true_peak"]} dBFS')
    report = {'total': round(total, 3), 'loudness': loud, 'segments': []}
    for c in clips:
        s = c['seg']
        e = {'id': s['id'], 'start': round(c['start'], 3), 'dur': round(c['dur'], 3)}
        if c['card']:
            e['card'] = s['card'].get('title')
        else:
            e['source'] = c['shots'][0]['src'].name
            e['dir'] = os.path.relpath(c['shots'][0]['src'].dir, ROOT)
            e['shots'] = [{'from': round(x['t0'], 3), 'to': round(x['t1'], 3), 'speed': x['speed'], 'layout': x['layout'],
                           'zoom': x['zoom'], 'center': x['center'], 'view': list(x['view'])} for x in c['shots']]
        report['segments'].append(e)
    report['levels'] = levels(fx_stem, music_stem, clips, loud)
    json.dump(report, open(os.path.join(out_dir, 'cut-report.json' if not only else 'preview-report.json'), 'w'), indent=1)
    log(f'wrote {os.path.relpath(final, ROOT)} ({total:.2f} s) and {os.path.relpath(contact, ROOT)}')
    if total > max_seconds:
        log(f'WARNING: {total:.2f} s is over the limit of {max_seconds:.0f} s')
        return 1
    return 0


def build_sound(clips, total, music_cfg, build):
    """Two stems at 48 kHz stereo: the effects (cut with the picture, sped with it) and the music bed (ducked under the
    effects)."""
    import numpy as np
    fx_out = os.path.join(build, 'fx-stem.wav')
    music_out = os.path.join(build, 'music-stem.wav')
    sr = 48000
    buf = np.zeros(int(math.ceil(total * sr)) + sr, dtype=np.float32)
    cache = {}
    voices = []

    def load(path, rate=sr):
        if path not in cache:
            r = run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-i', path, '-ac', '1', '-ar', str(rate), '-f', 'f32le', '-'], capture_output=True)
            cache[path] = np.frombuffer(r.stdout, dtype=np.float32)
        return cache[path]

    def tempo(x, sp):
        r = subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-f', 'f32le', '-ar', str(sr), '-ac', '1', '-i', '-',
                            '-af', f'atempo={sp:.5f}', '-f', 'f32le', '-'], input=x.astype(np.float32).tobytes(), capture_output=True)
        return np.frombuffer(r.stdout, dtype=np.float32)

    for c in clips:
        tt = c['start']
        for k, sh in enumerate(c['shots']):
            d = sh['n'] / FPS
            src = load(sh['src'].fx())
            a = int(round(sh['f0'] / FPS * sr))
            piece = src[a: a + int(round(d * sh['speed'] * sr))]
            if sh['speed'] > 1 + 1e-3 and len(piece):  # slower than life (a hold): the sound as it was, then silence
                piece = tempo(piece, sh['speed'])
            n = int(round(d * sr))
            piece = np.pad(piece, (0, max(0, n - len(piece))))[:n].copy()
            first, last = k == 0, k == len(c['shots']) - 1
            fin = c['dissolve_in'] if (first and c['dissolve_in']) else (0.012 if first else 0.0)
            fout = c['dissolve_out'] if (last and c['dissolve_out']) else (0.02 if last else 0.0)
            if fin > 0:
                m = min(n, int(fin * sr))
                piece[:m] *= np.linspace(0, 1, m, dtype=np.float32)
            if fout > 0:
                m = min(n, int(fout * sr))
                piece[n - m:] *= np.linspace(1, 0, m, dtype=np.float32)
            at = int(round(tt * sr))
            buf[at: at + n] += piece[: len(buf) - at]
            vo = c['seg'].get('voice')
            if vo and sh['t0'] - 1e-6 <= vo['_t'] < sh['t1']:  # a recorded line, laid in where the game heard it
                v = load(os.path.join(ROOT, vo['file'])) * (10 ** (float(vo.get('gain_db', 0)) / 20))
                vat = int(round((tt + (vo['_t'] - sh['t0']) / sh['speed']) * sr))
                end = min(len(buf), vat + len(v))
                buf[vat:end] += v[: end - vat]
                voices.append((vat / sr, end / sr, float(vo.get('duck_db', 8))))
                log(f'voice {vo["file"]} at {vat / sr:.2f} s of the film ({len(v) / sr:.2f} s)')
            tt += d
    buf = buf[: int(round(total * sr))]
    run(['ffmpeg', '-y', '-hide_banner', '-loglevel', 'error', '-f', 'f32le', '-ar', str(sr), '-ac', '1', '-i', '-', '-ac', '2',
         '-c:a', 'pcm_s16le', fx_out], input=buf.tobytes())

    # the music: the rags one after another (cross-faded), under everything, out under the end card
    files = [os.path.join(ROOT, f) for f in music_cfg.get('files', ['public/audio/music/sensation-rag.mp3', 'public/audio/music/peacherine-rag.mp3', 'public/audio/music/weeping-willow-rag.mp3'])]
    gain = float(music_cfg.get('gain_db', -12))
    fade_in = float(music_cfg.get('fade_in', 1.5))
    end_clip = clips[-1]
    fade_out_from = float(music_cfg.get('fade_out_from', end_clip['start'] if end_clip['card'] else total - 3))
    xf = float(music_cfg.get('crossfade', 2.5))
    duck = music_cfg.get('duck', {'threshold': 0.06, 'ratio': 3, 'attack': 8, 'release': 350})
    ins, g = [], []
    for i, f in enumerate(files):
        ins += ['-i', f]
        g.append(f'[{i}:a]aresample=48000,aformat=sample_rates=48000:channel_layouts=stereo[m{i}]')
    cur = '[m0]'
    for i in range(1, len(files)):
        g.append(f'{cur}[m{i}]acrossfade=d={xf}:c1=tri:c2=tri[mx{i}]')
        cur = f'[mx{i}]'
    g.append(f'{cur}apad=whole_dur={total:.4f},atrim=end={total:.4f},volume={gain:.2f}dB,afade=t=in:st=0:d={fade_in:.2f},'
             f'afade=t=out:st={fade_out_from:.3f}:d={max(0.5, total - fade_out_from - 0.2):.3f}[bed]')
    ins += ['-i', fx_out]
    fi = len(files)
    if duck:
        g.append(f'[{fi}:a]aformat=channel_layouts=stereo[sc]')
        g.append(f'[bed][sc]sidechaincompress=threshold={duck["threshold"]}:ratio={duck["ratio"]}:attack={duck["attack"]}:'
                 f'release={duck["release"]}:makeup=1[mus]')
    else:
        g.append('[bed]anull[mus]')
    ff(*ins, '-filter_complex', ';'.join(g), '-map', '[mus]', '-c:a', 'pcm_s16le', music_out)
    if voices:  # the music steps down under a spoken line (0.15 s ramps)
        r = run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-i', music_out, '-f', 'f32le', '-ac', '2', '-ar', str(sr), '-'], capture_output=True)
        mus = np.frombuffer(r.stdout, dtype=np.float32).reshape(-1, 2).copy()
        env = np.ones(len(mus), dtype=np.float32)
        tt = np.arange(len(mus), dtype=np.float32) / sr
        for a, b, db in voices:
            g_ = 10 ** (-db / 20)
            ramp = np.clip(np.minimum((tt - (a - 0.15)) / 0.15, ((b + 0.25) - tt) / 0.15), 0, 1)
            env = np.minimum(env, 1 - (1 - g_) * ramp)
        mus *= env[:, None]
        run(['ffmpeg', '-y', '-hide_banner', '-loglevel', 'error', '-f', 'f32le', '-ar', str(sr), '-ac', '2', '-i', '-', '-c:a', 'pcm_s16le', music_out],
            input=mus.tobytes())
    return fx_out, music_out


def last_json(text):
    i = text.rindex('{')
    return json.loads(text[i: text.index('}', i) + 1])


def master(fx, music, out, cfg):
    """Mix the stems and bring the whole to about -16 LUFS integrated, true peak under -1 dBFS (two-pass loudnorm)."""
    target, tp, lra = float(cfg.get('lufs', -16)), float(cfg.get('true_peak', -1.5)), float(cfg.get('lra', 11))
    mixed = out.replace('.wav', '-raw.wav')
    # a fast limiter on the few hardest hits first, so one gain can bring the whole to the target (linear loudnorm)
    pre = float(cfg.get('pre_limit_db', -4.0))
    ff('-i', fx, '-i', music, '-filter_complex', f'[0:a][1:a]amix=inputs=2:normalize=0:dropout_transition=0,'
       f'alimiter=limit={10 ** (pre / 20):.4f}:attack=1:release=60:level=disabled[m]', '-map', '[m]',
       '-c:a', 'pcm_s24le', mixed)
    r = subprocess.run(['ffmpeg', '-hide_banner', '-nostats', '-i', mixed, '-af', f'loudnorm=I={target}:TP={tp}:LRA={lra}:print_format=json',
                        '-f', 'null', '-'], capture_output=True, text=True)
    m = last_json(r.stderr)
    # one gain for the whole film (measured), then a limiter a little under the true-peak ceiling for the few hits
    # that would pass it; checked by measuring the result, and the gain trimmed once if it missed
    gain = target - float(m['input_i'])
    ceiling = 10 ** ((tp - 2.6) / 20)  # room for inter-sample peaks and the AAC encode
    for attempt in range(3):
        af = f'volume={gain:.3f}dB,alimiter=limit={ceiling:.4f}:attack=0.5:release=40:level=disabled,aresample=48000'
        r2 = subprocess.run(['ffmpeg', '-y', '-hide_banner', '-nostats', '-i', mixed, '-af', af, '-c:a', 'pcm_s24le', out],
                            capture_output=True, text=True)
        if r2.returncode:
            raise SystemExit(r2.stderr[-800:])
        chk = last_json(subprocess.run(['ffmpeg', '-hide_banner', '-nostats', '-i', out, '-af', f'loudnorm=I={target}:TP={tp}:print_format=json',
                                        '-f', 'null', '-'], capture_output=True, text=True).stderr)
        miss = target - float(chk['input_i'])
        if abs(miss) < 0.3:
            break
        gain += miss
    m2 = {'normalization_type': f'gain {gain:+.2f} dB + peak limiter'}
    # measure what was written
    r3 = subprocess.run(['ffmpeg', '-hide_banner', '-nostats', '-i', out, '-af', 'ebur128=peak=true', '-f', 'null', '-'], capture_output=True, text=True)
    tail = r3.stderr[r3.stderr.rindex('Summary:'):]
    i_val = float(re.search(r'I:\s+(-?[\d.]+) LUFS', tail).group(1))
    peak = float(re.search(r'Peak:\s+(-?[\d.]+) dBFS', tail).group(1))
    lra_v = float(re.search(r'LRA:\s+(-?[\d.]+) LU', tail).group(1))
    res = {'input_i': float(m['input_i']), 'input_tp': float(m['input_tp']), 'mode': m2.get('normalization_type'),
           'integrated': i_val, 'true_peak': peak, 'lra': lra_v, 'gain_db': round(gain, 2)}
    log(f'loudness: in {m["input_i"]} LUFS / {m["input_tp"]} dBTP -> out {i_val} LUFS, true peak {peak} dBFS, LRA {lra_v} ({res["mode"]})')
    return res


def levels(fx, music, clips, loud):
    """Per segment, as heard in the final mix: the effects' loudest 50 ms, the music's average and the gap."""
    import numpy as np

    def pcm(p):
        r = subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-i', p, '-ac', '1', '-ar', '48000', '-f', 'f32le', '-'], capture_output=True)
        return np.frombuffer(r.stdout, dtype=np.float32)

    gain = 10 ** (loud['gain_db'] / 20)
    a, b = pcm(fx) * gain, pcm(music) * gain
    n_all = max(len(a), len(b))
    a, b = np.pad(a, (0, n_all - len(a))), np.pad(b, (0, n_all - len(b)))
    win = 2400
    rows = []

    def db(x):
        return 20 * math.log10(max(x, 1e-9))

    for c in clips:
        s, e = int(c['start'] * 48000), int((c['start'] + c['dur']) * 48000)
        seg_a, seg_b = a[s:e], b[s:e]
        n = len(seg_a) // win
        if n == 0 or len(seg_b) < n * win:
            continue
        ra = np.sqrt((seg_a[: n * win].reshape(n, win) ** 2).mean(1))
        rb = np.sqrt((seg_b[: n * win].reshape(n, win) ** 2).mean(1))
        fx_peak = db(float(ra.max()))
        fx_rms = db(float(np.sqrt((seg_a ** 2).mean())))
        mus = db(float(np.sqrt((seg_b ** 2).mean())))
        # where an effect sounds (within 10 dB of its peak), how far under it is the music then
        hot = ra > ra.max() / 3.16
        under = db(float(ra[hot].mean())) - db(float(rb[hot].mean())) if hot.any() and rb[hot].mean() > 0 else None
        row = {'id': c['seg']['id'], 'fx_peak_db': round(fx_peak, 1), 'fx_rms_db': round(fx_rms, 1), 'music_rms_db': round(mus, 1),
               'gap_db': round(fx_peak - mus, 1), 'music_under_fx_when_sounding_db': None if under is None else round(under, 1)}
        rows.append(row)
        log(f'level {row["id"]:>10}: fx peak {row["fx_peak_db"]:6.1f}  fx rms {row["fx_rms_db"]:6.1f}  music rms {row["music_rms_db"]:6.1f}  '
            f'gap {row["gap_db"]:5.1f} dB  under-when-sounding {row["music_under_fx_when_sounding_db"]}')
    return rows


def make_contact(final, clips, out):
    from PIL import Image, ImageDraw, ImageFont
    tw, th, lab, cols = 640, 360, 58, 3
    rows = (len(clips) + cols - 1) // cols
    sheet = Image.new('RGB', (cols * tw, rows * (th + lab)), PAPER)
    dr = ImageDraw.Draw(sheet)
    try:
        f1 = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', 20)
        f2 = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', 16)
    except OSError:
        f1 = f2 = ImageFont.load_default()
    tmp = out + '.frame.png'
    for i, c in enumerate(clips):
        t = c['start'] + c['dur'] / 2
        run(['ffmpeg', '-y', '-hide_banner', '-loglevel', 'error', '-ss', f'{t:.3f}', '-i', final, '-frames:v', '1', '-vf', f'scale={tw}:{th}', tmp])
        im = Image.open(tmp).convert('RGB')
        x, y = (i % cols) * tw, (i // cols) * (th + lab)
        sheet.paste(im, (x, y + lab))
        s = c['seg']
        dr.text((x + 10, y + 6), f'{i + 1}. {s["id"]}  @ {c["start"]:.1f}s  ({c["dur"]:.1f}s)', fill=INK, font=f1)
        if c['card']:
            sub = 'card: ' + s['card'].get('title', '')
        else:
            sh = c['shots']
            sub = f'{sh[0]["src"].name} {sh[0]["t0"]:.1f}-{sh[-1]["t1"]:.1f}s  ' + '/'.join(dict.fromkeys(x['layout'] for x in sh))
            sps = sorted({x['speed'] for x in sh if x['speed'] != 1})
            if sps:
                sub += '  speed ' + ','.join(f'{v:g}' for v in sps)
        dr.text((x + 10, y + 32), sub[:70], fill=INK2, font=f2)
    os.remove(tmp)
    sheet.save(out, quality=88)


if __name__ == '__main__':
    sys.exit(main())
