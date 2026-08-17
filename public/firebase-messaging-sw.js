/**
 * FCM 背景訊息處理。
 * ⚠️ 這個檔案必須放在 public 根目錄，放子目錄的話 scope 不對，Service Worker 註冊會失敗。
 */

importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js');
importScripts('/config.js'); // config.js 用 self.COOLPATH_CONFIG，SW 裡讀得到

firebase.initializeApp(self.COOLPATH_CONFIG.firebase);
const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
  const n = payload.notification || {};
  self.registration.showNotification(n.title || '涼路 CoolPath', {
    body: n.body || '',
    icon: '/icon.png',
    badge: '/icon.png',
    tag: 'coolpath',
    requireInteraction: true, // 讓橫幅停久一點，Demo 時才來得及被看到
    data: payload.data || {},
  });
});

// 點推播回到網頁：已開著就聚焦，沒開就開新分頁
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ('focus' in c) return c.focus();
      }
      return clients.openWindow(url);
    })
  );
});
