import {
  PRESET_AVATARS,
  type UserProfile,
  getInitials,
} from "./profile";
import { cn } from "@/lib/utils";

interface AvatarProps {
  profile: UserProfile;
  size?: number;
  className?: string;
}

/**
 * Универсальный аватар:
 * - preset:<id> → SVG-градиент с инициалами
 * - data:image/... → загруженная картинка (object-cover)
 */
export function Avatar({ profile, size = 32, className }: AvatarProps) {
  const isImage = profile.avatar.startsWith("data:");

  if (isImage) {
    return (
      <img
        src={profile.avatar}
        alt={profile.displayName || profile.username || "Avatar"}
        width={size}
        height={size}
        className={cn(
          "rounded-full object-cover bg-secondary",
          className,
        )}
        style={{ width: size, height: size }}
      />
    );
  }

  const presetId = profile.avatar.replace(/^preset:/, "");
  const preset =
    PRESET_AVATARS.find((p) => p.id === presetId) ?? PRESET_AVATARS[0]!;
  const initials = getInitials(profile);
  const fontSize = Math.round(size * 0.42);
  const gradId = `cf-av-${preset.id}`;

  return (
    <span
      className={cn("inline-block rounded-full overflow-hidden", className)}
      style={{ width: size, height: size }}
      aria-label={profile.displayName || profile.username}
    >
      <svg width={size} height={size} viewBox="0 0 64 64">
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="64" y2="64">
            <stop offset="0%" stopColor={preset.from} />
            <stop offset="100%" stopColor={preset.to} />
          </linearGradient>
        </defs>
        <rect width="64" height="64" fill={`url(#${gradId})`} />
        <text
          x="50%"
          y="50%"
          textAnchor="middle"
          dominantBaseline="central"
          fill="white"
          fontFamily="Inter, ui-sans-serif, system-ui, sans-serif"
          fontWeight={600}
          fontSize={fontSize}
          letterSpacing="0.5"
        >
          {initials}
        </text>
      </svg>
    </span>
  );
}
