import { Check, Copy, MailPlus, X } from "lucide-react";
import { useState, type FormEvent } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  useCreateInvite,
  useInvites,
  useRevokeInvite,
} from "@/features/admin/invites/hooks";
import type {
  InviteCreated,
  InviteRow,
  InviteStatus,
} from "@/features/admin/invites/api";
import { ApiError } from "@/lib/api/client";
import { cn } from "@/lib/utils";

const STATUS_TABS: Array<{ value: InviteStatus | ""; label: string }> = [
  { value: "", label: "Все" },
  { value: "pending", label: "Pending" },
  { value: "consumed", label: "Consumed" },
  { value: "revoked", label: "Revoked" },
  { value: "expired", label: "Expired" },
];

import { PageHeader } from "./_PageHeader";

export function AdminInvitesPage(): JSX.Element {
  const [status, setStatus] = useState<InviteStatus | "">("");
  const [createOpen, setCreateOpen] = useState(false);
  const [created, setCreated] = useState<InviteCreated | null>(null);

  const list = useInvites(status);

  return (
    <div>
      <PageHeader
        title="Приглашения"
        description="Invite-ссылки на регистрацию. Email-bound + одноразовые + TTL."
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => list.refetch()}>
              Обновить
            </Button>
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <MailPlus className="h-4 w-4" /> Создать
            </Button>
          </>
        }
      />

      <div className="mb-3 inline-flex rounded-md border border-border bg-card/40 p-1">
        {STATUS_TABS.map((t) => (
          <button
            key={t.value}
            type="button"
            onClick={() => setStatus(t.value)}
            className={cn(
              "rounded px-3 py-1 text-xs font-medium transition-colors",
              status === t.value
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="overflow-hidden rounded-lg border border-border bg-card/40">
        <table className="w-full text-sm">
          <thead className="bg-card/80 text-left text-xs uppercase tracking-wider text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">Email</th>
              <th className="px-3 py-2 font-medium">Статус</th>
              <th className="px-3 py-2 font-medium">Истекает</th>
              <th className="px-3 py-2 font-medium">Создан</th>
              <th className="px-3 py-2 font-medium">Заметка</th>
              <th className="px-3 py-2 text-right font-medium">Действия</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {list.isLoading && (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-muted-foreground">
                  Загрузка…
                </td>
              </tr>
            )}
            {!list.isLoading && list.data?.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-muted-foreground">
                  Нет invite-ссылок.
                </td>
              </tr>
            )}
            {list.data?.map((row) => <InviteTableRow key={row.id} row={row} />)}
          </tbody>
        </table>
      </div>

      <CreateInviteDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(c) => {
          setCreated(c);
          setCreateOpen(false);
        }}
      />

      <CreatedInviteDialog
        invite={created}
        onClose={() => setCreated(null)}
      />
    </div>
  );
}

function InviteTableRow({ row }: { readonly row: InviteRow }) {
  const revoke = useRevokeInvite();
  const [err, setErr] = useState<string | null>(null);

  async function handleRevoke() {
    setErr(null);
    try {
      await revoke.mutateAsync(row.id);
    } catch (e) {
      setErr(formatError(e));
    }
  }

  return (
    <tr className="hover:bg-card/60">
      <td className="px-3 py-2 font-medium">{row.email}</td>
      <td className="px-3 py-2">
        <StatusBadge status={row.status} />
      </td>
      <td className="px-3 py-2 text-muted-foreground">
        {formatDate(row.expiresAt)}
      </td>
      <td className="px-3 py-2 text-muted-foreground">
        {formatDate(row.createdAt)}
      </td>
      <td className="px-3 py-2 text-xs text-muted-foreground max-w-xs truncate">
        {row.notes ?? "—"}
      </td>
      <td className="px-3 py-2 text-right">
        {row.status === "pending" && (
          <Button
            variant="outline"
            size="sm"
            onClick={handleRevoke}
            disabled={revoke.isPending}
          >
            <X className="h-3.5 w-3.5" /> Отозвать
          </Button>
        )}
        {err && <div className="mt-1 text-xs text-destructive">{err}</div>}
      </td>
    </tr>
  );
}

function StatusBadge({ status }: { readonly status: InviteStatus }) {
  if (status === "consumed") return <Badge variant="success">consumed</Badge>;
  if (status === "revoked") return <Badge variant="destructive">revoked</Badge>;
  if (status === "expired") return <Badge variant="warning">expired</Badge>;
  return <Badge variant="default">pending</Badge>;
}

function CreateInviteDialog({
  open,
  onClose,
  onCreated,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onCreated: (i: InviteCreated) => void;
}) {
  const [email, setEmail] = useState("");
  const [ttlHours, setTtlHours] = useState<number | "">("");
  const [notes, setNotes] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const create = useCreateInvite();

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    try {
      const i = await create.mutateAsync({
        email: email.trim().toLowerCase(),
        ...(typeof ttlHours === "number" ? { ttlHours } : {}),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
      });
      setEmail("");
      setTtlHours("");
      setNotes("");
      onCreated(i);
    } catch (e) {
      setErr(formatError(e));
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Создать invite"
      description="Email-bound одноразовый токен. После создания ссылка показывается один раз."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Отмена
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={!email || create.isPending}
          >
            Создать
          </Button>
        </>
      }
    >
      <form onSubmit={handleSubmit} className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="invite-email">Email</Label>
          <Input
            id="invite-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoFocus
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="invite-ttl">TTL, часов (по умолчанию 72)</Label>
          <Input
            id="invite-ttl"
            type="number"
            min={1}
            max={24 * 30}
            value={ttlHours}
            onChange={(e) =>
              setTtlHours(e.target.value === "" ? "" : Number(e.target.value))
            }
            placeholder="72"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="invite-notes">Заметка (опционально)</Label>
          <Input
            id="invite-notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            maxLength={2000}
            placeholder="Контекст: кому, зачем"
          />
        </div>
        {err && (
          <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {err}
          </p>
        )}
      </form>
    </Dialog>
  );
}

function CreatedInviteDialog({
  invite,
  onClose,
}: {
  readonly invite: InviteCreated | null;
  readonly onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);

  async function copyUrl() {
    if (!invite) return;
    try {
      await navigator.clipboard.writeText(invite.inviteUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  }

  return (
    <Dialog
      open={!!invite}
      onClose={onClose}
      title="Invite создан"
      description="Ссылка показывается ОДИН раз. Скопируйте и отправьте пользователю."
      footer={
        <Button onClick={onClose}>Закрыть</Button>
      }
    >
      {invite && (
        <div className="space-y-3 text-sm">
          <div>
            <div className="text-xs uppercase tracking-wider text-muted-foreground">
              Получатель
            </div>
            <div className="mt-0.5 font-medium">{invite.email}</div>
          </div>
          <div>
            <div className="text-xs uppercase tracking-wider text-muted-foreground">
              Ссылка
            </div>
            <div className="mt-1 flex items-stretch gap-2">
              <code className="flex-1 break-all rounded-md border border-border bg-background px-2 py-1.5 font-mono text-[11px]">
                {invite.inviteUrl}
              </code>
              <Button variant="outline" size="icon" onClick={copyUrl}>
                {copied ? (
                  <Check className="h-4 w-4 text-success" />
                ) : (
                  <Copy className="h-4 w-4" />
                )}
              </Button>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Истекает {formatDate(invite.expiresAt)}.
          </p>
        </div>
      )}
    </Dialog>
  );
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatError(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 409)
      return "Уже есть pending invite на этот email. Сначала отзови старый.";
    if (e.status === 400) return "Некорректный email или TTL.";
    return `Ошибка ${e.status}.`;
  }
  return "Сеть недоступна.";
}
