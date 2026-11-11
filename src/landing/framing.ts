// Where the page's camera stands when there is no headset: the Serial's theatre and table, seen from a little
// behind and above the seat. Wide screens see the stage to the right of the copy; phones see it head-on below it.
import type { PerspectiveCamera } from 'three';

export function frameSerial(cam: PerspectiveCamera, wide: boolean): void {
  if (wide) {
    cam.position.set(0.4, 1.5, 1.0);
    cam.lookAt(-0.52, 1.1, -0.7);
  } else {
    cam.position.set(0.0, 1.48, 1.5);
    cam.lookAt(0.0, 1.06, -0.7);
  }
  cam.updateMatrixWorld(true);
}
