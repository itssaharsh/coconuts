// Paper-tag speech bubbles drawn on canvas textures: the Director's lines and the take summary.
import { CanvasTexture, Group, Mesh, MeshBasicMaterial, Object3D, PlaneGeometry, SRGBColorSpace, Vector3 } from 'three';

const PX_PER_M = 1600; // canvas pixels per metre of bubble
const FONT = '600 42px "Instrument Sans", system-ui, sans-serif';
const SMALL = '500 30px "Instrument Sans", system-ui, sans-serif';

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
  private shown = false;

  constructor(
    public widthM = 0.42,
    private tone: 'paper' | 'accent' = 'paper',
  ) {
    this.group.name = 'bubble';
    this.material = new MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false });
    this.mesh = new Mesh(new PlaneGeometry(widthM, widthM * 0.3), this.material);
    this.mesh.renderOrder = 5;
    this.group.add(this.mesh);
    this.group.visible = false;
  }

  /** Show a line (and an optional small caption) for `seconds`; 0 keeps it until hide(). */
  say(text: string, caption = '', seconds = 6): void {
    const w = Math.round(this.widthM * PX_PER_M);
    const c = document.createElement('canvas');
    const g = c.getContext('2d')!;
    g.font = FONT;
    const lines = wrap(g, text, w - 120);
    const h = 60 + lines.length * 54 + (caption ? 44 : 0) + 40;
    c.width = w;
    c.height = h;
    g.font = FONT;
    g.fillStyle = this.tone === 'accent' ? '#3F8FD6' : '#FFFDF8';
    g.beginPath();
    g.roundRect(6, 6, w - 12, h - 12 - 18, 26);
    g.fill();
    // the tag's little tail
    g.beginPath();
    g.moveTo(w / 2 - 22, h - 30);
    g.lineTo(w / 2, h - 6);
    g.lineTo(w / 2 + 22, h - 30);
    g.fill();
    g.strokeStyle = this.tone === 'accent' ? '#2F6FB0' : '#E1D6C4';
    g.lineWidth = 4;
    g.beginPath();
    g.roundRect(6, 6, w - 12, h - 12 - 18, 26);
    g.stroke();
    g.fillStyle = this.tone === 'accent' ? '#FFFFFF' : '#2B2320';
    g.textBaseline = 'top';
    lines.forEach((l, i) => g.fillText(l, 60, 44 + i * 54));
    if (caption) {
      g.font = SMALL;
      g.fillStyle = this.tone === 'accent' ? '#E8F1FA' : '#8A7A66';
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
    const p = this.group.getWorldPosition(new Vector3());
    this.target.y = p.y;
    this.group.lookAt(this.target);
  }
}
