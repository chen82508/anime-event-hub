/* 動漫活動一站看：Web Push service worker（只處理推播，不做離線快取） */

self.addEventListener('push', (event) => {
  let data;
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: '動漫活動一站看', body: event.data ? event.data.text() : '' };
  }
  // 只接受站內路徑（排除 //host 這類協定相對網址）
  const url =
    typeof data.url === 'string' && data.url.startsWith('/') && !data.url.startsWith('//')
      ? data.url
      : '/me';
  event.waitUntil(
    self.registration.showNotification(data.title || '動漫活動一站看', {
      body: data.body || '',
      tag: data.tag,
      icon: '/icon.svg',
      badge: '/icon.svg',
      lang: 'zh-Hant-TW',
      data: { url },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || '/', self.location.origin).href;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const w of windows) {
        if (w.url === target && 'focus' in w) return w.focus();
      }
      return self.clients.openWindow(target);
    })(),
  );
});
