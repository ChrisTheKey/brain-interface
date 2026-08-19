/**
 * Audio-reactive smoke around ZERO.
 *
 * Every particle property is derived from the measured audio signal:
 *
 *   amplitude  → emission rate, particle opacity, expansion speed
 *   low band   → density / particle size (body of the voice)
 *   high band  → turbulence (consonants, emphasis)
 *   onset      → burst velocity when ZERO stresses a word
 *
 * With no signal (ZERO silent) the emitter produces essentially nothing, so
 * the brain returns to a quiet, controlled state on its own.
 */
import { clamp01, type AudioLevels } from '../audio/analyser';

export interface SmokeParticle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  size: number;
  seed: number;
  opacity: number;
}

export interface SmokeTuning {
  maxParticles?: number;
  /** Particles per frame at full amplitude. */
  emissionRate?: number;
  /** Base radius (layout units) the smoke is emitted from. */
  emitRadius?: number;
}

export interface SmokeEmissionParams {
  emission: number;
  velocity: number;
  turbulence: number;
  density: number;
  opacity: number;
}

/** Pure mapping from audio levels to emitter parameters (unit-tested). */
export function smokeParamsFromAudio(levels: AudioLevels): SmokeEmissionParams {
  const amplitude = clamp01(levels.amplitude);
  const low = clamp01(levels.low);
  const high = clamp01(levels.high);
  const onset = clamp01(levels.onset);

  // Below the noise floor ZERO counts as silent: no smoke at all.
  const gate = amplitude < 0.02 ? 0 : 1;

  return {
    emission: gate * (amplitude * 0.85 + onset * 0.6),
    velocity: gate * (0.25 + amplitude * 0.9 + onset * 1.4),
    turbulence: gate * (0.15 + high * 1.5 + onset * 0.5),
    density: gate * (0.35 + low * 1.1),
    opacity: gate * clamp01(0.08 + amplitude * 0.55 + low * 0.2),
  };
}

export class SmokeField {
  private readonly particles: SmokeParticle[] = [];
  private emissionCarry = 0;
  private readonly maxParticles: number;
  private readonly emissionRate: number;
  private readonly emitRadius: number;
  private time = 0;

  constructor(tuning: SmokeTuning = {}) {
    this.maxParticles = tuning.maxParticles ?? 260;
    this.emissionRate = tuning.emissionRate ?? 5;
    this.emitRadius = tuning.emitRadius ?? 56;
  }

  get count(): number {
    return this.particles.length;
  }

  get all(): readonly SmokeParticle[] {
    return this.particles;
  }

  clear(): void {
    this.particles.length = 0;
    this.emissionCarry = 0;
  }

  update(dt: number, levels: AudioLevels, random: () => number = Math.random): SmokeEmissionParams {
    const params = smokeParamsFromAudio(levels);
    this.time += dt;

    this.emissionCarry += params.emission * this.emissionRate * dt;
    const toSpawn = Math.floor(this.emissionCarry);
    this.emissionCarry -= toSpawn;

    for (let i = 0; i < toSpawn && this.particles.length < this.maxParticles; i += 1) {
      const angle = random() * Math.PI * 2;
      const radius = this.emitRadius * (0.75 + random() * 0.4);
      const speed = params.velocity * (0.4 + random() * 0.8);
      this.particles.push({
        x: Math.cos(angle) * radius,
        y: Math.sin(angle) * radius,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 0.15,
        life: 0,
        maxLife: 70 + random() * 90,
        size: 18 + params.density * 44 * (0.6 + random() * 0.8),
        seed: random() * 1000,
        opacity: params.opacity * (0.5 + random() * 0.6),
      });
    }

    for (let i = this.particles.length - 1; i >= 0; i -= 1) {
      const particle = this.particles[i];
      if (!particle) continue;
      particle.life += dt;
      if (particle.life >= particle.maxLife) {
        this.particles.splice(i, 1);
        continue;
      }
      const swirl = params.turbulence * 0.06;
      const noise = Math.sin(particle.seed + this.time * 0.03) * swirl;
      const noise2 = Math.cos(particle.seed * 1.7 + this.time * 0.024) * swirl;
      particle.vx = (particle.vx + noise) * 0.985;
      particle.vy = (particle.vy + noise2 - 0.004) * 0.985;
      particle.x += particle.vx * dt;
      particle.y += particle.vy * dt;
      particle.size += (0.25 + params.density * 0.7) * dt;
    }

    return params;
  }

  draw(ctx: CanvasRenderingContext2D, centerX: number, centerY: number, scale: number): void {
    if (this.particles.length === 0) return;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const particle of this.particles) {
      const progress = particle.life / particle.maxLife;
      const fade = Math.sin(Math.PI * progress);
      const alpha = particle.opacity * fade * 0.5;
      if (alpha <= 0.002) continue;
      const x = centerX + particle.x * scale;
      const y = centerY + particle.y * scale;
      const radius = particle.size * scale;
      const gradient = ctx.createRadialGradient(x, y, 0, x, y, Math.max(1, radius));
      gradient.addColorStop(0, `rgba(238, 232, 246, ${alpha.toFixed(4)})`);
      gradient.addColorStop(0.42, `rgba(196, 150, 196, ${(alpha * 0.32).toFixed(4)})`);
      gradient.addColorStop(1, 'rgba(12, 6, 14, 0)');
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.arc(x, y, Math.max(1, radius), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
}
