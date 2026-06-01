// One-off: build per-wallet golden fixtures for the testakk account wallets
// (artur, murat) from the live capture. Anchors every VERIFIED non-Fluid
// position; Fluid is skipped because one receipt (0x324c5dc1) maps to TWO
// decomposed positions per wallet (ETH + WBTC collateral) and the harness has
// no match-type to disambiguate by collateral asset yet (follow-up: add a
// `supplySymbol` match type, then anchor the 4 Fluid positions too).
//
// All 14 positions were verified from the operations registry on 2026-06-01:
//  - GMX (×7): startUsd = linkedCostBasisUsd (Σ stablecoin paid in the request
//    tx); round values are legitimate round deposits. POS-007 (artur 0x77b2ec35)
//    nets a 1157 GM partial withdrawal → $5268.32.
//  - Morpho (artur 0x6c247b1f, POS-014): GLV protocol-token collateral that
//    DeBank decomposes into WETH+USDC; cost basis lot-traced to $21,595.94.
//  - Uniswap V3 (×2, murat): vs Krystal totalDepositValue ($240.83 / $146.86).
//  - Fluid (×4, skipped here): WBTC cost = Σ stablecoin paid (artur exact
//    $30,000 = 5000+5000+10000+10000), ETH LIFO lot-traced; all confirmed.
import { readFileSync, writeFileSync } from "node:fs";

const HERE = "/Users/vladimir/Desktop/cap-flow (для блокчейна)/.claude/worktrees/condescending-fermi-99f0ac";
const CAP = `${HERE}/scripts/artur-murat-capture.json`;
const OUT_DIR = `${HERE}/apps/web/src/lib/portfolio/__fixtures__/golden`;
const cap = JSON.parse(readFileSync(CAP, "utf8"));

const idToName = new Map(cap.wallets.map((w) => [w.wallet.id, w.wallet.name]));

for (const w of cap.wallets) {
  const name = w.wallet.name; // artur | murat
  const slug = name.toLowerCase().replace(/\s+/g, "-");

  // Anchor every verified non-Fluid position for this wallet.
  const mine = cap.positions.filter(
    (p) => p.walletId === w.wallet.id && !/fluid/i.test(p.protocolName),
  );
  const seen = new Set();
  const anchors = [];
  for (const p of mine) {
    const isV3 = p.matchedV3TokenId != null;
    const match = isV3 ? "tokenId" : "marketKey";
    const key = isV3 ? `tok:${p.matchedV3TokenId}` : `mk:${p.lpTokenId}`;
    if (seen.has(key)) {
      throw new Error(`${name}: ambiguous anchor ${key} — would match >1 position`);
    }
    seen.add(key);
    anchors.push({
      label: `${name}:${p.protocolName}:${(p.lpTokenId || "").slice(0, 10)}${isV3 ? `#${p.matchedV3TokenId}` : ""}`,
      anchor: {
        chain: p.chain,
        protocolId: p.protocolId,
        marketKey: isV3 ? null : p.lpTokenId,
        openHash: p.openHash ?? null,
        tokenId: isV3 ? p.matchedV3TokenId : null,
      },
      match,
      expected: { startUsd: p.startUsd, toleranceAbsUsd: 1, tolerancePct: 0.005 },
    });
  }

  const v3pmEntry = cap.v3PositionMap.find(([k]) => k === w.wallet.id);
  const fixture = {
    schemaVersion: 2,
    label: slug,
    methodologyVersion: "ucb-2026-06-01",
    lotMethodology: cap.lotMethodology,
    position: { anchor: anchors[0].anchor, match: anchors[0].match },
    anchors,
    input: {
      wallets: [{ wallet: w.wallet, ops: w.ops, live: w.live }],
      histPrices: cap.histPrices,
      costBasisOverrideByHash: cap.costBasisOverrideByHash,
      nonLpOpenerByKey: cap.nonLpOpenerByKey,
      v3PositionMap: v3pmEntry ? [v3pmEntry] : [],
      v3CostBasis: cap.v3CostBasis,
      krystalV3ByTokenId: cap.krystalV3ByTokenId,
      krystalTxByTokenId: cap.krystalTxByTokenId,
    },
    expected: anchors[0].expected,
    provenance: {
      sourceOfTruth: "registry+krystal+onchain",
      note: `testakk/${name} positions, all verified from the operations registry 2026-06-01: GMX startUsd=linkedCostBasisUsd (Σ stablecoin paid, POS-007 nets partial withdrawal), Morpho POS-014 decomposed GLV collateral lot-traced, V3 vs Krystal totalDepositValue. Fluid (×2 per wallet on one receipt) skipped pending a supplySymbol match type.`,
    },
  };
  writeFileSync(`${OUT_DIR}/${slug}-1.json`, JSON.stringify(fixture));
  console.log(
    `${slug}-1.json: ${anchors.length} anchors [${anchors
      .map((a) => `${a.label.split(":").slice(1).join(":")}=$${Math.round(a.expected.startUsd)}`)
      .join(", ")}]; bytes ${JSON.stringify(fixture).length}`,
  );
}
