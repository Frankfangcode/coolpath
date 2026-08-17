# 涼路 CoolPath — 熱暴露評估引擎

核心產品是 `/api/coolRoute`：輸入起點終點，回傳多條路線及其熱暴露分數。
網站只是這支 API 的第一個客戶端，導航整段交給 Google Maps。

```
GET /api/coolRoute?origin=24.9874,121.5759&destination=25.0488,121.5137&mode=driving
```

---

## 專案結構

```
/
├── firebase.json
├── public/
│   ├── index.html
│   ├── app.js                       # 純 vanilla JS，無框架無 build
│   ├── style.css
│   ├── config.js                    # ⚠️ 部署前要填 API key
│   ├── icon.png
│   ├── firebase-messaging-sw.js     # 必須在 public 根目錄，否則 scope 不對
│   └── data/taipei_lst_grid.geojson
├── functions/
│   ├── index.js                     # 四支 HTTP function
│   ├── lst.js                       # LST 查詢共用模組
│   ├── geo.js                       # polyline 解碼與沿線取樣
│   ├── risk.js                      # Heat Index、風險分級、氣象/UVI 取得
│   ├── agent.js                     # Gemini prompt、fallback、輸出修正
│   ├── http.js                      # 逾時 fetch、參數解析等共用工具
│   ├── data/taipei_lst_grid.geojson # 同一份，functions 端也要
│   ├── test/                        # 88 項離線測試，不需要任何 key
│   └── package.json
└── tools/
    ├── dev_server.js                # 本機開發伺服器，免 firebase-tools 免 key
    ├── earthengine_lst_export.js    # EE 匯出腳本（含匯出前六項檢查）
    ├── verify_lst_grid.js           # 匯出後驗證 + 安裝到兩個 data 目錄
    └── make_placeholder_grid.js     # 產生佔位網格用
```

---

## 隨時知道還差什麼

```bash
npm run preflight          # 檢查每項設定，並列出各自卡住哪個功能
npm run preflight -- --live   # 實際打每支 API，驗證 key 真的能用
```

「有填」不等於「能用」—— key 打錯、API 沒啟用、金鑰限制設錯，都是填了但會失敗。
**上台前至少跑一次 `--live`。**

---

## 一、先做這三件事

### 1. 填 API key

`functions/.env`（複製 `.env.example`）：

```
GOOGLE_MAPS_API_KEY=   # Google Cloud Console，需啟用 Routes API
CWA_API_KEY=           # https://opendata.cwa.gov.tw/
MOENV_API_KEY=         # https://data.moenv.gov.tw/
```

**Gemini 不需要 API key**，走 Vertex AI + Application Default Credentials：

```bash
gcloud services enable aiplatform.googleapis.com
gcloud projects add-iam-policy-binding 專案ID \
  --member="serviceAccount:專案ID@appspot.gserviceaccount.com" \
  --role="roles/aiplatform.user"
gcloud auth application-default login   # 只有本機開發需要
```

部署到 Cloud Functions 後 ADC 是自動的（執行服務帳號自帶），`.env` 這區塊留空即可。
沒有 GCP 專案權限時，填 `GEMINI_API_KEY` 就會自動改走 AI Studio；
`GEMINI_BACKEND=vertex|aistudio` 可以強制指定。

`public/config.js`：`mapsApiKey`（需啟用 Maps JavaScript API）、`firebase`、`vapidKey`。
VAPID key 在 Firebase Console → 專案設定 → Cloud Messaging → Web Push certificates → Generate key pair。

`.firebaserc` 的專案名目前是 `coolpath-demo`，改成實際的專案 ID。

### 2. 換掉佔位地表溫度資料 ⚠️

**目前 repo 裡的 `taipei_lst_grid.geojson` 是合成的佔位資料，不是 Landsat 觀測值。**
它只是為了讓整條 pipeline 在真資料到位前能跑起來。覆蓋全台本島
（雙解析度：大台北 200m、其餘 1.1km，`lst.js` 搜尋半徑 800m 配合粗網格），
所以全台任何路線都能算熱暴露分數 —— 但數值是合成的，僅供流程展示。

### 全台「最新可用」Landsat LST

Landsat 不能提供真正即時溫度。Landsat 8 與 9 合併後名義重訪約 8 天，實際還會受
雲層與 Level-2 處理延遲影響。產品文案應使用「最新可用衛星觀測」，並同時顯示
拍攝日期或 `age_days`，不要寫成「即時 LST」。

`tools/earthengine_taiwan_latest_lst.js` 會從最近 48 天的 Landsat 8/9 Level-2
資料中，逐像元選最新一筆無雲 `ST_B10`，並輸出 `LST` 與 `age_days` 兩個 band。

全台資料不要匯出成 GeoJSON：100m 網格會有數百萬像元，瀏覽器無法一次載入。
建議架構：

1. Earth Engine 每日排程產生 Cloud Optimized GeoTIFF（COG）。
2. 地圖圖層使用 Earth Engine Map ID 或 COG tile server，以 `{z}/{x}/{y}` 圖磚載入。
3. 後端路線評分按路線取樣座標查 raster／Earth Engine，不下載整個全台資料集。
4. 回應中附上每條路線的覆蓋率及最舊 `age_days`；覆蓋不足 80% 時不比較熱暴露。
5. 即時氣溫與濕度仍使用中央氣象署；衛星 LST 只代表最近一次晴空過境的地表溫度。

快速開始：把新腳本貼到 Earth Engine Code Editor，確認場景日期、LST 範圍與
`age_days` 後，將 `YOUR_BUCKET_NAME` 換成自己的 Cloud Storage bucket，再執行
Export task。正式服務應使用 Earth Engine-enabled Google Cloud project 與 ADC
或服務帳號，私鑰不得放入前端或版本庫。

**步驟一：匯出前先在 EE Console 驗證。**
把 `tools/earthengine_lst_export.js` 貼到 https://code.earthengine.google.com。
它在 `Export` 之前會先印出六項檢查（影像數量、數值範圍、覆蓋率、都市熱島、
分布形狀、網格點數），每項都寫了合格標準。**六項都合格再去 Tasks 分頁按 RUN** ——
匯出要跑十幾二十分鐘，先驗完可以省掉一輪來回。

其中最重要的是**檢查 4 都市熱島**：台北車站要明顯比陽明山熱 5 度以上。
如果市區反而比山區涼，資料就是壞的，不要匯出。

**步驟二：匯出後驗證檔案，通過才安裝。**

```bash
node tools/verify_lst_grid.js ~/Downloads/taipei_lst_grid.geojson
node tools/verify_lst_grid.js ~/Downloads/taipei_lst_grid.geojson --install
cd functions && npm test
```

驗證器檢查十項，重點是那些**安靜壞掉**的失敗模式 —— 經緯度顛倒、忘了減 273.15、
雲遮罩吃掉半個台北。這些程式都不會報錯，只會讓 `heatScore` 全變 null 或一堆假數字，
然後你在台上才發現。每一項不合格都附了對應的修法。

`--install` 會在全部合格後才複製到 `public/data/` 與 `functions/data/` 兩邊。

佔位檔裡有 `"_placeholder": true`，程式偵測到就會：

- `/api/coolRoute` 的 `meta.lstSource` 回 `PLACEHOLDER_SYNTHETIC`（真資料是 `LANDSAT_8_9_SUMMER_MEDIAN`）
- 網頁最上方跳出紅色警告條

**換上真資料後這兩個警告會自動消失。上台前務必確認警告條不在。**

### 3. 部署

```bash
npm install -g firebase-tools
firebase login
cd functions && npm install && cd ..
firebase deploy
```

---

## 二、本機開發

```bash
npm run dev          # http://localhost:5050，不需要 firebase-tools、不需要任何 key
```

它靜態服務 `public/`，並把 `/api/*` 導到 `functions/index.js` 裡真正的 handler
（等同 `firebase.json` 的 rewrites，所以前端相對路徑照樣同源、沒有 CORS）。
啟動時會列出目前每一項是走真資料還是降級路徑。

**缺 key 時的降級行為：**

| 缺什麼 | 結果 |
| --- | --- |
| `GOOGLE_MAPS_API_KEY` | 只有「向 Routes API 要路線」這一步換成本機假路線；解碼、每 50m 取樣、查 LST、標 label、產 mapsUrl、排序全部是真程式碼跑真資料。key 設了就自動改打真的，不必改任何檔案 |
| `public/config.js` 的 `mapsApiKey` | 地圖圖磚不顯示，其餘畫面與 API 正常 |
| `CWA_API_KEY` / `MOENV_API_KEY` | `assessRisk` 用預設值，`meta.usedDefaults` 會標明 |
| ADC | `decide` 走規則式 fallback，`meta.source` 會標明 |

⚠️ 假路線不是真實道路幾何，只供本機開發，不可用於對外展示。
另外目前 LST 是合成佔位資料，兩條路廊的溫差只有 0.8 度；換上真 Landsat 後對比才會拉開。

想要跟正式環境完全一致（含 FCM、Firestore），才需要裝 firebase-tools：

```bash
npm install -g firebase-tools
firebase emulators:start --only functions,hosting
```

推播與定位需要 HTTPS，`localhost` 之外測不出完整行為，這部分要等部署上去才驗得了。

---

## 三、驗證清單（照 Demo 腳本走一遍）

- [ ] `https://專案名.web.app/api/coolRoute?origin=24.9874,121.5759&destination=25.0488,121.5137`
      在瀏覽器直接打開看得到乾淨 JSON ← **第 6 步，證明「我們是引擎不是 App」的關鍵**
- [ ] 網頁預設政大 → 台北車站，按「尋找涼爽路線」出現兩條路線，綠色最涼、藍色最快
- [ ] 對比卡片顯示「多花 N 分鐘，沿線平均地表溫度低 N 度」
- [ ] **點「用 Google Maps 導航」，確認 Google 重現的路線與我們算的最涼路線吻合**
      偏掉的話把 `functions/index.js` 的 `WAYPOINT_COUNT` 從 5 往上加（上限 9）再部署
- [ ] 手機掃 QR 開啟，確認 HTTPS、定位、語音都正常（localhost 測不出完整行為）
- [ ] 點「開始」→ 授權推播 → 按「一鍵示範」→ 橫幅蓋在 Google Maps 上
- [ ] 紅色佔位資料警告條**沒有**出現
- [ ] 明早推 preview channel 當備案：`firebase hosting:channel:deploy demo`

沒有後端也想看畫面：網址加 `?mock=1`，畫面會標明是示範假資料。

---

## 四、API

### `GET|POST /api/coolRoute`

`origin`、`destination` 可填 `lat,lng` 座標，也可直接填地名或地址（交給 Routes API
地理編碼，`regionCode=TW` 偏向台灣）；`mode` 支援 `driving` / `scooter` /
`walking` / `bicycling`（API 預設 `driving`；前端 TA 是行人與機車騎士，
預設 `scooter`，機車以汽車路線近似）。回應的 `query.resolved` 會回填實際
起訖座標，前端拿它更新環境風險列。

回傳是帶 `meta` 的物件而非裸陣列（`routes` 欄位才是 `RouteOption[]`），
這樣才能把資料來源與免責聲明一起帶出去，直接投影也看得懂：

```json
{
  "ok": true,
  "meta": {
    "lstSource": "LANDSAT_8_9_SUMMER_MEDIAN",
    "lstLabel": "夏季平均地表溫度（Landsat 8/9 熱紅外，100m 網格，2023–2026 夏季中位數）",
    "lstDisclaimer": "非即時溫度。Landsat 過境時間約上午 10:30…",
    "sampleIntervalM": 50,
    "sameRouteIsBoth": false
  },
  "comparison": { "extraMinutes": 5, "tempDelta": 5.8, "summary": "…" },
  "routes": [ { "polyline": "…", "heatScore": 38.4, "label": "coolest", "mapsUrl": "…" } ]
}
```

`label` 除了 `coolest` / `fastest`，第三條以後是 `alternative`。
最涼與最快是同一條時，該條標 `coolest`，並由 `meta.sameRouteIsBoth` 告知前端。

### `GET|POST /api/assessRisk`

`lat`、`lng`（預設台北車站），全台任何座標皆可。回傳 `RiskAssessment`，另有
`meta.degraded` / `meta.usedCache` / `meta.usedDefaults` 標示這次資料是實時取得、
讀快取、還是用了預設值。

資料來源（全台適用）：

- **體感溫度**：CWA 鄉鎮預報 `F-D0047-089`（新版 API 為 22 縣市層級，第一天逐時）
  的「體感溫度」欄位，挑距離最近的縣市、時間最近的時段；模組層快取 30 分鐘。
  抓不到時退回由測站氣溫濕度計算的 NOAA Heat Index，`meta.feelsLikeSource` 標明
  是 `CWA_FORECAST` 還是 `NOAA_HEAT_INDEX`。
- **氣溫／濕度**：`O-A0001-001`（自動站約 500 站）＋ `O-A0003-001`（局屬站）合併
  取最近有效測站。
- **UVI**：環境部 `uv_s_01` 挑距離最近的測站。

### `POST /api/decide`

Body `{ risk, routes }`，回傳 `AgentDecision`。`meta.source` 是 `gemini` 或 `rule-based-fallback`。

### `POST /api/notify`

`{ title, body, speech }` 送推播；`{ registerOnly: true, token }` 只註冊 FCM token 到
`users/demo_user`。（指令包原本沒有這支，但 Demo 第 5 步需要有人送推播，所以補上，
`firebase.json` 也多一條對應的 rewrite。）

---

## 五、測試

```bash
cd functions && npm test        # 88 項單元/整合測試
npm run verify:lst              # 檢查目前安裝的 LST 網格
```

88 項，全部離線執行，不需要 API key 也不需要 ADC、不會打到外部服務。coolRoute 的測試把
Routes API 換成假回應，驗證解碼 → 取樣 → 查 LST → 標 label → 產 mapsUrl → 排序整條流程，
其中包含「中繼點確實落在該條路線上」（誤差 < 1 公尺，這是 Google 能不能重現路線的前提）。

`risk.test.js` 把誠實性守則也寫成測試：規則式輸出不得出現「即時地表溫度」等禁語、
不得建議含糖飲料、`level` 為 `low` 時 `shouldNotify` 必須為 `false`。

---

## 六、兩個要知道的落差

**① 契約範例的 feelsLike 與 NOAA 公式對不起來。**
指令包契約寫 `airTemp 34.5 / humidity 72 → feelsLike 41.2`，但 NOAA Heat Index
對這組輸入算出來是 **49.6°C**（已對過 NOAA 官方對照表，全表誤差 < 3°F）。
41.2 比較接近澳洲式 Apparent Temperature。指令包明文要求 NOAA Heat Index。

**→ 產品決策（2026-08-17）：體感溫度改以 CWA 鄉鎮預報 `F-D0047-089` 的
「體感溫度」為主**（CWA 用自己的體感公式，數值與 41.2 那種量級一致），
NOAA Heat Index 保留為預報抓不到時的 fallback。`meta.feelsLikeSource` 誠實標明
本次用的是哪個來源，兩種數值不混用。

**② NOAA fallback 生效時，夏季 level 幾乎恆為 high。**
34°C / 70% 的 NOAA HI 是 48.5°C，遠超「體感 > 36 判 high」的門檻；CWA 預報值
一般低於 NOAA HI，但夏季白天也常超過 36。台上想展示「系統判斷不打擾使用者
（shouldNotify = false）」這個賣點，真實天氣不一定給你機會 —— 保險做法仍是
用涼爽情境的假 `risk` 打 `/api/decide`。

---

## 七、卡點速查

| 症狀 | 原因 |
| --- | --- |
| LST 查詢全回 null | GeoJSON 沒複製到 `functions/data/`，或經緯度顛倒（GeoJSON 是 `[lng, lat]`） |
| 定位一直失敗 | 沒跑在 HTTPS 上（localhost 除外） |
| Service Worker 註冊失敗 | `firebase-messaging-sw.js` 不在 `public` 根目錄 |
| 語音第一次不出聲 | Chrome 需使用者手勢解鎖，用「開始」按鈕觸發 |
| 語音數字讀錯 | `speech` 欄位要用國字，`agent.js` 的 `toChineseNumber` 負責 |
| 地圖嚴重卡頓 | 一次渲染太多格點；`app.js` 已限制只畫視野內且上限 2000 點 |
| fetch 被 CORS 擋 | 沒用 `/api/` 相對路徑，或 rewrites 沒設 |
| 推播沒有橫幅 | payload 缺 `notification` 區塊，或未設高優先級 |
| Google Maps 跳轉後路線不對 | 中繼點太少，調高 `WAYPOINT_COUNT` |
| hosting rewrite 打不到 function | v2 function 必須在 `us-central1`，見 `setGlobalOptions` |
| decide 回 `rule-based-fallback` 且錯誤提到 ADC | 沒啟用 `aiplatform.googleapis.com`，或服務帳號缺 `roles/aiplatform.user`；本機是沒跑 `gcloud auth application-default login` |
| Vertex 回 404 model not found | 該 `GEMINI_LOCATION` 沒有這個模型，改回 `global` |
