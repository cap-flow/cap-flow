import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { adminTelegramChatApi } from "./api";

const KEYS = {
  all: ["admin", "telegram-chat"] as const,
  conversations: () => [...KEYS.all, "conversations"] as const,
  messages: (userId: string) => [...KEYS.all, "messages", userId] as const,
  unread: () => [...KEYS.all, "unread"] as const,
};

const POLL_MS = 5000;

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

export function useUnreadCount() {
  return useQuery({
    queryKey: KEYS.unread(),
    queryFn: () => adminTelegramChatApi.unread(),
    refetchInterval: POLL_MS * 2,
    staleTime: POLL_MS,
  });
}
