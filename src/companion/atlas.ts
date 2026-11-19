// Loads the sprite atlas produced by scripts/extract-sprites.mjs.

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface AtlasManifest {
  version: number;
  /** "eyes" = glowing eyes that blink (Noli); "screen" = CRT face with a waveform mouth. */
  faceStyle?: 'eyes' | 'screen';
  image: string;
  cell: { w: number; h: number };
  frames: Rect[];
  /** Face (eyes / screen glyph) bounds per frame, relative to the cell. */
  faces: (Rect | null)[];
  sections: Record<SectionName, number[]>;
}

export type SectionName =
  | 'idle'
  | 'blink_eyes_overlay'
  | 'look_directions'
  | 'movement'
  | 'idle_actions'
  | 'gestures'
  | 'speaking'
  | 'thinking_confused'
  | 'emotions'
  | 'interactions'
  | 'reacting'
  | 'hurt_sad'
  | 'states'
  | 'teleport'
  | 'extra_sad'
  | 'special_states'
  | 'teleport_pixels'
  | 'follow_idle_sits'
  | 'facing_variants'
  | 'idle_loop'
  | 'talk_loop';

export interface UiAtlas {
  image: string;
  items: Record<string, Rect>;
}

export interface Atlas {
  manifest: AtlasManifest;
  image: HTMLImageElement;
  ui: UiAtlas;
  uiImage: HTMLImageElement;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`failed to load ${src}`));
    img.src = src;
  });
}

let cached: Promise<Atlas> | null = null;

export function loadAtlas(): Promise<Atlas> {
  if (!cached) {
    cached = (async () => {
      const [manifest, ui] = await Promise.all([
        fetch('/sprites/phantom-atlas.json').then((r) => r.json() as Promise<AtlasManifest>),
        fetch('/sprites/ui-atlas.json').then((r) => r.json() as Promise<UiAtlas>),
      ]);
      const [image, uiImage] = await Promise.all([loadImage(`/sprites/${manifest.image}`), loadImage(`/sprites/${ui.image}`)]);
      return { manifest, image, ui, uiImage };
    })();
  }
  return cached;
}
