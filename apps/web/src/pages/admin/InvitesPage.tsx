import { Check, Copy, LinkIcon, MailPlus, X } from "lucide-react";
import { useState, type FormEvent } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/label";
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

import { PageHeader } from "./_PageHeader";

const STATUS_TABS: Array<{ value: InviteStatus | ""; label: string }> = [
  { value: "", label: "Все" },
  { value: "pending", label: "Pending" },
  { value: "consumed", label: "Consumed" },
  { value: "revoked", label: "Revoked" },
  { value: "expired", label: "Expired" },
];

/**
 * Standalone admin page. Now also embeddable inside `/admin/users` as a
 * sub-tab — see `InvitesPanel` below.
 */
export function AdminInvitesPage(): JSX.Element {
  return (
    <div>
      <PageHeader
        title="Приглашения"
        description="Одноразовая invite-ссылка с TTL. Нажмите «Создать» — получите ссылку, скопируйте и отправьте пользователю любым удобным способом. Пользователь перейдёт по ссылке, введёт email + пароль, аккаунт создастся автоматически."
      />
      <InvitesPanel />
    </div>
  );
}

/**
 * Reusable invites UI without a page header. Used both as the standalone
 * page above and as a sub-tab inside `/admin/users` (so admin doesn't have
 * to navigate between two pages to manage the same user lifecycle).
 *
 * Exposes a `showHeader` flag (default true) so it can render its own
 * filter row + create button when embedded — but the embed wraps it in
 * its own header so we let the parent control that placement.
 */
export function InvitesPanel(): JSX.Element {
  const [status, setStatus] = useState<InviteStatus | "">("");
  const [createOpen, setCreateOpen] = useState(false);
  const [created, setCreated] = useState<InviteCreated | null>(null);

  const list = useInvites(status);

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <div className="inline-flex rounded-md border border-border bg-card/40 p-1">
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
        <div className="ml-auto flex gap-2">
          <Button variant="outline" size="sm" onClick={() => list.refetch()}>
            Обновить
          </Button>
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <MailPlus className="h-4 w-4" /> Создать ссылку
          </Button>
        </div>
      </div>

      <div className="overflow-x-auto rounded-lg border border-border bg-card/40">
        <table className="w-full min-w-[900px] text-sm">
          <thead className="bg-card/80 text-left text-xs uppercase tracking-wider text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">Получатель</th>
              <th className="px-3 py-2 font-medium">Статус</th>
              <th className="px-3 py-2 font-medium">Истекает</th>
              <th className="px-3 py-2 font-medium">Создан</th>
              <th className="px-3 py-2 font-medium">Заметка для юзера</th>
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
                  Нет приглашений. Нажмите «Создать ссылку».
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

      <CreatedInviteDialog invite={created} onClose={() => setCreated(null)} />
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
      <td className="px-3 py-2 font-medium">
        {row.email ?? (
          <span className="inline-flex items-center gap-1.5 text-muted-foreground">
            <LinkIcon className="h-3 w-3" />
            <span className="italic">открытая ссылка</span>
          </span>
        )}
      </td>
      <td className="px-3 py-2">
        <StatusBadge status={row.status} />
      </td>
      <td className="px-3 py-2 text-muted-foreground">
        {formatDate(row.expiresAt)}
      </td>
      <td className="px-3 py-2 text-muted-foreground">
        {formatDate(row.createdAt)}
      </td>
      <td className="px-3 py-2 max-w-xs text-xs text-muted-foreground">
        <div className="line-clamp-2 whitespace-pre-wrap">
          {row.notes ?? "—"}
        </div>
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
  const [notes, setNotes] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const create = useCreateInvite();

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    try {
      const i = await create.mutateAsync({
        // Email left empty → backend issues an "open" invite link.
        ...(notes.trim() ? { notes: notes.trim() } : {}),
      });
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
      title="Создать invite-ссылку"
      description="Получите уникальную одноразовую ссылку для регистрации. Email и пароль пользователь введёт сам после перехода."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Отмена
          </Button>
          <Button onClick={handleSubmit} disabled={create.isPending}>
            {create.isPending ? "Создаём…" : "Создать"}
          </Button>
        </>
      }
    >
      <form onSubmit={handleSubmit} className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="invite-notes">
            Заметка для пользователя (опционально)
          </Label>
          <Textarea
            id="invite-notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            maxLength={2000}
            rows={3}
            placeholder='Например: "Привет, Иван! Это твой персональный invite в Capflow. Срок действия 72 часа."'
          />
          <p className="text-[11px] text-muted-foreground">
            Эта заметка будет показана пользователю на странице регистрации.
            Также её увидите вы в списке приглашений для ориентации.
          </p>
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

const INSTRUCTION_TEMPLATE = (url: string, expiresAt: string) => `Здравствуйте! Это персональная invite-ссылка для регистрации в Capflow:

🔗 ${url}

Что нужно сделать:
1. Перейдите по ссылке выше.
2. Введите свой email и пароль (минимум 12 символов).
3. Готово — вы попадёте в личный кабинет.

⭐ Важно: после регистрации сохраните адрес сайта как закладку в браузере (Ctrl+D / Cmd+D) или закрепите вкладку, чтобы потом не потерять — в дальнейшем туда же вы будете заходить под своим логином и паролем.

Ссылка одноразовая и действует до ${expiresAt}.
Если возникнут вопросы — отвечайте на это сообщение.`;

function CreatedInviteDialog({
  invite,
  onClose,
}: {
  readonly invite: InviteCreated | null;
  readonly onClose: () => void;
}) {
  const [copiedUrl, setCopiedUrl] = useState(false);
  const [copiedTemplate, setCopiedTemplate] = useState(false);

  async function copy(text: string, kind: "url" | "template") {
    try {
      await navigator.clipboard.writeText(text);
      if (kind === "url") {
        setCopiedUrl(true);
        setTimeout(() => setCopiedUrl(false), 1500);
      } else {
        setCopiedTemplate(true);
        setTimeout(() => setCopiedTemplate(false), 1500);
      }
    } catch {
      /* ignore */
    }
  }

  if (!invite) return null;

  const expiresHuman = formatDate(invite.expiresAt);
  const instruction = INSTRUCTION_TEMPLATE(invite.inviteUrl, expiresHuman);

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title="Invite-ссылка готова"
      description="Скопируйте ссылку или готовое сообщение и отправьте пользователю любым удобным способом (Telegram, email, мессенджер)."
      footer={<Button onClick={onClose}>Закрыть</Button>}
    >
      <div className="space-y-4 text-sm">
        {invite.notes && (
          <div className="rounded-md border border-border bg-secondary/30 px-3 py-2">
            <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
              Заметка (увидит пользователь)
            </div>
            <div className="mt-1 whitespace-pre-wrap text-foreground">
              {invite.notes}
            </div>
          </div>
        )}

        <div>
          <div className="text-xs uppercase tracking-wider text-muted-foreground">
            Уникальная ссылка
          </div>
          <div className="mt-1 flex items-stretch gap-2">
            <code className="flex-1 break-all rounded-md border border-border bg-background px-2 py-1.5 font-mono text-[11px]">
              {invite.inviteUrl}
            </code>
            <Button
              variant="outline"
              size="sm"
              onClick={() => copy(invite.inviteUrl, "url")}
            >
              {copiedUrl ? (
                <>
                  <Check className="h-4 w-4 text-success" /> Скопировано
                </>
              ) : (
                <>
                  <Copy className="h-4 w-4" /> Копировать
                </>
              )}
            </Button>
          </div>
          <p className="mt-1.5 text-[11px] text-muted-foreground">
            Истекает {expiresHuman}. Ссылка одноразовая — после регистрации
            становится недействительной.
          </p>
        </div>

        <div>
          <div className="flex items-center justify-between">
            <div className="text-xs uppercase tracking-wider text-muted-foreground">
              Готовое сообщение для отправки
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => copy(instruction, "template")}
            >
              {copiedTemplate ? (
                <>
                  <Check className="h-4 w-4 text-success" /> Скопировано
                </>
              ) : (
                <>
                  <Copy className="h-4 w-4" /> Копировать
                </>
              )}
            </Button>
          </div>
          <pre className="mt-1 whitespace-pre-wrap rounded-md border border-border bg-background p-3 text-xs leading-relaxed text-foreground">
            {instruction}
          </pre>
        </div>
      </div>
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
    if (e.status === 409) return "Конфликт. Попробуйте ещё раз.";
    if (e.status === 400) return "Некорректные данные.";
    return `Ошибка ${e.status}.`;
  }
  return "Сеть недоступна.";
}
