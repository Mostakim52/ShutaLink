interface ShutaLinkMarkProps {
  className?: string;
}

export function ShutaLinkMark({ className }: ShutaLinkMarkProps) {
  return (
    <svg className={className} viewBox="0 0 64 64" fill="none" aria-hidden="true">
      <g
        transform="translate(32 32) rotate(-45) translate(-11 0)"
        strokeWidth="7"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M-7-8H7A8 8 0 0 1 7 8H-7A8 8 0 0 1-7-8Z" stroke="currentColor" />
        <path d="M15-8H29A8 8 0 0 1 29 8H15A8 8 0 0 1 15-8Z" stroke="var(--amber, #ffb020)" />
        <path
          d="M7-8A8 8 0 0 1 7 8"
          pathLength={100}
          stroke="currentColor"
          strokeDasharray="17 83"
          strokeDashoffset="-75"
        />
      </g>
    </svg>
  );
}
