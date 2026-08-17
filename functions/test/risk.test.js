/**
 * 風險計算與判斷層的純函式測試（不需要 API key）
 *   node functions/test/risk.test.js
 *
 * 這裡順便把「誠實性守則」寫成測試：規則式 decision 的輸出不可以出現
 * 「即時溫度」這類說法，也不可以建議含糖飲料。
 */

const assert = require('assert');
const risk = require('../risk');
const agent = require('../agent');

let pass = 0;
function t(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    pass++;
  } catch (err) {
    console.error(`  ✗ ${name}\n    ${err.message}`);
    process.exitCode = 1;
  }
}

console.log('\nrisk.js —— Heat Index 體感溫度');

t('NOAA 對照表：32.2°C / 70% ≈ 40.6°C（誤差 1 度內）', () => {
  const hi = risk.heatIndexC(32.2, 70);
  assert.ok(Math.abs(hi - 40.6) < 1.0, `算出 ${hi}`);
});

t('NOAA 對照表：35°C / 50% ≈ 41.1°C（誤差 1 度內）', () => {
  const hi = risk.heatIndexC(35, 50);
  assert.ok(Math.abs(hi - 41.1) < 1.0, `算出 ${hi}`);
});

t('NOAA 對照表：37.8°C / 60%（100°F/60%）= 129°F ≈ 53.9°C', () => {
  const hi = risk.heatIndexC(37.8, 60);
  assert.ok(Math.abs(hi - 53.9) < 1.0, `算出 ${hi}`);
});

t('整條 NOAA 對照表誤差都在 3°F 內', () => {
  const F = (c) => (c * 9) / 5 + 32;
  const C = (f) => ((f - 32) * 5) / 9;
  const chart = {
    85: { 40: 85, 50: 86, 60: 88, 70: 90, 80: 97 },
    90: { 40: 91, 50: 95, 60: 100, 70: 106, 80: 113 },
    95: { 40: 101, 50: 107, 60: 114, 70: 124 },
    100: { 40: 109, 50: 118, 60: 129 },
  };
  for (const tf of Object.keys(chart)) {
    for (const rh of Object.keys(chart[tf])) {
      const mine = F(risk.heatIndexC(C(Number(tf)), Number(rh)));
      const official = chart[tf][rh];
      assert.ok(
        Math.abs(mine - official) < 3,
        `${tf}°F/${rh}%：官方 ${official}°F，本實作 ${mine.toFixed(1)}°F`
      );
    }
  }
});

t('涼爽時體感接近氣溫', () => {
  const hi = risk.heatIndexC(24, 50);
  assert.ok(Math.abs(hi - 24) < 2, `算出 ${hi}`);
});

t('同溫度下濕度越高體感越高', () => {
  assert.ok(risk.heatIndexC(34, 80) > risk.heatIndexC(34, 40));
});

/**
 * ⚠️ 已知落差，記錄在此避免之後有人「修」錯方向：
 * 指令包的資料契約範例寫 airTemp 34.5 / humidity 72 → feelsLike 41.2，
 * 但 NOAA Heat Index 對這組輸入算出來是 49.6°C。41.2 比較接近澳洲式
 * Apparent Temperature（含風速修正），不是 NOAA HI。
 * 指令包明文要求「NOAA Heat Index 公式（攝氏版）」，所以以公式為準，
 * 契約範例當作欄位格式示意即可。
 */
t('指令包契約範例的 34.5°C / 72%，NOAA HI 實際是 49.6 度（非契約寫的 41.2）', () => {
  const hi = risk.heatIndexC(34.5, 72);
  assert.ok(Math.abs(hi - 49.6) < 0.5, `算出 ${hi}`);
});

t('台北夏季典型值在 NOAA HI 下必然落在 high（Demo 要展示 low 得自己調參數）', () => {
  // 這條測試是在記錄產品後果，不是在驗證公式：
  // 34°C / 70% 的體感 48.5 度 > 36，門檻表會直接判 high，
  // 因此夏季實測時 shouldNotify 幾乎恆為 true。
  const hi = risk.heatIndexC(34, 70);
  assert.ok(hi > 36, `算出 ${hi}`);
  assert.strictEqual(risk.classifyLevel(hi, 9, 44), 'high');
  // 要在台上展示「系統決定不打擾」，得用涼爽情境
  assert.strictEqual(risk.classifyLevel(risk.heatIndexC(26, 55), 4, 33), 'low');
});

console.log('\nrisk.js —— 風險分級門檻');

t('low：體感 < 32 且 UVI < 6', () => {
  assert.strictEqual(risk.classifyLevel(30, 5, 35), 'low');
  assert.strictEqual(risk.classifyLevel(28, 3, 38), 'low');
});

t('medium：體感 32–36 或 UVI 6–7', () => {
  assert.strictEqual(risk.classifyLevel(33, 4, 35), 'medium');
  assert.strictEqual(risk.classifyLevel(30, 7, 35), 'medium');
  assert.strictEqual(risk.classifyLevel(36, 5, 40), 'medium');
});

t('high：體感 > 36', () => {
  assert.strictEqual(risk.classifyLevel(37, 3, 30), 'high');
});

t('high：UVI >= 8', () => {
  assert.strictEqual(risk.classifyLevel(28, 8, 30), 'high');
  assert.strictEqual(risk.classifyLevel(20, 11, 28), 'high');
});

t('high：路線最高地表溫度 > 40（即使體感與 UVI 都低）', () => {
  assert.strictEqual(risk.classifyLevel(28, 3, 44), 'high');
});

t('地表溫度剛好 40 不算 high（門檻是嚴格大於）', () => {
  assert.strictEqual(risk.classifyLevel(28, 3, 40), 'low');
});

t('maxSurfaceTemp 為 undefined 時不影響判定', () => {
  assert.strictEqual(risk.classifyLevel(30, 5, undefined), 'low');
  assert.strictEqual(risk.classifyLevel(30, 5, null), 'low');
});

console.log('\nagent.js —— 數字轉國字（避免 TTS 讀錯）');

t('整數', () => {
  assert.strictEqual(agent.toChineseNumber(5), '五');
  assert.strictEqual(agent.toChineseNumber(10), '十');
  assert.strictEqual(agent.toChineseNumber(15), '十五');
  assert.strictEqual(agent.toChineseNumber(42), '四十二');
  assert.strictEqual(agent.toChineseNumber(30), '三十');
});

t('小數點後逐字唸', () => {
  assert.strictEqual(agent.toChineseNumber(5.8), '五點八');
  assert.strictEqual(agent.toChineseNumber(41.2), '四十一點二');
});

console.log('\nagent.js —— JSON 解析（模型不聽話時的防線）');

t('剝掉 ```json 圍欄', () => {
  const o = agent.extractJson('```json\n{"level":"high","shouldNotify":true}\n```');
  assert.strictEqual(o.level, 'high');
});

t('剝掉沒有標明語言的圍欄', () => {
  assert.strictEqual(agent.extractJson('```\n{"a":1}\n```').a, 1);
});

t('前後有多餘文字也抓得出 JSON', () => {
  const o = agent.extractJson('好的，以下是結果：\n{"level":"low"}\n希望有幫助！');
  assert.strictEqual(o.level, 'low');
});

t('乾淨 JSON 直接吃', () => {
  assert.strictEqual(agent.extractJson('{"level":"medium"}').level, 'medium');
});

t('完全不是 JSON 時丟例外（讓上層走 fallback）', () => {
  assert.throws(() => agent.extractJson('抱歉，我無法回答'));
  assert.throws(() => agent.extractJson(''));
});

console.log('\nagent.js —— 規則式 fallback 與輸出修正');

const sampleRisk = { level: 'high', feelsLike: 41.2, airTemp: 34.5, humidity: 72, uvi: 9, surfaceTemp: 42.1 };
const sampleRoutes = [
  { label: 'coolest', durationSec: 2100, distanceM: 13400, heatScore: 38.4, maxSurfaceTemp: 42.1, samplePoints: 268 },
  { label: 'fastest', durationSec: 1800, distanceM: 11200, heatScore: 44.2, maxSurfaceTemp: 47.0, samplePoints: 224 },
];

t('fallback 具備資料契約的全部欄位', () => {
  const d = agent.fallbackDecision(sampleRisk, sampleRoutes);
  for (const k of ['level', 'shouldNotify', 'headline', 'action', 'reason', 'speech']) {
    assert.ok(k in d, `缺欄位 ${k}`);
  }
});

t('fallback 的 action 含具體數字，不是空話', () => {
  const d = agent.fallbackDecision(sampleRisk, sampleRoutes);
  assert.ok(/\d/.test(d.action), `action 沒有數字：${d.action}`);
  assert.ok(!/請多加注意|注意防曬|請小心/.test(d.action), `action 是空話：${d.action}`);
  assert.ok(d.action.includes('5'), `應該要講多花 5 分鐘：${d.action}`);
  assert.ok(d.action.includes('38.4') && d.action.includes('44.2'), `應該要有溫度數字：${d.action}`);
});

t('level 為 low 時 shouldNotify 必須為 false（不打擾使用者）', () => {
  const lowRisk = { ...sampleRisk, level: 'low', feelsLike: 29, uvi: 4 };
  const d = agent.fallbackDecision(lowRisk, sampleRoutes);
  assert.strictEqual(d.shouldNotify, false);
});

t('level 為 high / medium 時 shouldNotify 為 true', () => {
  assert.strictEqual(agent.fallbackDecision(sampleRisk, sampleRoutes).shouldNotify, true);
  assert.strictEqual(
    agent.fallbackDecision({ ...sampleRisk, level: 'medium' }, sampleRoutes).shouldNotify,
    true
  );
});

t('speech 在 30 字內且數字用國字', () => {
  const d = agent.fallbackDecision(sampleRisk, sampleRoutes);
  assert.ok(d.speech.length <= 30, `${d.speech.length} 字：${d.speech}`);
  assert.ok(!/\d/.test(d.speech), `speech 出現阿拉伯數字：${d.speech}`);
});

t('只有一條路線時不會炸掉，且輸出仍然具體', () => {
  const d = agent.fallbackDecision(sampleRisk, [sampleRoutes[0]]);
  assert.ok(d.headline && d.action && d.speech);
  assert.ok(/\d/.test(d.action));
});

t('空路線陣列不會炸掉', () => {
  const d = agent.fallbackDecision(sampleRisk, []);
  assert.ok(d.headline && d.speech);
});

console.log('\n誠實性守則 —— 輸出文案檢查');

const FORBIDDEN = ['即時地表溫度', '現在的溫度', '目前地表溫度', '紫外線路線規劃', '精準到每一公尺'];
const SUGAR = ['含糖', '汽水', '可樂', '奶茶', '果汁'];

t('規則式輸出不含被禁止的說法', () => {
  const cases = [
    agent.fallbackDecision(sampleRisk, sampleRoutes),
    agent.fallbackDecision({ ...sampleRisk, level: 'low' }, sampleRoutes),
    agent.fallbackDecision(sampleRisk, [sampleRoutes[0]]),
  ];
  for (const d of cases) {
    const all = [d.headline, d.action, d.reason, d.speech].join(' ');
    for (const w of FORBIDDEN) assert.ok(!all.includes(w), `出現禁語「${w}」：${all}`);
    for (const w of SUGAR) assert.ok(!all.includes(w), `建議了含糖飲料「${w}」：${all}`);
  }
});

t('補水建議只提白開水或電解質飲料', () => {
  const d = agent.fallbackDecision(sampleRisk, [sampleRoutes[0]]);
  const all = [d.headline, d.action, d.reason, d.speech].join(' ');
  if (/水|飲/.test(all)) {
    assert.ok(/白開水|電解質/.test(all), `提到補水卻沒指明種類：${all}`);
  }
});

t('system prompt 有把誠實性守則寫進去', () => {
  const p = agent.SYSTEM_PROMPT;
  assert.ok(p.includes('夏季平均地表溫度'), '缺少地表溫度性質說明');
  assert.ok(p.includes('即時'), '缺少「不可宣稱即時」的規則');
  assert.ok(p.includes('白開水') && p.includes('電解質'), '缺少補水限制');
  assert.ok(p.includes('shouldNotify'), '缺少不打擾規則');
  assert.ok(p.includes('國字'), '缺少 speech 數字用國字的規則');
});

console.log('\nagent.js —— normalizeDecision 把模型輸出拉回契約');

t('模型在 low 卻設 shouldNotify=true 時強制改回 false', () => {
  const lowRisk = { ...sampleRisk, level: 'low' };
  const d = agent.normalizeDecision(
    { level: 'low', shouldNotify: true, headline: 'x', action: 'y', reason: 'z', speech: 'w' },
    lowRisk,
    sampleRoutes
  );
  assert.strictEqual(d.shouldNotify, false);
});

t('模型漏欄位時用 fallback 補齊', () => {
  const d = agent.normalizeDecision({ level: 'high' }, sampleRisk, sampleRoutes);
  assert.ok(d.headline && d.action && d.reason && d.speech);
  assert.ok(/\d/.test(d.action), 'action 補上來的內容要含數字');
});

t('模型給出無效 level 時退回規則判定的等級', () => {
  const d = agent.normalizeDecision({ level: '非常高' }, sampleRisk, sampleRoutes);
  assert.strictEqual(d.level, 'high');
});

t('模型回空字串欄位時視為缺漏', () => {
  const d = agent.normalizeDecision(
    { level: 'high', headline: '   ', action: '', reason: null, speech: undefined },
    sampleRisk,
    sampleRoutes
  );
  assert.ok(d.headline.trim().length > 0);
  assert.ok(d.action.trim().length > 0);
});

console.log('\nagent.js —— 送給模型的 prompt');

t('prompt 帶入實際數值，模型才有東西可以引用', () => {
  const p = agent.buildUserPrompt(sampleRisk, sampleRoutes);
  assert.ok(p.includes('41.2'), '缺體感溫度');
  assert.ok(p.includes('9'), '缺 UVI');
  assert.ok(p.includes('38.4') && p.includes('44.2'), '缺路線溫度');
  assert.ok(p.includes('268'), '缺取樣點數');
  assert.ok(p.includes('多花 5 分鐘'), '缺兩條路線的差異');
});

t('prompt 標明 UVI 與路線無關', () => {
  const p = agent.buildUserPrompt(sampleRisk, sampleRoutes);
  assert.ok(/城市級/.test(p));
});

(async () => {
  console.log('\nrisk.js —— fetchFeelsLike（CWA F-D0047-089 縣市預報，離線假回應）');

  // 依照 2026-08 實測的新版 schema 造假回應：Locations[0].Location[] 為縣市
  const FAKE_FD0047 = {
    success: 'true',
    records: {
      Locations: [
        {
          LocationsName: '台灣',
          Location: [
            {
              LocationName: '臺北市',
              Latitude: '25.0375',
              Longitude: '121.5637',
              WeatherElement: [
                {
                  ElementName: '體感溫度',
                  Time: [
                    { DataTime: '2026-08-17T18:00:00+08:00', ElementValue: [{ ApparentTemperature: '38' }] },
                    { DataTime: '2026-08-17T19:00:00+08:00', ElementValue: [{ ApparentTemperature: '36' }] },
                  ],
                },
              ],
            },
            {
              LocationName: '高雄市',
              Latitude: '22.6273',
              Longitude: '120.3014',
              WeatherElement: [
                {
                  ElementName: '體感溫度',
                  Time: [
                    { DataTime: '2026-08-17T18:00:00+08:00', ElementValue: [{ ApparentTemperature: '40' }] },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  };

  const savedFetch = global.fetch;
  process.env.CWA_API_KEY = process.env.CWA_API_KEY || 'test-key';
  global.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => FAKE_FD0047,
    text: async () => '',
  });

  const now = new Date('2026-08-17T18:10:00+08:00').getTime();

  risk._clearFeelsCache();
  const taipei = await risk.fetchFeelsLike(25.04, 121.51, now);
  t('挑距離最近的縣市，取時間最接近的時段值', () => {
    assert.strictEqual(taipei.area, '臺北市');
    assert.strictEqual(taipei.feelsLike, 38); // 18:10 離 18:00 比 19:00 近
    assert.strictEqual(taipei.forecastTime, '2026-08-17T18:00:00+08:00');
  });

  const kaohsiung = await risk.fetchFeelsLike(22.63, 120.3, now);
  t('高雄座標挑到高雄市（快取共用同一份回應，不重打 API）', () => {
    assert.strictEqual(kaohsiung.area, '高雄市');
    assert.strictEqual(kaohsiung.feelsLike, 40);
  });

  let fetchCount = 0;
  global.fetch = async () => {
    fetchCount++;
    return { ok: true, status: 200, json: async () => FAKE_FD0047, text: async () => '' };
  };
  await risk.fetchFeelsLike(24.15, 120.67, now); // 30 分鐘內第三次查詢
  t('30 分鐘 TTL 內不重新抓取', () => {
    assert.strictEqual(fetchCount, 0);
  });

  global.fetch = savedFetch;
  risk._clearFeelsCache();

  console.log(`\n${pass} 項通過${process.exitCode ? '，有失敗項目' : '，全數通過'}\n`);
})();
