// Paper-tag speech bubbles drawn on canvas textures: the slate's lines over the table.
import { CanvasTexture, Group, Mesh, MeshBasicMaterial, Object3D, PlaneGeometry, SRGBColorSpace, Vector3 } from 'three';

const PX_PER_M = 1600; // canvas pixels per metre of bubble
const SMALL = '500 30px "Instrument Sans", system-ui, sans-serif';
/** The slate speaks for the show itself, so it is a theatre ticket: the intertitles' face on cream, ruled in brass. */
const TICKET = '400 42px "Limelight", "Instrument Sans", system-ui, serif';

function wrap(g: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    const t = cur ? `${cur} ${w}` : w;
    if (g.measureText(t).width > maxWidth && cur) {
      lines.push(cur);
      cur = w;
    } else cur = t;
  }
  if (cur) lines.push(cur);
  return lines;
}

export class Bubble {
  readonly group = new Group();
  private mesh: Mesh;
  private material: MeshBasicMaterial;
  private hideAt = 0;
  private target = new Vector3();
  private here = new Vector3();
  private shown = false;

  constructor(public widthM = 0.42) {
    this.group.name = 'bubble';
    // a paper tag is a readout: it draws over the props so a door or a sheet never hides a line
    this.material = new MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, depthTest: false });
    this.mesh = new Mesh(new PlaneGeometry(widthM, widthM * 0.3), this.material);
    this.mesh.renderOrder = 25;
    this.group.add(this.mesh);
    this.group.visible = false;
  }

  /** Show a line (and an optional small caption) for `seconds`; 0 keeps it until hide(). */
  say(text: string, caption = '', seconds = 6): void {
    const w = Math.round(this.widthM * PX_PER_M);
    const c = document.createElement('canvas');
    const g = c.getContext('2d')!;
    g.font = TICKET;
    const lines = wrap(g, text, w - 120);
    const h = 60 + lines.length * 54 + (caption ? 44 : 0) + 40;
    c.width = w;
    c.height = h;
    g.font = TICKET;
    g.fillStyle = '#F8EFDC';
    g.beginPath();
    g.roundRect(6, 6, w - 12, h - 12 - 18, 26);
    g.fill();
    // the tag's little tail
    g.beginPath();
    g.moveTo(w / 2 - 22, h - 30);
    g.lineTo(w / 2, h - 6);
    g.lineTo(w / 2 + 22, h - 30);
    g.fill();
    g.strokeStyle = '#B58630';
    g.lineWidth = 6;
    g.beginPath();
    g.roundRect(6, 6, w - 12, h - 12 - 18, 26);
    g.stroke();
    // a second, thin rule inside the first, as on a ticket
    g.lineWidth = 2;
    g.beginPath();
    g.roundRect(18, 18, w - 36, h - 36 - 18, 16);
    g.stroke();
    g.fillStyle = '#2B2320';
    g.textBaseline = 'top';
    lines.forEach((l, i) => g.fillText(l, 60, 44 + i * 54));
    if (caption) {
      g.font = SMALL;
      g.fillStyle = '#6E5A40';
      g.fillText(caption, 60, 44 + lines.length * 54 + 10);
    }
    const tex = new CanvasTexture(c);
    tex.colorSpace = SRGBColorSpace;
    this.material.map?.dispose();
    this.material.map = tex;
    this.material.needsUpdate = true;
    this.mesh.geometry.dispose();
    this.mesh.geometry = new PlaneGeometry(this.widthM, (h / w) * this.widthM);
    this.mesh.position.y = ((h / w) * this.widthM) / 2;
    this.group.visible = true;
    this.shown = true;
    this.hideAt = seconds > 0 ? performance.now() + seconds * 1000 : 0;
  }

  hide(): void {
    this.shown = false;
  }

  get visible(): boolean {
    return this.shown;
  }

  /** Ease opacity and face the viewer. */
  update(dt: number, viewer: Object3D): void {
    if (this.hideAt && performance.now() > this.hideAt) this.shown = false;
    const k = Math.min(1, dt * 10);
    this.material.opacity += ((this.shown ? 1 : 0) - this.material.opacity) * k;
    if (this.material.opacity < 0.02 && !this.shown) this.group.visible = false;
    viewer.getWorldPosition(this.target);
    const p = this.group.getWorldPosition(this.here);
    this.target.y = p.y;
    this.group.lookAt(this.target);
  }
}
