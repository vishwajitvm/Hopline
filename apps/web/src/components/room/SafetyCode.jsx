import { useState } from 'react';
import { Icon } from '../common/Icon.jsx';

/**
 * Both devices derive this code from the encryption keys of this exact connection. If the other person reads
 * out the same code, nobody — not even the server — is intercepting the connection.
 */
export function SafetyCode({ code }) {
  const [open, setOpen] = useState(false);
  if (!code) return null;
  return (
    <div className="safety">
      <button type="button" className="safety-toggle" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <Icon name="shield" size={16} />
        <span>
          Safety code <code>{code}</code>
        </span>
      </button>
      {open && (
        <p className="safety-help">
          Read this code to the other person over a call or chat. If theirs matches exactly, your connection
          is end-to-end encrypted with no one in the middle. If it doesn’t match, leave the room.
        </p>
      )}
    </div>
  );
}
