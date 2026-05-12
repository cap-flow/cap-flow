import { z } from "zod";

import { api } from "@/lib/api/client";

export const walletKindSchema = z.enum(["internal", "external"]);
export type WalletKind = z.infer<typeof walletKindSchema>;

export const walletSchema = z.object({
  id: z.string().uuid(),
  accountId: z.string().uuid(),
  name: z.string(),
  kind: walletKindSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Wallet = z.infer<typeof walletSchema>;

export const addressTypeSchema = z.enum([
  "evm",
  "solana",
  "tron",
  "btc",
  "other",
]);
export type AddressType = z.infer<typeof addressTypeSchema>;

export const walletAddressSchema = z.object({
  id: z.string().uuid(),
  walletId: z.string().uuid(),
  address: z.string(),
  type: addressTypeSchema,
  chains: z.array(z.number()),
  createdAt: z.string(),
});
export type WalletAddress = z.infer<typeof walletAddressSchema>;

const walletListSchema = z.array(walletSchema);
const addressListSchema = z.array(walletAddressSchema);

export interface CreateWalletInput {
  readonly name: string;
  readonly kind?: WalletKind;
}

export interface AddAddressInput {
  readonly address: string;
  readonly type: AddressType;
  readonly chains: number[];
}

export const walletsApi = {
  list: (accountId: string) =>
    api.get(`/v1/accounts/${accountId}/wallets`, walletListSchema),

  create: (accountId: string, input: CreateWalletInput) =>
    api.post(`/v1/accounts/${accountId}/wallets`, input, walletSchema),

  rename: (accountId: string, walletId: string, name: string) =>
    api.patch(
      `/v1/accounts/${accountId}/wallets/${walletId}`,
      { name },
      walletSchema
    ),

  delete: (accountId: string, walletId: string) =>
    api.delete(
      `/v1/accounts/${accountId}/wallets/${walletId}`,
      z.unknown()
    ),

  listAddresses: (accountId: string, walletId: string) =>
    api.get(
      `/v1/accounts/${accountId}/wallets/${walletId}/addresses`,
      addressListSchema
    ),

  addAddress: (
    accountId: string,
    walletId: string,
    input: AddAddressInput
  ) =>
    api.post(
      `/v1/accounts/${accountId}/wallets/${walletId}/addresses`,
      input,
      walletAddressSchema
    ),

  deleteAddress: (
    accountId: string,
    walletId: string,
    addressId: string
  ) =>
    api.delete(
      `/v1/accounts/${accountId}/wallets/${walletId}/addresses/${addressId}`,
      z.unknown()
    ),
};
