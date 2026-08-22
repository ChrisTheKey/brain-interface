/**
 * One tiny texture carries all per-cluster activity to the GPU.
 *
 * Filaments, travelling energy and cluster nodes all need to know "how active
 * is agent N, and which way is the energy flowing". Passing that as uniform
 * arrays means dynamic indexing, which GLSL ES 1.00 does not reliably allow;
 * passing it as a per-vertex attribute means rewriting thousands of floats per
 * frame. A 1-pixel-per-cluster data texture is neither: one small upload per
 * frame, sampled by every shader that needs it.
 *
 *   r  energy      0..1, how lit this agent's path is
 *   g  direction   0 = agent → ZERO, 1 = ZERO → agent
 *   b  status      0..1, how strongly the node itself reads (idle → active)
 *   a  presence    1 for a slot that is in use
 */
import { DataTexture, NearestFilter, RGBAFormat, UnsignedByteType } from 'three';

export const MAX_CLUSTERS = 64;

export class ActivityTexture {
  readonly texture: DataTexture;
  private readonly data: Uint8Array;
  private readonly size: number;

  constructor(size = MAX_CLUSTERS) {
    this.size = size;
    this.data = new Uint8Array(size * 4);
    this.texture = new DataTexture(this.data, size, 1, RGBAFormat, UnsignedByteType);
    this.texture.magFilter = NearestFilter;
    this.texture.minFilter = NearestFilter;
    this.texture.generateMipmaps = false;
    this.texture.needsUpdate = true;
  }

  get slots(): number {
    return this.size;
  }

  /** The u coordinate of a slot — what the shaders receive as an attribute. */
  uv(index: number): number {
    return (index + 0.5) / this.size;
  }

  set(index: number, energy: number, direction: number, status: number): void {
    if (index < 0 || index >= this.size) return;
    const offset = index * 4;
    this.data[offset] = clampByte(energy * 255);
    this.data[offset + 1] = clampByte((direction * 0.5 + 0.5) * 255);
    this.data[offset + 2] = clampByte(status * 255);
    this.data[offset + 3] = 255;
  }

  clear(): void {
    this.data.fill(0);
  }

  commit(): void {
    this.texture.needsUpdate = true;
  }

  dispose(): void {
    this.texture.dispose();
  }
}

function clampByte(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value > 255 ? 255 : Math.round(value);
}

/** GLSL helper shared by every shader that reads the texture. */
export const GLSL_ACTIVITY = /* glsl */ `
uniform sampler2D uActivity;
vec4 readActivity(float slot) {
  return texture2D(uActivity, vec2(slot, 0.5));
}
`;
