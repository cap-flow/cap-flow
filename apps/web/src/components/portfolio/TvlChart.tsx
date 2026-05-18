import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { z } from "zod";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { api } from "@/lib/api/client";
import { useActiveAccount } from "@/features/accounts/hooks";
import { cn } from "@/lib/utils";

/**
 * H17 (2026-05-14) — TVL historical chart.
 *
 * Reads from `GET /v1/portfolio/:id/history?days=N`. Renders a minimal
 * inline-SVG line chart — no third-party chart lib needed for a single
 * series with hover-tooltip. Keeps bundle size flat.
 *
 * Three period tabs (7d / 30d / 90d). Default 30d, persisted in state
 * only (no localStorage — choice is per-tab, not per-user).
 */

const responseSchema = z.object({
  accountId: z.string().uuid(),
  granularity: z.enum(["hour", "day"]),
  points: z.array(z.object({ t: z.number(), totalUsd: z.number() })),
});
type HistoryResponse = z.infer<typeof responseSchema>;

const portfolioHistoryApi = {
  // Backend mounts portfolioRoutes under `/accounts/` (see app.ts).
  // The original draft used `/portfolio/` which 404'd at runtime —
  // fixed once we confirmed the actual mount prefix.
  fetch: (accountId: string, days: number): Promise<HistoryResponse> =>
    api.get(`/v1/accounts/${accountId}/history?days=${days}`, responseSchema),
};

const PERIODS = [
  { value: 7, label: "7д" },
  { value: 30, label: "30д" },
  { value: 90, label: "90д" },
] as const;

export function TvlChart(): JSX.Element | null {
  const active = useActiveAccount();
  const [days, setDays] = useState<number>(30);
  const q = useQuery({
    queryKey: ["portfolio", "history", active?.id, days],
    queryFn: () => portfolioHistoryApi.fetch(active!.id, days),
    enabled: !!active?.id,
    staleTime: 60_000,
  });

  if (!active) return null;
  const points = q.data?.points ?? [];

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
        <div>
          <CardTitle className="text-base">Стоимость портфеля</CardTitle>
          <p className="mt-1 text-xs text-muted-foreground">
            Снапшоты копятся раз в час worker'ом. Здесь — динамика за
            выбранный период.
          </p>
        </div>
        <div className="inline-flex rounded-md border border-border bg-card/40 p-1">
          {PERIODS.map((p) => (
            <button
              key={p.value}
              type="button"
              onClick={() => setDays(p.value)}
              className={cn(
                "rounded px-2.5 py-1 text-xs font-medium transition-colors",
                days === p.value
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {p.label}
            </button>
          ))}
        </div>
      </CardHeader>
      <CardContent>
        {q.isLoading && (
          <div className="flex h-48 items-center justify-center text-sm text-muted-foreground">
            Загружаем историю…
          </div>
        )}
        {q.error && (
          <div className="flex h-48 items-center justify-center text-sm text-destructive">
            Не удалось загрузить: {(q.error as Error).message}
          </div>
        )}
        {!q.isLoading && !q.error && points.length === 0 && (
          <div className="flex h-48 items-center justify-center text-sm text-muted-foreground">
            Снапшотов пока нет. Дёрни «Обновить» хотя бы раз — потом
            подождите cron worker (1 раз в час).
          </div>
        )}
        {points.length > 0 && (
          <Chart points={points} granularity={q.data?.granularity ?? "day"} />
        )}
      </CardContent>
    </Card>
  );
}

interface Point {
  readonly t: number;
  readonly totalUsd: number;
}

function Chart({
  points,
  granularity,
}: {
  readonly points: Point[];
  readonly granularity: "hour" | "day";
}) {
  const [hover, setHover] = useState<number | null>(null);
  const dims = useMemo(() => buildDims(points), [points]);

  const first = points[0]!;
  const last = points[points.length - 1]!;
  const change = last.totalUsd - first.totalUsd;
  const changePct =
    first.totalUsd > 0 ? (change / first.totalUsd) * 100 : 0;

  return (
    <div className="space-y-3">
      <div className="flex items-baseline gap-3">
        <span className="text-2xl font-semibold tabular-nums">
          {fmtUsd(last.totalUsd)}
        </span>
        <span
          className={cn(
            "text-sm font-medium tabular-nums",
            change >= 0 ? "text-success" : "text-destructive"
          )}
        >
          {change >= 0 ? "+" : ""}
          {fmtUsd(change)} ({change >= 0 ? "+" : ""}
          {changePct.toFixed(2)}%)
        </span>
      </div>

      <div className="relative">
        <svg
          viewBox={`0 0 ${dims.w} ${dims.h}`}
          preserveAspectRatio="none"
          className="h-48 w-full"
          onMouseLeave={() => setHover(null)}
          onMouseMove={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            const x = ((e.clientX - rect.left) / rect.width) * dims.w;
            const idx = nearestIndex(points, x, dims);
            setHover(idx);
          }}
        >
          {/* Gridline at midpoint for visual scale anchor. */}
          <line
            x1={0}
            x2={dims.w}
            y1={dims.h / 2}
            y2={dims.h / 2}
            stroke="currentColor"
            strokeOpacity={0.08}
            strokeDasharray="3 3"
          />
          {/* Gradient fill under the line. */}
          <defs>
            <linearGradient id="tvl-grad" x1="0" y1="0" x2="0" y2="1">
              <stop
                offset="0%"
                stopColor={change >= 0 ? "#10b981" : "#ef4444"}
                stopOpacity={0.25}
              />
              <stop
                offset="100%"
                stopColor={change >= 0 ? "#10b981" : "#ef4444"}
                stopOpacity={0}
              />
            </linearGradient>
          </defs>
          <path
            d={areaPath(points, dims)}
            fill="url(#tvl-grad)"
            stroke="none"
          />
          <path
            d={linePath(points, dims)}
            fill="none"
            stroke={change >= 0 ? "#10b981" : "#ef4444"}
            strokeWidth={1.5}
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
          {hover !== null && points[hover] && (
            <line
              x1={xFor(hover, points.length, dims)}
              x2={xFor(hover, points.length, dims)}
              y1={0}
              y2={dims.h}
              stroke="currentColor"
              strokeOpacity={0.3}
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
          )}
        </svg>

        {hover !== null && points[hover] && (
          <div
            className="pointer-events-none absolute top-0 rounded-md border border-border bg-card px-2.5 py-1.5 text-xs shadow-lg"
            style={{
              left: `${
                (xFor(hover, points.length, dims) / dims.w) * 100
              }%`,
              transform: "translateX(-50%)",
            }}
          >
            <div className="font-medium tabular-nums">
              {fmtUsd(points[hover]!.totalUsd)}
            </div>
            <div className="text-[10px] text-muted-foreground">
              {fmtDate(points[hover]!.t, granularity)}
            </div>
          </div>
        )}
      </div>

      <div className="flex justify-between text-[10px] text-muted-foreground">
        <span>{fmtDate(first.t, granularity)}</span>
        <span>{fmtDate(last.t, granularity)}</span>
      </div>
    </div>
  );
}

interface Dims {
  readonly w: number;
  readonly h: number;
  readonly pad: number;
  readonly min: number;
  readonly max: number;
}

function buildDims(points: Point[]): Dims {
  const values = points.map((p) => p.totalUsd);
  const min = Math.min(...values);
  const max = Math.max(...values);
  // Add 5% headroom top + bottom so the line doesn't kiss the edges.
  const span = max - min || max || 1;
  return {
    w: 800,
    h: 200,
    pad: 4,
    min: min - span * 0.05,
    max: max + span * 0.05,
  };
}

function xFor(idx: number, n: number, d: Dims): number {
  if (n <= 1) return d.w / 2;
  return d.pad + (idx / (n - 1)) * (d.w - 2 * d.pad);
}

function yFor(v: number, d: Dims): number {
  const span = d.max - d.min || 1;
  const norm = (v - d.min) / span;
  return d.pad + (1 - norm) * (d.h - 2 * d.pad);
}

function linePath(points: Point[], d: Dims): string {
  return points
    .map((p, i) => {
      const x = xFor(i, points.length, d);
      const y = yFor(p.totalUsd, d);
      return `${i === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");
}

function areaPath(points: Point[], d: Dims): string {
  if (points.length === 0) return "";
  const path = linePath(points, d);
  const lastX = xFor(points.length - 1, points.length, d);
  const firstX = xFor(0, points.length, d);
  return `${path} L${lastX.toFixed(2)},${d.h} L${firstX.toFixed(2)},${d.h} Z`;
}

function nearestIndex(points: Point[], svgX: number, d: Dims): number {
  if (points.length === 0) return 0;
  const ratio = (svgX - d.pad) / (d.w - 2 * d.pad);
  const idx = Math.round(ratio * (points.length - 1));
  return Math.max(0, Math.min(points.length - 1, idx));
}

function fmtUsd(n: number): string {
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(2)}K`;
  return `$${n.toFixed(2)}`;
}

function fmtDate(ms: number, granularity: "hour" | "day"): string {
  const d = new Date(ms);
  if (granularity === "hour") {
    return d.toLocaleString("ru-RU", {
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  }
  return d.toLocaleDateString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
  });
}
