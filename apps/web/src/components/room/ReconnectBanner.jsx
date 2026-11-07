/** Shown while the connection is being restored. Transfers continue where they stopped once it's back. */
export function ReconnectBanner({ peerOnline, serverOnline }) {
  let detail = 'Transfers will continue from where they stopped.';
  if (!serverOnline) detail = 'Your internet connection seems to be down. Waiting for it to come back…';
  else if (!peerOnline) detail = 'Waiting for the other device to come back online…';
  return (
    <div className="banner banner--warning" role="status">
      <span className="spinner spinner--small" aria-hidden="true" />
      <div>
        <strong>Connection interrupted — reconnecting</strong>
        <span>{detail}</span>
      </div>
    </div>
  );
}
