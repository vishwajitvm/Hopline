import { useCallback, useEffect, useRef, useState } from 'react';
import { copyText } from '../utils/clipboard.js';

/** Returns [copied, copy]; `copied` flips back to false after `resetMs`. */
export function useCopyToClipboard(resetMs = 2000) {
  const [copied, setCopied] = useState(false);
  const timer = useRef(null);

  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = useCallback(
    async (text) => {
      try {
        await copyText(text);
        setCopied(true);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), resetMs);
      } catch {
        setCopied(false);
      }
    },
    [resetMs],
  );

  return [copied, copy];
}
