// The film screen: an HTML video drawn on a plane behind the proscenium.
import { Group, Mesh, MeshBasicMaterial, PlaneGeometry, SRGBColorSpace, VideoTexture } from 'three';
import { buildScreenFrame } from './toys';

export const SCREEN_W = 0.8;
export const SCREEN_H = 0.45;

export class Screen {
  readonly group = new Group();
  readonly video: HTMLVideoElement;
  private texture: VideoTexture;
  private plane: Mesh;
  private poster: Mesh;
  private clipId: string | null = null;
  onEnded: (() => void) | null = null;

  constructor() {
    this.group.name = 'screen';
    this.video = document.createElement('video');
    this.video.muted = true; // silent films; the sound is yours
    this.video.playsInline = true;
    this.video.preload = 'auto';
    this.video.crossOrigin = 'anonymous';
    this.video.setAttribute('playsinline', '');
    this.video.style.display = 'none';
    document.body.appendChild(this.video);
    this.video.addEventListener('ended', () => {
      console.log('TAKE end', this.clipId, this.video.currentTime.toFixed(2));
      this.onEnded?.();
    });
    this.texture = new VideoTexture(this.video);
    this.texture.colorSpace = SRGBColorSpace;
    this.plane = new Mesh(new PlaneGeometry(SCREEN_W, SCREEN_H), new MeshBasicMaterial({ map: this.texture, toneMapped: false }));
    this.plane.name = 'film';
    this.group.add(this.plane);
    this.poster = new Mesh(new PlaneGeometry(SCREEN_W, SCREEN_H), new MeshBasicMaterial({ color: 0x1a1512 }));
    this.poster.position.z = 0.001;
    this.poster.name = 'leader';
    this.group.add(this.poster);
    this.group.add(buildScreenFrame(SCREEN_W, SCREEN_H));
  }

  async load(clipId: string, url: string): Promise<void> {
    this.clipId = clipId;
    this.video.src = url;
    this.video.load();
    await new Promise<void>((resolve) => {
      const ok = () => {
        cleanup();
        resolve();
      };
      const fail = () => {
        cleanup();
        console.warn('FILM failed to load', url);
        resolve();
      };
      const cleanup = () => {
        this.video.removeEventListener('loadeddata', ok);
        this.video.removeEventListener('error', fail);
      };
      this.video.addEventListener('loadeddata', ok);
      this.video.addEventListener('error', fail);
      if (this.video.readyState >= 2) ok();
    });
    console.log('FILM loaded', clipId, this.video.duration.toFixed(1), 's');
  }

  get currentTime(): number {
    return this.video.currentTime;
  }

  get playing(): boolean {
    return !this.video.paused && !this.video.ended;
  }

  get id(): string | null {
    return this.clipId;
  }

  async play(from = 0): Promise<boolean> {
    try {
      this.video.currentTime = from;
      await this.video.play();
      this.poster.visible = false;
      return true;
    } catch (err) {
      console.warn('FILM play refused', err);
      return false;
    }
  }

  pause(): void {
    this.video.pause();
  }

  showLeader(): void {
    this.poster.visible = true;
  }
}
