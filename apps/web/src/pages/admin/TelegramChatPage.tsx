import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Send, Loader2, MessageSquare, ExternalLink } from "lucide-react";

import { PageHeader } from "./_PageHeader";
import {
  useConversations,
  useMessages,
  useSendMessage,
  useMarkRead,
} from "@/features/admin/telegram-chat/hooks";
import { useAdminUsers } from "@/features/admin/users/hooks";
import type { AdminUserRow } from "@/features/admin/users/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
  });
}

function formatUsd(n: number | null): string {
  if (n == null) return "—";
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}k`;
  return `$${n.toFixed(0)}`;
}

function ChatHeader({
  user,
  userId,
}: {
  readonly user: AdminUserRow | null;
  readonly userId: string;
}): JSX.Element {
  const statusTone =
    user?.status === "active"
      ? "success"
      : user?.status === "blocked"
        ? "destructive"
        : "warning";
  return (
    <div className="border-b border-border px-4 py-2.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-sm truncate">
              {user?.name ?? userId.slice(0, 8) + "…"}
            </span>
            {user && (
              <>
                <Badge
                  variant={statusTone}
                  className="text-[9px] uppercase px-1.5 py-0"
                >
                  {user.status}
                </Badge>
                <Badge
                  variant={user.role === "admin" ? "default" : "muted"}
                  className="text-[9px] uppercase px-1.5 py-0"
                >
                  {user.role}
                </Badge>
              </>
            )}
          </div>
          {user?.email && (
            <div className="text-xs text-muted-foreground truncate">
              {user.email}
            </div>
          )}
        </div>
        {user && (
          <Link
            to={`/admin/users/${user.id}`}
            className="shrink-0 inline-flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground"
            title="Открыть профиль"
          >
            Профиль <ExternalLink className="h-3 w-3" />
          </Link>
        )}
      </div>
      {user && (
        <dl className="mt-2 grid grid-cols-4 gap-x-3 gap-y-1 text-[10px]">
          <UserStat label="Регистрация" value={formatDate(user.createdAt)} />
          <UserStat
            label="Last login"
            value={user.lastLoginAt ? formatDate(user.lastLoginAt) : "—"}
          />
          <UserStat label="Аккаунты" value={String(user.accountCount)} />
          <UserStat
            label="Капитал"
            value={formatUsd(user.lastSnapshotUsd)}
            sub={
              user.lastSnapshotAt
                ? `на ${formatDate(user.lastSnapshotAt)}`
                : undefined
            }
          />
        </dl>
      )}
    </div>
  );
}

function UserStat({
  label,
  value,
  sub,
}: {
  readonly label: string;
  readonly value: string;
  readonly sub?: string;
}): JSX.Element {
  return (
    <div className="min-w-0">
      <dt className="uppercase tracking-wider text-muted-foreground/70">
        {label}
      </dt>
      <dd className="font-medium text-foreground truncate">
        {value}
        {sub && (
          <span className="ml-1 font-normal text-muted-foreground/70">
            {sub}
          </span>
        )}
      </dd>
    </div>
  );
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatTimeShort(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  if (
    d.getDate() === today.getDate() &&
    d.getMonth() === today.getMonth() &&
    d.getFullYear() === today.getFullYear()
  ) {
    return d.toLocaleTimeString("ru-RU", {
      hour: "2-digit",
      minute: "2-digit",
    });
  }
  return d.toLocaleDateString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
  });
}

export function AdminTelegramChatPage(): JSX.Element {
  const conversations = useConversations();
  const usersList = useAdminUsers({ limit: 200 });
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [onlyUnread, setOnlyUnread] = useState(false);
  const [draft, setDraft] = useState("");
  const messages = useMessages(selectedUserId);
  const sendMutation = useSendMessage();
  const markReadMutation = useMarkRead();
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const userById = useMemo(() => {
    const m = new Map<string, AdminUserRow>();
    for (const u of usersList.data?.items ?? []) m.set(u.id, u);
    return m;
  }, [usersList.data]);

  const filteredConversations = useMemo(() => {
    const all = conversations.data ?? [];
    return onlyUnread ? all.filter((c) => c.unreadCount > 0) : all;
  }, [conversations.data, onlyUnread]);

  const totalUnread = useMemo(
    () =>
      (conversations.data ?? []).reduce((sum, c) => sum + c.unreadCount, 0),
    [conversations.data],
  );

  // Auto-scroll to bottom when new messages arrive.
  useEffect(() => {
    if (messages.data && messages.data.length > 0) {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages.data?.length]);

  // Mark as read when conversation opens.
  useEffect(() => {
    if (!selectedUserId) return;
    const conv = conversations.data?.find((c) => c.userId === selectedUserId);
    if (conv && conv.unreadCount > 0) {
      markReadMutation.mutate(selectedUserId);
    }
  }, [selectedUserId, conversations.data]);

  async function handleSend() {
    const text = draft.trim();
    if (!text || !selectedUserId) return;
    try {
      await sendMutation.mutateAsync({ userId: selectedUserId, text });
      setDraft("");
    } catch (e) {
      alert(`Ошибка отправки: ${(e as Error).message}`);
    }
  }

  const selectedConv = useMemo(
    () =>
      selectedUserId
        ? conversations.data?.find((c) => c.userId === selectedUserId) ?? null
        : null,
    [selectedUserId, conversations.data],
  );

  // Сортируем messages по времени (от старых к новым для chat view).
  const sortedMessages = useMemo(
    () =>
      (messages.data ?? [])
        .slice()
        .sort(
          (a, b) =>
            new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
        ),
    [messages.data],
  );

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Чат с пользователями"
        description="Переписка через Telegram-бот. Отвечайте напрямую — пользователи получат сообщения в Telegram."
      />
      <div className="grid flex-1 grid-cols-1 gap-3 lg:grid-cols-[320px_1fr] min-h-0">
        {/* Sidebar: conversations */}
        <div className="flex flex-col rounded-md border border-border bg-card overflow-hidden">
          <div className="border-b border-border px-3 py-2 flex items-center justify-between gap-2">
            <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Диалоги ({filteredConversations.length}
              {onlyUnread && `/${conversations.data?.length ?? 0}`})
            </span>
            <button
              type="button"
              onClick={() => setOnlyUnread((v) => !v)}
              className={cn(
                "rounded px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider transition-colors",
                onlyUnread
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground hover:bg-accent",
              )}
              title="Показать только диалоги с непрочитанными"
            >
              {onlyUnread
                ? `Непрочитанные${totalUnread > 0 ? ` · ${totalUnread}` : ""}`
                : `Все${totalUnread > 0 ? ` · ${totalUnread}` : ""}`}
            </button>
          </div>
          <div className="flex-1 overflow-y-auto">
            {conversations.isLoading && (
              <div className="flex items-center gap-2 p-3 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Загрузка…
              </div>
            )}
            {conversations.data && conversations.data.length === 0 && (
              <div className="p-4 text-sm text-muted-foreground text-center">
                <MessageSquare className="mx-auto mb-2 h-8 w-8 opacity-40" />
                Нет диалогов. Они появятся когда пользователь напишет в бот.
              </div>
            )}
            {conversations.data &&
              conversations.data.length > 0 &&
              filteredConversations.length === 0 && (
                <div className="p-4 text-xs text-muted-foreground text-center">
                  Нет непрочитанных. Все диалоги отвечены 🎉
                </div>
              )}
            {filteredConversations.map((c) => {
              const user = userById.get(c.userId);
              const isActive = c.userId === selectedUserId;
              return (
                <button
                  key={c.userId}
                  type="button"
                  onClick={() => setSelectedUserId(c.userId)}
                  className={cn(
                    "w-full border-b border-border/40 px-3 py-2 text-left hover:bg-accent/30 transition-colors",
                    isActive && "bg-accent/40",
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-medium">
                      {user?.name ?? c.userId.slice(0, 8)}
                    </span>
                    <span className="shrink-0 text-[10px] text-muted-foreground">
                      {formatTimeShort(c.lastAt)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-2 mt-0.5">
                    <span className="truncate text-xs text-muted-foreground">
                      {c.lastDirection === "out" && "Вы: "}
                      {c.lastText ?? "(media)"}
                    </span>
                    {c.unreadCount > 0 && (
                      <span className="shrink-0 inline-flex h-4 min-w-[16px] items-center justify-center rounded-full bg-primary px-1 text-[10px] font-medium text-primary-foreground">
                        {c.unreadCount}
                      </span>
                    )}
                  </div>
                  {user?.email && (
                    <div className="truncate text-[10px] text-muted-foreground/70 mt-0.5">
                      {user.email}
                    </div>
                  )}
                  {user?.role === "admin" && (
                    <div className="mt-0.5 text-[9px] font-medium uppercase text-primary">
                      admin
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {/* Chat panel */}
        <div className="flex flex-col rounded-md border border-border bg-card overflow-hidden">
          {!selectedUserId ? (
            <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
              Выберите диалог слева
            </div>
          ) : (
            <>
              {/* Header — user info */}
              <ChatHeader user={userById.get(selectedUserId) ?? null} userId={selectedUserId} />


              {/* Messages */}
              <div className="flex-1 overflow-y-auto p-4 space-y-2 bg-muted/10">
                {messages.isLoading && (
                  <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" /> Загрузка…
                  </div>
                )}
                {sortedMessages.map((m) => (
                  <div
                    key={m.id}
                    className={cn(
                      "flex",
                      m.direction === "out" ? "justify-end" : "justify-start",
                    )}
                  >
                    <div
                      className={cn(
                        "max-w-[70%] rounded-lg px-3 py-1.5 text-sm shadow-sm",
                        m.direction === "out"
                          ? "bg-primary text-primary-foreground"
                          : "bg-card border border-border",
                      )}
                    >
                      {/* Media render. fileUrl = storageKey, served через GET /files/:key. */}
                      {m.fileUrl && (m.type === "photo" || m.type === "sticker") && (
                        <a
                          href={`/api/v1/admin/telegram-chat/files/${m.fileUrl}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          <img
                            src={`/api/v1/admin/telegram-chat/files/${m.fileUrl}`}
                            alt={m.type}
                            className="max-h-64 rounded my-1 block"
                          />
                        </a>
                      )}
                      {m.fileUrl && m.type === "video" && (
                        <video
                          src={`/api/v1/admin/telegram-chat/files/${m.fileUrl}`}
                          controls
                          className="max-h-64 rounded my-1 block"
                        />
                      )}
                      {m.fileUrl && (m.type === "voice" || m.type === "audio") && (
                        <audio
                          src={`/api/v1/admin/telegram-chat/files/${m.fileUrl}`}
                          controls
                          className="my-1 block w-full"
                        />
                      )}
                      {m.fileUrl && m.type === "document" && (
                        <a
                          href={`/api/v1/admin/telegram-chat/files/${m.fileUrl}`}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 underline text-xs"
                        >
                          📎 {m.fileName ?? "Документ"}
                        </a>
                      )}
                      {!m.fileUrl && m.type !== "text" && (
                        <em className="opacity-70">(media: {m.type}, скачивание не удалось)</em>
                      )}
                      {m.text && <div>{m.text}</div>}
                      <div
                        className={cn(
                          "text-[10px] mt-0.5",
                          m.direction === "out"
                            ? "text-primary-foreground/70"
                            : "text-muted-foreground",
                        )}
                      >
                        {formatTime(m.createdAt)}
                        {m.direction === "in" && !m.readAt && (
                          <span className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-primary" />
                        )}
                      </div>
                    </div>
                  </div>
                ))}
                <div ref={messagesEndRef} />
              </div>

              {/* Composer */}
              <div className="border-t border-border p-3 flex items-end gap-2">
                <textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      void handleSend();
                    }
                  }}
                  placeholder="Введите сообщение… (Enter — отправить, Shift+Enter — новая строка)"
                  rows={2}
                  className="flex-1 resize-none rounded border border-border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
                  disabled={sendMutation.isPending || !selectedConv}
                />
                <Button
                  onClick={handleSend}
                  disabled={
                    !draft.trim() || sendMutation.isPending || !selectedConv
                  }
                  className="shrink-0"
                >
                  {sendMutation.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Send className="h-4 w-4" />
                  )}
                </Button>
              </div>
              {selectedConv === null && selectedUserId && (
                <div className="border-t border-warning/40 bg-warning/10 px-4 py-2 text-xs text-warning">
                  Этот пользователь ещё не привязал Telegram. Отправить
                  сообщение не получится.
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
