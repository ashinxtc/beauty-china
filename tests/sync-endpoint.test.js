const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const CUSTOM_ORIGIN = 'https://beauty-sync.daka-tool.top';
const source = fs.readFileSync(path.join(__dirname, '..', 'sync.js'), 'utf8');

function existingFamily() {
  return {
    bc_profiles: [
      { id: 'child_default', name: '预览测试孩子', avatar: '🦁', updatedAt: 100 },
      { id: 'sibling', name: '另一个孩子', avatar: '🐯', updatedAt: 100 },
    ],
    bc_active_child_id: 'child_default',
    bc_children_data: {
      child_default: {
        answers: { Q_0001: 'C' }, answerUpdatedAt: { Q_0001: 100 },
        favorites: { Q_0003: true }, favoriteUpdatedAt: { Q_0003: 100 },
        mistakes: { Q_0004: { errorCount: 1, mastered: false, updatedAt: 100 } },
        progressIndex: { unified: 4 }, progressUpdatedAt: { unified: 100 },
        progressQuestions: { unified: { uid: 'Q_0005', revision: 'saved-revision' } },
        examHistory: [{ id: 'saved-exam', score: 90, timestamp: 100 }], resetAt: 0,
      },
      sibling: { answers: { Q_0006: 'A' }, favorites: {}, mistakes: {}, examHistory: [] },
    },
    bc_sync_code: 'phone-preview-family',
    bc_auto_sync_enabled: false,
    bc_cloud_ts: 17,
    bc_last_sync_time: 17,
    bc_last_hash: 'saved-sync-marker',
    bc_legacy_migrated: true,
  };
}

function response(status, data = {}) {
  return { status, ok: status >= 200 && status < 300, text: async () => JSON.stringify(data) };
}

// No native fetch is exposed: every request stays inside this mock transport.
function device({ search = '', initialStorage = existingFamily(),
                  withParameters = true, withLocation = true } = {}) {
  const storage = new Map(Object.entries(initialStorage).map(([key, value]) => [key, JSON.stringify(value)]));
  const before = new Map(storage);
  const requests = [];
  const timers = new Map();
  let timerId = 0;
  let handler = () => response(404);
  const context = {
    window: { addEventListener() {}, ...(withLocation ? { location: { search } } : {}) },
    document: { visibilityState: 'visible', addEventListener() {} },
    localStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, String(value)),
    },
    Date: class extends Date { static now() { return 1000; } },
    console: { log() {}, warn() {}, error() {} },
    alert() {}, AbortController,
    ...(withParameters ? { URLSearchParams } : {}),
    setTimeout(callback, delay) {
      const id = ++timerId;
      timers.set(id, callback);
      if (delay <= 2000) queueMicrotask(() => {
        if (timers.delete(id)) callback();
      });
      return id;
    },
    clearTimeout: id => timers.delete(id),
    setInterval: () => ++timerId,
    clearInterval() {},
    fetch: async (url, options = {}) => {
      requests.push({ url: String(url), ...options, method: options.method || 'GET' });
      return handler(url, options);
    },
  };
  vm.runInNewContext(source, context);
  return { engine: context.window.CloudSync, storage, before, requests,
    respond: callback => { handler = callback; } };
}

test('ordinary pages and old preview links use the same fixed custom domain', () => {
  for (const search of ['', '?sync-preview=', '?sync-preview=custom-domain-extra',
    '?sync-preview=Custom-Domain', '?sync-preview=custom-domain%00',
    '?other=custom-domain', '?sync-preview=https%3A%2F%2Funtrusted.example',
    '?sync-preview=disabled&sync-preview=custom-domain',
    '?serverUrl=https%3A%2F%2Funtrusted.example&sync-url=https%3A%2F%2Funtrusted.example']) {
    assert.equal(device({ search }).engine.serverUrl, CUSTOM_ORIGIN, search);
  }
  for (const search of ['?sync-preview=custom-domain',
    '?other=value&sync-preview=custom-domain', '?sync-preview=custom%2Ddomain',
    '?sync-preview=custom-domain&sync-preview=https%3A%2F%2Funtrusted.example',
    '?sync-preview=custom-domain&serverUrl=https%3A%2F%2Funtrusted.example']) {
    assert.equal(device({ search }).engine.serverUrl, CUSTOM_ORIGIN, search);
  }
  assert.equal(device({ search: '?sync-preview=custom-domain', withParameters: false }).engine.serverUrl,
    CUSTOM_ORIGIN);
  assert.equal(device({ withLocation: false }).engine.serverUrl, CUSTOM_ORIGIN);
});

test('the endpoint cutover preserves profiles, records, sync code and sync metadata byte for byte', () => {
  for (const search of ['', '?sync-preview=custom-domain',
    '?sync-preview=custom-domain&code=another-family&sync-code=another-family']) {
    const d = device({ search });
    assert.deepEqual(d.storage, d.before);
    assert.equal(d.engine.getSyncCode(), 'phone-preview-family');
    assert.equal(d.engine.getActiveProfile().id, 'child_default');
    assert.equal(d.requests.length, 0);
  }
});

test('explicit constructor serverUrl overrides the default while query URLs cannot override it', async () => {
  const d = device({ search: '?sync-preview=custom-domain&serverUrl=https%3A%2F%2Funtrusted.example' });
  const configured = new d.engine.constructor({ serverUrl: 'https://configured-beauty.example' });
  d.respond((url, options) => options.method === 'POST' ? response(200) : response(404));
  assert.equal((await configured.syncToCloud()).ok, true);
  assert.deepEqual(d.requests.map(request => request.method), ['GET', 'POST']);
  assert.ok(d.requests.every(request => new URL(request.url).origin === 'https://configured-beauty.example'));
});

test('the singleton merges and uploads using only the fixed custom domain and stored family code', async () => {
  const d = device({ search: '?code=untrusted-family&serverUrl=https%3A%2F%2Funtrusted.example' });
  let cloud = { _app: 'beautifulChina', _syncTs: 2000, profiles: existingFamily().bc_profiles,
    childrenData: { child_default: { answers: { Q_0002: 'B' }, answerUpdatedAt: { Q_0002: 2000 } } } };
  d.respond((url, options) => {
    if (options.method === 'POST') {
      cloud = JSON.parse(options.body);
      return response(200);
    }
    return response(200, cloud);
  });
  assert.equal((await d.engine.syncToCloud()).ok, true);
  assert.equal((await d.engine.syncFromCloud()).ok, true);
  assert.deepEqual(d.requests.map(request => request.method), ['GET', 'POST', 'GET']);
  for (const request of d.requests) {
    const url = new URL(request.url);
    assert.equal(url.origin, CUSTOM_ORIGIN);
    assert.equal(url.pathname, '/');
    assert.equal(url.searchParams.get('code'), 'bc_phone-preview-family');
  }
  assert.equal(cloud.childrenData.child_default.answers.Q_0001, 'C');
  assert.equal(cloud.childrenData.child_default.answers.Q_0002, 'B');
  assert.equal(cloud.childrenData.sibling.answers.Q_0006, 'A');
  assert.equal(cloud.childrenData.child_default.examHistory[0].id, 'saved-exam');
});

for (const failure of ['HTTP 503', 'network error']) {
  test(`a custom-domain ${failure} preserves local data and never falls back to another endpoint`, async () => {
    const d = device();
    d.respond(() => {
      if (failure === 'network error') throw new TypeError('Failed to fetch');
      return response(503);
    });
    assert.equal((await d.engine.syncToCloud()).ok, false);
    assert.equal(d.requests.length, 3);
    assert.ok(d.requests.every(request => new URL(request.url).origin === CUSTOM_ORIGIN));
    assert.ok(d.requests.every(request => request.method === 'GET'));
    assert.deepEqual(d.storage, d.before);
    assert.equal(d.engine.isSyncing, false);
  });
}
