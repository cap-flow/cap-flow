# `event topic0 → op_type` — выверенный словарь (workflow 2026-06-04)

✅verified = topic0 совпал с живыми on-chain логами (Alchemy RPC, ETH/Arb, 2026-06-04).
⚠canonical = keccak256 канонической ABI-подписи верен, но в выборке окна живого лога не нашлось
(legacy / низкая активность / вариант пула) — подпись из стандартного ABI, сверена с sibling-событиями.

## Tier 1 — универсальные ERC (любой протокол)
| topic0 | событие | op_type | |
|---|---|---|---|
| `0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef` | ERC20 `Transfer` | transfer_in/out (по from/to) | ✅ |
| `0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925` | ERC20 `Approval` | approve (шум) | ⚠ |
| `0xdcbc1c05240f31ff3ad067ef1ee35ce4997762752e3a095284754544f4c709d7` | ERC4626 `Deposit(caller,owner,assets,shares)` | lend_supply/lp_add (vault) | ✅ |
| `0xfbde797d201c681b91056529119e0b02407c7bb96a4a2c75c01fc9667232c8db` | ERC4626 `Withdraw` | lend_withdraw | ✅ |

## Uniswap V2 family (Sushi/Pancake V2, Aerodrome/Velodrome volatile)
| topic0 | событие | op_type | |
|---|---|---|---|
| `0x4c209b5fc8ad50758f13e2e1088ba56a560dff690a1c6fef26394f4c03821c4f` | `Mint(address,uint256,uint256)` | lp_add | ✅ ⚠коллизия с Compound v2 cToken Mint |
| `0xdccd412f0b1252819cb1fd330b93224ca42612892bb3f4f789976e6d81936496` | `Burn(...)` | lp_remove | ✅ |
| `0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822` | `Swap(...)` | swap | ✅ |

## Uniswap V3 — NPM (Uni/Pancake/Sushi V3 + 28 Krystal-протоколов)
| topic0 | событие | op_type | |
|---|---|---|---|
| `0x3067048beee31b25b2f1681f88dac838c8bba36af25bfb2b7cf7473a5847e35f` | `IncreaseLiquidity` | lp_add | ✅ |
| `0x26f6a048ee9138f2c0ce266f322cb99228e8d619ae2bff30c67f8dcf9d2377b4` | `DecreaseLiquidity` | lp_remove | ✅ |
| `0x40d0efd1a53d60ecbf40971b9daf7dc90178c3aadc7aab1765632738fa8b8f01` | `Collect` | claim_rewards (LP fee — авторитет = Krystal) | ✅ |

## Uniswap V3 — pool-level
| `0x7a53080ba414158be7ec69b987b5fb7d07dee101fe85488f0853ae16239d0bde` | pool `Mint` | lp_add | ✅ |
| `0x0c396cd989a39f4459b5fa1aed6a9a8dcdbc45908acfd67e028cd568da98982c` | pool `Burn` | lp_remove | ✅ |
| `0x70935338e69775456a85ddef226c395fb668b63fa0115f5f20610b388e6ca9c0` | pool `Collect` | claim_rewards (fee) | ✅ |
| `0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67` | pool `Swap` | swap | ✅ |

## Uniswap V4 — singleton PoolManager (⚠ data-decode: направление = знак liquidityDelta)
| `0xf208f4912782fd25c7f114ca3723a2d5dd6f3bcc3ac8db5af63baa85f711d5ec` | `ModifyLiquidity` | lp_add/lp_remove (знак int256) | ✅ |
| `0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f` | `Swap` | swap | ✅ |

## Aave V2 (LendingPool)
| `0xde6857219544bb5b7746f48ed30be6386fefc61b2f864cacf559893bf50fd951` | `Deposit` | lend_supply | ⚠ |
| `0x3115d1449a7b732c986cba18244e897a450f61e1bb8d589cd2e69e6c8924f9f7` | `Withdraw` | lend_withdraw | ✅ (общий с Aave V3) |
| `0xc6a898309e823ee50bac64e45ca8adba6690e99e7841c45d754e2a38e9019d9b` | `Borrow` | borrow | ⚠ |
| `0x4cdde6e09bb755c9a5589ebaec640bbfedff1362d4b255ebf8339782b9942faa` | `Repay` | repay | ✅ |

## Aave V3 (Pool)
| `0x2b627736bca15cd5381dcf80b0bf11fd197d01a037c52b927a881a10fb73ba61` | `Supply` | lend_supply | ✅ |
| `0x3115d1449a7b732c986cba18244e897a450f61e1bb8d589cd2e69e6c8924f9f7` | `Withdraw` | lend_withdraw | ✅ |
| `0xb3d084820fb1a9decffb176436bd02558d15fac9b0ddfed8c465bc7359d7dce0` | `Borrow` | borrow | ✅ |
| `0xa534c8dbe71f871f9f3530e97a74601fea17b426cae02e1c5aee42c96c784051` | `Repay` | repay | ✅ |

## Compound v2 (cToken)
| `0x4c209b5fc8ad50758f13e2e1088ba56a560dff690a1c6fef26394f4c03821c4f` | `Mint` | lend_supply | ⚠ коллизия UniV2 → различать по контракту |
| `0xe5b754fb1abb7f01b499791d0b820ae3b6af3424ac1c59768edb53f4ec31a929` | `Redeem` | lend_withdraw | ✅ |
| `0x13ed6866d4e1ee6da46f845c46d7e54120883d75c5ea9a2dacc1c4ca8984ab80` | `Borrow` | borrow | ⚠ |
| `0x1a2a22cb034d26d1854bdc6666a5b91fe25efbbb5dcad3b0355478d6f5c362a1` | `RepayBorrow` | repay | ✅ |

## Compound v3 (Comet)
| `0xd1cf3d156d5f8f0d50f6c122ed609cec09d35c9b9fb3fff6ea0959134dae424e` | `Supply` | lend_supply | ✅ |
| `0x9b1bfa7fa9ee420a16e124f794c35ac9f90472acc99140eb2f6447c714cad8eb` | `Withdraw` | lend_withdraw / borrow (если база) | ✅ |
| `0xfa56f7b24f17183d81894d3ac2ee654e3c26388d17a28dbd9549b8114304e1f4` | `SupplyCollateral` | lend_supply (collateral) | ✅ |
| `0xd6d480d5b3068db003533b170d67561494d72e3bf9fa40a266471351ebba9e16` | `WithdrawCollateral` | lend_withdraw (collateral) | ✅ |

## Curve (⚠ topic0 зависит от arity coins — entry на каждую)
| `0x423f6495a08fc652425cf4ed0d1f9e37e571d9b9529b1c1c23cce780b2e7df0d` | `AddLiquidity` 3-coin | lp_add | ✅ |
| `0x26f55a85081d24974e85c6c00045d0f0453991e95873f52bff0d21af4079a768` | `AddLiquidity` 2-coin | lp_add | ⚠ |
| `0xa49d4cf02656aebf8c771f5a8585638a2a15ee6c97cf7205d4208ed7c1df252d` | `RemoveLiquidity` 3-coin | lp_remove | ✅ |
| `0x7c363854ccf79623411f8995b362bce5eddff18c927edc6f5dbbb5e05819a82c` | `RemoveLiquidity` 2-coin | lp_remove | ⚠ |
| `0x5ad056f2e28a8cec232015406b843668c1e36cda598127ec3b8c59b8c72773a0` | `RemoveLiquidityOne` | lp_remove | ⚠ (NG-пулы иначе) |
| `0x8b3e96f2b889fa771c53c981b40daf005f63f637f1869f707052d15a3dd97140` | `TokenExchange` | swap | ✅ |

## Convex
| `0x73a19dd210f1a7f902193214c0ee91dd35ee5b4d920cba8d519eca65a7b488ca` | Booster `Deposited` | stake | ✅ |
| `0x92ccf450a286a957af52509bc1c9939d1a6a481783e142e41e2499f0bb66ebc6` | Booster `Withdrawn` | unstake | ✅ |
| `0x9e71bc8eea02a63969f509818f2dafb9254532904319f9dbda79b67bd34a5f3d` | BaseRewardPool `Staked` | stake | ✅ |
| `0x7084f5476618d8e60b11ef0d7d3f06914655adb8793e28ff7f018d4c76d505d5` | BaseRewardPool `Withdrawn` | unstake | ✅ |

## Lido / ether.fi
| `0x96a25c8ce0baabc1fdefd93e9ed25d8e092a3332f3aa9a41722b5697231d1d1a` | Lido `Submitted` | stake | ✅ |
| `0xa241faf62e66ce518d1934ce4c936d806a02289ba483fac23beb8c15755be90d` | ether.fi LP `Deposit` | stake (mint eETH) | ✅ ⚠несколько Deposit-событий — это user-facing |

## Morpho Blue (singleton `0xBBBB…FFCb`)
| `0xedf8870433c83823eb071d3df1caa8d008f12f6440918c20d75a3602cda30fe0` | `Supply` | lend_supply | ✅ |
| `0xa56fc0ad5702ec05ce63666221f796fb62437c32db1aa1aa075fc6484cf58fbf` | `Withdraw` | lend_withdraw | ✅ |
| `0x570954540bed6b1304a87dfe815a5eda4a648f7097a16240dcd85c9b5fd42a43` | `Borrow` | borrow | ✅ |
| `0x52acb05cebbd3cd39715469f22afbf5a17496295ef3bc9bb5944056c63ccaa09` | `Repay` | repay | ✅ |
| `0xa3b9472a1399e17e123f3c2e6586c23e504184d504de59cdaa2b375e880c6184` | `SupplyCollateral` | lend_supply (collateral) | ✅ |
| `0xe80ebd7cc9223d7382aab2e0d1d6155c65651f83d53c8b9b06901d167e321142` | `WithdrawCollateral` | lend_withdraw (collateral) | ✅ |

## Synthetix StakingRewards (SNX, Curve gauges, тысячи ферм — самый переиспользуемый набор)
| `0x9e71bc8eea02a63969f509818f2dafb9254532904319f9dbda79b67bd34a5f3d` | `Staked` | stake | ✅ |
| `0x7084f5476618d8e60b11ef0d7d3f06914655adb8793e28ff7f018d4c76d505d5` | `Withdrawn` | unstake | ✅ |
| `0xe2403640ba68fed3a2f88b7557551d1993f84b99bb10ff833f0cf8db0c5e0486` | `RewardPaid` | claim_rewards | ✅ |

## ⚠ DATA-decode (topic0 НЕ хватает — направление/имя в DATA)
- **GMX V2** — все события через один EventEmitter `0xC8ee…22Fb`: topic0 `0x468a25a7…`(`EventLog2`) / `0x137a4406…`(`EventLog1`) ✅verified. Имя события (`DepositCreated`/`WithdrawalExecuted`/`PositionIncrease`/…) — **строка в DATA**. → ABI-декод DATA.
- **Fluid** — `LogOperate`-семейство (`0xfcc2278…`/`0x4d93b23…`/`0xfef6476…`): supply/borrow/withdraw/repay по **знаку amount в DATA**.
- **UniV4 ModifyLiquidity** — add vs remove = знак `int256 liquidityDelta`.
- **Curve** — topic0 по arity coins.
- **Pendle** — по типу контракта (SY Deposit/Redeem→stake/unstake, Market Mint/Burn→lp_add/lp_remove). Per-contract ABI.

## ⚠ Коллизии (один topic0 → разный смысл, различать по emitting-контракту/со-событиям)
- `Mint(address,uint256,uint256)` `0x4c209b5f…` = UniV2 lp_add **И** Compound v2 lend_supply.
- `Withdraw(...)` `0x3115d144…` = Aave V2 **И** V3 (оба lend_withdraw — безопасно).
- `Staked`/`Withdrawn` = Convex **И** Synthetix (оба одинаково — безопасно).
- Generic-имена (`Supply`/`Borrow`/…) имеют **разный topic0 у разных протоколов** (разный список параметров) — всегда ключ по полному topic0.

Связанные: `taxonomy-standards.md`, `classifier-upgrade-plan.md`, [[capflow_data_source_authority]].
