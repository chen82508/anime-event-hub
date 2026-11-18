import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 整合測試共用同一個測試 DB，不可平行
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
