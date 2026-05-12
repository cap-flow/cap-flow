# CoinStats API

Универсальный wallet API на 147 блокчейнов.

## Endpoints

Base: `https://openapiv1.coinstats.app` (через Vite proxy `/coinstats`).

Auth: `X-API-KEY: <key>` header.

| Endpoint | Method | Cost |
|---|---|---|
| `/wallet/blockchains` | GET | low |
| `/wallet/balance?address=&connectionId=` | GET | 40 credits |
| `/wallet/defi?address=&connectionId=` | GET | ~30 credits |
| `/wallet/transactions?address=&connectionId=&limit=` | GET | 30 credits |
| `/wallet/transactions?address=&connectionId=` | PATCH | 50 credits (sync) |

## ConnectionId — основные

### EVM (имеют DeBank-аналог)
- `ethereum`, `binancesmartchain`, `arbitrum-wallet`, `optimism-wallet`,
  `polygon-wallet`, `base-wallet`, `avalanche-wallet`, `fantom-wallet`,
  `gnosis-chain`, `linea-wallet`, `scroll-wallet`, `mantle-wallet`,
  `zksync-era-wallet`, `zkevm-polygon-wallet`, `arbitrum-nova-wallet`,
  `blast-wallet`, `manta-wallet`, `opbnb-wallet`, `taiko-wallet`,
  `mode-wallet`, `metis-wallet`, `boba-wallet`, `cronos-wallet`,
  `celo-wallet`, `moonbeam-wallet`, `moonriver-wallet`, `aurora-wallet`,
  `harmony-wallet`, `okx-wallet`, `klaytn-wallet`, `heco-wallet`,
  `pulsechain-wallet`, `kava-wallet`, `evmos-wallet`, `canto-wallet`,
  `rootstock-wallet`

### Новые EVM L2 (не покрывает DeBank или покрывает плохо)
- `berachain-wallet`, `monad-wallet`, `hyperevm-wallet`, `sonic-wallet`,
  `soneium-wallet`, `plume-wallet`, `worldchain-wallet`, `unichain-wallet`,
  `zircuit-wallet`, `plasma-wallet`, `katana-wallet`, `redstone-wallet`,
  `bitlayer-wallet`, `bsquared-wallet`, `ailayer-wallet`, `bob-wallet`,
  `core-wallet`, `merlin-wallet`, `xdc-wallet`, `duckchain-wallet`,
  `megaeth-wallet`, `fraxtal-wallet`, `zetachain-wallet`,
  `abstract-wallet`, `ronin-wallet`, `beam-wallet`, `karak-wallet`,
  `ape-wallet`, `ink-wallet`, `mode-wallet`, `taiko-wallet`,
  `manta-wallet`

### Не-EVM мейнстрим
- `solana`, `bitcoin`, `ton-wallet`, `aptos-wallet`, `sui-wallet`,
  `near-wallet`, `tron`, `cardano`, `xrp`, `stellar`, `algorand`,
  `tezos`, `filecoin-wallet`, `hedera-wallet`, `casper-wallet`,
  `xrpl-wallet`, `iota`, `vechain`, `eos`, `waves`,
  `litecoin`, `dash`, `dogecoin` (`doge-wallet`), `bitcoin_cash`,
  `bitcoin_sv`, `zcash-wallet`, `kaspa-wallet`,
  `internet-computer-wallet`, `eclipse-wallet`, `starknet-wallet`,
  `immutable-wallet`, `stacks-wallet`, `aleo-wallet`, `story-wallet`,
  `polkadot`, `kusama-wallet`, `bnb_beacon`

### Cosmos-экосистема
- `cosmos`, `osmosis-wallet`, `juno-wallet`, `injective-wallet`,
  `celestia-wallet`, `cronos-cosmos-wallet`, `sei-wallet`,
  `kujira-wallet`, `akash-wallet`, `dymension-wallet`,
  `dymension-evm-wallet`, `kava-cosmos-wallet`, `axelar-wallet`,
  `stride-wallet`, `thorchain-wallet`, `evmos-cosmos-wallet`,
  `dydx-wallet`, `mantra-wallet`, `secret-wallet`, `babylon-wallet`,
  `zigchain-wallet`, `nillion-wallet`, `initia-wallet`,
  `bittensor-wallet`, `fetch-wallet`, `band_protocol`

## Особенности

- **Sync обязателен** для свежей `/wallet/transactions`. Без PATCH сначала
  отдаёт ошибку «Full portfolio history sync in progress».
- **DeFi automated detection** — не нужны отдельные интеграции с протоколами,
  CoinStats сам индексирует staking/lending/LP по wallet.
- **Bitcoin via xpub/ypub/zpub** — поддерживает HD-кошельки.

## Тестовый пример (наш Solana-кошелёк)

```bash
curl -H "X-API-KEY: <key>" \
  "https://openapiv1.coinstats.app/wallet/balance?\
address=HUaFZSfz8G5bK34JyrQvaLtTcGZtLetWDPF4ezvSfGdF&connectionId=solana"
```

Ответ: `[{symbol: "USDC", amount: 0.000025}, {symbol: "SOL", amount: 0.056}]`.

## Полезные ссылки

- API docs: https://coinstats.app/api-docs/
- LLMs index: https://coinstats.app/docs/llms.txt
