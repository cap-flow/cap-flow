import { useLocalStorage } from "@/lib/useLocalStorage";

/**
 * Аватар пользователя:
 * - "preset:<id>" — один из встроенных градиентных аватаров
 * - data-URL (image/png|jpeg|webp) — загруженная пользователем картинка
 */
export interface UserProfile {
  username: string;
  displayName: string;
  email: string;
  bio: string;
  avatar: string; // preset:1 | data:image/...
}

export const DEFAULT_PROFILE: UserProfile = {
  username: "0x1f…a4d2",
  displayName: "",
  email: "",
  bio: "",
  avatar: "preset:1",
};

export const PRESET_AVATARS: { id: string; from: string; to: string; label: string }[] = [
  { id: "1", from: "#34E0B6", to: "#22D3EE", label: "Mint → Cyan" },
  { id: "2", from: "#22D3EE", to: "#3B82F6", label: "Cyan → Blue" },
  { id: "3", from: "#3B82F6", to: "#1E3A8A", label: "Blue → Deep" },
  { id: "4", from: "#34E0B6", to: "#3B82F6", label: "Mint → Blue" },
  { id: "5", from: "#A855F7", to: "#3B82F6", label: "Violet → Blue" },
  { id: "6", from: "#F59E0B", to: "#EF4444", label: "Amber → Red" },
  { id: "7", from: "#10B981", to: "#0EA5E9", label: "Emerald → Sky" },
  { id: "8", from: "#0F172A", to: "#475569", label: "Slate" },
];

/**
 * Конвертирует File → data-URL с ресайзом до квадрата размера `size`,
 * чтобы не хранить мегабайты в localStorage и быстро рисовать иконку.
 */
export async function fileToAvatarDataUrl(
  file: File,
  size = 96,
): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context unavailable");

  // cover-кроп: вписываем по короткой стороне, центрируем
  const scale = Math.max(size / bitmap.width, size / bitmap.height);
  const dw = bitmap.width * scale;
  const dh = bitmap.height * scale;
  const dx = (size - dw) / 2;
  const dy = (size - dh) / 2;

  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, dx, dy, dw, dh);

  // webp компактнее, fallback в jpeg
  const out =
    canvas.toDataURL("image/webp", 0.85) ||
    canvas.toDataURL("image/jpeg", 0.85);
  bitmap.close();
  return out;
}

export function useProfile() {
  return useLocalStorage<UserProfile>("capflow.profile", DEFAULT_PROFILE);
}

/** Инициалы для preset-аватара. */
export function getInitials(p: UserProfile): string {
  const src =
    p.displayName.trim() || p.username.trim() || p.email.trim() || "C";
  const parts = src
    .replace(/^0x/i, "")
    .split(/\s+|[._-]/)
    .filter(Boolean);
  const first = parts[0]?.[0] ?? "C";
  const second = parts[1]?.[0] ?? "";
  return (first + second).toUpperCase().slice(0, 2);
}
