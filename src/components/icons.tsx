// Line icons from the design (Lucide shapes).
interface IconProps {
  className?: string;
  size?: number;
}

const stroke = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

export function ChevronIcon({ className, size = 14, open }: IconProps & { open?: boolean }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      {...stroke}
      style={{ transform: open ? "rotate(90deg)" : undefined }}
    >
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}

export function FileIcon({ className, size = 14 }: IconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" {...stroke}>
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
      <path d="M14 2v4a2 2 0 0 0 2 2h4" />
    </svg>
  );
}

export function FolderIcon({ className, size = 14 }: IconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" {...stroke}>
      <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
    </svg>
  );
}

export function PlayIcon({ className, size = 14 }: IconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <polygon points="7 4 20 12 7 20 7 4" />
    </svg>
  );
}

export function PauseIcon({ className, size = 14 }: IconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <rect x="14" y="4" width="4" height="16" rx="1" />
      <rect x="6" y="4" width="4" height="16" rx="1" />
    </svg>
  );
}

export function SearchIcon({ className, size = 14 }: IconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" {...stroke}>
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  );
}

export function ArrowIcon({ className, size = 12 }: IconProps) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      {...stroke}
      strokeWidth={2.2}
    >
      <path d="M7 7h10v10" />
      <path d="M7 17 17 7" />
    </svg>
  );
}

export function CheckIcon({ className, size = 14 }: IconProps) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      {...stroke}
      strokeWidth={2.4}
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

export function SendIcon({ className, size = 15 }: IconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" {...stroke}>
      <path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z" />
      <path d="m21.854 2.147-10.94 10.939" />
    </svg>
  );
}

export function ArrowRightIcon({ className, size = 16 }: IconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" {...stroke}>
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  );
}

export function CommentIcon({ className, size = 17 }: IconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" {...stroke}>
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      <path d="M12 7v6M9 10h6" />
    </svg>
  );
}

export function PasteIcon({ className, size = 15 }: IconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" {...stroke}>
      <rect width="8" height="4" x="8" y="2" rx="1" ry="1" />
      <path d="M8 4H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
      <path d="M16 4h2a2 2 0 0 1 2 2v4M21 14H11M15 10l-4 4 4 4" />
    </svg>
  );
}

export function PencilIcon({ className, size = 12 }: IconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" {...stroke}>
      <path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" />
    </svg>
  );
}

export function TrashIcon({ className, size = 13 }: IconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" {...stroke}>
      <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </svg>
  );
}

export function MicIcon({ className, size = 14 }: IconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" {...stroke}>
      <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <line x1="12" x2="12" y1="19" y2="22" />
    </svg>
  );
}

export function CaptionsIcon({ className, size = 14 }: IconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" {...stroke}>
      <rect width="18" height="14" x="3" y="5" rx="2" ry="2" />
      <path d="M7 15h4M15 15h2M7 11h2M13 11h4" />
    </svg>
  );
}

export function KeyIcon({ className, size = 16 }: IconProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" {...stroke}>
      <circle cx="7.5" cy="15.5" r="5.5" />
      <path d="m21 2-9.6 9.6" />
      <path d="m15.5 7.5 3 3L22 7l-3-3" />
    </svg>
  );
}
