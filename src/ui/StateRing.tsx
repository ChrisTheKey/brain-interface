/**
 * ZERO's runtime state, as one glyph.
 *
 * Eleven states, one ring: the label names it, the dot pulses with it, and the
 * colour is the same accent the core is using in the 3D scene, so the HUD and
 * the brain never disagree about what ZERO is doing.
 */
import { RUNTIME_STATE_VISUALS, type ZeroRuntimeState } from '../runtime/states';

export interface StateRingProps {
  state: ZeroRuntimeState;
  detail?: string | null;
}

export function StateRing({ state, detail }: StateRingProps): React.JSX.Element {
  const visual = RUNTIME_STATE_VISUALS[state];
  return (
    <div
      className={`state-ring state-${state.toLowerCase()}${visual.demandsHuman ? ' state-demands' : ''}`}
      style={{ '--state-accent': visual.accent } as React.CSSProperties}
      role="status"
      aria-live="polite"
      data-state={state}
    >
      <span className="state-dot" aria-hidden="true" />
      <span className="state-name">{visual.label}</span>
      {detail ? <span className="state-detail">{detail}</span> : null}
    </div>
  );
}
