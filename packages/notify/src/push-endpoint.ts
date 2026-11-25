/**
 * Web Push 端點白名單。
 * 端點網址由瀏覽器提供、經網站存進 DB，worker 之後會對它發 POST；
 * 若不限制主機，有心人可塞入內網位址讓 worker 代為請求（SSRF）。只接受各大瀏覽器的推播服務。
 */
const ALLOWED_PUSH_HOST_SUFFIXES = [
  // Chrome / Edge（Chromium）/ Opera / Samsung Internet
  'fcm.googleapis.com',
  'android.googleapis.com',
  // Firefox
  'push.services.mozilla.com',
  // Safari（macOS 13+、iOS 16.4+ 加入主畫面）
  'push.apple.com',
  // 舊版 Edge
  'notify.windows.com',
] as const;

export function isAllowedPushEndpoint(endpoint: string): boolean {
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.port !== '' || u.username || u.password) return false;
  const host = u.hostname.toLowerCase();
  return ALLOWED_PUSH_HOST_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`));
}
