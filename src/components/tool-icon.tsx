import type { ToolIcon as ToolIconName } from "@/lib/tool-icon-names";

type ToolIconProps = {
  name: ToolIconName;
  className?: string;
};

const shared = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

export default function ToolIcon({ name, className = "h-6 w-6" }: ToolIconProps) {
  switch (name) {
    case "brackets":
      return (
        <svg viewBox="0 0 24 24" className={className} aria-hidden="true" {...shared}>
          <path d="M8 4H6a2 2 0 0 0-2 2v3a2 2 0 0 1-2 2 2 2 0 0 1 2 2v3a2 2 0 0 0 2 2h2" />
          <path d="M16 4h2a2 2 0 0 1 2 2v3a2 2 0 0 0 2 2 2 2 0 0 0-2 2v3a2 2 0 0 1-2 2h-2" />
          <path d="M12 9v6" />
        </svg>
      );
    case "key":
      return (
        <svg viewBox="0 0 24 24" className={className} aria-hidden="true" {...shared}>
          <circle cx="16" cy="8" r="4" />
          <path d="M12.5 11.5 4 20l1.5 1.5L7 20l1.5 1.5L10 20l1-1-2-2 1.5-1.5" />
        </svg>
      );
    case "shield":
      return (
        <svg viewBox="0 0 24 24" className={className} aria-hidden="true" {...shared}>
          <path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z" />
          <path d="M9.5 12.5l1.8 1.8 3.4-3.6" />
        </svg>
      );
    case "clock":
      return (
        <svg viewBox="0 0 24 24" className={className} aria-hidden="true" {...shared}>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 2" />
        </svg>
      );
    case "regex":
      return (
        <svg viewBox="0 0 24 24" className={className} aria-hidden="true" {...shared}>
          <path d="M15 4v8" />
          <path d="M11.5 6l7 4" />
          <path d="M18.5 6l-7 4" />
          <circle cx="6.5" cy="17.5" r="2" />
        </svg>
      );
    case "hash":
      return (
        <svg viewBox="0 0 24 24" className={className} aria-hidden="true" {...shared}>
          <path d="M5 9h14M5 15h14M10 4l-2 16M16 4l-2 16" />
        </svg>
      );
    case "calculator":
      return (
        <svg viewBox="0 0 24 24" className={className} aria-hidden="true" {...shared}>
          <rect x="4" y="3" width="16" height="18" rx="2" />
          <path d="M8 7h8" />
          <path d="M8 11h.01M12 11h.01M16 11h.01M8 15h.01M12 15h.01M16 15v3" />
        </svg>
      );
    case "lock":
      return (
        <svg viewBox="0 0 24 24" className={className} aria-hidden="true" {...shared}>
          <rect x="5" y="11" width="14" height="9" rx="2" />
          <path d="M8 11V8a4 4 0 0 1 8 0v3" />
        </svg>
      );
    default:
      return null;
  }
}
