#!/usr/bin/env python3
"""Lay the recorded sounds under a capture: reads the SND lines a capture run logged (show time, type, bank key,
gain) and mixes the same recordings the game plays into one audio file.

  python3 tools/video/soundtrack.py <log.txt> <out.m4a|out.wav> [--length SECONDS] [--offset SECONDS] [--no-music]

A line looks like `SND 12.433 hit door-knock 0.80`, `SND 3.000 stage curtain 1.00` or `SND 5.200 music on 0.16`.
--offset is subtracted from every time (the show time at which the film's first frame was captured).
Takes are chosen round robin per bank (the game picks at random; any take is the same prop).
--no-music leaves out the house pianist (the `music` lines): an effects-only track, for an edit that lays one
continuous music bed of its own under the cut. A .wav output is written as 16-bit PCM (exact to cut), anything else AAC.
"""
import json, os, re, subprocess, sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..')
AUDIO = os.path.join(ROOT, 'public', 'audio')


def main() -> int:
    args = sys.argv[1:]
    if len(args) < 2:
        print(__doc__)
        return 2
    log, out = args[0], args[1]
    length = float(args[args.index('--length') + 1]) if '--length' in args else None
    offset = float(args[args.index('--offset') + 1]) if '--offset' in args else 0.0
    no_music = '--no-music' in args
    manifest = json.load(open(os.path.join(AUDIO, 'manifest.json')))
    events = []
    for line in open(log, encoding='utf-8', errors='ignore'):
        m = re.search(r'SND (\d+(?:\.\d+)?) (hit|stage|music) (\S+) (\d+(?:\.\d+)?)', line)
        if m:
            events.append((float(m.group(1)) - offset, m.group(2), m.group(3), float(m.group(4))))
    events.sort()
    if not events:
        print('no SND lines in', log)
        return 1
    end = length if length is not None else events[-1][0] + 4
    inputs, filters, mix = [], [], []
    turn = {}

    def add(path: str, at: float, gain: float, extra: str = '') -> None:
        i = len(inputs) // 2
        inputs.extend(['-i', path])
        ms = max(0, int(round(at * 1000)))
        filters.append(f'[{i}:a]aresample=44100,aformat=channel_layouts=mono{extra},volume={gain:.3f},adelay={ms}:all=1[a{i}]')
        mix.append(f'[a{i}]')

    music_on = None
    for t, kind, key, gain in events:
        if t < -0.5 or t > end:
            continue
        if kind == 'music':
            if no_music:
                continue
            if key == 'on' and music_on is None:
                music_on = (t, gain)
            elif key == 'off' and music_on is not None:
                bed(music_on, t, manifest, add)
                music_on = None
            continue
        files = manifest.get('foley' if kind == 'hit' else 'stage', {}).get(key, [])
        if not files:
            continue
        n = turn.get(key, 0)
        turn[key] = n + 1
        add(os.path.join(AUDIO, files[n % len(files)]), max(0.0, t), gain)
    if music_on is not None:
        bed(music_on, end, manifest, add)
    if not mix:
        print('nothing to mix')
        return 1
    graph = ';'.join(filters) + ';' + ''.join(mix) + f'amix=inputs={len(mix)}:normalize=0:dropout_transition=0,alimiter=limit=0.89,atrim=0:{end:.3f}[out]'
    codec = ['-c:a', 'pcm_s16le'] if out.lower().endswith('.wav') else ['-c:a', 'aac', '-b:a', '192k']
    cmd = ['ffmpeg', '-y', '-loglevel', 'error', *inputs, '-filter_complex', graph, '-map', '[out]', *codec, out]
    subprocess.run(cmd, check=True)
    print(f'wrote {out}: {len(mix)} sounds over {end:.1f} s')
    return 0


def bed(on, until, manifest, add) -> None:
    """The house pianist from `on` to `until`: the excerpts one after another, faded at both ends."""
    t, gain = on
    for i, m in enumerate(manifest.get('music', []) * 3):
        if t >= until:
            break
        length = min(float(m.get('seconds', 80)), until - t)
        fade = f',atrim=0:{length:.3f},afade=t=in:st=0:d=1.2,afade=t=out:st={max(0.0, length - 0.8):.3f}:d=0.8'
        add(os.path.join(AUDIO, m['file']), t, gain, fade)
        t += length


if __name__ == '__main__':
    sys.exit(main())
