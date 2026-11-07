import { useEffect, useRef } from 'react';
import { isValidRoomCode, normalizeRoomCode } from '@hopline/protocol';
import { canShareInviteLinks } from '../config/runtime.js';

const PARAM = 'code';

/** Builds a link that opens Hopline and joins `code` automatically. Null when the page can't be shared (desktop app). */
export function buildInviteLink(code) {
  if (!canShareInviteLinks()) return null;
  const url = new URL(window.location.href);
  url.search = '';
  url.hash = '';
  url.searchParams.set(PARAM, code);
  return url.toString();
}

/** If the page was opened from an invite link, joins that room once and cleans the code out of the URL. */
export function useInviteLink(onCode) {
  const handled = useRef(false);

  useEffect(() => {
    if (handled.current) return;
    handled.current = true;

    const url = new URL(window.location.href);
    const code = normalizeRoomCode(url.searchParams.get(PARAM));
    if (!isValidRoomCode(code)) return;

    url.searchParams.delete(PARAM);
    window.history.replaceState(null, '', url);
    onCode(code);
  }, [onCode]);
}
