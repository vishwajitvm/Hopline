import { useState } from 'react';
import { isValidRoomCode, normalizeRoomCode } from '@hopline/protocol';
import { Icon } from '../common/Icon.jsx';

const FEATURES = [
  {
    icon: 'globe',
    title: 'Anywhere',
    text: 'Across the room or across the world. Relays step in when networks block a direct link.',
  },
  {
    icon: 'shield',
    title: 'Private & verified',
    text: 'End-to-end encrypted. Every file is checksum-verified on arrival.',
  },
  {
    icon: 'infinity',
    title: 'Big files',
    text: 'Streams straight to disk and resumes after a dropped connection.',
  },
];

export function HomeView({ busy, error, onCreateRoom, onJoinRoom }) {
  const [code, setCode] = useState('');
  const [hideIp, setHideIp] = useState(false);
  const canJoin = isValidRoomCode(code) && !busy;

  const handleJoin = (event) => {
    event.preventDefault();
    if (canJoin) onJoinRoom(code, { hideIp });
  };

  return (
    <section className="home">
      <div className="hero">
        <h1>Send files straight to another device.</h1>
        <p className="lead">
          Open Hopline on both devices, connect with a short code, and drop in your files. They never touch a
          server.
        </p>
      </div>

      <div className="home-actions">
        <article className="card">
          <h2>Start a room</h2>
          <p className="muted">Get a code to share with the other device.</p>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => onCreateRoom({ hideIp })}
            disabled={busy}
          >
            {busy ? 'Connecting…' : 'Create a room'}
          </button>
        </article>

        <form className="card" onSubmit={handleJoin}>
          <h2>Join a room</h2>
          <p className="muted">Enter the code shown on the other device.</p>
          <div className="join-row">
            <input
              className="code-input"
              value={code}
              onChange={(event) => setCode(normalizeRoomCode(event.target.value))}
              placeholder="K7Q2XM"
              aria-label="Room code"
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
            />
            <button type="submit" className="btn" disabled={!canJoin}>
              Join
            </button>
          </div>
        </form>
      </div>

      <label className="toggle">
        <input type="checkbox" checked={hideIp} onChange={(event) => setHideIp(event.target.checked)} />
        <span>
          <strong>
            <Icon name="eyeOff" size={16} /> Hide my IP address
          </strong>
          <span className="muted">
            Route this connection through the relay server so the other device never sees your IP. Can be a
            little slower.
          </span>
        </span>
      </label>

      {error && (
        <p className="alert alert-error" role="alert">
          {error}
        </p>
      )}

      <ul className="features">
        {FEATURES.map((feature) => (
          <li key={feature.title}>
            <Icon name={feature.icon} />
            <div>
              <strong>{feature.title}</strong>
              <span>{feature.text}</span>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
