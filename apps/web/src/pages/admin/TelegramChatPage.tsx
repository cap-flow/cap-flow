import { useEffect, useMemo, useRef, useState } from "react";
import { Send, Loader2, MessageSquare } from "lucide-react";

import { PageHeader } from "./_PageHeader";
import {
  useConversations,
  useMessages,
  useSendMessage,
  useMarkRead,
} from "@/features/admin/telegram-chat/hooks";
import { useAdminUsers } from "@/features/admin/users/hooks";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

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
  const [draft, setDraft] = useState("");
  const messages = useMessages(selectedUserId);
  const sendMutation = useSendMessage();
  const markReadMutation = useMarkRead();
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // User name lookup via existing admin users hook.
  const userNameById = useMemo(() => {
    const m = new Map<string, { name: string; email: string | null }>();
    for (const u of usersList.data?.items ?? []) {
      m.set(u.id, { name: u.name ?? "—", email: u.email });
    }
    return m;
  }, [usersList.data]);

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
          <div className="border-b border-border px-3 py-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Диалоги ({conversations.data?.length ?? 0})
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
            {conversations.data?.map((c) => {
              const user = userNameById.get(c.userId);
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
              {/* Header */}
              <div className="border-b border-border px-4 py-2">
                <div className="font-medium text-sm">
                  {userNameById.get(selectedUserId)?.name ?? selectedUserId.slice(0, 8)}
                </div>
                {userNameById.get(selectedUserId)?.email && (
                  <div className="text-xs text-muted-foreground">
                    {userNameById.get(selectedUserId)?.email}
                  </div>
                )}
              </div>

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
                      {m.text || <em className="opacity-70">(media: {m.type})</em>}
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
