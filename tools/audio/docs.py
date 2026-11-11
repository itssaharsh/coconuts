#!/usr/bin/env python3
"""Write public/audio/manifest.json and public/audio/CREDITS.md (only files that exist)."""
import os, json, sys
sys.path.insert(0, os.path.dirname(__file__))
import build
ACC = '2026-11-11'
OGA = 'https://opengameart.org'
F = OGA + '/sites/default/files/'
# OpenGameArt sources: key = path inside assets-src/audio-raw/oga/ (prefix match) -> (page, file url, author, what)
OGA_SRC = {
 'x/100-CC0-SFX_0/': (OGA+'/content/100-cc0-sfx', F+'100-CC0-SFX_0.zip', 'rubberduck'),
 'x/door_close_-_starninjas/': (OGA+'/content/4-door-closes', F+'door_close_-_starninjas.zip', 'StarNinjas'),
 'glass_breaking.wav': (OGA+'/content/glass-break', F+'glass_breaking.wav', 'Till Behrend'),
 'x/sfx_breaking_and_falling/': (OGA+'/content/75-cc0-breaking-falling-hit-sfx', F+'sfx_breaking_and_falling.zip', 'rubberduck'),
 'creaky_door_hinge.wav': (OGA+'/content/creaky-door-hinge-spooky', F+'creaky_door_hinge.wav', 'OpenGameArt user (page shows an e-mail address as the name; omitted here)'),
 'x/sword_clash/': (OGA+'/content/20-sword-sound-effects-attacks-and-clashes', F+'sword_clash_-_starninjas_0.zip', 'StarNinjas'),
 'boing.flac': (OGA+'/content/boing', F+'boing.flac', 'Aeva'),
 'x/steps/': (OGA+'/content/different-steps-on-wood-stone-leaves-gravel-and-mud', F+'%5Bkdd%5DDifferentSteps_0.zip', 'TinyWorlds'),
}
def tsv(path, key_col=0):
    d = {}
    if os.path.exists(path):
        for l in open(path, encoding='utf8'):
            c = l.rstrip('\n').split('\t'); d[c[key_col]] = c
    return d
FS = tsv(os.path.join(build.RAW, 'fs', 'meta.tsv'))
CM = tsv(os.path.join(build.RAW, 'commons', 'meta.tsv'))
WHAT = {
 'foley/coconuts': 'coconut-shell hoof clop', 'foley/door-knock': 'knock on a wooden door', 'foley/door-slam': 'wooden door slamming shut',
 'foley/bell': 'desk / reception bell ding with ring-out', 'foley/thunder-crack': 'thunder crack', 'foley/thunder': 'thunder-sheet / thunder roll',
 'foley/whistle-fall': 'slide whistle, falling', 'foley/whistle-rise': 'slide whistle, rising', 'foley/glass': 'breaking glass crash',
 'stage/curtain': 'curtain pull / swish', 'stage/creak': 'wooden door creak', 'stage/whinny': 'horse whinny', 'stage/clang': 'sword clash (metal on metal)',
 'stage/applause': 'audience applause', 'stage/clap': 'film clapperboard clap', 'stage/boing': 'comic boing', 'stage/step': 'footstep on stone', 'stage/thud': 'body fall thud',
}
def what(n):
    for k in sorted(WHAT, key=len, reverse=True):
        if n.startswith(k): return WHAT[k]
def source(src):
    kind, rest = src.split('/', 1)
    if kind == 'fs':
        c = FS[rest.split('.')[0]]
        return dict(page=c[3], url=c[4], author=c[2], title=c[1], lic='"This sound effect is released under the Creative Commons 0" (' + c[5].split('(')[1].rstrip(')') + ')')
    if kind == 'commons':
        c = CM[rest]
        return dict(page=c[4], url=c[5], author=c[2], title=c[1], lic='"%s" (Commons licence line; uploader %s)' % (c[6], c[3]))
    rest = rest.lstrip('/')
    for k, (pg, fu, au) in OGA_SRC.items():
        if rest.startswith(k): return dict(page=pg, url=fu, author=au, title=os.path.basename(rest), lic='"License(s): CC0"')
    raise KeyError(src)
manifest = {'foley': {}, 'stage': {}, 'music': []}
rows = []
for name, spec in build.ITEMS.items():
    rel = name + '.mp3'
    if not os.path.exists(os.path.join(build.OUT, rel)): continue
    grp, base = name.split('/'); prop = base.rsplit('-', 1)[0] if base[-1].isdigit() else base
    manifest[grp].setdefault(prop, []).append(rel)
    s = source(spec[0]); rows.append((rel, what(name), s, spec[0]))
meta = {
 'music/sensation-rag': ('Sensation Rag (1908)', 'Scott Joplin'), 'music/peacherine-rag': ('Peacherine Rag (1901)', 'Scott Joplin'),
 'music/weeping-willow-rag': ('Weeping Willow Rag (1903)', 'Scott Joplin'),
}
import subprocess
for name, spec in build.MUSIC.items():
    rel = name + '.mp3'; p = os.path.join(build.OUT, rel)
    if not os.path.exists(p): continue
    sec = float(subprocess.run(['ffprobe','-v','error','-show_entries','format=duration','-of','csv=p=0',p], capture_output=True, text=True).stdout)
    manifest['music'].append({'file': rel, 'title': meta[name][0], 'composer': meta[name][1], 'seconds': round(sec)})
    rows.append((rel, 'solo piano, %s (%s), excerpt %ds' % (meta[name][0], meta[name][1], round(sec)), source(spec[0]), spec[0]))
for g in ('foley', 'stage'): manifest[g] = {k: sorted(v) for k, v in manifest[g].items()}
json.dump(manifest, open(os.path.join(build.OUT, 'manifest.json'), 'w'), indent=2); open(os.path.join(build.OUT, 'manifest.json'), 'a').write('\n')
L = ['# Audio credits', '', 'Every file below is CC0 or Public Domain, as stated on the source page (licence line quoted). Accessed %s.' % ACC,
     'Freesound files are the site\'s own HQ preview MP3s (the sound\'s page states Creative Commons 0). Processing: `tools/audio/build.py`.', '',
     '| output | what | source page | direct file | author / uploader | licence (as stated) | accessed |', '|---|---|---|---|---|---|---|']
for rel, w, s, src in rows:
    L.append('| %s | %s | %s | %s | %s | %s | %s |' % (rel, w, s['page'], s['url'], s['author'].replace('|', '/'), s['lic'], ACC))
L += ['', 'Music notes: the compositions (Joplin, 1901-1908) are public domain; each recording is a Wikimedia Commons file whose uploader tags it "Public domain".', '']
open(os.path.join(build.OUT, 'CREDITS.md'), 'w').write('\n'.join(L))
print(json.dumps(manifest, indent=1)[:1500]); print(len(rows), 'credited files')
