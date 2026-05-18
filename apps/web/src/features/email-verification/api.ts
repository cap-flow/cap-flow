import { z } from "zod";

import { api } from "@/lib/api/client";

const sendResponseSchema = z.object({
  sent: z.boolean(),
  alreadyVerified: z.boolean(),
  email: z.string().email().nullable(),
});
export type SendVerificationResponse = z.infer<typeof sendResponseSchema>;

const confirmResponseSchema = z.object({
  verified: z.literal(true),
  wasAlreadyVerified: z.boolean(),
  email: z.string().email(),
});
export type ConfirmVerificationResponse = z.infer<typeof confirmResponseSchema>;

export const emailVerificationApi = {
  /** POST /v1/auth/email-verification/send — auth required. */
  send: () =>
    api.post(
      "/v1/auth/email-verification/send",
      undefined as unknown,
      sendResponseSchema
    ),
  /** POST /v1/auth/email-verification/confirm/:token — public. */
  confirm: (token: string) =>
    api.postPublic(
      `/v1/auth/email-verification/confirm/${encodeURIComponent(token)}`,
      undefined as unknown,
      confirmResponseSchema
    ),
};
