import { useRef, useState } from "react";
import { Check, Loader2, Trash2, Upload } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Avatar } from "./Avatar";
import {
  PRESET_AVATARS,
  fileToAvatarDataUrl,
  type UserProfile,
} from "./profile";
import { cn } from "@/lib/utils";

interface AvatarPickerProps {
  profile: UserProfile;
  onChange: (next: UserProfile) => void;
}

const MAX_FILE_BYTES = 4 * 1024 * 1024; // 4 MB
const ACCEPT = "image/png,image/jpeg,image/webp";

export function AvatarPicker({ profile, onChange }: AvatarPickerProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isImage = profile.avatar.startsWith("data:");

  async function handleFile(file: File) {
    setError(null);
    if (!ACCEPT.split(",").includes(file.type)) {
      setError("Только PNG / JPEG / WebP.");
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      setError("Файл больше 4 МБ.");
      return;
    }
    setBusy(true);
    try {
      const dataUrl = await fileToAvatarDataUrl(file, 96);
      onChange({ ...profile, avatar: dataUrl });
    } catch (e) {
      setError("Не удалось обработать изображение.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      {/* Превью + действия */}
      <div className="flex items-center gap-4">
        <div className="rounded-full ring-2 ring-border ring-offset-2 ring-offset-background">
          <Avatar profile={profile} size={64} />
        </div>
        <div className="flex flex-1 flex-wrap items-center gap-2">
          <input
            ref={fileRef}
            type="file"
            accept={ACCEPT}
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void handleFile(f);
              e.target.value = "";
            }}
          />
          <Button
            variant="outline"
            size="sm"
            onClick={() => fileRef.current?.click()}
            disabled={busy}
          >
            {busy ? <Loader2 className="animate-spin" /> : <Upload />}
            Загрузить фото
          </Button>
          {isImage && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                onChange({ ...profile, avatar: "preset:1" })
              }
            >
              <Trash2 />
              Удалить
            </Button>
          )}
          <p className="text-xs text-muted-foreground">
            PNG / JPEG / WebP, до 4 МБ. Кадрируется до 96×96.
          </p>
        </div>
      </div>

      {error ? (
        <p className="text-xs text-destructive">{error}</p>
      ) : null}

      {/* Пресеты */}
      <div>
        <p className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Или выберите готовый
        </p>
        <div className="grid grid-cols-4 gap-3 sm:grid-cols-8">
          {PRESET_AVATARS.map((p) => {
            const value = `preset:${p.id}`;
            const active = profile.avatar === value;
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => onChange({ ...profile, avatar: value })}
                aria-label={`Avatar ${p.label}`}
                aria-pressed={active}
                className={cn(
                  "relative aspect-square rounded-full transition-transform",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                  active
                    ? "ring-2 ring-primary ring-offset-2 ring-offset-background scale-[1.04]"
                    : "ring-1 ring-border hover:scale-[1.04]",
                )}
              >
                <Avatar
                  profile={{ ...profile, avatar: value }}
                  size={48}
                  className="h-full w-full"
                />
                {active && (
                  <span className="absolute -bottom-1 -right-1 flex h-5 w-5 items-center justify-center rounded-full bg-primary text-primary-foreground shadow">
                    <Check className="h-3 w-3" />
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
