/** 内联 SVG 图标（不引入图标库依赖，全部 currentColor）。 */

interface IconProps {
  size?: number;
}

const strokeProps = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.7,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

export function SearchIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="11" cy="11" r="7" {...strokeProps} />
      <line x1="16.5" y1="16.5" x2="21" y2="21" {...strokeProps} />
    </svg>
  );
}

export function GearIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="3.2" {...strokeProps} />
      <path
        d="M19.4 13.5a7.6 7.6 0 0 0 0-3l1.6-1.3-1.9-3.3-1.9.8a7.7 7.7 0 0 0-2.6-1.5L14.3 3h-4.6l-.3 2.2a7.7 7.7 0 0 0-2.6 1.5l-1.9-.8L3 9.2l1.6 1.3a7.6 7.6 0 0 0 0 3L3 14.8l1.9 3.3 1.9-.8a7.7 7.7 0 0 0 2.6 1.5l.3 2.2h4.6l.3-2.2a7.7 7.7 0 0 0 2.6-1.5l1.9.8 1.9-3.3-1.6-1.3Z"
        {...strokeProps}
      />
    </svg>
  );
}

export function SendIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 12 20 4l-4.5 16-3.7-6.2L4 12Z" {...strokeProps} />
    </svg>
  );
}

export function CloseIcon({ size = 14 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <line x1="5" y1="5" x2="19" y2="19" {...strokeProps} />
      <line x1="19" y1="5" x2="5" y2="19" {...strokeProps} />
    </svg>
  );
}

export function TrashIcon({ size = 15 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 7h16M9 7V5h6v2M7 7l1 13h8l1-13" {...strokeProps} />
    </svg>
  );
}

export function CopyIcon({ size = 15 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <rect x="9" y="9" width="11" height="11" rx="2" {...strokeProps} />
      <path d="M15 5H6a1 1 0 0 0-1 1v9" {...strokeProps} />
    </svg>
  );
}

export function QuoteIcon({ size = 15 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M9 6C6 7 5 10 5 13h4v5H4v-5c0-4 2-6 5-7Z" {...strokeProps} />
      <path d="M19 6c-3 1-4 4-4 7h4v5h-5v-5c0-4 2-6 5-7Z" {...strokeProps} />
    </svg>
  );
}

export function ShieldIcon({ size = 15 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 3 5 6v6c0 4.2 2.9 7.4 7 9 4.1-1.6 7-4.8 7-9V6l-7-3Z" {...strokeProps} />
    </svg>
  );
}

export function RefreshIcon({ size = 15 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5" {...strokeProps} />
    </svg>
  );
}
