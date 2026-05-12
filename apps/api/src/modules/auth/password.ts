import { hash, verify } from "@node-rs/argon2";

// @node-rs/argon2 v2 defaults to Argon2id; we tune cost params explicitly.
// Avoiding the Algorithm const enum here for isolatedModules compatibility.
const HASH_OPTIONS = {
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 1,
} as const;

export async function hashPassword(plain: string): Promise<string> {
  return hash(plain, HASH_OPTIONS);
}

export async function verifyPassword(
  plain: string,
  storedHash: string
): Promise<boolean> {
  try {
    return await verify(storedHash, plain);
  } catch {
    return false;
  }
}
