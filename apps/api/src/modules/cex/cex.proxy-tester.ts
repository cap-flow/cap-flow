/**
 * Standalone proxy tester — пробит candidate proxy URL против 3 CEX
 * endpoint'ов и возвращает диагностический отчёт. **НЕ сохраняет** URL
 * в БД, **не апдейтит** `cexProxyState`. Используется в админ-UI для
 * «попробовать прокси перед сохранением».
 *
 * Каждый target probed через TLS HEAD-эквивалент (GET-таймсервер бирж —
 * cheap, public, без auth). Метрика — `latencyMs` + `httpCode` +
 * `error`. UI рендерит результаты как «работает (200) / запрещено
 * (403) / timeout / network».
 *
 * Безопасность: при логировании URL credentials всегда маскируются
 * через `maskProxyCredentials()` (см. ниже).
 */

import { fetch as undiciFetch, ProxyAgent as UndiciProxyAgent } from "undici";

/** Лимит на один probe — 10 секунд. Хорошее compromise между быстротой UI и слабым прокси. */
const PROBE_TIMEOUT_MS = 10_000;

/** Public-time эндпойнты бирж — не требуют auth, отвечают быстро если CDN не блокирует. */
export const PROXY_TEST_TARGETS = [
  { exchange: "bybit", url: "https://api.bybit.com/v5/market/time" },
  { exchange: "bingx", url: "https://api.bingx.com/openApi/spot/v1/server/time" },
  { exchange: "bitget", url: "https://api.bitget.com/api/v2/public/time" },
  { exchange: "binance", url: "https://api.binance.com/api/v3/time" },
] as const;

export type ProxyTestStatus =
  | "ok" // 200 — прокси работает, биржа ответила
  | "geo_blocked" // 403 от CloudFront — exit-IP в заблокированной стране
  | "auth_failed" // 401/407 от прокси — неверные creds
  | "timeout" // нет ответа за PROBE_TIMEOUT_MS
  | "network_error" // TCP refused / DNS / TLS failure
  | "exchange_error"; // 4xx/5xx с тела биржи (но прокси работает)

export interface ProxyTestResult {
  readonly exchange: string;
  readonly url: string;
  readonly status: ProxyTestStatus;
  /** Полная длительность probe в ms. */
  readonly latencyMs: number;
  /** HTTP-код от биржи если ответ был, иначе null. */
  readonly httpCode: number | null;
  /** Краткая ошибка/диагностика для UI tooltip. */
  readonly note: string | null;
}

export interface ProxyTestReport {
  /** Замаскированный URL для отображения в UI. */
  readonly proxyUrl: string;
  readonly results: readonly ProxyTestResult[];
  /** Сводный verdict: хотя бы один target с status='ok'. */
  readonly anyOk: boolean;
}

/**
 * Маскирует `user:pass@` в proxy URL → `***@`. Использовать **всегда**
 * при логировании или возврате URL клиенту.
 */
export function maskProxyCredentials(url: string): string {
  return url.replace(/(\bhttps?:\/\/)([^@/]+@)/i, "$1***@");
}

/**
 * Запускает probe candidate proxy против всех `PROXY_TEST_TARGETS`.
 * Параллельно — общее время ~10s даже если все таргеты timeout'ят.
 *
 * Если URL malformed — throws (caller обернёт в HTTP 400).
 */
export async function testProxy(proxyUrl: string): Promise<ProxyTestReport> {
  const trimmed = proxyUrl.trim();
  if (!trimmed) {
    throw new Error("Proxy URL is empty.");
  }
  // Валидация шасси URL — undici ProxyAgent ругается с криптом
  // «invalid URL», превратим в человеческое сообщение.
  try {
    new URL(trimmed);
  } catch {
    throw new Error(
      `Malformed proxy URL: '${maskProxyCredentials(trimmed)}'. Expected http(s)://user:pass@host:port.`,
    );
  }

  let dispatcher: UndiciProxyAgent;
  try {
    dispatcher = new UndiciProxyAgent(trimmed);
  } catch (e) {
    throw new Error(
      `Failed to build proxy dispatcher: ${(e as Error).message}`,
    );
  }

  const results = await Promise.all(
    PROXY_TEST_TARGETS.map((t) => probeOne(t, dispatcher)),
  );
  return {
    proxyUrl: maskProxyCredentials(trimmed),
    results,
    anyOk: results.some((r) => r.status === "ok"),
  };
}

async function probeOne(
  target: (typeof PROXY_TEST_TARGETS)[number],
  dispatcher: UndiciProxyAgent,
): Promise<ProxyTestResult> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await undiciFetch(target.url, {
      method: "GET",
      dispatcher,
      signal: controller.signal,
    });
    const latencyMs = Date.now() - started;
    clearTimeout(timer);
    return classifyResponse(target, res.status, latencyMs);
  } catch (e) {
    const latencyMs = Date.now() - started;
    clearTimeout(timer);
    return classifyError(target, e as Error, latencyMs);
  }
}

function classifyResponse(
  target: (typeof PROXY_TEST_TARGETS)[number],
  httpCode: number,
  latencyMs: number,
): ProxyTestResult {
  if (httpCode >= 200 && httpCode < 300) {
    return {
      exchange: target.exchange,
      url: target.url,
      status: "ok",
      latencyMs,
      httpCode,
      note: null,
    };
  }
  if (httpCode === 403) {
    return {
      exchange: target.exchange,
      url: target.url,
      status: "geo_blocked",
      latencyMs,
      httpCode,
      note: "CloudFront 403 — exit-IP прокси в заблокированной зоне для этой биржи. Нужен прокси в EU/SG/HK.",
    };
  }
  if (httpCode === 401 || httpCode === 407) {
    return {
      exchange: target.exchange,
      url: target.url,
      status: "auth_failed",
      latencyMs,
      httpCode,
      note: "Прокси отверг auth. Проверьте credentials.",
    };
  }
  return {
    exchange: target.exchange,
    url: target.url,
    status: "exchange_error",
    latencyMs,
    httpCode,
    note: `Биржа ответила ${httpCode}. Прокси работает, проблема не на стороне прокси.`,
  };
}

function classifyError(
  target: (typeof PROXY_TEST_TARGETS)[number],
  err: Error,
  latencyMs: number,
): ProxyTestResult {
  const msg = err.message ?? "";
  if (err.name === "AbortError" || /timeout|abort/i.test(msg)) {
    return {
      exchange: target.exchange,
      url: target.url,
      status: "timeout",
      latencyMs,
      httpCode: null,
      note: `Прокси не ответил за ${PROBE_TIMEOUT_MS / 1000}s. Скорее всего прокси мёртв или жёстко rate-limit'ит.`,
    };
  }
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ENETUNREACH/i.test(msg)) {
    return {
      exchange: target.exchange,
      url: target.url,
      status: "network_error",
      latencyMs,
      httpCode: null,
      note: `Сетевая ошибка: ${msg.slice(0, 120)}`,
    };
  }
  return {
    exchange: target.exchange,
    url: target.url,
    status: "network_error",
    latencyMs,
    httpCode: null,
    note: `${msg.slice(0, 120)}`,
  };
}
