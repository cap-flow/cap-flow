/**
 * Download incoming Telegram media (photo/document/voice/audio/video/sticker)
 * на disk + return file_path для сохранения в БД.
 *
 * Telegram API flow:
 *   1. POST /bot<TOKEN>/getFile?file_id=... → returns { file_path }
 *   2. GET  /file/bot<TOKEN>/<file_path> → raw bytes
 *
 * Storage: ./storage/tg-files/<random-uuid>.<ext>
 *
 * Disk-based storage — fine для single-instance. Multi-instance/HA
 * нужно мигрировать в S3/blob storage.
 */

import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, extname } from "node:path";
import { fetch as undiciFetch } from "undici";

import type { TelegramProxyState } from "./telegram.proxy.js";

export interface DownloadedFile {
  /** Path относительно `storage/tg-files/` для сохранения в БД (e.g. "uuid.jpg") */
  storageKey: string;
  /** Original file name (если был) — для UI display. */
  fileName: string | null;
  /** MIME type если известен. */
  mimeType: string | null;
  /** Size в байтах. */
  size: number;
}

const STORAGE_DIR = process.env["TG_FILES_DIR"] ?? "./storage/tg-files";

export async function downloadTelegramFile(args: {
  botApiToken: string;
  fileId: string;
  proxyState?: TelegramProxyState | null;
  /** Original file_name из document/audio (если есть). */
  fileName?: string | null;
  /** Suggested extension если file_name нет (e.g. "jpg" для photo). */
  defaultExt?: string;
}): Promise<DownloadedFile | null> {
  const proxy = args.proxyState?.currentSync() ?? null;
  const dispatcher = proxy?.dispatcher;

  // Step 1: getFile to resolve file_path.
  const infoUrl =
    `https://api.telegram.org/bot${args.botApiToken}/getFile?file_id=` +
    encodeURIComponent(args.fileId);
  const infoRes = await undiciFetch(infoUrl, {
    ...(dispatcher ? { dispatcher } : {}),
  });
  if (!infoRes.ok) return null;
  const infoJson = (await infoRes.json().catch(() => null)) as
    | { ok: boolean; result?: { file_path?: string; file_size?: number } }
    | null;
  if (!infoJson?.ok || !infoJson.result?.file_path) return null;
  const filePath = infoJson.result.file_path;
  const size = infoJson.result.file_size ?? 0;

  // Step 2: download raw bytes.
  const fileUrl = `https://api.telegram.org/file/bot${args.botApiToken}/${filePath}`;
  const dlRes = await undiciFetch(fileUrl, {
    ...(dispatcher ? { dispatcher } : {}),
  });
  if (!dlRes.ok) return null;
  const buf = Buffer.from(await dlRes.arrayBuffer());

  // Step 3: save to disk.
  const tgExt = extname(filePath); // e.g. ".jpg"
  const ext = args.fileName ? extname(args.fileName) : tgExt || `.${args.defaultExt ?? "bin"}`;
  const storageKey = `${randomUUID()}${ext}`;
  const fullPath = join(STORAGE_DIR, storageKey);
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, buf);

  return {
    storageKey,
    fileName: args.fileName ?? null,
    mimeType: null, // не парсим из Telegram сейчас — UI определит по ext
    size: size || buf.length,
  };
}

/** Resolve storage key → full disk path для serve endpoint'а. */
export function resolveStorageKey(storageKey: string): string | null {
  // Basic sanity — prevent path traversal.
  if (storageKey.includes("/") || storageKey.includes("..") || storageKey.includes("\\")) {
    return null;
  }
  return join(STORAGE_DIR, storageKey);
}
