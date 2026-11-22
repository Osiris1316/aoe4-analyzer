// A video mark for Twitch VODs: a small screen with a play triangle.
export function VodIcon({ size = 14 }: { size?: number }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden="true" focusable="false" style={{ display: 'block', flex: '0 0 auto' }}>
      <rect x="1.5" y="3" width="13" height="10" rx="2" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M6.6 5.9v4.2L10.2 8z" fill="currentColor" />
    </svg>
  );
}
