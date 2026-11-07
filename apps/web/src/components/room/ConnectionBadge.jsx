import { Icon } from '../common/Icon.jsx';

const DESCRIPTIONS = {
  direct: 'Files go straight between the two devices.',
  relay:
    "Files pass through the relay server because the networks don't allow a direct link (or you chose to hide " +
    'your IP). They stay end-to-end encrypted — the relay only sees scrambled data.',
};

const LANES_HINT =
  ' Files are spread over several parallel connections ("lanes"), which is much faster over long distances.';

/** Shows whether the connection is direct or relayed, its round-trip time, and how many lanes carry data. */
export function ConnectionBadge({ connection }) {
  if (!connection) return null;
  const relayed = connection.route === 'relay';
  const label = relayed ? 'Relayed' : 'Direct';
  return (
    <span
      className={`chip ${relayed ? 'chip--relay' : 'chip--direct'}`}
      title={DESCRIPTIONS[connection.route] + (connection.lanes > 1 ? LANES_HINT : '')}
    >
      <Icon name={relayed ? 'relay' : 'bolt'} size={14} />
      {label}
      {connection.rttMs !== null && <span className="chip-detail">{connection.rttMs} ms</span>}
      {connection.lanes > 1 && <span className="chip-detail">{connection.lanes} lanes</span>}
    </span>
  );
}
