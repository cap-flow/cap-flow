// One-off: build per-wallet golden fixtures for MMaksimuk 1/2 from the live capture.
import { readFileSync, writeFileSync } from "node:fs";

const CAP = "/Users/vladimir/Desktop/cap-flow (для блокчейна)/.claude/worktrees/romantic-brahmagupta-8acbff/mmaksimuk-capture.json";
const OUT_DIR = "/Users/vladimir/Desktop/cap-flow (для блокчейна)/.claude/worktrees/condescending-fermi-99f0ac/apps/web/src/lib/portfolio/__fixtures__/golden";
const g = JSON.parse(readFileSync(CAP, "utf8"));

// label → {wallet name, chain, protocolId, marketKey, tokenId}  (verified vs Krystal)
const ANCHORS = [
  ["POS-004","MMaksimuk 1","arb","arb_uniswap4","0xd88f38f930b7952f2db2432cb002e7abbf3dd869","147480"],
  ["POS-006","MMaksimuk 1","eth","uniswap3","0x89dfb4033d87f3b15dc1badb4a7b97e01cc41837","1245582"],
  ["POS-008","MMaksimuk 1","eth","uniswap3","0xeeb8f880ead7281a301ef2e6791a6bbe790603ed","1245807"],
  ["POS-009","MMaksimuk 1","eth","uniswap3","0x877da2662c8454417d69399b20f570ea4f1a44df","1196206"],
  ["POS-010","MMaksimuk 1","arb","arb_uniswap3","0xc6f780497a95e246eb9449f5e4770916dcd6396a","5393696"],
  ["POS-012","MMaksimuk 1","arb","arb_uniswap3","0x641c00a822e8b671738d32a431a4fb6074e5c79d","5292019"],
  ["POS-019","MMaksimuk 1","eth","uniswap3","0x9b727c74e881433d05e536fd95e516673d1028ea","1220777"],
  ["POS-021","MMaksimuk 1","eth","uniswap3","0x55a0d7694c8c6bb73e27523648554fbdc8efd9d0","1227688"],
  ["POS-025","MMaksimuk 1","eth","uniswap3","0x9fd05e53628e40b36fc991eec1163d6ed77b4bd9","1220760"],
  // POS-026 (Velodrome gauge-staked) EXCLUDED from replay: the V3 slot0 match
  // isn't reproducible offline (not Krystal-covered → no override correction).
  // It is verified on-chain + documented durably in notes/golden/knowledge-base.md §6c.
  ["POS-039","MMaksimuk 1","arb","arb_pancakeswap3","0x5e09acf80c0296740ec5d6f643005a4ef8daa694","238921"],
  ["POS-003","MMaksimuk 2","eth","uniswap3","0x877da2662c8454417d69399b20f570ea4f1a44df","1197113"],
  ["POS-005","MMaksimuk 2","eth","uniswap3","0x89dfb4033d87f3b15dc1badb4a7b97e01cc41837","1237252"],
  ["POS-007","MMaksimuk 2","eth","uniswap3","0xeeb8f880ead7281a301ef2e6791a6bbe790603ed","1237257"],
  ["POS-011","MMaksimuk 2","arb","arb_uniswap3","0x641c00a822e8b671738d32a431a4fb6074e5c79d","5266800"],
  ["POS-023","MMaksimuk 2","arb","arb_uniswap3","0x5969efdde3cf5c0d9a88ae51e47d721096a97203","5446793"],
  ["POS-027","MMaksimuk 2","arb","arb_uniswap3","0xc6f780497a95e246eb9449f5e4770916dcd6396a","5375541"],
];

// captured live position by tokenId → startUsd (the value replay must reproduce)
const startByToken = new Map();
for (const p of g.positions) if (p.tokenId != null) startByToken.set(String(p.tokenId), p.startUsd);

for (const walletName of ["MMaksimuk 1", "MMaksimuk 2"]) {
  const w = g.wallets.find((x) => x.wallet.name === walletName);
  if (!w) { console.log("wallet not found:", walletName); continue; }
  const slug = walletName.toLowerCase().replace(/\s+/g, "-"); // mmaksimuk-1
  const anchors = [];
  const missing = [];
  for (const [label, wn, chain, protocolId, marketKey, tokenId] of ANCHORS) {
    if (wn !== walletName) continue;
    const start = startByToken.get(tokenId);
    if (start == null) { missing.push(`${label}(tok ${tokenId} not in live positions)`); continue; }
    anchors.push({
      label, anchor: { chain, protocolId, marketKey, openHash: null, tokenId }, match: "tokenId",
      expected: { startUsd: start, toleranceAbsUsd: 1, tolerancePct: 0.005 },
    });
  }
  // V3 position map entry for this wallet only; v3CostBasis kept whole (harmless extras)
  const v3pmEntry = g.v3PositionMap.find(([k]) => k === w.wallet.id);
  const fixture = {
    schemaVersion: 2, label: slug, methodologyVersion: "ucb-2026-06-01",
    lotMethodology: g.lotMethodology,
    position: { anchor: anchors[0].anchor, match: anchors[0].match },
    anchors,
    input: {
      wallets: [{ wallet: w.wallet, ops: w.ops, live: w.live }],
      histPrices: g.histPrices,
      costBasisOverrideByHash: g.costBasisOverrideByHash,
      nonLpOpenerByKey: g.nonLpOpenerByKey,
      v3PositionMap: v3pmEntry ? [v3pmEntry] : [],
      v3CostBasis: g.v3CostBasis,
      krystalV3ByTokenId: g.krystalV3ByTokenId,
      krystalTxByTokenId: g.krystalTxByTokenId,
    },
    expected: anchors[0].expected,
    provenance: { sourceOfTruth: "krystal+onchain", note: `${walletName} V3/V4/CL LP anchors, verified vs Krystal /transactions Σ DEPOSIT (LP authoritative) 2026-06-01; POS-026 verified on-chain (Velodrome gauge).` },
  };
  writeFileSync(`${OUT_DIR}/${slug}.json`, JSON.stringify(fixture));
  console.log(`${slug}.json: ${anchors.length} anchors [${anchors.map(a=>a.label).join(",")}]; missing: ${missing.join(",")||"none"}; bytes ${JSON.stringify(fixture).length}`);
}
