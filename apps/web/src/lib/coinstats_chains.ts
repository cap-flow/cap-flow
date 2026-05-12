/**
 * Курируемый каталог CoinStats сетей для UI-выбора.
 *
 * CoinStats отдаёт ~147 connectionId через `/wallet/blockchains`. Здесь
 * вручную сгруппированы самые востребованные — так пользователю проще
 * выбрать. Для редкой сети можно вручную ввести `connectionId`.
 */

export interface CoinStatsChainOption {
  /** CoinStats `connectionId` (e.g. "bitcoin", "ton-wallet"). */
  id: string;
  /** Человекочитаемое название. */
  label: string;
}

export interface CoinStatsChainGroup {
  group: string;
  chains: CoinStatsChainOption[];
}

export const COINSTATS_CHAIN_GROUPS: CoinStatsChainGroup[] = [
  {
    group: "Bitcoin & UTXO",
    chains: [
      { id: "bitcoin", label: "Bitcoin" },
      { id: "litecoin", label: "Litecoin" },
      { id: "doge-wallet", label: "Dogecoin" },
      { id: "bitcoin_cash", label: "Bitcoin Cash" },
      { id: "dash", label: "Dash" },
      { id: "zcash-wallet", label: "Zcash" },
      { id: "kaspa-wallet", label: "Kaspa" },
    ],
  },
  {
    group: "L1 (non-EVM)",
    chains: [
      { id: "ton-wallet", label: "TON" },
      { id: "aptos-wallet", label: "Aptos" },
      { id: "sui-wallet", label: "Sui" },
      { id: "near-wallet", label: "NEAR" },
      { id: "cardano", label: "Cardano" },
      { id: "tron", label: "Tron" },
      { id: "xrpl-wallet", label: "XRP Ledger" },
      { id: "stellar", label: "Stellar" },
      { id: "algorand", label: "Algorand" },
      { id: "tezos", label: "Tezos" },
      { id: "hedera-wallet", label: "Hedera" },
      { id: "polkadot", label: "Polkadot" },
      { id: "filecoin-wallet", label: "Filecoin" },
      { id: "starknet-wallet", label: "Starknet" },
      { id: "internet-computer-wallet", label: "Internet Computer" },
      { id: "iota", label: "IOTA" },
      { id: "vechain", label: "VeChain" },
      { id: "casper-wallet", label: "Casper" },
    ],
  },
  {
    group: "Cosmos ecosystem",
    chains: [
      { id: "cosmos", label: "Cosmos Hub" },
      { id: "osmosis-wallet", label: "Osmosis" },
      { id: "injective-wallet", label: "Injective" },
      { id: "celestia-wallet", label: "Celestia" },
      { id: "sei-wallet", label: "Sei" },
      { id: "kujira-wallet", label: "Kujira" },
      { id: "akash-wallet", label: "Akash" },
      { id: "dymension-wallet", label: "Dymension" },
      { id: "axelar-wallet", label: "Axelar" },
      { id: "stride-wallet", label: "Stride" },
      { id: "thorchain-wallet", label: "THORChain" },
      { id: "dydx-wallet", label: "dYdX" },
      { id: "mantra-wallet", label: "Mantra" },
      { id: "secret-wallet", label: "Secret" },
      { id: "babylon-wallet", label: "Babylon" },
      { id: "kava-cosmos-wallet", label: "Kava (Cosmos)" },
      { id: "juno-wallet", label: "Juno" },
      { id: "cronos-cosmos-wallet", label: "Cronos PoS" },
    ],
  },
  {
    group: "Новые EVM L2",
    chains: [
      { id: "berachain-wallet", label: "Berachain" },
      { id: "monad-wallet", label: "Monad" },
      { id: "hyperevm-wallet", label: "HyperEVM" },
      { id: "sonic-wallet", label: "Sonic" },
      { id: "soneium-wallet", label: "Soneium" },
      { id: "plume-wallet", label: "Plume" },
      { id: "worldchain-wallet", label: "Worldchain" },
      { id: "unichain-wallet", label: "Unichain" },
      { id: "zircuit-wallet", label: "Zircuit" },
      { id: "abstract-wallet", label: "Abstract" },
      { id: "fraxtal-wallet", label: "Fraxtal" },
      { id: "katana-wallet", label: "Katana" },
      { id: "redstone-wallet", label: "Redstone" },
      { id: "story-wallet", label: "Story" },
      { id: "mantle-wallet", label: "Mantle" },
      { id: "scroll-wallet", label: "Scroll" },
      { id: "linea-wallet", label: "Linea" },
      { id: "blast-wallet", label: "Blast" },
      { id: "manta-wallet", label: "Manta Pacific" },
      { id: "taiko-wallet", label: "Taiko" },
      { id: "mode-wallet", label: "Mode" },
      { id: "ink-wallet", label: "Ink" },
      { id: "ape-wallet", label: "ApeChain" },
      { id: "ronin-wallet", label: "Ronin" },
      { id: "beam-wallet", label: "Beam" },
      { id: "core-wallet", label: "Core" },
      { id: "bob-wallet", label: "BOB" },
      { id: "merlin-wallet", label: "Merlin" },
      { id: "bitlayer-wallet", label: "Bitlayer" },
      { id: "xdc-wallet", label: "XDC" },
      { id: "duckchain-wallet", label: "DuckChain" },
    ],
  },
];

/** Найти label по connectionId. */
export function coinStatsChainLabel(id: string): string {
  for (const g of COINSTATS_CHAIN_GROUPS) {
    const c = g.chains.find((c) => c.id === id);
    if (c) return c.label;
  }
  return id;
}
