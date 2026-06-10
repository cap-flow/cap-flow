/** One-off: enqueue a manual portfolio-refresh job for an account. The running
 *  worker drains it (live DeBank fetch + UCB shadow recompute when flag ON). */
import Redis from "ioredis";

import { PortfolioRefreshQueue } from "../src/modules/queue/portfolio-refresh.queue.js";

const accountId = process.argv[2];
const actorUserId = process.argv[3];
if (!accountId || !actorUserId) {
  console.error("usage: enqueue-refresh.mts <accountId> <actorUserId>");
  process.exit(1);
}
const conn = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", {
  maxRetriesPerRequest: null,
});
const q = new PortfolioRefreshQueue(conn);
const jobId = await q.enqueueManual(accountId, actorUserId, "admin");
console.log("[enqueue-refresh] queued job", jobId, "for account", accountId);
await conn.quit();
process.exit(0);
