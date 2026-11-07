export function Logo({ size = 28 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="hopline-logo-gradient" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" style={{ stopColor: 'var(--brand-start)' }} />
          <stop offset="1" style={{ stopColor: 'var(--brand-end)' }} />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="9" fill="url(#hopline-logo-gradient)" />
      <path
        d="M8 21c2.5-9 13.5-9 16 0"
        fill="none"
        stroke="#fff"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeDasharray="0.1 4.2"
      />
      <circle cx="8" cy="21.5" r="3" fill="#fff" />
      <circle cx="24" cy="21.5" r="3" fill="#fff" />
    </svg>
  );
}
