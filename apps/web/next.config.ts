import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // workspace 套件直接輸出 TS 原始碼，由 Next 轉譯
  transpilePackages: ['@aeh/core'],
};

export default nextConfig;
