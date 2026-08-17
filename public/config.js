/**
 * 前端設定。index.html 與 firebase-messaging-sw.js 共用這一份
 * （用 self 而不是 window，Service Worker 裡才讀得到）。
 *
 * ⚠️ 部署前把下面四個值填好：
 *   1. mapsApiKey  — Google Cloud Console，啟用 Maps JavaScript API
 *   2. firebase    — Firebase Console → 專案設定 → 一般 → 你的應用程式 → SDK 設定與配置
 *   3. vapidKey    — Firebase Console → 專案設定 → Cloud Messaging → Web Push certificates → Generate key pair
 */
self.COOLPATH_CONFIG = {
  mapsApiKey: 'REPLACE_WITH_MAPS_JS_API_KEY',

  firebase: {
    apiKey: 'REPLACE_WITH_FIREBASE_API_KEY',
    authDomain: 'coolpath-demo.firebaseapp.com',
    projectId: 'coolpath-demo',
    storageBucket: 'coolpath-demo.appspot.com',
    messagingSenderId: 'REPLACE_WITH_SENDER_ID',
    appId: 'REPLACE_WITH_APP_ID',
  },

  vapidKey: 'REPLACE_WITH_VAPID_PUBLIC_KEY',

  // 示範路線：政大 → 台北車站
  demo: {
    origin: { lat: 24.9874, lng: 121.5759, name: '國立政治大學' },
    destination: { lat: 25.0488, lng: 121.5137, name: '台北車站' },
  },
};
