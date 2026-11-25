import type { MetadataRoute } from 'next';

/** PWA manifest：iOS 需「加入主畫面」後才能使用 Web Push */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: '動漫活動一站看｜Anime Event Hub TW',
    short_name: '動漫活動',
    description: '台灣動漫演唱會、見面會、展覽、快閃店、同人展一次看，開賣與活動前提醒。',
    lang: 'zh-Hant-TW',
    start_url: '/',
    display: 'standalone',
    background_color: '#fbf9ff',
    theme_color: '#6b2bd9',
    icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
  };
}
