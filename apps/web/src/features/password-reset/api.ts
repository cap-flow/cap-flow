import { z } from "zod";

import { api } from "@/lib/api/client";

/**
 * Password reset — both endpoints are public:
 *   request: always responds 204 (no email enumeration on the wire)
 *   confirm: sets a new password, revokes all sessions, returns 204
 */

export const passwordResetApi = {
  request: (email: string) =>
    api.postPublic("/v1/auth/password/reset-request", { email }, z.unknown()),

  confirm: (token: string, newPassword: string) =>
    api.postPublic(
      "/v1/auth/password/reset-confirm",
      { token, newPassword },
      z.unknown()
    ),
};
