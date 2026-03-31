export function Logo({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
      {/* Outer frame — tilted square */}
      <rect x="8" y="8" width="48" height="48" fill="var(--accent)" stroke="var(--fg)" strokeWidth="4" />

      {/* Arrow/deploy symbol — chunky upward bolt */}
      <polygon
        points="32,12 44,30 37,30 37,44 27,44 27,30 20,30"
        fill="var(--fg)"
      />

      {/* Ground line — thick brutalist bar */}
      <rect x="22" y="48" width="20" height="4" fill="var(--fg)" />
    </svg>
  );
}
