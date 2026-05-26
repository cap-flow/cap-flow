/**
 * In-process pub-sub для admin chat SSE.
 *
 * Single-instance Node EventEmitter — все SSE subscribers (admin tabs)
 * получают broadcasted события когда:
 *   - webhook сохраняет incoming message от user → `new-message`
 *   - admin отправляет message через UI → `new-message`
 *   - admin маркирует conversation как read → `read`
 *
 * Не persistence — если worker crashes / restart'ится, активные SSE
 * соединения теряются (browser автоматически переподключится через
 * EventSource retry). Это OK для admin chat — для важных update'ов
 * есть polling fallback в frontend hooks.
 *
 * Multi-process scaling: если в будущем заведём 2+ API instances за
 * load balancer'ом, нужно будет добавить Redis pub-sub bridge. Сейчас
 * single-instance — local EventEmitter достаточен.
 */

import { EventEmitter } from "node:events";

export interface ChatNewMessageEvent {
  userId: string;
  message: {
    id: string;
    direction: "in" | "out";
    text: string | null;
    createdAt: string;
  };
}

export interface ChatReadEvent {
  userId: string;
}

class ChatEventBus extends EventEmitter {
  // Increase default max listeners — multiple admin browser tabs can open
  // SSE concurrently. Default of 10 is too restrictive for power users.
  constructor() {
    super();
    this.setMaxListeners(50);
  }

  emitNewMessage(payload: ChatNewMessageEvent): void {
    this.emit("new-message", payload);
  }

  emitRead(userId: string): void {
    this.emit("read", { userId } satisfies ChatReadEvent);
  }
}

/** Singleton — один на process. */
export const chatEventBus = new ChatEventBus();
