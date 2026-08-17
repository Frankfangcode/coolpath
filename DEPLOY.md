# 部署到 Google Cloud（Firebase Hosting + Cloud Functions）

從零到線上網址，照順序做。中間任何一步卡住，跑 `npm run preflight` 看還差什麼。

架構：**Firebase Hosting**（靜態網頁）＋ **Cloud Functions v2**（四支 API）＋
**Firestore**（FCM token 與氣象快取）。Hosting 的 rewrites 把 `/api/*` 轉給
Functions，所以前端用相對路徑、沒有 CORS 問題。

---

## 步驟一：建立 Firebase 專案

1. https://console.firebase.google.com → **建立專案**
2. 專案名稱自取（例：`coolpath`）。Firebase 會產生一個**專案 ID**
   （例：`coolpath-4a91f`）—— 這串才是後面要用的，不是顯示名稱
3. Google Analytics 可以關掉，這個 demo 用不到
4. 建好後進 **⚙️ 專案設定 → 一般**，記下「專案 ID」

Firebase 專案就是 GCP 專案，兩邊 Console 看到的是同一個東西。

## 步驟二：升級 Blaze 方案（用比賽的 credits）

Cloud Functions v2 **必須** Blaze 方案才能部署，Spark（免費）不行。

1. Firebase Console 左下角 **升級** → 選 **Blaze 隨用隨付**
2. 綁定帳單帳戶時，選比賽提供的那個（有 credits 的）帳戶。
   如果比賽給的是 credits 兌換碼，先到
   https://console.cloud.google.com/billing → **兌換促銷代碼**，
   兌換後該帳單帳戶就會有額度，再回來綁定
3. 建議同時設 **預算警示**（Console → Billing → Budgets & alerts），
   設個 $5 上限提醒，避免 key 外洩時無感燒錢

費用感覺：這個規模的 demo（每天幾百次請求）Functions 與 Hosting 幾乎都在免費
額度內。真正會花錢的是 **Google Maps Platform**（Routes API 每 1000 次約 $5，
每月有 $200 免費額度）。

## 步驟三：安裝工具並登入

```bash
npm install -g firebase-tools
firebase login          # 會開瀏覽器做 Google 登入
```

`gcloud` 不是必要的（下面所有事都能在 Console 網頁點完），但有的話比較快：
https://cloud.google.com/sdk/docs/install

## 步驟四：把專案 ID 寫進 .firebaserc

把 `coolpath-demo` 換成步驟一拿到的真實專案 ID：

```json
{
  "projects": {
    "default": "你的專案ID"
  }
}
```

或用指令：`firebase use --add`

## 步驟五：啟用需要的 API

Console → https://console.cloud.google.com/apis/library （確認左上角選對專案）
逐一啟用：

| API | 用途 | 不啟用的後果 |
| --- | --- | --- |
| **Routes API** | 後端算路線 | `/api/coolRoute` 全掛 |
| **Maps JavaScript API** | 前端地圖圖磚 | 地圖空白 |
| **Places API** | 起訖點地名自動完成 | 自動完成沒有下拉，但仍可打字（後端會地理編碼） |
| **Geocoding API** | 後端把地名轉座標 | 輸入地名會失敗，只能打座標 |
| **Vertex AI API** (`aiplatform`) | Gemini 判斷層 | 退回規則式 fallback（功能仍在） |

指令版：

```bash
gcloud services enable routes.googleapis.com maps-backend.googleapis.com \
  places-backend.googleapis.com geocoding-backend.googleapis.com \
  aiplatform.googleapis.com --project=你的專案ID
```

## 步驟六：建立**兩把**不同的 API key ⚠️ 最重要的一步

**絕對不要前後端共用同一把 key。** 前端的 key 會出現在
`public/config.js`，任何人都看得到；如果那把 key 同時能打 Routes API，
別人就能拿去刷你的帳單。

Console → https://console.cloud.google.com/apis/credentials

**Key A — 前端用（會公開）**
- 名稱：`coolpath-web`
- **應用程式限制**：HTTP 參照網址 → 加入
  `https://你的專案ID.web.app/*` 與 `https://你的專案ID.firebaseapp.com/*`
  （本機測試再加 `http://localhost:*`）
- **API 限制**：只勾 **Maps JavaScript API** 與 **Places API**
- 填到 `public/config.js` 的 `mapsApiKey`

**Key B — 後端用（保密）**
- 名稱：`coolpath-server`
- **應用程式限制**：無（Cloud Functions 出口 IP 不固定）
- **API 限制**：只勾 **Routes API** 與 **Geocoding API**
- 填到 `functions/.env` 的 `GOOGLE_MAPS_API_KEY`

> 目前本機開發是把 `.env` 那把 key 注入前端 config.js 共用（`tools/dev_server.js`），
> 方便但**不能沿用到正式環境**。部署時務必分成兩把。

## 步驟七：拿 firebaseConfig 與 VAPID key（推播用）

1. Firebase Console → **⚙️ 專案設定 → 一般** → 捲到「你的應用程式」
   → 點 **`</>`（Web）** 新增網頁應用程式（暱稱自取，**不要**勾 Hosting 設定）
2. 複製它顯示的 `firebaseConfig` 物件，填進 `public/config.js` 的 `firebase` 區塊
3. **⚙️ 專案設定 → Cloud Messaging** → Web Push certificates
   → **Generate key pair** → 複製那串公鑰，填進 `public/config.js` 的 `vapidKey`

填完 `public/config.js` 應該沒有任何 `REPLACE_WITH_` 字樣。

> `public/config.js` 裡的值都是**設計上就會公開**的（Firebase Web API key 不是密碼，
> 它靠 Firebase 安全規則與上面的 referrer 限制保護）。commit 進 git 沒問題。
> 真正不能公開的是 `functions/.env`，它已經在 `.gitignore` 裡。

## 步驟八：建立 Firestore 資料庫

沒建的話 `/api/notify` 與氣象快取寫入會 500。

Firebase Console → **建構 → Firestore Database** → **建立資料庫**
- 模式：**正式版模式**
- 位置：**`us-central1`**（要跟 Functions 同區，見下方註）

安全規則保持預設（全部拒絕）即可 —— 只有後端用 Admin SDK 存取，
Admin SDK 會繞過安全規則，前端不直接讀寫 Firestore。

## 步驟九：部署

```bash
cd functions && npm install && cd ..
npm run preflight          # 確認每項都綠燈
firebase deploy
```

或一次到底：`npm run deploy`（會先跑 preflight，沒過就不部署）

第一次部署會問要不要建立 Cloud Functions 相關資源，選 Yes。
跑完會給你網址：`https://你的專案ID.web.app`

## 步驟十：驗證（照 Demo 腳本走）

- [ ] `https://你的專案ID.web.app/api/coolRoute?origin=國立政治大學&destination=台北車站`
      在瀏覽器直接打開看得到乾淨 JSON ← 證明「我們是引擎不是 App」
- [ ] 首頁地圖有圖磚、有熱區色點（沒有的話 → Key A 的 referrer 限制設錯）
- [ ] 起訖點打地名有自動完成下拉
- [ ] 按「尋找涼爽路線」出現綠／藍兩條路線與對比卡片
- [ ] 環境資訊列的體感溫度顯示「CWA 預報」而不是「由氣溫濕度計算」
- [ ] 點「用 Google Maps 導航」，確認 Google 重現的路線與我們算的吻合
      （偏掉就把 `functions/index.js` 的 `WAYPOINT_COUNT` 從 5 往上加，上限 9）
- [ ] 手機掃 QR 開啟：HTTPS 才測得出定位、語音、推播
- [ ] 點「開始」→ 授權推播 → 按「一鍵示範」→ 橫幅出現
- [ ] 檢查沒有出現橘色的「合成佔位資料」警告條（有的話代表 LST 還沒換成真資料）

出問題先看 log：

```bash
firebase functions:log --only coolRoute
```

---

## 常見卡點

| 症狀 | 原因 |
| --- | --- |
| `HTTP 403 REQUEST_DENIED` | 對應的 API 沒啟用，或 Key B 的 API 限制沒勾到 |
| 地圖空白、console 出現 `RefererNotAllowedMapError` | Key A 的 HTTP referrer 沒加上正式網址 |
| `/api/*` 回 404 | v2 function 必須在 `us-central1`（`setGlobalOptions` 已設好，別改） |
| 推播沒橫幅 | VAPID key 沒填，或 `firebase-messaging-sw.js` 不在 `public` 根目錄 |
| `decide` 回 `rule-based-fallback` | Vertex AI API 沒啟用，或服務帳號缺 `roles/aiplatform.user`：<br>`gcloud projects add-iam-policy-binding 專案ID --member="serviceAccount:專案ID@appspot.gserviceaccount.com" --role="roles/aiplatform.user"` |
| 部署時 Node 版本警告 | `functions/package.json` 的 `engines.node` 目前是 `22` |
| 想先給評審看但不想動正式站 | `firebase hosting:channel:deploy demo` 產生有效期 7 天的預覽網址 |

---

## 更新已部署的版本

第一次部署完成後，之後改程式碼只要挑對應的指令重跑。**不需要**重做步驟一到八。

| 你改了什麼 | 跑這個 | 大約耗時 |
| --- | --- | --- |
| `public/` 底下任何東西（HTML / CSS / app.js / config.js / 網格資料） | `npm run deploy:web` | 10–30 秒 |
| `functions/` 底下任何東西（含 `.env`） | `npm run deploy:api` | 1–3 分鐘 |
| 兩邊都改，或不確定 | `npm run deploy` | 1–3 分鐘 |
| 想先給人看但不動正式站 | `npm run deploy:preview` | 10–30 秒 |

```bash
npm test              # 改了 functions 先跑，94 項離線測試
npm run deploy:api    # 再部署
```

### 幾個容易忘的點

- **`functions/.env` 改了也要 `deploy:api`**。`.env` 是跟著 function 一起上傳的，
  只改本機檔案對線上沒有任何影響。
- **改了 LST 網格要部署兩邊**。`taipei_lst_grid.geojson` 在
  `public/data/`（給地圖圖層）與 `functions/data/`（給路線評分）各有一份，
  `verify_lst_grid.js --install` 會同時更新兩份，所以要跑 `npm run deploy`。
- **看不到改動先強制重新整理**。Hosting 有 CDN 快取、瀏覽器也有自己的快取，
  Mac 上是 <kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>R</kbd>。
  Service Worker（`firebase-messaging-sw.js`）已經設成 `no-cache`，
  但改了它之後最好順手關掉分頁再開，讓舊的 SW 退場。
- **只想回上一版**：Firebase Console → Hosting → 版本清單 → 對舊版按「復原」，
  不用重跑指令。Functions 沒有一鍵回滾，要 `git revert` 後重新部署。

### 部署前的習慣動作

```bash
npm test          # functions 有改就跑
npm run preflight # 確認設定沒有掉東西
npm run dev       # 本機開 http://localhost:5050 看一眼
```

`npm run deploy` 已經內建 preflight，沒過就不會部署。
