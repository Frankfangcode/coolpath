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
  mapsApiKey: 'AIzaSyDOeiLcY1PpitveFTZym2Dis58rlZhIwlU',

  firebase: {
    apiKey: "AIzaSyATI5n-haQYWGlfteFYKK3oS5lP2173UxQ",
  authDomain: "devjam26aug17tpe-1210.firebaseapp.com",
  projectId: "devjam26aug17tpe-1210",
  storageBucket: "devjam26aug17tpe-1210.firebasestorage.app",
  messagingSenderId: "239652904792",
  appId: "1:239652904792:web:bce99680eb9c3d44380f2d"
  },

  

  vapidKey: 'BEj0lOCiZ9ECR-KsrptdzTdUObqnBTFHkRfhe6RCG-m2U10XcTmazFigywd5E5_gz9TUboXHCHHkMbtYCUYfx2g',

  // 示範路線：政大 → 台北車站
  demo: {
    origin: { lat: 24.9874, lng: 121.5759, name: '國立政治大學' },
    destination: { lat: 25.0488, lng: 121.5137, name: '台北車站' },
  },
};
