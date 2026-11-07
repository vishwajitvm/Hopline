import { useEffect, useState } from 'react';

/** Renders `text` to a QR code data URL. The qrcode library is loaded lazily so it stays out of the main bundle. */
export function useQrCode(text) {
  const [dataUrl, setDataUrl] = useState(null);

  useEffect(() => {
    if (!text) {
      setDataUrl(null);
      return undefined;
    }
    let cancelled = false;
    import('qrcode')
      .then(({ toDataURL }) =>
        toDataURL(text, { margin: 1, width: 440, color: { dark: '#111827', light: '#ffffff' } }),
      )
      .then((url) => !cancelled && setDataUrl(url))
      .catch(() => !cancelled && setDataUrl(null));
    return () => {
      cancelled = true;
    };
  }, [text]);

  return dataUrl;
}
