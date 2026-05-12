import type { IAuditRepository } from "./audit.repository.js";

export interface AuditLogInput {
  readonly actorUserId: string | null;
  readonly action: string;
  readonly asAdmin?: boolean;
  readonly targetUserId?: string | null;
  readonly accountId?: string | null;
  readonly target?: string | null;
  readonly payload?: Record<string, unknown>;
  readonly ip?: string | null;
  readonly userAgent?: string | null;
}

export class AuditService {
  constructor(private readonly repo: IAuditRepository) {}

  async log(input: AuditLogInput): Promise<void> {
    try {
      await this.repo.insert({
        actorId: input.actorUserId ?? null,
        asAdmin: input.asAdmin ?? false,
        targetUserId: input.targetUserId ?? null,
        accountId: input.accountId ?? null,
        action: input.action,
        target: input.target ?? null,
        payload: input.payload ?? {},
        ip: input.ip ?? null,
        userAgent: input.userAgent ?? null,
        occurredAt: new Date(),
      });
    } catch {
      // Audit failures must never break a real request flow.
    }
  }
}
