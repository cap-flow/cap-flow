import { type Database, schema } from "@cap-flow/db";
import { eq } from "drizzle-orm";

import type { Env } from "../../config/env.js";
import { NotFoundError, ValidationError } from "../../core/errors.js";
import {
  buildSettingsCatalog,
  type SettingDefinition,
} from "./app-settings.catalog.js";

export type SettingPrimitive = number | boolean | string;

export interface ResolvedSetting extends SettingDefinition {
  /** Текущее активное значение (DB-override или дефолт каталога). */
  readonly currentValue: SettingPrimitive;
  /** Источник активного значения. */
  readonly source: "db" | "default";
  /** ISO время последнего изменения (если есть DB-override). */
  readonly editedAt: string | null;
}

const SETTINGS_CACHE_TTL_MS = 10_000;

/**
 * Admin-настраиваемые «кнобы» с resolution `DB-override → дефолт каталога (env)`.
 *
 *   GET    /admin/app-settings        — список каталога + текущие значения + source.
 *   PATCH  /admin/app-settings/:key   — задать значение (валидация по каталогу).
 *   DELETE /admin/app-settings/:key   — сброс к дефолту.
 *   GET    /v1/me/app-config          — только frontend-кнобы (для веба).
 *
 * Кэш: in-proc Map с TTL ~10s. `set/reset` синхронно перезагружают снапшот, так
 * что live-кнобы (rate limits, квоты) подхватываются без рестарта. На мульти-
 * реплике другие инстансы догоняют в пределах TTL (sync-геттер триггерит
 * фоновую перезагрузку при устаревании). «restart»-кнобы применяются на boot.
 */
export class AppSettingsService {
  private readonly catalog: SettingDefinition[];
  private readonly byKey: Map<string, SettingDefinition>;
  /** key → распарсенное значение DB-override (если строка присутствует). */
  private snapshot = new Map<string, SettingPrimitive>();
  /** key → ISO updatedAt для DB-override. */
  private editedAt = new Map<string, string>();
  private loadedAt = 0;
  private reloading: Promise<void> | null = null;

  constructor(
    private readonly db: Database,
    env: Env,
  ) {
    this.catalog = buildSettingsCatalog(env);
    this.byKey = new Map(this.catalog.map((d) => [d.key, d]));
  }

  /** Прогрев снапшота при старте (опционально, до wiring консьюмеров). */
  async warm(): Promise<void> {
    await this.loadAll();
  }

  /* ----------------------------- загрузка ------------------------------- */

  private async loadAll(): Promise<void> {
    if (this.reloading) return this.reloading;
    this.reloading = (async () => {
      try {
        const rows = await this.db.select().from(schema.appSettings);
        const nextSnap = new Map<string, SettingPrimitive>();
        const nextEdited = new Map<string, string>();
        for (const r of rows) {
          const def = this.byKey.get(r.key);
          if (!def) continue; // неизвестный ключ — игнорируем
          if (r.value == null || r.value === "") continue; // = сброшено → дефолт
          const parsed = this.parse(def, r.value);
          if (parsed != null) nextSnap.set(r.key, parsed);
          if (r.updatedAt) nextEdited.set(r.key, r.updatedAt.toISOString());
        }
        this.snapshot = nextSnap;
        this.editedAt = nextEdited;
        this.loadedAt = Date.now();
      } catch (e) {
        // Таблица ещё не мигрирована / БД недоступна → работаем на дефолтах.
        // eslint-disable-next-line no-console
        console.warn(
          "[app-settings] load failed, falling back to catalog defaults:",
          (e as Error).message,
        );
        this.loadedAt = Date.now(); // не долбим БД каждый запрос
      } finally {
        this.reloading = null;
      }
    })();
    return this.reloading;
  }

  private async ensureFresh(): Promise<void> {
    if (Date.now() - this.loadedAt >= SETTINGS_CACHE_TTL_MS) {
      await this.loadAll();
    }
  }

  /** Фоновая перезагрузка при устаревании — для синхронных консьюмеров. */
  private kickReloadIfStale(): void {
    if (Date.now() - this.loadedAt >= SETTINGS_CACHE_TTL_MS && !this.reloading) {
      void this.loadAll();
    }
  }

  /* ----------------------------- парсинг -------------------------------- */

  private parse(
    def: SettingDefinition,
    raw: string,
  ): SettingPrimitive | null {
    if (def.valueType === "number") {
      const n = Number(raw);
      if (!Number.isFinite(n)) return null;
      return n;
    }
    if (def.valueType === "boolean") {
      return raw === "true" || raw === "1";
    }
    return raw;
  }

  private serialize(value: SettingPrimitive): string {
    return typeof value === "boolean" ? (value ? "true" : "false") : String(value);
  }

  private resolveSync(key: string): SettingPrimitive {
    const def = this.byKey.get(key);
    if (!def) throw new NotFoundError(`Unknown setting: ${key}`);
    const override = this.snapshot.get(key);
    return override !== undefined ? override : def.defaultValue;
  }

  /* ------------------------------ чтение -------------------------------- */

  /** Синхронный доступ к текущему значению (для hot-path: rate limit getters). */
  getSnapshotSync<T extends SettingPrimitive = SettingPrimitive>(key: string): T {
    this.kickReloadIfStale();
    return this.resolveSync(key) as T;
  }

  async getNumber(key: string): Promise<number> {
    await this.ensureFresh();
    const v = this.resolveSync(key);
    return typeof v === "number" ? v : Number(v);
  }

  async getBoolean(key: string): Promise<boolean> {
    await this.ensureFresh();
    return Boolean(this.resolveSync(key));
  }

  async getString(key: string): Promise<string> {
    await this.ensureFresh();
    return String(this.resolveSync(key));
  }

  /** Для admin-UI: каталог + текущие значения + источник. */
  async listResolved(): Promise<ResolvedSetting[]> {
    await this.ensureFresh();
    return this.catalog.map((def) => {
      const override = this.snapshot.get(def.key);
      return {
        ...def,
        currentValue: override !== undefined ? override : def.defaultValue,
        source: override !== undefined ? ("db" as const) : ("default" as const),
        editedAt: this.editedAt.get(def.key) ?? null,
      };
    });
  }

  /** Только frontend-кнобы — для GET /v1/me/app-config. */
  async frontendConfig(): Promise<Record<string, SettingPrimitive>> {
    await this.ensureFresh();
    const out: Record<string, SettingPrimitive> = {};
    for (const def of this.catalog) {
      if (def.scope !== "frontend") continue;
      const override = this.snapshot.get(def.key);
      out[def.key] = override !== undefined ? override : def.defaultValue;
    }
    return out;
  }

  /* ------------------------------ запись -------------------------------- */

  private validate(def: SettingDefinition, value: SettingPrimitive): void {
    if (def.valueType === "number") {
      const n = typeof value === "number" ? value : Number(value);
      if (!Number.isFinite(n)) {
        throw new ValidationError(`${def.key}: ожидалось число`);
      }
      if (def.min != null && n < def.min) {
        throw new ValidationError(`${def.key}: значение < минимума (${def.min})`);
      }
      if (def.max != null && n > def.max) {
        throw new ValidationError(`${def.key}: значение > максимума (${def.max})`);
      }
    } else if (def.valueType === "boolean") {
      if (typeof value !== "boolean" && value !== "true" && value !== "false") {
        throw new ValidationError(`${def.key}: ожидался boolean`);
      }
    }
  }

  /** Задать/обновить значение кноба. Инвалидирует кэш (live-применение). */
  async set(
    key: string,
    value: SettingPrimitive,
    actorUserId: string,
  ): Promise<void> {
    const def = this.byKey.get(key);
    if (!def) throw new NotFoundError(`Unknown setting: ${key}`);
    this.validate(def, value);
    const serialized = this.serialize(value);
    await this.db
      .insert(schema.appSettings)
      .values({
        key,
        value: serialized,
        valueType: def.valueType,
        updatedBy: actorUserId,
      })
      .onConflictDoUpdate({
        target: schema.appSettings.key,
        set: {
          value: serialized,
          valueType: def.valueType,
          updatedBy: actorUserId,
          updatedAt: new Date(),
        },
      });
    this.loadedAt = 0; // инвалидация
    await this.loadAll();
  }

  /** Сброс кноба к дефолту (удаляет DB-override). */
  async reset(key: string, _actorUserId: string): Promise<void> {
    const def = this.byKey.get(key);
    if (!def) throw new NotFoundError(`Unknown setting: ${key}`);
    await this.db
      .delete(schema.appSettings)
      .where(eq(schema.appSettings.key, key));
    this.loadedAt = 0;
    await this.loadAll();
  }
}
