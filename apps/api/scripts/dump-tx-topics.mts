/** One-off: дамп topic0 всех логов tx (для self-extending loop — опознать события).
 * Run: npx tsx --env-file=../../.env scripts/dump-tx-topics.mts <chain> <tx...> */
import { createPublicClient, http } from "viem";
import { mainnet, base, arbitrum } from "viem/chains";
import { TOPIC0_DICT } from "@cap-flow/ucb/topic0_dict";

const CH: Record<string, { chain: any; host: string }> = {
  eth: { chain: mainnet, host: "eth-mainnet.g.alchemy.com" },
  base: { chain: base, host: "base-mainnet.g.alchemy.com" },
  arb: { chain: arbitrum, host: "arb-mainnet.g.alchemy.com" },
};
const chain = process.argv[2]!;
const txs = process.argv.slice(3);
const c = CH[chain]!;
const cl = createPublicClient({ chain: c.chain, transport: http(`https://${c.host}/v2/${process.env.ALCHEMY_API_KEY}`) });

for (const tx of txs) {
  const r = await cl.getTransactionReceipt({ hash: tx as `0x${string}` });
  console.log(`\n=== ${tx} (${r.logs.length} logs) ===`);
  const seen = new Set<string>();
  for (const l of r.logs) {
    const t = l.topics[0]?.toLowerCase();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    const e = TOPIC0_DICT.get(t);
    console.log(`  ${t}  ${e ? "✓ " + e.event : "✗ unknown"}  @${l.address.slice(0, 10)}`);
  }
}
process.exit(0);
