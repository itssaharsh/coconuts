#!/usr/bin/env python3
"""Rebuild every file in public/audio from assets-src/audio-raw.

Usage: python3 tools/audio/build.py [name ...]   (no args = everything)
Needs ffmpeg + numpy. Prints the exact ffmpeg commands it runs.

One-shots: cut from a source time, high-pass 20 Hz (removes DC), mono, fade out,
gain so the peak is -1.5 dBFS (measured with ffmpeg volumedetect), MP3 -q:a 4, 44.1 kHz.
'perc' items refine an approximate onset hint to the first sample that reaches
-20 dB relative to the local peak and start 3 ms earlier.
Music: excerpt of k*S seconds (S = autocorrelation-derived 16-bar section length),
fade in 0.3 s / out 1.5 s, two-pass loudnorm to -20 LUFS, 96 kbps mono MP3.
"""
import os, re, subprocess, sys, json
import numpy as np

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
RAW = os.path.join(ROOT, 'assets-src', 'audio-raw')
OUT = os.path.join(ROOT, 'public', 'audio')
SR = 44100

# name -> (source relative to RAW, mode, start/onset seconds, duration s, fade-out s)
OS = 'oga/x/100-CC0-SFX_0/'
ITEMS = {
 'foley/coconuts-1':   ('fs/843303.mp3', 'perc', 1.045, 0.22, 0.04),
 'foley/coconuts-2':   ('fs/843303.mp3', 'perc', 3.512, 0.22, 0.04),
 'foley/coconuts-3':   ('fs/363028.mp3', 'perc', 0.630, 0.22, 0.04),
 'foley/door-knock-1': ('fs/268500.mp3', 'perc', 0.271, 0.25, 0.06),
 'foley/door-knock-2': ('fs/256513.mp3', 'perc', 0.071, 0.20, 0.08),
 'foley/door-knock-3': ('fs/193873.mp3', 'perc', 0.005, 0.25, 0.06),
 'foley/door-slam-1':  (OS+'door_close_02.ogg', 'perc', 0.053, 0.90, 0.15),
 'foley/door-slam-2':  ('oga/x/door_close_-_starninjas/door.2.ogg', 'perc', 0.065, 0.70, 0.12),
 'foley/bell-1':       ('fs/398281.mp3', 'perc', 0.0, 2.3, 0.6),
 'foley/bell-2':       ('fs/685111.mp3', 'perc', 0.809, 1.8, 0.5),
 'foley/thunder-1':    ('fs/241777.mp3', 'raw', 0.06, 3.6, 0.9),
 'foley/thunder-2':    ('fs/119788.mp3', 'raw', 0.50, 3.5, 1.0),
 'foley/thunder-crack-1': ('fs/200990.mp3', 'perc', 0.555, 1.6, 0.5),
 'foley/whistle-fall-1': ('fs/497093.mp3', 'raw', 0.0, 1.15, 0.06),
 'foley/whistle-fall-2': ('fs/517633.mp3', 'raw', 3.575, 1.2, 0.08),
 'foley/whistle-rise-1': ('fs/497092.mp3', 'raw', 0.02, 1.15, 0.06),
 'foley/glass-1':      ('oga/glass_breaking.wav', 'perc', 0.016, 1.2, 0.2),
 'foley/glass-2':      ('oga/x/sfx_breaking_and_falling/bfh1_glass_breaking_06.ogg', 'perc', 0.0, 0.85, 0.15),
 'foley/glass-3':      ('oga/x/sfx_breaking_and_falling/bfh1_glass_breaking_03.ogg', 'perc', 0.002, 0.75, 0.15),
 'stage/curtain':      ('fs/365528.mp3', 'raw', 0.10, 2.6, 0.6),
 'stage/creak':        ('oga/creaky_door_hinge.wav', 'raw', 0.20, 2.8, 0.5),
 'stage/whinny':       ('fs/347036.mp3', 'raw', 1.30, 2.6, 0.6),
 'stage/clang-1':      ('oga/x/sword_clash/sword_clash.2.ogg', 'perc', 0.03, 0.70, 0.15),
 'stage/clang-2':      ('oga/x/sword_clash/sword_clash.7.ogg', 'perc', 0.123, 0.75, 0.15),
 'stage/clang-3':      ('oga/x/sword_clash/sword_clash.9.ogg', 'perc', 0.174, 0.75, 0.15),
 'stage/applause':     ('commons/Sound_Effects_Applause_after_a_concert.ogg', 'raw', 2.0, 4.0, 0.8),  # also faded in 0.25 s (FADE_IN)
 'stage/clap':         ('fs/484323.mp3', 'perc', 0.133, 0.30, 0.1),
 'stage/boing':        ('oga/boing.flac', 'perc', 0.001, 1.1, 0.3),
 'stage/step-1':       ('oga/x/steps/stone01.ogg', 'perc', 0.0, 0.30, 0.08),
 'stage/step-2':       ('fs/390764.mp3', 'perc', 0.028, 0.28, 0.08),
 'stage/thud':         ('fs/346694.mp3', 'perc', 0.479, 0.80, 0.2),
 'stage/laugh-1':      ('fs/678668.mp3', 'raw', 0.10, 1.6, 0.5),
 'stage/laugh-2':      ('fs/678669.mp3', 'raw', 0.15, 2.5, 0.7),
 'stage/laugh-3':      ('fs/678670.mp3', 'raw', 0.05, 2.4, 0.7),
 'stage/gasp-1':       ('fs/635110.mp3', 'raw', 0.0, 1.0, 0.3),
 'stage/gasp-2':       ('fs/480774.mp3', 'raw', 1.0, 1.1, 0.4),
 'stage/ooh-1':        ('fs/264499.mp3', 'raw', 0.25, 1.5, 0.5),
 'stage/ooh-2':        ('fs/264499.mp3', 'raw', 2.25, 1.6, 0.5),
 'stage/cheer':        ('fs/678543.mp3', 'raw', 0.9, 2.8, 0.8),
 'stage/whoosh-1':     ('fs/495390.mp3', 'raw', 0.0, 0.7, 0.25),
 'stage/whoosh-2':     ('fs/495390.mp3', 'raw', 1.35, 0.7, 0.25),
 'stage/crash_far-1':  ('fs/135830.mp3', 'raw', 0.45, 1.0, 0.35),
 'stage/crash_far-2':  ('fs/209002.mp3', 'raw', 2.2, 1.1, 0.4),
}
FADE_IN = {'stage/applause': 0.25, 'stage/laugh-1': 0.08, 'stage/laugh-2': 0.08, 'stage/laugh-3': 0.08,
           'stage/gasp-2': 0.05, 'stage/ooh-1': 0.1, 'stage/ooh-2': 0.1, 'stage/cheer': 0.2,
           'stage/whoosh-1': 0.04, 'stage/whoosh-2': 0.06, 'stage/crash_far-1': 0.01, 'stage/crash_far-2': 0.01}
# extra filters: crash_far is low-passed so it reads as distant
EXTRA = {'stage/crash_far-1': 'lowpass=f=4000', 'stage/crash_far-2': 'lowpass=f=4000'}
MUSIC = {
 'music/sensation-rag':     ('commons/Scott_Joplin_Sensation_Rag_1908_.ogg',),
 'music/peacherine-rag':    ('commons/Scott_Joplin_Peacherine_Rag_1901_.ogg',),
 'music/weeping-willow-rag':('commons/Scott_Joplin_Weeping_Willow_Rag_1903_.ogg',),
}

def run(cmd, capture=False):
    print('$', ' '.join(f'"{c}"' if ' ' in c else c for c in cmd), flush=True)
    return subprocess.run(cmd, capture_output=capture, text=True)

def load(path):
    b = subprocess.run(['ffmpeg','-v','error','-i',path,'-ac','1','-ar',str(SR),'-f','f32le','-'],
                       capture_output=True).stdout
    return np.frombuffer(b, dtype=np.float32)

def channels(path):
    r = subprocess.run(['ffprobe','-v','error','-select_streams','a:0','-show_entries','stream=channels',
                        '-of','csv=p=0',path], capture_output=True, text=True)
    return int(r.stdout.strip().strip(',') or 1)

def refine(x, hint):
    a = max(0, int((hint-0.06)*SR)); b = min(len(x), int((hint+0.25)*SR))
    w = np.abs(x[a:b]); p = w.max()
    i = int(np.argmax(w > 0.1*p))           # first sample >= -20 dB re local peak
    return max(0.0, (a+i)/SR - 0.003)

def mono_chain(path):
    return ['pan=mono|c0=0.5*c0+0.5*c1'] if channels(path) > 1 else []

def max_volume(base, chain):
    r = run(['ffmpeg','-hide_banner','-nostats']+base+['-af',','.join(chain+['volumedetect']),'-f','null','-'], capture=True)
    return float(re.search(r'max_volume: (-?[\d.]+) dB', r.stderr).group(1))

def oneshot(name, spec):
    src, mode, t, dur, fo = spec
    path = os.path.join(RAW, src)
    ss = refine(load(path), t) if mode == 'perc' else t
    # atrim (decode from the start, then cut): input-side -ss mis-decodes MP3 sources, output-side -ss cuts after the filters
    chain = [f'atrim=start={ss:.4f}:duration={dur:.3f}', 'asetpts=PTS-STARTPTS', 'highpass=f=20'] + mono_chain(path) + ([EXTRA[name]] if name in EXTRA else []) + ([f'afade=t=in:d={FADE_IN[name]}'] if name in FADE_IN else []) + [f'afade=t=out:st={dur-fo:.3f}:d={fo:.3f}']
    base = ['-i', path]
    pk = max_volume(base, chain)
    gain = -1.5 - pk
    out = os.path.join(OUT, name + '.mp3')
    os.makedirs(os.path.dirname(out), exist_ok=True)
    for _ in range(4):   # re-encode until the DECODED mp3 peaks at about -1.5 dBFS (MP3 overshoots on clipped sources)
        c = chain + [f'volume={gain:.2f}dB']
        run(['ffmpeg','-y','-v','error']+base+['-af',','.join(c),'-ac','1','-ar',str(SR),
             '-c:a','libmp3lame','-q:a','4','-map_metadata','-1',out])
        y = load(out); got = 20*np.log10(max(float(np.abs(y).max()), 1e-9))
        if -2.0 <= got <= -1.0: break
        gain += -1.5 - got
    print(f'# {name}: start {ss:.4f}s dur {dur}s gain {gain:+.2f} dB', flush=True)

def section_period(x):
    h = int(0.005*SR); n = len(x)//h*h
    e = np.abs(x[:n]).reshape(-1, h).max(1)
    d = np.maximum(np.diff(np.log(e+1e-4)), 0); f = d - d.mean()
    ac = np.correlate(f, f, 'full')[len(f)-1:]
    lo, hi = 50, 200                         # beat 250 ms .. 1 s
    beat = lo + int(ac[lo:hi].argmax())
    a, b = int(30*beat), int(34*beat)        # ~16 bars of 2/4 = 32 beats
    S = a + int(ac[a:b].argmax())
    first = int(np.argmax(e > 0.02))*0.005
    return S*0.005, beat*0.005, first

def music(name, spec):
    path = os.path.join(RAW, spec[0])
    x = load(path)
    S, beat, first = section_period(x)
    k = max(1, round(75/S))
    while k*S > 90: k -= 1
    dur = k*S; start = max(0.0, first-0.02)
    print(f'# {name}: beat {beat:.3f}s section {S:.3f}s first {first:.2f}s -> k={k} dur {dur:.2f}s', flush=True)
    chain = [f'atrim=start={start:.3f}:duration={dur:.3f}', 'asetpts=PTS-STARTPTS', 'highpass=f=20'] + mono_chain(path) + ['afade=t=in:d=0.3', f'afade=t=out:st={dur-1.5:.3f}:d=1.5']
    base = ['-i', path]
    ln = 'loudnorm=I=-20:TP=-1.5:LRA=11'
    r = run(['ffmpeg','-hide_banner','-nostats']+base+['-af',','.join(chain+[ln+':print_format=json']),'-f','null','-'], capture=True)
    j = json.loads(re.search(r'\{[^{}]*"input_i"[^{}]*\}', r.stderr, re.S).group(0))
    ln2 = (f'{ln}:measured_I={j["input_i"]}:measured_LRA={j["input_lra"]}:measured_TP={j["input_tp"]}'
           f':measured_thresh={j["input_thresh"]}:offset={j["target_offset"]}:linear=true')
    out = os.path.join(OUT, name + '.mp3'); os.makedirs(os.path.dirname(out), exist_ok=True)
    run(['ffmpeg','-y','-v','error']+base+['-af',','.join(chain+[ln2]),'-ac','1','-ar',str(SR),
         '-c:a','libmp3lame','-b:a','96k','-map_metadata','-1',out])

if __name__ == '__main__':
    want = set(sys.argv[1:])
    for n, s in ITEMS.items():
        if not want or n in want: oneshot(n, s)
    for n, s in MUSIC.items():
        if not want or n in want: music(n, s)
