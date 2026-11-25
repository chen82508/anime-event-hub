import type { MetadataRoute } from 'next';

/** 後台、個人頁與 API 不需被索引 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: '*', allow: '/', disallow: ['/admin', '/me', '/api/'] }],
  };
}
