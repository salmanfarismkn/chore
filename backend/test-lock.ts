import { connectRedis, redis } from "./src/config/redis";
import { AllocationLockService } from "./src/modules/allocation/allocation-lock.service";

(async () => {
  // Connect before using
  await connectRedis();

  const lockService = new AllocationLockService();

  const first = await lockService.acquire(1, 101, 20);
  const second = await lockService.acquire(1, 102, 20);

  console.log("First acquire:", first);   // true
  console.log("Second acquire:", second); // false

  const currentWorker = await lockService.getWorker(1);
  console.log("Current worker:", currentWorker); // 101

  const released = await lockService.release(1, 101);
  console.log("Released:", released); // true

  // Clean shutdown
  await redis.quit();
})();

