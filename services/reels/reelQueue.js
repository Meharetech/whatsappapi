// Redis/BullMQ is optional - jobs will be processed immediately without scheduling
let reelQueue = null;
let redisConnected = false;

// Skip BullMQ entirely - it auto-connects and causes spam errors
// To enable: install Redis, then uncomment this section
/*
try {
  const { Queue } = await import("bullmq");
  const IORedis = (await import("ioredis")).default;
  const connection = new IORedis(process.env.REDIS_URL || "redis://127.0.0.1:6379");
  reelQueue = new Queue("reelQueue", { connection });
  redisConnected = true;
} catch (err) {
  console.warn("⚠️ Redis disabled - reel uploads will be immediate (no scheduling)");
}
*/

export function addReelJob(name, data, opts = {}) {
  // Fallback: no scheduling, just return resolved promise
  return Promise.resolve({ id: Date.now() });
}

export function isRedisConnected() {
  return redisConnected;
}
