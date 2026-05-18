import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  useDeleteFeatureFlag,
  useFeatureFlags,
  useUpsertFeatureFlag,
} from "@/features/admin/feature-flags/hooks";
import type { FlagScope } from "@/features/admin/feature-flags/api";

import { PageHeader } from "./_PageHeader";

/**
 * Admin console for feature flags.
 *
 * Layout: list of (key → rows grouped by scope) on the left, create/upsert
 * form on the right. Each row is editable inline (toggle enabled, change
 * payload, delete). Per-account / per-user overrides take an additional
 * `scopeRefId` UUID.
 */
export function AdminFeatureFlagsPage(): JSX.Element {
  const flags = useFeatureFlags();
  const upsert = useUpsertFeatureFlag();
  const del = useDeleteFeatureFlag();

  // Group by key for display.
  const grouped = useMemo(() => {
    const byKey = new Map<
      string,
      ReturnType<typeof useFeatureFlags>["data"] extends Array<infer T> ? T[] : never
    >();
    for (const row of flags.data ?? []) {
      const arr = byKey.get(row.key) ?? [];
      arr.push(row);
      byKey.set(row.key, arr);
    }
    return [...byKey.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [flags.data]);

  // Form state.
  const [formKey, setFormKey] = useState("");
  const [formScope, setFormScope] = useState<FlagScope>("global");
  const [formRefId, setFormRefId] = useState("");
  const [formEnabled, setFormEnabled] = useState(true);
  const [formError, setFormError] = useState<string | null>(null);

  async function onCreate(): Promise<void> {
    setFormError(null);
    try {
      await upsert.mutateAsync({
        key: formKey.trim(),
        body: {
          scope: formScope,
          scopeRefId: formScope === "global" ? null : formRefId.trim() || null,
          enabled: formEnabled,
        },
      });
      setFormKey("");
      setFormRefId("");
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Ошибка");
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Feature flags"
        description="Канареечная выкатка фич + версионирование методики. Приоритет: user → account → global → default(false)."
      />

      <div className="grid gap-4 lg:grid-cols-[1fr,360px]">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Текущие флаги</CardTitle>
            <CardDescription>
              {flags.data?.length ?? 0} ряд(ов) во всех scope-ах.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {flags.isLoading ? (
              <p className="text-sm text-muted-foreground">Загружаем…</p>
            ) : grouped.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Пока ничего не создано.
              </p>
            ) : (
              <div className="space-y-4">
                {grouped.map(([key, rows]) => (
                  <div key={key} className="rounded-md border p-3">
                    <div className="mb-2 flex items-center justify-between">
                      <code className="font-mono text-sm font-semibold">
                        {key}
                      </code>
                      <span className="text-xs text-muted-foreground">
                        {rows.length} scope-ряд(ов)
                      </span>
                    </div>
                    <div className="overflow-x-auto">
                    <table className="w-full min-w-[500px] text-sm">
                      <thead className="text-left text-muted-foreground">
                        <tr>
                          <th className="py-1">Scope</th>
                          <th className="py-1">Ref ID</th>
                          <th className="py-1 text-center">Enabled</th>
                          <th className="py-1 text-right" />
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((r) => (
                          <tr key={r.id} className="border-t">
                            <td className="py-1.5">{r.scope}</td>
                            <td className="py-1.5 font-mono text-xs">
                              {r.scopeRefId
                                ? r.scopeRefId.slice(0, 8) + "…"
                                : "—"}
                            </td>
                            <td className="py-1.5 text-center">
                              <input
                                type="checkbox"
                                checked={r.enabled}
                                onChange={(e) =>
                                  upsert.mutate({
                                    key: r.key,
                                    body: {
                                      scope: r.scope,
                                      scopeRefId: r.scopeRefId,
                                      enabled: e.target.checked,
                                    },
                                  })
                                }
                                disabled={upsert.isPending}
                              />
                            </td>
                            <td className="py-1.5 text-right">
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                onClick={() => del.mutate(r.id)}
                                disabled={del.isPending}
                              >
                                Удалить
                              </Button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="self-start">
          <CardHeader>
            <CardTitle className="text-base">Создать / обновить</CardTitle>
            <CardDescription>
              Pусть upsert по ключу: повторное PUT обновляет существующий ряд
              этого scope.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div>
              <Label htmlFor="key">Ключ</Label>
              <Input
                id="key"
                placeholder="cost_basis_v2"
                value={formKey}
                onChange={(e) => setFormKey(e.target.value)}
                disabled={upsert.isPending}
              />
            </div>
            <div>
              <Label htmlFor="scope">Scope</Label>
              <select
                id="scope"
                className="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
                value={formScope}
                onChange={(e) => setFormScope(e.target.value as FlagScope)}
                disabled={upsert.isPending}
              >
                <option value="global">global</option>
                <option value="account">account</option>
                <option value="user">user</option>
              </select>
            </div>
            {formScope !== "global" && (
              <div>
                <Label htmlFor="refId">
                  {formScope === "user" ? "User ID" : "Account ID"} (UUID)
                </Label>
                <Input
                  id="refId"
                  placeholder="00000000-0000-0000-0000-000000000000"
                  value={formRefId}
                  onChange={(e) => setFormRefId(e.target.value)}
                  disabled={upsert.isPending}
                />
              </div>
            )}
            <div className="flex items-center gap-2">
              <input
                id="enabled"
                type="checkbox"
                checked={formEnabled}
                onChange={(e) => setFormEnabled(e.target.checked)}
                disabled={upsert.isPending}
              />
              <Label htmlFor="enabled">enabled</Label>
            </div>
            {formError && (
              <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {formError}
              </p>
            )}
            <Button
              type="button"
              onClick={() => void onCreate()}
              disabled={
                upsert.isPending ||
                !formKey.trim() ||
                (formScope !== "global" && !formRefId.trim())
              }
              className="w-full"
            >
              {upsert.isPending ? "Сохраняем…" : "Создать / обновить"}
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
