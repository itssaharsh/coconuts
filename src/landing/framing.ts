// Where the page's camera stands when there is no headset. The page marks a rectangle for the stage (an element with
// `data-stage-frame`: the house panel right of the copy on wide screens, the window under the copy on phones), and the
// camera is solved so everything visible on the stage (theatre, table, props, their tags) fits inside it. The camera
// follows that rectangle, so the stage moves over when a reel takes the page, and keeps fitting when the theatre grows.
import { Box3, Mesh, PerspectiveCamera, Vector3, type Object3D } from 'three';

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface View {
  /** Radians round the stage, negative = seen from its left. */
  az: number;
  /** Radians above the stage. */
  el: number;
}

/** A three-quarter view from the left and above while the page introduces the show; nearly head-on while a reel plays. */
const INTRO: View = { az: -0.24, el: 0.36 };
const REEL: View = { az: -0.12, el: 0.27 };
const PHONE: View = { az: -0.14, el: 0.34 };

/** The stage before its models and the theatre arrive: the desk-size theatre and the table (world metres). */
const FALLBACK = new Box3(new Vector3(-0.72, 0.8, -1.3), new Vector3(0.72, 1.78, -0.24));

let cam: PerspectiveCamera | null = null;
let box = FALLBACK.clone();
let boxAt = -Infinity;
let playing = false;
const pos = new Vector3();
const aim = new Vector3();
const wantPos = new Vector3();
const wantAim = new Vector3();
let solvedKey = '';
let posed = false;

const probe = new PerspectiveCamera();
const corners = Array.from({ length: 8 }, () => new Vector3());
const tmp = new Vector3();
const tmpBox = new Box3();
const right = new Vector3();
const up = new Vector3();
const reduced = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;

function frameElement(): HTMLElement | null {
  for (const el of document.querySelectorAll<HTMLElement>('[data-stage-frame]')) {
    if (el.offsetWidth > 0 && el.offsetHeight > 0) return el;
  }
  return null;
}

/** The target rectangle in the canvas's own pixels, or null when the page has none (the classic films page). */
function frameRect(): { rect: Rect; view: { w: number; h: number } } | null {
  const el = frameElement();
  const canvas = document.querySelector<HTMLCanvasElement>('#scene-container canvas');
  if (!el || !canvas) return null;
  const c = canvas.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  if (c.width < 1 || c.height < 1 || r.width < 1 || r.height < 1) return null;
  return { rect: { x: r.left - c.left, y: r.top - c.top, w: r.width, h: r.height }, view: { w: c.width, h: c.height } };
}

/** Everything drawn on the stage, in world space; the house-lights dome and anything far from the table are left out. */
function measureStage(from: Object3D): Box3 | null {
  let root: Object3D = from;
  while (root.parent) root = root.parent;
  const stage = root.getObjectByName('coconuts-stage');
  if (!stage) return null;
  stage.updateWorldMatrix(true, true);
  const centre = stage.getWorldPosition(new Vector3());
  const out = new Box3();
  stage.traverseVisible((o) => {
    const m = o as Mesh & { isInstancedMesh?: boolean; isSkinnedMesh?: boolean };
    if (!m.isMesh || m.isInstancedMesh || o.name === 'house-lights' || !m.geometry) return;
    if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
    const bb = m.geometry.boundingBox;
    if (!bb || bb.isEmpty()) return;
    tmpBox.copy(bb).applyMatrix4(o.matrixWorld);
    if (tmpBox.getCenter(tmp).distanceTo(centre) > 4.5) return; // a stray full-screen quad or a skybox, not the stage
    out.union(tmpBox);
  });
  return out.isEmpty() ? null : out;
}

function project(p: Vector3, a: Vector3, b: Box3): { cx: number; cy: number; hw: number; hh: number; ok: boolean } {
  probe.position.copy(p);
  probe.lookAt(a);
  probe.updateMatrixWorld(true);
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let ok = true;
  let i = 0;
  for (const x of [b.min.x, b.max.x])
    for (const y of [b.min.y, b.max.y])
      for (const z of [b.min.z, b.max.z]) {
        const v = corners[i++].set(x, y, z).project(probe);
        if (v.z < -1 || v.z > 1) ok = false;
        minX = Math.min(minX, v.x);
        maxX = Math.max(maxX, v.x);
        minY = Math.min(minY, v.y);
        maxY = Math.max(maxY, v.y);
      }
  return { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, hw: (maxX - minX) / 2, hh: (maxY - minY) / 2, ok };
}

/** The camera pose that puts the whole stage box, seen from `view`, inside `rect` of a canvas `size` pixels big. */
function solve(source: PerspectiveCamera, size: { w: number; h: number }, rect: Rect, b: Box3, view: View): void {
  probe.fov = source.fov;
  probe.near = source.near;
  probe.far = source.far;
  probe.aspect = size.w / size.h;
  probe.updateProjectionMatrix();
  const centre = b.getCenter(new Vector3());
  const dir = new Vector3(Math.sin(view.az) * Math.cos(view.el), Math.sin(view.el), Math.cos(view.az) * Math.cos(view.el));
  const tx = ((rect.x + rect.w / 2) / size.w) * 2 - 1;
  const ty = 1 - ((rect.y + rect.h / 2) / size.h) * 2;
  const halfW = rect.w / size.w;
  const halfH = rect.h / size.h;
  const tanHalf = Math.tan((probe.fov * Math.PI) / 360);
  const p = new Vector3();
  const a = new Vector3();
  const place = (d: number) => {
    p.copy(centre).addScaledVector(dir, d);
    a.copy(centre);
    let f = project(p, a, b);
    for (let k = 0; k < 6; k++) {
      // turn the camera until the stage's middle lands on the rectangle's middle
      right.setFromMatrixColumn(probe.matrixWorld, 0);
      up.setFromMatrixColumn(probe.matrixWorld, 1);
      a.addScaledVector(right, -(tx - f.cx) * d * tanHalf * probe.aspect).addScaledVector(up, -(ty - f.cy) * d * tanHalf);
      f = project(p, a, b);
    }
    return f;
  };
  let lo = 0.4;
  let hi = 40;
  for (let k = 0; k < 22; k++) {
    const d = (lo + hi) / 2;
    const f = place(d);
    if (f.ok && f.hw <= halfW && f.hh <= halfH) hi = d;
    else lo = d;
  }
  place(hi);
  wantPos.copy(p);
  wantAim.copy(a);
}

function apply(c: PerspectiveCamera): void {
  c.position.copy(pos);
  c.lookAt(aim);
  c.updateMatrixWorld(true);
}

/** Work out where the camera wants to be; true when the page has a stage rectangle to frame into. */
function target(c: PerspectiveCamera, now: number): boolean {
  const f = frameRect();
  if (!f) return false;
  if (now - boxAt > 250) {
    // the stage changes shape rarely (its models arriving, the theatre growing to the size of the wall)
    boxAt = now;
    const b = measureStage(c);
    if (b && b.getSize(tmp).length() < 12) box = b;
  }
  const { rect, view } = f;
  // breathing room inside the rectangle: the stage never touches its edges
  const pad = Math.max(16, Math.min(rect.w, rect.h) * 0.05);
  const r = { x: rect.x + pad, y: rect.y + pad, w: rect.w - 2 * pad, h: rect.h - 2 * pad };
  const angle = view.w <= 900 ? PHONE : playing ? REEL : INTRO;
  const key = [r.x, r.y, r.w, r.h, view.w, view.h, c.fov, angle.az, angle.el, box.min.toArray(), box.max.toArray()]
    .flat()
    .map((n) => Math.round(n * 100))
    .join(',');
  if (key !== solvedKey) {
    solvedKey = key;
    solve(c, view, r, box, angle);
  }
  return true;
}

/** Called by the engine whenever the window's width changes: the camera goes straight to its place. */
export function frameSerial(c: PerspectiveCamera, wide: boolean): void {
  cam = c;
  if (target(c, performance.now())) {
    pos.copy(wantPos);
    aim.copy(wantAim);
    posed = true;
    apply(c);
    return;
  }
  // no page to frame into: the stage seen from a little behind and above the seat
  if (wide) {
    c.position.set(0.4, 1.5, 1.0);
    c.lookAt(-0.52, 1.1, -0.7);
  } else {
    c.position.set(0.0, 1.48, 1.5);
    c.lookAt(0.0, 1.06, -0.7);
  }
  c.updateMatrixWorld(true);
}

/**
 * Called by the page every frame outside the headset: re-measures the stage rectangle and eases the camera to it
 * (a reel taking the page, the theatre growing, the phone's address bar sliding away).
 */
export function followSerial(dt: number, reel: boolean): void {
  playing = reel;
  if (!cam || !target(cam, performance.now())) return;
  if (!posed) {
    pos.copy(wantPos);
    aim.copy(wantAim);
    posed = true;
  } else {
    const k = reduced?.matches ? 1 : 1 - Math.exp(-Math.min(dt, 0.1) * 5);
    pos.lerp(wantPos, k);
    aim.lerp(wantAim, k);
  }
  apply(cam);
}
