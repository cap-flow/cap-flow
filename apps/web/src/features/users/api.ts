import { z } from "zod";

import { api } from "@/lib/api/client";

export const userSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  name: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const usersListSchema = z.array(userSchema);

export type User = z.infer<typeof userSchema>;

export interface CreateUserInput {
  readonly email: string;
  readonly name: string;
}

export const usersApi = {
  list: () => api.get("/v1/users", usersListSchema),
  create: (input: CreateUserInput) => api.post("/v1/users", input, userSchema),
  remove: (id: string) => api.delete(`/v1/users/${id}`),
};
