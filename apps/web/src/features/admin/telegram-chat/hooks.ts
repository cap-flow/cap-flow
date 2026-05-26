import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { adminTelegramChatApi, type UpsertTemplateInput } from "./api";

const KEYS = {
  all: ["admin", "telegram-chat"] as const,
  conversations: () => [...KEYS.all, "conversations"] as const,
  messages: (userId: string) => [...KEYS.all, "messages", userId] as const,
  unread: () => [...KEYS.all, "unread"] as const,
  templates: () => [...KEYS.all, "templates"] as const,
};

/**
 * Polling — fallback на случай если SSE упал (network drop, прокси
 * убил idle connection). 30s достаточно медленно чтобы не нагружать
 * backend, но достаточно быстро чтобы catch'ить пропущенные events.
 */
const POLL_MS = 30_000;

export function useConversations() {
  return useQuery({
    queryKey: KEYS.conversations(),
    queryFn: () => adminTelegramChatApi.listConversations(),
    refetchInterval: POLL_MS,
    staleTime: POLL_MS / 2,
  });
}

export function useMessages(userId: string | null) {
  return useQuery({
    queryKey: userId ? KEYS.messages(userId) : ["admin", "telegram-chat", "messages", "none"],
    queryFn: () => {
      if (!userId) return Promise.resolve([]);
      return adminTelegramChatApi.listMessages(userId, { limit: 100 });
    },
    enabled: !!userId,
    refetchInterval: userId ? POLL_MS : false,
    staleTime: POLL_MS / 2,
  });
}

export function useSendMessage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, text }: { userId: string; text: string }) =>
      adminTelegramChatApi.sendMessage(userId, text),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: KEYS.messages(vars.userId) });
      qc.invalidateQueries({ queryKey: KEYS.conversations() });
    },
  });
}

export function useMarkRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) => adminTelegramChatApi.markRead(userId),
    onSuccess: (_, userId) => {
      qc.invalidateQueries({ queryKey: KEYS.messages(userId) });
      qc.invalidateQueries({ queryKey: KEYS.conversations() });
      qc.invalidateQueries({ queryKey: KEYS.unread() });
    },
  });
}

export function useChatTemplates() {
  return useQuery({
    queryKey: KEYS.templates(),
    queryFn: () => adminTelegramChatApi.listTemplates(),
    staleTime: 60_000,
  });
}

export function useCreateChatTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpsertTemplateInput) =>
      adminTelegramChatApi.createTemplate(input),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEYS.templates() }),
  });
}

export function useUpdateChatTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Partial<UpsertTemplateInput> }) =>
      adminTelegramChatApi.updateTemplate(id, patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEYS.templates() }),
  });
}

export function useDeleteChatTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => adminTelegramChatApi.deleteTemplate(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEYS.templates() }),
  });
}

export function useUnreadCount() {
  return useQuery({
    queryKey: KEYS.unread(),
    queryFn: () => adminTelegramChatApi.unread(),
    refetchInterval: POLL_MS * 2,
    staleTime: POLL_MS,
  });
}

/**
 * SSE подписка на admin chat events. Открывает EventSource, при любом
 * event'е инвалидирует react-query cache → данные перезагружаются.
 *
 * Browser автоматически reconnect'ится при разрыве — robust enough
 * без custom retry. Polling из useConversations/useMessages — fallback
 * на случай длительного outage.
 *
 * Вызывать ОДИН раз на admin shell mount (не в каждой странице) —
 * иначе будут multiple SSE connections от одного browser tab'а.
 */
export function useChatEventStream(): void {
  const qc = useQueryClient();
  useEffect(() => {
    const es = new EventSource("/api/v1/admin/telegram-chat/stream", {
      withCredentials: true,
    });
    const invalidateAll = (): void => {
      qc.invalidateQueries({ queryKey: KEYS.all });
    };
    es.addEventListener("new-message", invalidateAll);
    es.addEventListener("read", invalidateAll);
    // `error` event при reconnect — EventSource сам пытается переподключиться.
    es.addEventListener("error", () => {
      // Молчим — это нормально (network blip, server restart).
    });
    return () => {
      es.close();
    };
  }, [qc]);
}
