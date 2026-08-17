/**
 * Gemini 後端選擇與請求組裝的測試（不連網、不需要 ADC 也不需要 API key）
 *   node functions/test/gemini.test.js
 */

const assert = require('assert');
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

/** 每個案例都在乾淨的環境變數下跑，避免互相污染 */
function withEnv(vars, fn) {
  const keys = ['GEMINI_API_KEY', 'GEMINI_BACKEND', 'GEMINI_PROJECT_ID', 'GEMINI_LOCATION', 'GEMINI_MODEL'];
  const saved = {};
  for (const k of keys) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  Object.assign(process.env, vars);
  try {
    return fn();
  } finally {
    for (const k of keys) {
      delete process.env[k];
      if (saved[k] !== undefined) process.env[k] = saved[k];
    }
  }
}

const sampleRisk = { level: 'high', feelsLike: 41.2, airTemp: 34.5, humidity: 72, uvi: 9, surfaceTemp: 42.1 };
const sampleRoutes = [
  { label: 'coolest', durationSec: 2100, distanceM: 13400, heatScore: 38.4, maxSurfaceTemp: 42.1, samplePoints: 268 },
  { label: 'fastest', durationSec: 1800, distanceM: 11200, heatScore: 44.2, maxSurfaceTemp: 47.0, samplePoints: 224 },
];

const build = (opts) =>
  agent.buildGeminiRequest({
    model: 'gemini-2.5-flash',
    location: 'global',
    risk: sampleRisk,
    routes: sampleRoutes,
    ...opts,
  });

console.log('\n後端選擇');

t('沒有 API key 時預設走 vertex（用 ADC）', () => {
  withEnv({}, () => assert.strictEqual(agent.geminiBackend(), 'vertex'));
});

t('設了 GEMINI_API_KEY 就自動改走 aistudio', () => {
  withEnv({ GEMINI_API_KEY: 'x' }, () => assert.strictEqual(agent.geminiBackend(), 'aistudio'));
});

t('GEMINI_BACKEND 可以強制指定，蓋過自動判斷', () => {
  withEnv({ GEMINI_API_KEY: 'x', GEMINI_BACKEND: 'vertex' }, () =>
    assert.strictEqual(agent.geminiBackend(), 'vertex')
  );
  withEnv({ GEMINI_BACKEND: 'aistudio' }, () =>
    assert.strictEqual(agent.geminiBackend(), 'aistudio')
  );
});

t('無法辨識的 GEMINI_BACKEND 值退回自動判斷', () => {
  withEnv({ GEMINI_BACKEND: '亂填' }, () => assert.strictEqual(agent.geminiBackend(), 'vertex'));
});

console.log('\nVertex endpoint');

t('global 位置沒有區域前綴', () => {
  assert.strictEqual(
    agent.vertexEndpoint('coolpath-demo', 'global', 'gemini-2.5-flash'),
    'https://aiplatform.googleapis.com/v1/projects/coolpath-demo/locations/global' +
      '/publishers/google/models/gemini-2.5-flash:generateContent'
  );
});

t('區域位置要加區域前綴', () => {
  const u = agent.vertexEndpoint('coolpath-demo', 'asia-east1', 'gemini-2.5-flash');
  assert.ok(u.startsWith('https://asia-east1-aiplatform.googleapis.com/v1/'), u);
  assert.ok(u.includes('/locations/asia-east1/'), u);
});

console.log('\n請求組裝 —— vertex（ADC）');

t('打到 Vertex，且不帶任何 API key 標頭', () => {
  const r = build({ backend: 'vertex', projectId: 'coolpath-demo' });
  assert.ok(r.url.includes('aiplatform.googleapis.com'), r.url);
  assert.ok(!('x-goog-api-key' in r.headers), '不該出現 x-goog-api-key');
  assert.ok(!r.url.includes('key='), 'URL 不該帶 key');
  assert.strictEqual(r.headers['Content-Type'], 'application/json');
});

t('Authorization 不在這層組（由 callGemini 帶入 ADC token）', () => {
  const r = build({ backend: 'vertex', projectId: 'coolpath-demo' });
  assert.ok(!('Authorization' in r.headers));
});

t('取不到專案 ID 時給出可行動的錯誤訊息', () => {
  assert.throws(
    () => build({ backend: 'vertex', projectId: null }),
    (err) => /專案 ID/.test(err.message) && /GEMINI_API_KEY|GCLOUD_PROJECT/.test(err.message)
  );
});

console.log('\n請求組裝 —— aistudio（API key）');

t('打到 generativelanguage，且用 x-goog-api-key 標頭', () => {
  const r = build({ backend: 'aistudio', apiKey: 'test-key' });
  assert.ok(r.url.includes('generativelanguage.googleapis.com'), r.url);
  assert.strictEqual(r.headers['x-goog-api-key'], 'test-key');
});

t('沒有 key 就丟錯，不會靜靜地送出未認證請求', () => {
  assert.throws(() => build({ backend: 'aistudio', apiKey: undefined }), /GEMINI_API_KEY/);
});

t('API key 只放在標頭，不放在 URL（避免被記進 log）', () => {
  const r = build({ backend: 'aistudio', apiKey: 'test-key' });
  assert.ok(!r.url.includes('test-key'), r.url);
});

console.log('\n兩條路的 body 必須一致');

t('body 內容與後端無關', () => {
  const v = build({ backend: 'vertex', projectId: 'p' });
  const a = build({ backend: 'aistudio', apiKey: 'k' });
  assert.deepStrictEqual(v.body, a.body);
});

t('body 帶了 system prompt、實際數值與 JSON 輸出設定', () => {
  const r = build({ backend: 'vertex', projectId: 'p' });
  assert.ok(r.body.systemInstruction.parts[0].text.includes('決策'));
  const prompt = r.body.contents[0].parts[0].text;
  assert.ok(prompt.includes('41.2') && prompt.includes('38.4') && prompt.includes('44.2'));
  assert.strictEqual(r.body.generationConfig.responseMimeType, 'application/json');
  assert.strictEqual(r.body.generationConfig.thinkingConfig.thinkingBudget, 0);
});

console.log(`\n${pass} 項通過${process.exitCode ? '，有失敗項目' : '，全數通過'}\n`);
