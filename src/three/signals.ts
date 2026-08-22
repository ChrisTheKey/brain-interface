/**
 * The bridge between React and the render loop.
 *
 * React owns *structure* — which agents exist, which state ZERO is in — and
 * re-renders when that changes. The render loop owns *motion* — the audio
 * levels, the microphone, the energy travelling along a path — and reads it
 * from this mutable object 60 times a second.
 *
 * That separation is the reason there is not one React state update per frame:
 * everything that changes per frame lives here, outside React.
 */
import { Color } from 'three';
import { SILENT_LEVELS, type AudioLevels } from '../audio/analyser';
import { RUNTIME_STATE_VISUALS, type ZeroRuntimeState } from '../runtime/states';

export interface ClusterPulse {
  /** 0..1, decays on its own. */
  energy: number;
  /** +1 = ZERO → agent (a task going out), −1 = agent → ZERO (a result). */
  direction: number;
}

export class BrainSignals {
  /** Measured levels of the audio that is playing right now. */
  levels: AudioLevels = SILENT_LEVELS;
  /** Real microphone input level while listening, 0..1. */
  micLevel = 0;
  state: ZeroRuntimeState = 'IDLE';
  /** How agitated the brain is, smoothed towards the state's own value. */
  agitation = 0.05;
  /** The state's accent colour, smoothed so state changes cross-fade. */
  readonly accent = new Color(RUNTIME_STATE_VISUALS.IDLE.accent);
  /** Seconds since the brain started. */
  time = 0;
  /** Per-agent activity, keyed by agent id. */
  readonly clusters = new Map<string, ClusterPulse>();
  /** Set while a human is required — the brain holds its breath. */
  demandsHuman = false;
  /** True when the audio reaction is estimated rather than measured. */
  estimated = false;

  /** Light one agent's path up. Called from real events, never from a timer. */
  pulse(clusterId: string, direction: number, energy = 1): void {
    const existing = this.clusters.get(clusterId);
    this.clusters.set(clusterId, {
      energy: Math.min(1, Math.max(existing?.energy ?? 0, energy)),
      direction,
    });
  }

  /** Hold an agent's path lit for as long as it is really running. */
  hold(clusterId: string, direction: number, energy: number): void {
    this.clusters.set(clusterId, { energy, direction });
  }

  energyFor(clusterId: string): ClusterPulse {
    return this.clusters.get(clusterId) ?? { energy: 0, direction: 1 };
  }

  /**
   * Advance the transient parts. `dt` is in seconds. Held agents (still
   * running) are refreshed by the caller each frame, so only the decaying
   * ones fade out here.
   */
  step(dt: number, held: ReadonlySet<string>): void {
    this.time += dt;
    const target = RUNTIME_STATE_VISUALS[this.state];
    this.agitation += (target.agitation - this.agitation) * Math.min(1, dt * 3);
    this.accent.lerp(new Color(target.accent), Math.min(1, dt * 2.5));
    this.demandsHuman = target.demandsHuman;

    for (const [id, pulse] of this.clusters) {
      if (held.has(id)) continue;
      const next = pulse.energy - dt * 0.55;
      if (next <= 0.01) this.clusters.delete(id);
      else this.clusters.set(id, { energy: next, direction: pulse.direction });
    }
  }
}
