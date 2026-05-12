import { useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { usePrimaryAccount } from "@/features/accounts/hooks";
import type {
  AddressType,
  Wallet,
  WalletKind,
} from "@/features/wallets/api";
import {
  useAddAddress,
  useCreateWallet,
  useDeleteAddress,
  useDeleteWallet,
  useRenameWallet,
  useWalletAddresses,
  useWallets,
} from "@/features/wallets/hooks";

/**
 * /wallets — single page for managing a user's wallets and their on-chain
 * addresses. Layout: left column = list of wallets + "create" button;
 * right column = detail of the currently-selected wallet (its addresses
 * + form to add a new one). Hardcoded to the user's primary account
 * since the beta limit is "1 active account per user".
 */
export function WalletsPage(): JSX.Element {
  const primary = usePrimaryAccount();

  if (primary === undefined) {
    return (
      <div className="p-4 text-sm text-muted-foreground">Загружаем…</div>
    );
  }
  if (primary === null) {
    return (
      <div className="p-4 text-sm text-muted-foreground">
        У вас ещё нет аккаунта.
      </div>
    );
  }
  return <WalletsContent accountId={primary.id} />;
}

function WalletsContent({
  accountId,
}: {
  readonly accountId: string;
}): JSX.Element {
  const wallets = useWallets(accountId);
  const createWallet = useCreateWallet(accountId);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected =
    wallets.data?.find((w) => w.id === selectedId) ?? wallets.data?.[0] ?? null;

  // Create-wallet form state.
  const [newName, setNewName] = useState("");
  const [newKind, setNewKind] = useState<WalletKind>("external");
  const [createError, setCreateError] = useState<string | null>(null);

  async function onCreateWallet(e: FormEvent): Promise<void> {
    e.preventDefault();
    setCreateError(null);
    try {
      const w = await createWallet.mutateAsync({
        name: newName.trim(),
        kind: newKind,
      });
      setNewName("");
      setSelectedId(w.id);
    } catch (err) {
      setCreateError(
        err instanceof Error ? err.message : "Не удалось создать кошелёк"
      );
    }
  }

  return (
    <div className="space-y-4 p-4">
      <div>
        <h1 className="text-2xl font-semibold">Кошельки</h1>
        <p className="text-sm text-muted-foreground">
          Группируйте on-chain адреса в кошельки. Балансы автоматически
          подтягиваются раз в час; ручное обновление — на странице
          «Дашборд».
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-[280px,1fr]">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Список</CardTitle>
            <CardDescription>
              {wallets.data?.length ?? 0} кошельк(а/ов)
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {wallets.isLoading ? (
              <p className="text-sm text-muted-foreground">Загружаем…</p>
            ) : (
              <ul className="space-y-1">
                {(wallets.data ?? []).map((w) => (
                  <li key={w.id}>
                    <button
                      type="button"
                      className={`w-full rounded-md px-2 py-1.5 text-left text-sm transition-colors ${
                        selected?.id === w.id
                          ? "bg-accent text-foreground"
                          : "text-muted-foreground hover:bg-accent hover:text-foreground"
                      }`}
                      onClick={() => setSelectedId(w.id)}
                    >
                      <div className="font-medium">{w.name}</div>
                      <div className="text-xs">
                        {w.kind === "internal" ? "Свой" : "Внешний"}
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <form onSubmit={onCreateWallet} className="space-y-2 pt-3 border-t">
              <Label htmlFor="new-wallet">Новый кошелёк</Label>
              <Input
                id="new-wallet"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Имя"
                disabled={createWallet.isPending}
              />
              <select
                className="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
                value={newKind}
                onChange={(e) => setNewKind(e.target.value as WalletKind)}
                disabled={createWallet.isPending}
              >
                <option value="external">Внешний</option>
                <option value="internal">Свой</option>
              </select>
              {createError && (
                <p className="text-xs text-destructive">{createError}</p>
              )}
              <Button
                type="submit"
                size="sm"
                className="w-full"
                disabled={createWallet.isPending || !newName.trim()}
              >
                {createWallet.isPending ? "Создаём…" : "Создать"}
              </Button>
            </form>
          </CardContent>
        </Card>

        {selected ? (
          <WalletDetail accountId={accountId} wallet={selected} />
        ) : (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Адреса</CardTitle>
              <CardDescription>
                Выберите или создайте кошелёк слева.
              </CardDescription>
            </CardHeader>
          </Card>
        )}
      </div>
    </div>
  );
}

function WalletDetail({
  accountId,
  wallet,
}: {
  readonly accountId: string;
  readonly wallet: Wallet;
}): JSX.Element {
  const addresses = useWalletAddresses(accountId, wallet.id);
  const addAddr = useAddAddress(accountId, wallet.id);
  const delAddr = useDeleteAddress(accountId, wallet.id);
  const rename = useRenameWallet(accountId);
  const delWallet = useDeleteWallet(accountId);

  const [editingName, setEditingName] = useState(false);
  const [draftName, setDraftName] = useState(wallet.name);

  const [addr, setAddr] = useState("");
  const [addrType, setAddrType] = useState<AddressType>("evm");
  const [chainsStr, setChainsStr] = useState("1,42161,8453,10,137,56,43114");
  const [addError, setAddError] = useState<string | null>(null);

  async function onAdd(e: FormEvent): Promise<void> {
    e.preventDefault();
    setAddError(null);
    const chains = chainsStr
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0);
    try {
      await addAddr.mutateAsync({
        address: addr.trim(),
        type: addrType,
        chains: addrType === "evm" ? chains : [],
      });
      setAddr("");
    } catch (err) {
      setAddError(err instanceof Error ? err.message : "Ошибка");
    }
  }

  async function onRename(): Promise<void> {
    if (!draftName.trim() || draftName === wallet.name) {
      setEditingName(false);
      return;
    }
    await rename.mutateAsync({ walletId: wallet.id, name: draftName.trim() });
    setEditingName(false);
  }

  async function onDelete(): Promise<void> {
    if (!confirm(`Удалить кошелёк «${wallet.name}» вместе со всеми адресами?`))
      return;
    await delWallet.mutateAsync(wallet.id);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          {editingName ? (
            <span className="flex gap-2">
              <Input
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                className="h-8"
                autoFocus
                onBlur={() => void onRename()}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void onRename();
                  if (e.key === "Escape") setEditingName(false);
                }}
              />
            </span>
          ) : (
            <button
              type="button"
              onClick={() => {
                setDraftName(wallet.name);
                setEditingName(true);
              }}
              className="hover:underline"
            >
              {wallet.name}
            </button>
          )}
        </CardTitle>
        <CardDescription>
          {wallet.kind === "internal" ? "Свой кошелёк" : "Внешний"}
          {" · "}
          создан {new Date(wallet.createdAt).toLocaleDateString("ru")}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <h3 className="text-sm font-medium">Адреса</h3>
          {addresses.isLoading ? (
            <p className="text-sm text-muted-foreground">Загружаем…</p>
          ) : !addresses.data || addresses.data.length === 0 ? (
            <p className="text-sm text-muted-foreground">Адресов нет.</p>
          ) : (
            <ul className="space-y-1">
              {addresses.data.map((a) => (
                <li
                  key={a.id}
                  className="flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm"
                >
                  <div className="min-w-0">
                    <code className="block break-all font-mono text-xs">
                      {a.address}
                    </code>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      {a.type.toUpperCase()}
                      {a.chains.length > 0 &&
                        ` · chains: ${a.chains.join(", ")}`}
                    </div>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => delAddr.mutate(a.id)}
                    disabled={delAddr.isPending}
                  >
                    Удалить
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <form onSubmit={onAdd} className="space-y-3 rounded-md border p-3">
          <h3 className="text-sm font-medium">Добавить адрес</h3>
          <div className="grid gap-2 sm:grid-cols-[1fr,140px]">
            <div>
              <Label htmlFor="address" className="text-xs">
                Адрес
              </Label>
              <Input
                id="address"
                value={addr}
                onChange={(e) => setAddr(e.target.value)}
                placeholder="0x… / TN… / …"
                disabled={addAddr.isPending}
              />
            </div>
            <div>
              <Label htmlFor="type" className="text-xs">
                Тип
              </Label>
              <select
                id="type"
                className="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
                value={addrType}
                onChange={(e) => setAddrType(e.target.value as AddressType)}
                disabled={addAddr.isPending}
              >
                <option value="evm">EVM</option>
                <option value="solana">Solana</option>
                <option value="tron">Tron</option>
                <option value="btc">Bitcoin</option>
                <option value="other">Other</option>
              </select>
            </div>
          </div>
          {addrType === "evm" && (
            <div>
              <Label htmlFor="chains" className="text-xs">
                Chains (comma-separated chainId)
              </Label>
              <Input
                id="chains"
                value={chainsStr}
                onChange={(e) => setChainsStr(e.target.value)}
                disabled={addAddr.isPending}
              />
              <p className="mt-1 text-xs text-muted-foreground">
                ETH=1, OP=10, BSC=56, Polygon=137, Base=8453, Arbitrum=42161,
                Avalanche=43114.
              </p>
            </div>
          )}
          {addError && (
            <p className="text-xs text-destructive">{addError}</p>
          )}
          <Button
            type="submit"
            size="sm"
            disabled={addAddr.isPending || !addr.trim()}
          >
            {addAddr.isPending ? "Добавляем…" : "Добавить"}
          </Button>
        </form>

        <div className="pt-2 border-t">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void onDelete()}
            disabled={delWallet.isPending}
          >
            Удалить кошелёк
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
