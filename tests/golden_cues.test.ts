// Golden cue sheets (AC-10): every bundled clip is credited and its cues are well formed.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CLIP_IDS,
  MAX_LABEL_WORDS,
  inWindow,
  loadClipMeta,
  parseClip,
  validateClip,
  wordCount,
  type Clip,
  type Cue,
} from '../src/foley/clips';
import { PROP_IDS } from '../src/foley/types';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (id: string): Clip => JSON.parse(readFileSync(join(ROOT, 'public/clips', `${id}.json`), 'utf8'));

describe.each(CLIP_IDS)('clip %s', (id) => {
  const clip = read(id);

  it('is credited: title, year, director, source, licence, duration', () => {
    expect(clip.id).toBe(id);
    expect(clip.title.length).toBeGreaterThan(0);
    expect(clip.year).toBeLessThan(1929);
    expect(clip.director.length).toBeGreaterThan(0);
    expect(clip.source.item.length).toBeGreaterThan(0);
    expect(clip.source.file.length).toBeGreaterThan(0);
    expect(clip.source.url).toMatch(/^https:\/\/archive\.org\/download\//);
    expect(clip.licence).toMatch(/public domain/i);
    expect(clip.duration).toBeGreaterThanOrEqual(60);
    expect(clip.duration).toBeLessThanOrEqual(120.5);
  });

  it('ships its film (MP4 and VP9 WebM) under 25 MB, and a poster', () => {
    const film = join(ROOT, 'public', clip.film);
    const webm = film.replace(/\.mp4$/, '.webm');
    for (const f of [film, webm]) {
      expect(existsSync(f)).toBe(true);
      expect(statSync(f).size).toBeLessThanOrEqual(25 * 1024 * 1024);
    }
    expect(existsSync(join(ROOT, 'public', clip.poster))).toBe(true);
  });

  it('has at least 8 cues inside the clip, sorted and at least 1 s apart', () => {
    expect(clip.cues.length).toBeGreaterThanOrEqual(8);
    clip.cues.forEach((c: Cue, i: number) => {
      expect(c.t).toBeGreaterThanOrEqual(0);
      expect(c.t).toBeLessThanOrEqual(clip.duration);
      if (i > 0) expect(c.t - clip.cues[i - 1].t).toBeGreaterThanOrEqual(1.0);
    });
  });

  it('uses only table props, short labels and positive windows', () => {
    for (const c of clip.cues) {
      expect(PROP_IDS).toContain(c.prop);
      expect(c.label.trim().length).toBeGreaterThan(0);
      expect(wordCount(c.label)).toBeLessThanOrEqual(MAX_LABEL_WORDS);
      expect(c.window).toHaveLength(2);
      expect(c.window[0]).toBeGreaterThan(0);
      expect(c.window[1]).toBeGreaterThan(0);
    }
  });

  it('records provenance: proposed by a model, checked by hand', () => {
    expect(clip.provenance.proposed_by).toMatch(/^gemini/);
    expect(Number.isNaN(Date.parse(clip.provenance.proposed_at))).toBe(false);
    expect(clip.provenance.checked_by).toBe('hand');
    expect(clip.provenance.notes.length).toBeGreaterThan(0);
  });

  it('passes the runtime validator', () => {
    expect(validateClip(clip)).toEqual([]);
    expect(() => parseClip(clip)).not.toThrow();
  });
});

describe('cue sheets together', () => {
  it('use at least four different props across the three clips', () => {
    const used = new Set(CLIP_IDS.flatMap((id) => read(id).cues.map((c) => c.prop)));
    expect(used.size).toBeGreaterThanOrEqual(4);
  });
});

describe('inWindow', () => {
  const cue: Cue = { t: 10, prop: 'door', label: 'door slams', window: [0.6, 0.8] };
  it('counts hits inside [t - before, t + after]', () => {
    expect(inWindow(cue, 10)).toBe(true);
    expect(inWindow(cue, 9.4)).toBe(true);
    expect(inWindow(cue, 10.8)).toBe(true);
  });
  it('misses outside the window', () => {
    expect(inWindow(cue, 9.39)).toBe(false);
    expect(inWindow(cue, 10.81)).toBe(false);
  });
});

describe('validateClip', () => {
  const good = read('one-week');
  it('flags an unknown prop, a long label, unsorted cues and a cue past the end', () => {
    const bad = {
      ...good,
      cues: [
        { t: 5, prop: 'kazoo', label: 'a', window: [0.6, 0.8] },
        { t: 4, prop: 'door', label: 'one two three four five', window: [0.6, 0.8] },
        { t: good.duration + 5, prop: 'door', label: 'late', window: [0, 0.8] },
      ],
    };
    const errs = validateClip(bad).join('\n');
    expect(errs).toMatch(/prop kazoo not allowed/);
    expect(errs).toMatch(/over 4 words/);
    expect(errs).toMatch(/not sorted/);
    expect(errs).toMatch(/outside the clip/);
    expect(errs).toMatch(/window must be two positive numbers/);
  });
});

describe('loadClipMeta', () => {
  it('fetches ${base}clips/<id>.json and validates it', async () => {
    const seen: string[] = [];
    const clip = await loadClipMeta('safety-last', {
      base: '/coconuts/',
      fetch: async (url) => {
        seen.push(url);
        return { ok: true, status: 200, json: async () => read('safety-last') };
      },
    });
    expect(seen).toEqual(['/coconuts/clips/safety-last.json']);
    expect(clip.title).toMatch(/Safety Last/);
  });
  it('throws on HTTP errors', async () => {
    await expect(
      loadClipMeta('one-week', { fetch: async () => ({ ok: false, status: 404, json: async () => ({}) }) }),
    ).rejects.toThrow(/404/);
  });
});
