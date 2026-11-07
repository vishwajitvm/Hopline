import { Phase } from '../../state/session-reducer.js';

const LABELS = {
  [Phase.WAITING]: 'Waiting for the other device',
  [Phase.CONNECTING]: 'Connecting',
  [Phase.CONNECTED]: 'Connected',
  [Phase.RECONNECTING]: 'Reconnecting',
  [Phase.ENDED]: 'Disconnected',
};

export function StatusBadge({ phase }) {
  return (
    <span className={`status-badge status-badge--${phase}`} role="status">
      <span className="status-dot" aria-hidden="true" />
      {LABELS[phase] ?? 'Starting'}
    </span>
  );
}
