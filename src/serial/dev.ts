// The stage dev page: the theatre and a stand-in table seen from the player's seat, driven by the keyboard
// (c d b t w g = coconuts door bell thunder whistle glass, space = clapper) or by scripts through window.__serial.
// ?step=1 stops the clock so a script can advance it frame by frame (smooth capture on a slow machine).
import {
  AmbientLight,
  BoxGeometry,
  Color,
  DirectionalLight,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  Timer,
  WebGLRenderer,
} from 'three';
import type { PropId } from '../foley/types';
import { film } from './film';
import { WRITTEN } from './pieces';
import { Serial } from './serial';

const q = new URLSearchParams(location.search);
const renderer = new WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = SRGBColorSpace;
document.body.appendChild(renderer.domElement);

const scene = new Scene();
// room light for the proscenium and the table (the stage itself carries its own light)
const sun = new DirectionalLight(0xfff2e0, 2.2);
sun.position.set(-0.6, 1.4, 1);
scene.add(new AmbientLight(0xffffff, 0.9), sun);
scene.background = new Color(q.get('bg') ?? '#171310');
const camera = new PerspectiveCamera(Number(q.get('fov') ?? 66), innerWidth / innerHeight, 0.01, 30);
camera.position.set(Number(q.get('ex') ?? 0), Number(q.get('ey') ?? 0), 0); // the eye
camera.lookAt(0, Number(q.get('ly') ?? 0.0), -0.88);

const serial = new Serial('/serial/', '/models/screen_frame.glb', {
  onWaiting: (w) => (waiting = w ? `${w.kind}: ${w.label} [${w.prop ?? 'any'}]` : ''),
});
// the theatre stands behind the table: its floor 24 cm below the eyes, its opening 88 cm away
serial.theatre.setSize(Number(q.get('size') ?? 1.1));
serial.theatre.group.position.set(0, Number(q.get('ty') ?? -0.24), -0.88);
scene.add(serial.theatre.group);

// a stand-in for the foley table, for scale and occlusion
const table = new Mesh(new BoxGeometry(0.7, 0.015, 0.4), new MeshStandardMaterial({ color: 0xead9b9, roughness: 0.75 }));
table.position.set(0, -0.3875, -0.48);
scene.add(table);

let waiting = '';
const hud = document.getElementById('hud')!;
const KEYS: Record<string, PropId> = { c: 'coconuts', d: 'door', b: 'bell', t: 'thunder', w: 'whistle', g: 'glass' };
addEventListener('keydown', (e) => {
  if (e.key === ' ') void serial.roll();
  else if (e.key === 'p') serial.togglePause();
  else if (KEYS[e.key]) serial.sound(KEYS[e.key], 'key', 1);
});
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

const stepped = q.has('step');
const timer = new Timer();
let clock = 0;
const forceColour = q.has('colour') ? Number(q.get('colour')) : null;
function frame(dt: number, draw = true): void {
  clock += dt;
  if (forceColour !== null) serial.theatre.setColour(forceColour);
  serial.update(dt);
  if (!draw) return;
  renderer.render(scene, camera);
  hud.textContent = q.has('hud') ? `${serial.state} reel ${serial.reelNumber}  t=${clock.toFixed(1)}\n${waiting}\ncalls ${renderer.info.render.calls} tris ${renderer.info.render.triangles}` : '';
}
if (!stepped) {
  renderer.setAnimationLoop(() => {
    timer.update();
    frame(Math.min(0.1, timer.getDelta()));
  });
}

const api = {
  serial,
  film,
  ready: false,
  /** Advance the stage by dt seconds and draw (stepped mode). */
  step: (dt: number) => frame(dt),
  /** Advance by `seconds` in steps of `dt` without waiting for real time; only the last step is drawn. */
  run: (seconds: number, dt = 1 / 30) => {
    const n = Math.max(1, Math.round(seconds / dt));
    for (let i = 0; i < n; i++) frame(dt, i === n - 1);
  },
  sound: (prop: PropId, kind = 'script') => serial.sound(prop, kind, 1),
  roll: () => serial.roll(),
  info: () => ({ state: serial.state, waiting, clock, calls: renderer.info.render.calls, tris: renderer.info.render.triangles, colour: 0 }),
};
(window as unknown as { __serial: typeof api }).__serial = api;

void serial.init().then(async () => {
  // ?written=thunder puts that prop's written reel on the stage instead of reel one
  const written = q.get('written') as PropId | null;
  if (written && WRITTEN[written]) await serial.preview(WRITTEN[written]);
  api.ready = true;
  document.title = 'stage ready';
  if (q.has('roll')) void serial.roll();
});
