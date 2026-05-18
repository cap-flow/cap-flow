import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

import { UnauthorizedError } from "../../core/errors.js";
import type { NotificationsService } from "../notifications/notifications.service.js";

import type { IAuthRepository } from "./auth.repository.js";
import type { EmailVerificationService } from "./email-verification.service.js";

interface RoutesOptions {
  readonly service: EmailVerificationService;
  readonly notifications: NotificationsService;
  readonly authRepo: IAuthRepository;
}

/**
 * Email verification HTTP surface (B4).
 *
 *   POST /api/v1/auth/email-verification/send         — auth required;
 *       (re-)mints a token for the current user and emails it. Idempotent
 *       for already-verified users (no token sent, returns 200 + flag).
 *   POST /api/v1/auth/email-verification/confirm/:token  — public;
 *       confirms the token, stamps users.email_verified_at, consumes the
 *       token. Returns 200 + flag indicating whether this was the first
 *       verification or a replay-of-no-op.
 *
 * Rate-limited tighter than normal auth routes — abuse here = spam to
 * the user's mailbox AND DB write churn.
 */
export async function emailVerificationRoutes(
  app: FastifyInstance,
  opts: RoutesOptions
): Promise<void> {
  const route = app.withTypeProvider<ZodTypeProvider>();

  // Authenticated "send/resend my verification email" — current user is
  // taken from JWT, not body, so a malicious user cannot trigger emails
  // to arbitrary addresses.
  route.post(
    "/send",
    {
      preHandler: app.requireAuth,
      schema: {
        response: {
          200: z.object({
            sent: z.boolean(),
            alreadyVerified: z.boolean(),
            email: z.string().email().nullable(),
          }),
        },
      },
      config: {
        // Prevent inbox spam: each authenticated user can hit "resend" at
        // most a few times per hour.
        rateLimit: { max: 5, timeWindow: "1 hour" },
      },
    },
    async (req) => {
      const u = req.user;
      if (!u) throw new UnauthorizedError();
      const r = await opts.service.issueToken(u.id);
      if (r.alreadyVerified || !r.url) {
        return { sent: false, alreadyVerified: true, email: r.email };
      }
      const userRow = await opts.authRepo.findUserById(u.id);
      if (userRow) {
        try {
          await opts.notifications.sendEmailVerification(userRow, r.url);
        } catch {
          // notifications service writes its own audit row; we still
          // return 200 so retry semantics are consistent and the admin
          // can pull the URL from audit log if Resend was down.
        }
      }
      return { sent: true, alreadyVerified: false, email: r.email };
    }
  );

  // Public confirm — no preHandler, but token does the auth. Rate-limit
  // tight because brute-force on 128-bit token space is futile but spam
  // against `/confirm/<random>` still hits DB.
  route.post(
    "/confirm/:token",
    {
      schema: {
        params: z.object({ token: z.string().min(8).max(200) }),
        response: {
          200: z.object({
            verified: z.literal(true),
            wasAlreadyVerified: z.boolean(),
            email: z.string().email(),
          }),
        },
      },
      config: {
        rateLimit: { max: 20, timeWindow: "1 minute" },
      },
    },
    async (req) => {
      const r = await opts.service.confirm(req.params.token);
      return {
        verified: true as const,
        wasAlreadyVerified: r.wasAlreadyVerified,
        email: r.emailAtIssue,
      };
    }
  );
}
