import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

// 與 worker 共用 repo 根目錄的 .env（DATABASE_URL、ADMIN_BASIC_AUTH）
const rootEnv = fileURLToPath(new URL('../../.env', import.meta.url));
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const nextConfig: NextConfig = {
  // workspace 套件直接輸出 TS 原始碼，由 Next 轉譯
  transpilePackages: [
    '@aeh/core',
    '@aeh/db',
    '@aeh/dedup',
    '@aeh/normalize',
    '@aeh/notify',
    '@aeh/scrapers',
    '@aeh/tagger',
  ],
  // DB driver 不打包，直接由 Node 載入
  serverExternalPackages: ['postgres'],
};

export default nextConfig;
