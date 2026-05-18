/**
 * Tax T5: per-jurisdiction rule configuration.
 *
 * Software model упрощённый: только параметры, которые влияют на нашу
 * tax-event generation. Реальная tax law гораздо более нюансирована
 * (per-state rules, wash sale, etc.). Для actual filing нужен tax
 * advisor — это tool для подготовки данных, не legal advice.
 *
 * Backlog T5.1: like-kind exception (если jurisdiction разрешает crypto
 * exchange skip), wash sale rules, per-state nuances (US: CA / NY).
 */
import type { LotMethodology } from "./lots/types";

export const JURISDICTIONS = ["US", "EU", "RU", "UK"] as const;
export type Jurisdiction = (typeof JURISDICTIONS)[number];

export interface JurisdictionConfig {
  readonly code: Jurisdiction;
  readonly label: string;
  /**
   * Days threshold для классификации gain как 'long' vs 'short'.
   * Infinity → нет distinction (e.g. UK).
   */
  readonly longTermThresholdDays: number;
  /**
   * Whitelist methodologies разрешённых в этой jurisdiction. UI выбирает
   * только из них; default = first in array.
   */
  readonly allowedMethodologies: ReadonlyArray<LotMethodology>;
  /**
   * Treat token-to-token swap как taxable disposition (US default since 2018).
   * False → exchange events не emit'ятся.
   */
  readonly tokenToTokenTaxable: boolean;
  /** UI-facing notes / disclaimers. */
  readonly notes: string;
}

const US_CONFIG: JurisdictionConfig = {
  code: "US",
  label: "United States",
  longTermThresholdDays: 365,
  allowedMethodologies: ["WAC", "FIFO", "LIFO", "HIFO"],
  tokenToTokenTaxable: true,
  notes:
    "Holding ≥ 365 days = long-term capital gains rate. Token-to-token swaps " +
    "taxable since 2018 (no like-kind exception). Specific ID разрешён.",
};

const EU_CONFIG: JurisdictionConfig = {
  code: "EU",
  label: "European Union (generic)",
  longTermThresholdDays: 365,
  allowedMethodologies: ["WAC", "FIFO"],
  tokenToTokenTaxable: true,
  notes:
    "Generic EU model: 365d threshold typical. Per-country variations " +
    "(Germany 1y, France 22.5%+17.2%, NL Box-3) — backlog T5.x.",
};

const RU_CONFIG: JurisdictionConfig = {
  code: "RU",
  label: "Russia",
  longTermThresholdDays: 1095, // 3 years
  allowedMethodologies: ["FIFO", "LIFO"],
  tokenToTokenTaxable: true,
  notes:
    "Налогообложение крипты в РФ (НК РФ ст. 309.1): декларация по полному " +
    "доходу. WAC не применяется — лот-учёт FIFO/LIFO. Льгота 3-летнего " +
    "владения для отдельных активов (не для крипты по умолчанию).",
};

const UK_CONFIG: JurisdictionConfig = {
  code: "UK",
  label: "United Kingdom",
  longTermThresholdDays: Number.POSITIVE_INFINITY,
  allowedMethodologies: ["WAC"],
  tokenToTokenTaxable: true,
  notes:
    "HMRC Section 104 pooling = WAC. Нет distinction long/short. CGT " +
    "annual allowance (£3k @ 2025). Same-day и 30-day matching rules — " +
    "backlog T5.x.",
};

const CONFIGS: Record<Jurisdiction, JurisdictionConfig> = {
  US: US_CONFIG,
  EU: EU_CONFIG,
  RU: RU_CONFIG,
  UK: UK_CONFIG,
};

export function getJurisdictionConfig(j: Jurisdiction): JurisdictionConfig {
  return CONFIGS[j];
}

export function getDefaultMethodForJurisdiction(
  j: Jurisdiction,
): LotMethodology {
  return CONFIGS[j].allowedMethodologies[0] ?? "WAC";
}
