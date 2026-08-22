/**
 * A short living list of the operator's missions, at the rim of the brain.
 *
 * Five entries, newest first. It exists so the brain has a caption, not so the
 * interface becomes a mission console — the detail lives in HWD-ZERO's own
 * journal, which is where the audit trail belongs.
 */
import type { OperatorMission } from '../hwd/types';

export interface MissionStripProps {
  missions: OperatorMission[];
  offline: boolean;
  offlineReason: string;
  max?: number;
}

function shortMissionId(missionId: string): string {
  const tail = missionId.split('-').at(-1) ?? missionId;
  return tail.length > 10 ? tail.slice(0, 10) : tail;
}

function missionClass(status: string): string {
  if (status === 'RUNNING') return 'mission-running';
  if (status === 'DONE') return 'mission-done';
  if (status === 'HUMAN_GATE') return 'mission-gate';
  return 'mission-stopped';
}

export function MissionStrip({
  missions,
  offline,
  offlineReason,
  max = 5,
}: MissionStripProps): React.JSX.Element {
  if (offline) {
    return (
      <p className="operator-offline">
        {offlineReason || 'HWD-ZERO is not answering.'}
        <br />
        <code>zero serve</code> on the laptop brings the operator up.
      </p>
    );
  }

  if (missions.length === 0) return <p className="dim">No mission has run yet.</p>;

  return (
    <ul className="missions" aria-label="Missions">
      {missions
        .slice(-max)
        .reverse()
        .map((mission) => (
          <li key={mission.mission_id} className={missionClass(mission.status)}>
            <span className="mission-id">{shortMissionId(mission.mission_id)}</span>
            <span className="mission-task">{mission.task_id || mission.objective}</span>
            <span className="mission-status">{mission.status}</span>
          </li>
        ))}
    </ul>
  );
}
