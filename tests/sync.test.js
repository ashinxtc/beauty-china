const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

// Separate storage and clocks model devices without contacting the live service.
function device(initialStorage = {}) {
  const storage = new Map(Object.entries(initialStorage).map(([key, value]) => [key, JSON.stringify(value)]));
  const timers = new Map();
  let now = 100;
  let timerId = 0;
  const requests = [];
  let handler = () => response(404);
  const context = {
    window: { addEventListener() {} },
    document: { visibilityState: 'visible', addEventListener() {} },
    localStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, String(value))
    },
    Date: class extends Date { static now() { return now; } },
    console: { log() {}, warn() {}, error() {} },
    alert() {},
    AbortController,
    setTimeout: (callback, delay) => {
      const id = ++timerId;
      timers.set(id, { callback, delay });
      if (delay <= 2000) queueMicrotask(() => {
        if (timers.delete(id)) callback();
      });
      return id;
    },
    clearTimeout: id => timers.delete(id),
    setInterval: () => ++timerId,
    clearInterval() {},
    fetch: async (url, options = {}) => {
      requests.push({ url, ...options });
      return handler(url, options);
    }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'sync.js'), 'utf8'), context);
  return {
    get engine() { return context.window.CloudSync; }, requests, timers,
    advance: () => { now += 100; },
    respond: fn => { handler = fn; },
    reload: () => vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'sync.js'), 'utf8'), context),
    flush: delay => {
      for (const [id, timer] of [...timers]) {
        if (timer.delay === delay && timers.delete(id)) timer.callback();
      }
    }
  };
}

function response(status, data = {}) {
  return { status, ok: status >= 200 && status < 300,
    json: async () => structuredClone(data), text: async () => JSON.stringify(data) };
}

function payload(childrenData = {}) {
  return { _app: 'beautifulChina', _syncTs: 200,
    profiles: [{ id: 'child_default', name: '大宝', avatar: '🦁' }], childrenData };
}

test('the latest answer wins instead of the older local answer', () => {
  const { engine } = device();
  const local = engine.getActiveChildData();
  local.answers.Q_0001 = 'A';
  engine.saveActiveChildData(local);
  engine.smartMerge(payload({ child_default: {
    answers: { Q_0001: 'C' }, answerUpdatedAt: { Q_0001: 200 }
  } }));
  assert.equal(engine.getActiveChildData().answers.Q_0001, 'C');
});

test('merged progress keeps the question and revision from the same device', () => {
  const { engine } = device();
  const local = engine.getActiveChildData();
  local.progressIndex.contest25 = 100;
  local.progressQuestions.contest25 = { uid: 'contest25_0101', revision: 'old' };
  engine.saveActiveChildData(local);
  engine.smartMerge(payload({ child_default: {
    progressIndex: { contest25: 90 }, progressUpdatedAt: { contest25: 200 },
    progressQuestions: { contest25: { uid: 'contest25_0102', revision: 'new' } }
  } }));
  const merged = engine.getActiveChildData();
  assert.equal(merged.progressIndex.contest25, 90);
  assert.equal(merged.progressQuestions.contest25.uid, 'contest25_0102');
  assert.equal(merged.progressQuestions.contest25.revision, 'new');
});

test('untimestamped progress keeps the larger index and its matching question', () => {
  const { engine } = device({ bc_children_data: { child_default: {
    progressIndex: { contest25: 100 },
    progressQuestions: { contest25: { uid: 'local-question', revision: 'old' } }
  } } });
  engine.smartMerge(payload({ child_default: {
    progressIndex: { contest25: 90 },
    progressQuestions: { contest25: { uid: 'cloud-question', revision: 'new' } }
  } }));
  const merged = engine.getActiveChildData();
  assert.equal(merged.progressIndex.contest25, 100);
  assert.equal(merged.progressQuestions.contest25.uid, 'local-question');
});

test('removing a favorite on another device stays removed', () => {
  const { engine } = device();
  const local = engine.getActiveChildData();
  local.favorites.Q_0001 = true;
  engine.saveActiveChildData(local);
  engine.smartMerge(payload({ child_default: {
    favorites: { Q_0001: false }, favoriteUpdatedAt: { Q_0001: 200 }
  } }));
  assert.equal(engine.getActiveChildData().favorites.Q_0001, false);
});

test('a new incorrect answer reopens a previously mastered mistake', () => {
  const { engine } = device();
  const local = engine.getActiveChildData();
  local.mistakes.Q_0001 = { errorCount: 1, consecutiveCorrect: 2, mastered: true };
  engine.saveActiveChildData(local);
  engine.smartMerge(payload({ child_default: { mistakes: {
    Q_0001: { errorCount: 2, consecutiveCorrect: 0, mastered: false, updatedAt: 200 }
  } } }));
  const mistake = engine.getActiveChildData().mistakes.Q_0001;
  assert.equal(mistake.mastered, false);
  assert.equal(mistake.consecutiveCorrect, 0);
});

test('automatic upload merges cloud records before posting local records', async () => {
  const d = device();
  d.engine.setSyncCode('test-family');
  const local = d.engine.getActiveChildData();
  local.answers.Q_0001 = 'C';
  d.engine.saveActiveChildData(local);
  d.respond((url, options) => options.method === 'POST' ? response(200) :
    response(200, payload({ child_default: { answers: { Q_0002: 'B' } } })));
  assert.equal((await d.engine.syncToCloud()).ok, true);
  const uploaded = JSON.parse(d.requests.find(r => r.method === 'POST').body);
  assert.equal(uploaded.childrenData.child_default.answers.Q_0001, 'C');
  assert.equal(uploaded.childrenData.child_default.answers.Q_0002, 'B');
});

test('timestamps do not cause repeated uploads of unchanged data', async () => {
  const d = device();
  d.engine.setSyncCode('test-family');
  let cloud = null;
  d.respond((url, options) => {
    if (options.method === 'POST') { cloud = JSON.parse(options.body); return response(200); }
    return cloud ? response(200, cloud) : response(404);
  });
  await d.engine.syncToCloud();
  d.advance();
  await d.engine.syncToCloud();
  assert.equal(d.requests.filter(r => r.method === 'POST').length, 1);
});

test('turning off automatic sync cancels queued uploads and polling', async () => {
  const d = device();
  d.engine.setSyncCode('test-family');
  d.engine.triggerDebouncedUpload();
  assert.ok(d.engine.debounceUploadTimer);
  d.engine.setAutoSyncEnabled(false);
  assert.equal(d.engine.debounceUploadTimer, null);
  await d.engine.checkCloudTimestamp();
  assert.equal(d.requests.length, 0);
});

test('changing families discards an in-flight response and old sync metadata', async () => {
  const d = device();
  d.engine.setSyncCode('old-family');
  d.engine.setStorage('cloud_ts', 999);
  let resolve;
  d.respond(() => new Promise(r => { resolve = r; }));
  const syncing = d.engine.syncFromCloud();
  d.engine.setSyncCode('new-family');
  resolve(response(200, payload({ child_default: { answers: { Q_0001: 'A' } } })));
  assert.equal((await syncing).ok, false);
  assert.equal(d.engine.getActiveChildData().answers.Q_0001, undefined);
  assert.equal(d.engine.getStorage('cloud_ts', 0), 0);
});

test('older data cannot restore progress after a reset', () => {
  const d = device();
  const local = d.engine.getActiveChildData();
  local.answers.Q_0001 = 'A';
  d.engine.saveActiveChildData(local);
  d.advance();
  d.engine.saveActiveChildData({ answers: {}, favorites: {}, mistakes: {},
    progressIndex: {}, examHistory: [], resetAt: 200 });
  d.engine.smartMerge(payload({ child_default: {
    answers: { Q_0001: 'A' }, answerUpdatedAt: { Q_0001: 100 }
  } }));
  assert.equal(Object.keys(d.engine.getActiveChildData().answers).length, 0);
});

test('a deleted profile is not restored by an older cloud payload', () => {
  const d = device();
  const child = d.engine.addProfile({ name: '二宝' });
  const oldCloud = d.engine.collectPayload();
  d.advance();
  d.engine.deleteProfile(child.id);
  d.engine.smartMerge(oldCloud);
  assert.equal(d.engine.getProfiles().some(p => p.id === child.id), false);
});

test('progress saved during upload is queued for a second upload', async () => {
  const d = device();
  d.engine.setSyncCode('test-family');
  let cloud = null;
  let completeFirstUpload;
  let posts = 0;
  d.respond((url, options) => {
    if (options.method !== 'POST') return cloud ? response(200, cloud) : response(404);
    cloud = JSON.parse(options.body);
    posts++;
    if (posts === 1) return new Promise(resolve => { completeFirstUpload = resolve; });
    return response(200);
  });
  const syncing = d.engine.syncToCloud();
  await new Promise(setImmediate);
  const data = d.engine.getActiveChildData();
  data.answers.Q_0001 = 'C';
  d.advance();
  d.engine.saveActiveChildData(data);
  d.flush(3000); // Debounce expires while the first request is still in flight.
  completeFirstUpload(response(200));
  await syncing;
  assert.ok(d.engine.debounceUploadTimer);
  d.flush(3000);
  await new Promise(setImmediate);
  assert.equal(posts, 2);
  assert.equal(cloud.childrenData.child_default.answers.Q_0001, 'C');
});

test('an unavailable service retries finitely and preserves local records', async () => {
  const d = device();
  d.engine.setSyncCode('test-family');
  const data = d.engine.getActiveChildData();
  data.answers.Q_0001 = 'C';
  d.engine.saveActiveChildData(data);
  d.respond(() => response(503));
  const result = await d.engine.syncToCloud();
  assert.equal(result.ok, false);
  assert.equal(d.requests.length, 3);
  assert.equal(d.engine.isSyncing, false);
  assert.equal(d.engine.getActiveChildData().answers.Q_0001, 'C');
});

test('a hung request times out and permits a later retry', async () => {
  const d = device();
  d.engine.setSyncCode('test-family');
  d.respond((url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => {
      const error = new Error('aborted'); error.name = 'AbortError'; reject(error);
    });
  }));
  const syncing = d.engine.syncToCloud();
  for (let i = 0; i < 3; i++) {
    await new Promise(setImmediate);
    d.flush(10000);
  }
  const result = await syncing;
  assert.equal(result.ok, false);
  assert.match(result.error, /超时/);
  assert.equal(d.engine.isSyncing, false);
  d.respond((url, options) => options.method === 'POST' ? response(200) : response(404));
  assert.equal((await d.engine.syncToCloud()).ok, true);
});

test('invalid data from another app never replaces local data', async () => {
  const d = device();
  d.engine.setSyncCode('test-family');
  const data = d.engine.getActiveChildData();
  data.answers.Q_0001 = 'C';
  d.engine.saveActiveChildData(data);
  d.respond(() => response(200, { ...payload(), _app: 'another-app' }));
  assert.equal((await d.engine.syncFromCloud()).ok, false);
  assert.equal(d.engine.getActiveChildData().answers.Q_0001, 'C');
  assert.equal(d.requests.filter(r => r.method === 'POST').length, 0);
});

test('legacy progress is migrated once and cannot reappear after resetting', () => {
  const d = device({ beautiful_china_study_data_v2: { answers: { Q_0001: 'A' } } });
  assert.equal(d.engine.getActiveChildData().answers.Q_0001, 'A');
  d.advance();
  d.engine.saveActiveChildData({ answers: {}, favorites: {}, mistakes: {},
    progressIndex: {}, examHistory: [], resetAt: 200 });
  d.reload();
  assert.equal(Object.keys(d.engine.getActiveChildData().answers).length, 0);
});

test('new work survives a reset while older cloud work is removed', () => {
  const d = device();
  d.engine.saveActiveChildData({ answers: {}, favorites: {}, mistakes: {},
    progressIndex: {}, examHistory: [], resetAt: 150 });
  d.engine.smartMerge(payload({ child_default: {
    answers: { Q_0001: 'A', Q_0002: 'B' }, answerUpdatedAt: { Q_0001: 100, Q_0002: 200 }
  } }));
  assert.equal(d.engine.getActiveChildData().answers.Q_0001, undefined);
  assert.equal(d.engine.getActiveChildData().answers.Q_0002, 'B');
});

test('an existing legacy family keeps its cloud profile name on first binding', () => {
  const d = device();
  const cloud = payload();
  cloud.profiles[0].name = '辰辰';
  d.engine.smartMerge(cloud);
  assert.equal(d.engine.getActiveProfile().name, '辰辰');
});

test('polling retries unsent work after connectivity is restored', async () => {
  const d = device();
  d.engine.setSyncCode('test-family');
  const data = d.engine.getActiveChildData();
  data.answers.Q_0001 = 'C';
  d.engine.saveActiveChildData(data);
  d.respond(() => response(503));
  assert.equal((await d.engine.syncToCloud()).ok, false);
  let uploaded;
  d.respond((url, options) => {
    if (options.method === 'POST') { uploaded = JSON.parse(options.body); return response(200); }
    return response(404);
  });
  await d.engine.checkCloudTimestamp();
  assert.equal(uploaded.childrenData.child_default.answers.Q_0001, 'C');
});
