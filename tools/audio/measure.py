#!/usr/bin/env python3
"""Measure every mp3 under public/audio and print a table (+ flags).
columns: duration, peak dBFS, mean(RMS) dBFS, ms to first sample > -20 dBFS,
spectral centroid Hz, DC offset, t90 = time by which 90% of the energy has passed (s),
tail = RMS of the last 10% re peak (dB, a high value = file ends in noise / never decays)."""
import os, subprocess, sys, glob
import numpy as np
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
OUT = os.path.join(ROOT, 'public', 'audio'); SR = 44100
def load(p):
    b = subprocess.run(['ffmpeg','-v','error','-i',p,'-ac','1','-ar',str(SR),'-f','f32le','-'],capture_output=True).stdout
    return np.frombuffer(b, dtype=np.float32)
db = lambda v: 20*np.log10(max(float(v), 1e-9))
rows = []
for p in sorted(glob.glob(OUT+'/**/*.mp3', recursive=True)):
    x = load(p); n = len(x); pk = np.abs(x).max()
    idx = np.where(np.abs(x) > 0.1)[0]; first = idx[0]/SR*1000 if len(idx) else -1
    X = np.abs(np.fft.rfft(x*np.hanning(n))); f = np.fft.rfftfreq(n, 1/SR)
    cen = (X*f).sum()/X.sum()
    c = np.cumsum(x.astype(np.float64)**2); t90 = np.searchsorted(c, 0.9*c[-1])/SR
    tail = db(np.sqrt((x[-n//10:]**2).mean())) - db(pk)
    rows.append(dict(name=os.path.relpath(p, OUT), size=os.path.getsize(p), dur=n/SR, pk=db(pk),
                     rms=db(np.sqrt((x**2).mean())), first=first, cen=cen, dc=float(x.mean()), t90=t90, tail=tail))
print('%-26s %6s %5s %6s %6s %7s %6s %8s %5s %7s' % ('file','KB','dur','peak','mean','first>-20','cent','dc','t90','tail'))
flags = []
for r in rows:
    print('%-26s %6.1f %5.2f %6.1f %6.1f %7.0fms %6.0f %8.5f %5.2f %7.1f' % (r['name'], r['size']/1024, r['dur'], r['pk'], r['rms'], r['first'], r['cen'], r['dc'], r['t90'], r['tail']))
    perc = not r['name'].startswith('music') and not any(k in r['name'] for k in ('thunder-1','thunder-2','curtain','creak','applause','whistle','whinny','laugh','gasp','ooh','cheer','whoosh','crash_far'))
    if perc and r['first'] > 15: flags.append((r['name'], 'late transient %.0f ms' % r['first']))
    if r['pk'] > -1.0: flags.append((r['name'], 'peak %.1f dBFS' % r['pk']))
    if abs(r['dc']) > 0.005: flags.append((r['name'], 'DC offset %.4f' % r['dc']))
    if r['tail'] > -25 and not r['name'].startswith('music') and 'applause' not in r['name']: flags.append((r['name'], 'tail only %.0f dB below peak (does not decay)' % r['tail']))
tot = sum(r['size'] for r in rows); print('\ntotal %.0f KB (%d files)' % (tot/1024, len(rows)))
# near-duplicate takes of the same prop: compare duration/centroid/rms
groups = {}
for r in rows:
    k = os.path.basename(r['name']).rsplit('-', 1)[0] if r['name'][-5].isdigit() else None
    if k: groups.setdefault((os.path.dirname(r['name']), k), []).append(r)
for (d, k), g in groups.items():
    for i in range(len(g)):
        for j in range(i+1, len(g)):
            a, b = g[i], g[j]
            if abs(a['cen']-b['cen'])/max(a['cen'], 1) < 0.03 and abs(a['dur']-b['dur']) < 0.03 and abs(a['rms']-b['rms']) < 1.0:
                flags.append((a['name']+' ~ '+b['name'], 'near-identical measurements'))
print('\nFLAGS:'); [print(' ', n, '-', m) for n, m in flags] if flags else print('  none')
