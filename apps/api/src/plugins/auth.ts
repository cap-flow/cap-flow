import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";

import {
  ForbiddenError,
  UnauthorizedError,
} from "../core/errors.js";
import { AuditRepository } from "../modules/audit/audit.repository.js";
import { AuditService } from "../modules/audit/audit.service.js";
import {
  AuthRepository,
  type UserRow,
} from "../modules/auth/auth.repository.js";
import { extractAccessToken } from "../modules/auth/auth.cookies.js";
import { AuthService } from "../modules/auth/auth.service.js";
import type { AuthUser } from "../modules/auth/auth.types.js";
import { verifyAccessToken } from "../modules/auth/tokens.js";

/** Best-effort display name when `users.name` isn't populated yet. */
function deriveDisplayName(u: UserRow): string {
  if (u.name && u.name.trim()) return u.name.trim();
  const fl = [u.firstName, u.lastName].filter(Boolean).join(" ").trim();
  if (fl) return fl;
  if (u.email) return u.email.split("@")[0] ?? u.email;
  return "user";
}

export interface AuthPluginOptions {
  readonly jwtSecret: string;
  readonly accessTtlMinutes: number;
  readonly refreshTtlDays: number;
}

declare module "fastify" {
  interface FastifyInstance {
    auth: AuthService;
    audit: AuditService;
    requireAuth: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireAdmin: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }

  interface FastifyRequest {
    user?: AuthUser;
  }
}

export const authPlugin = fp<AuthPluginOptions>(
  async (app: FastifyInstance, opts) => {
    const auditRepo = new AuditRepository(app.db);
    const audit = new AuditService(auditRepo);
    const authRepo = new AuthRepository(app.db);
    const authService = new AuthService(authRepo, audit, {
      jwtSecret: opts.jwtSecret,
      accessTtlMinutes: opts.accessTtlMinutes,
      refreshTtlDays: opts.refreshTtlDays,
    });

    app.decorate("audit", audit);
    app.decorate("auth", authService);

    app.decorate(
      "requireAuth",
      async (req: FastifyRequest, _reply: FastifyReply) => {
        // S3.5: Bearer header (preferred) → fallback to `cap_access`
        // cookie (scoped to /api/v1/upstream — for viem and other
        // clients that can't set headers).
        const token = extractAccessToken({
          headers: { authorization: req.headers.authorization ?? undefined },
          cookies: (req.cookies ?? {}) as Record<string, string | undefined>,
        });
        if (!token) {
          throw new UnauthorizedError("Missing access token.");
        }
        const payload = verifyAccessToken(token, opts.jwtSecret);

        // Verify session is still active and user is still active.
        const session = await authRepo.findActiveSessionById(payload.sid);
        if (!session || session.userId !== payload.sub) {
          throw new UnauthorizedError("Session no longer valid.");
        }
        if (session.expiresAt.getTime() < Date.now()) {
          throw new UnauthorizedError("Session expired.");
        }
        const user = await authRepo.findActiveUserById(payload.sub);
        if (!user) throw new UnauthorizedError("User no longer active.");

        const impersonation =
          session.impersonatedById && session.impersonationMode
            ? {
                impersonatorId: session.impersonatedById,
                mode: session.impersonationMode,
              }
            : undefined;

        req.user = {
          id: user.id,
          email: user.email ?? "",
          name: deriveDisplayName(user),
          role: user.role as AuthUser["role"],
          sessionId: session.id,
          impersonation,
        };
      }
    );

    app.decorate(
      "requireAdmin",
      async (req: FastifyRequest, reply: FastifyReply) => {
        await app.requireAuth(req, reply);
        if (!req.user || req.user.role !== "admin") {
          throw new ForbiddenError("Admin access required.");
        }
      }
    );
  },
  { name: "auth", dependencies: ["db"] }
);
