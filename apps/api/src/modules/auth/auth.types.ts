/** User role mirrors the existing `user_role` enum: admin | user | viewer. */
export type UserRole = "admin" | "user" | "viewer";

/** Session impersonation context — present when an admin opened a session
 *  scoped to another user via `/admin/users/:id/impersonate`. */
export interface ImpersonationContext {
  readonly impersonatorId: string;
  readonly mode: "view" | "edit";
}

export interface AuthUser {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly role: UserRole;
  readonly sessionId: string;
  /** If set, request acts on behalf of `id` but was initiated by `impersonatorId`. */
  readonly impersonation?: ImpersonationContext | undefined;
}
