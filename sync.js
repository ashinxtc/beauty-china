/**
 * ==========================================================================
 * CloudSyncClient - 跨应用通用云同步与多档案（多孩子）管理模块
 * ==========================================================================
 * 特性：
 * 1. 严格的项目数据隔离 (Project Namespace Isolation)
 *    - 默认添加前缀 `bc_`，绝不与 daka-tool 或其他应用在云端或本地发生冲突
 * 2. 多孩子 (Child Profiles) 档案管理与独立学习数据隔离
 *    - 每个孩子拥有独立的答题记录、错题本、收藏夹、进度和模考成绩
 * 3. 智能双向云端合并 (Smart Bidirectional Merge)
 *    - 自动合并家庭成员、答题记录、消灭错题状态与收藏夹
 * 4. 跨设备防冲突与网络重试机制
 */

(function () {
  'use strict';

  // 简易稳定 Hash 算法，用于检测数据是否有变动以防冗余网络请求
  function hashString(str) {
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) + hash) + str.charCodeAt(i);
      hash |= 0;
    }
    return String(hash);
  }

  function stableStringify(value) {
    if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
    if (value && typeof value === 'object') {
      return '{' + Object.keys(value).sort().map(key =>
        JSON.stringify(key) + ':' + stableStringify(value[key])).join(',') + '}';
    }
    return JSON.stringify(value);
  }

  function payloadHash(payload) {
    // 上传时间和当前选中的孩子不属于学习数据，不能使内容校验失效。
    const { _syncTs, activeChildId, app_profiles_v1, ...content } = payload;
    return hashString(stableStringify(content));
  }

  function emptyChildData() {
    return { answers: {}, mistakes: {}, favorites: {}, progressIndex: {}, progressQuestions: {}, examHistory: [],
      answerUpdatedAt: {}, favoriteUpdatedAt: {}, progressUpdatedAt: {}, resetAt: 0 };
  }

  class CloudSyncEngine {
    constructor(options = {}) {
      this.appId = options.appId || 'beautifulChina';
      this.prefix = options.prefix || 'bc_';
      this.serverUrl = options.serverUrl || 'https://sync.daka-tool.top';
      this.listeners = {};
      this.isSyncing = false;
      this.autoSyncTimer = null;
      this.debounceUploadTimer = null;
      this.pendingUpload = false;
      this.syncGeneration = 0;

      this.init();
    }

    // 事件订阅发布
    on(event, cb) {
      if (!this.listeners[event]) this.listeners[event] = [];
      this.listeners[event].push(cb);
    }

    emit(event, payload) {
      if (this.listeners[event]) {
        this.listeners[event].forEach(cb => {
          try { cb(payload); } catch (e) { console.error(e); }
        });
      }
    }

    // 本地存储键名
    _k(key) {
      return this.prefix + key;
    }

    getStorage(key, fallback = null) {
      try {
        const val = localStorage.getItem(this._k(key));
        return val !== null ? JSON.parse(val) : fallback;
      } catch (e) {
        return fallback;
      }
    }

    setStorage(key, val) {
      try {
        localStorage.setItem(this._k(key), JSON.stringify(val));
      } catch (e) {
        console.warn('LocalStorage error', e);
      }
    }

    // 初始化档案与数据迁移
    init() {
      let profiles = this.getStorage('profiles', null);
      if (!profiles || !Array.isArray(profiles) || profiles.length === 0) {
        // 创建默认首个孩子档案
        profiles = [
          {
            id: 'child_default',
            name: '大宝',
            avatar: '🦁',
            grade: '小学组',
            createdAt: Date.now(),
            updatedAt: 0
          }
        ];
        this.setStorage('profiles', profiles);
      }

      let activeId = this.getStorage('active_child_id', null);
      if (!activeId || !profiles.some(p => p.id === activeId)) {
        activeId = profiles[0].id;
        this.setStorage('active_child_id', activeId);
      }

      // 如果有遗留的旧版单一用户数据，平滑迁移到默认孩子
      const legacy = localStorage.getItem('beautiful_china_study_data_v2');
      if (legacy && !this.getStorage('legacy_migrated', false)) {
        try {
          const parsed = JSON.parse(legacy);
          let childrenData = this.getStorage('children_data', {});
          if (!childrenData[activeId] || Object.keys(childrenData[activeId].answers || {}).length === 0) {
            childrenData[activeId] = {
              answers: parsed.answers || {},
              mistakes: parsed.mistakes || {},
              favorites: parsed.favorites || {},
              progressIndex: parsed.progressIndex || {},
              examHistory: parsed.examHistory || []
            };
            this.setStorage('children_data', childrenData);
          }
          this.setStorage('legacy_migrated', true);
        } catch (e) {}
      }

      // 绑定页面唤醒时自动检测云端更新
      if (typeof window !== 'undefined') {
        window.addEventListener('focus', () => this.checkCloudTimestamp());
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') {
            this.checkCloudTimestamp();
          }
        });
      }

      // 启动定时轮询轻量时间戳 (每 60 秒)
      if (this.isAutoSyncEnabled()) {
        this.startAutoSync();
      }
    }

    // ==========================================
    // 孩子档案管理 (Profiles API)
    // ==========================================
    getProfiles() {
      return this.getStorage('profiles', []);
    }

    getActiveProfile() {
      const profiles = this.getProfiles();
      const activeId = this.getStorage('active_child_id', '');
      return profiles.find(p => p.id === activeId) || profiles[0];
    }

    setActiveProfile(childId) {
      const profiles = this.getProfiles();
      const target = profiles.find(p => p.id === childId);
      if (target) {
        this.setStorage('active_child_id', target.id);
        this.emit('profile-change', target);
        return true;
      }
      return false;
    }

    addProfile({ name, avatar = '🦁', grade = '小学组' }) {
      if (!name || !name.trim()) return null;
      const profiles = this.getProfiles();
      const newChild = {
        id: 'child_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        name: name.trim(),
        avatar: avatar || '🦁',
        grade: grade || '小学组',
        createdAt: Date.now(),
        updatedAt: Date.now()
      };
      profiles.push(newChild);
      this.setStorage('profiles', profiles);
      this.setActiveProfile(newChild.id);
      this.triggerDebouncedUpload();
      return newChild;
    }

    updateProfile(childId, updateData) {
      const profiles = this.getProfiles();
      const idx = profiles.findIndex(p => p.id === childId);
      if (idx !== -1) {
        profiles[idx] = Object.assign(profiles[idx], updateData, { id: childId, updatedAt: Date.now() });
        this.setStorage('profiles', profiles);
        this.emit('profile-change', this.getActiveProfile());
        this.triggerDebouncedUpload();
        return true;
      }
      return false;
    }

    deleteProfile(childId) {
      let profiles = this.getProfiles();
      if (!profiles.some(p => p.id === childId)) return false;
      if (profiles.length <= 1) {
        alert('家庭中至少需要保留一名孩子档案！');
        return false;
      }
      profiles = profiles.filter(p => p.id !== childId);
      const deleted = this.getStorage('deleted_profiles', {});
      deleted[childId] = Date.now();
      this.setStorage('deleted_profiles', deleted);
      this.setStorage('profiles', profiles);
      
      // 清除该孩子的本地数据
      let childrenData = this.getStorage('children_data', {});
      delete childrenData[childId];
      this.setStorage('children_data', childrenData);

      // 切换到剩余首个孩子
      if (this.getStorage('active_child_id') === childId) this.setActiveProfile(profiles[0].id);
      this.triggerDebouncedUpload();
      return true;
    }

    // ==========================================
    // 孩子专属答题数据存取
    // ==========================================
    getActiveChildData() {
      const active = this.getActiveProfile();
      const childrenData = this.getStorage('children_data', {});
      if (!childrenData[active.id]) {
        childrenData[active.id] = emptyChildData();
        this.setStorage('children_data', childrenData);
      }
      return Object.assign(emptyChildData(), childrenData[active.id]);
    }

    saveActiveChildData(childData) {
      const active = this.getActiveProfile();
      let childrenData = this.getStorage('children_data', {});
      const previous = childrenData[active.id] || emptyChildData();
      if (stableStringify(previous) === stableStringify(childData)) return;
      const now = Date.now();
      for (const [field, timestamps] of [
        ['answers', 'answerUpdatedAt'], ['favorites', 'favoriteUpdatedAt'],
        ['progressIndex', 'progressUpdatedAt']
      ]) {
        childData[timestamps] = Object.assign({}, previous[timestamps], childData[timestamps]);
        for (const key of Object.keys(childData[field] || {})) {
          if (stableStringify(previous[field]?.[key]) !== stableStringify(childData[field][key]) ||
              (field === 'progressIndex' && stableStringify(previous.progressQuestions?.[key]) !== stableStringify(childData.progressQuestions?.[key]))) {
            childData[timestamps][key] = Math.max(now, childData[timestamps][key] || 0,
              (previous[timestamps]?.[key] || 0) + 1, childData.resetAt || 0);
          }
        }
      }
      for (const [uid, mistake] of Object.entries(childData.mistakes || {})) {
        if (stableStringify(previous.mistakes?.[uid]) !== stableStringify(mistake)) {
          mistake.updatedAt = Math.max(now, (previous.mistakes?.[uid]?.updatedAt || 0) + 1,
            childData.resetAt || 0);
        }
      }
      childrenData[active.id] = childData;
      this.setStorage('children_data', childrenData);
      this.setStorage('local_ts', Date.now());
      this.triggerDebouncedUpload();
    }

    // ==========================================
    // 云同步核心逻辑
    // ==========================================
    getSyncCode() {
      return this.getStorage('sync_code', '') || '';
    }

    setSyncCode(code) {
      const clean = (code || '').trim();
      if (clean !== this.getSyncCode()) {
        this.syncGeneration++;
        this.setStorage('last_hash', '');
        this.setStorage('cloud_ts', 0);
        this.setStorage('last_sync_time', null);
        this.pendingUpload = false;
        if (this.debounceUploadTimer) clearTimeout(this.debounceUploadTimer);
        this.debounceUploadTimer = null;
      }
      this.setStorage('sync_code', clean);
      return clean;
    }

    isAutoSyncEnabled() {
      return this.getStorage('auto_sync_enabled', true);
    }

    setAutoSyncEnabled(enabled) {
      this.setStorage('auto_sync_enabled', !!enabled);
      if (enabled) this.startAutoSync();
      else this.stopAutoSync();
    }

    startAutoSync() {
      if (this.autoSyncTimer) clearInterval(this.autoSyncTimer);
      this.autoSyncTimer = setInterval(() => {
        this.checkCloudTimestamp();
      }, 60000); // 每分钟轻量轮询
    }

    stopAutoSync() {
      if (this.autoSyncTimer) {
        clearInterval(this.autoSyncTimer);
        this.autoSyncTimer = null;
      }
      if (this.debounceUploadTimer) clearTimeout(this.debounceUploadTimer);
      this.debounceUploadTimer = null;
      this.pendingUpload = false;
    }

    triggerDebouncedUpload() {
      if (!this.isAutoSyncEnabled()) return;
      if (!this.getSyncCode()) return;
      this.pendingUpload = true;
      if (this.debounceUploadTimer) clearTimeout(this.debounceUploadTimer);
      this.debounceUploadTimer = setTimeout(() => {
        this.debounceUploadTimer = null;
        this.syncToCloud(false);
      }, 3000); // 防抖 3 秒合并上传
    }

    // 构建隔离后的云端 KV 请求代码
    _getCloudSyncParam() {
      const rawCode = this.getSyncCode();
      if (!rawCode) return null;
      // 核心：添加前缀 bc_ 确保与 daka-tool 等应用在云端 KV 彻底隔离
      return this.prefix + rawCode;
    }

    // 收集待同步的全量数据包
    collectPayload() {
      this.getActiveChildData();
      const profiles = this.getProfiles();
      const activeId = this.getStorage('active_child_id', '');
      const childrenData = Object.fromEntries(Object.entries(this.getStorage('children_data', {}))
        .map(([id, data]) => [id, Object.assign(emptyChildData(), data)]));
      const ts = Date.now();

      return {
        _app: this.appId,
        _syncTs: ts,
        _version: 3,
        syncCode: this.getSyncCode(),
        // 兼容 Cloudflare Worker 的防减员检查
        app_profiles_v1: JSON.stringify(profiles),
        profiles: profiles,
        activeChildId: activeId,
        childrenData: childrenData,
        deletedProfiles: this.getStorage('deleted_profiles', {})
      };
    }

    // 请求超时与有限重试，避免离线时永久停留在“同步中”。
    async request(url, options = {}) {
      for (let attempt = 0; attempt < 3; attempt++) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);
        try {
          const response = await fetch(url, { ...options, signal: controller.signal });
          if (attempt < 2 && (response.status === 429 || response.status >= 500)) {
            await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
            continue;
          }
          // 在超时保护内读完响应体，避免只收到响应头后一直等待。
          const body = await response.text();
          return { status: response.status, ok: response.ok, json: async () => JSON.parse(body) };
        } catch (error) {
          if (attempt === 2) {
            throw new Error(error.name === 'AbortError' ? '网络请求超时，请稍后重试' : '网络连接失败，请稍后重试');
          }
          await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
        } finally {
          clearTimeout(timeout);
        }
      }
    }

    ensureCurrentSync(generation) {
      if (generation !== this.syncGeneration) throw new Error('同步码已变更，请重新同步');
    }

    // 普通上传先读取并合并；只有用户明确选择覆盖才跳过合并。
    syncToCloud(force = false) {
      return this.synchronize(true, force);
    }

    syncFromCloud() {
      return this.synchronize(false, false);
    }

    async synchronize(upload, force) {
      const cloudCode = this._getCloudSyncParam();
      if (!cloudCode) {
        this.emit('sync-status', { status: 'idle', message: '未绑定同步码' });
        return { ok: false, error: '未绑定同步码' };
      }
      if (this.isSyncing) {
        if (upload && this.isAutoSyncEnabled()) this.pendingUpload = true;
        return { ok: false, error: '正在同步中，请稍后重试' };
      }
      const generation = this.syncGeneration;
      this.isSyncing = true;
      this.pendingUpload = false;
      this.emit('sync-status', { status: 'syncing', message: '正在合并云端学习数据...' });
      try {
        const url = `${this.serverUrl}/?code=${encodeURIComponent(cloudCode)}`;
        let cloudPayload = null;
        let mergedResult = null;
        if (!force) {
          const response = await this.request(url);
          this.ensureCurrentSync(generation);
          if (response.status === 404) {
            upload = true;
          } else {
            if (!response.ok) throw new Error(`拉取失败 (${response.status})`);
            cloudPayload = await response.json();
            this.ensureCurrentSync(generation);
            const previous = payloadHash(this.collectPayload());
            mergedResult = this.smartMerge(cloudPayload);
            if (previous !== payloadHash(this.collectPayload())) this.emit('data-merged', mergedResult);
          }
        }
        const payload = this.collectPayload();
        const hash = payloadHash(payload);
        const skipped = upload && !force && cloudPayload && hash === payloadHash(cloudPayload);
        if (upload && !skipped) {
          const response = await this.request(url, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          });
          this.ensureCurrentSync(generation);
          if (!response.ok) throw new Error(`上传失败 (${response.status})`);
          this.setStorage('last_hash', hash);
          this.setStorage('cloud_ts', payload._syncTs);
        }
        if (upload) this.setStorage('last_hash', hash);
        this.setStorage('last_sync_time', Date.now());
        this.emit('sync-status', { status: 'success', message: upload ? '双向同步完成' : '云端数据已拉取并合并' });
        return { ok: true, skipped: !!skipped, data: mergedResult, ts: this.getStorage('cloud_ts', 0) };
      } catch (error) {
        if (generation === this.syncGeneration) {
          this.emit('sync-status', { status: 'error', message: error.message || '网络异常' });
        }
        return { ok: false, error: error.message };
      } finally {
        this.isSyncing = false;
        // 请求过程中产生的答题记录仍需上传，不能被一次同步吞掉。
        if (this.pendingUpload) this.triggerDebouncedUpload();
      }
    }

    async checkCloudTimestamp() {
      const cloudCode = this._getCloudSyncParam();
      if (!this.isAutoSyncEnabled() || !cloudCode || this.isSyncing || this.isCheckingTimestamp) return;
      const generation = this.syncGeneration;
      this.isCheckingTimestamp = true;
      try {
        if (payloadHash(this.collectPayload()) !== this.getStorage('last_hash', '')) {
          await this.syncToCloud();
          return;
        }
        const response = await this.request(`${this.serverUrl}/ts?code=${encodeURIComponent(cloudCode)}`);
        this.ensureCurrentSync(generation);
        if (response.ok) {
          const { ts } = await response.json();
          this.ensureCurrentSync(generation);
          if (this.isAutoSyncEnabled() && ts > this.getStorage('cloud_ts', 0)) await this.syncToCloud();
        }
      } catch (error) {
        // 静默轮询失败不影响本地刷题，用户手动同步时会显示错误。
      } finally {
        this.isCheckingTimestamp = false;
      }
    }

    smartMerge(cloudData) {
      if (!cloudData || typeof cloudData !== 'object' ||
          (cloudData._app && cloudData._app !== this.appId) ||
          !Array.isArray(cloudData.profiles) || !cloudData.childrenData ||
          typeof cloudData.childrenData !== 'object' || Array.isArray(cloudData.childrenData)) {
        throw new Error('云端数据格式不正确，已保留本地记录');
      }
      const deleted = { ...this.getStorage('deleted_profiles', {}) };
      for (const [id, time] of Object.entries(cloudData.deletedProfiles || {})) {
        deleted[id] = Math.max(deleted[id] || 0, time);
      }
      const profileMap = new Map();
      for (const profile of [...this.getProfiles(), ...cloudData.profiles]) {
        if (!profile || !profile.id || Object.hasOwn(deleted, profile.id)) continue;
        const existing = profileMap.get(profile.id);
        if (!existing || (profile.updatedAt || 0) > (existing.updatedAt || 0) ||
            ((profile.updatedAt || 0) === (existing.updatedAt || 0) &&
              (!profile.updatedAt || stableStringify(profile) > stableStringify(existing)))) {
          profileMap.set(profile.id, { ...existing, ...profile });
        }
      }
      let mergedProfiles = Array.from(profileMap.values()).sort((a, b) => a.id.localeCompare(b.id));
      // 两台设备各删一个孩子时，仍保留一个新的空档案供本地继续使用。
      if (!mergedProfiles.length) {
        mergedProfiles = [{ id: 'child_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
          name: '大宝', avatar: '🦁', grade: '小学组', createdAt: Date.now(), updatedAt: Date.now() }];
      }
      const localChildren = this.getStorage('children_data', {});
      const cloudChildren = cloudData.childrenData;
      const mergedChildren = {};
      const childIds = new Set([...Object.keys(localChildren), ...Object.keys(cloudChildren), ...mergedProfiles.map(p => p.id)]);
      for (const id of childIds) {
        if (Object.hasOwn(deleted, id)) continue;
        const local = localChildren[id] || emptyChildData();
        const cloud = cloudChildren[id] || emptyChildData();
        const resetAt = Math.max(local.resetAt || 0, cloud.resetAt || 0);
        const merged = { ...cloud, ...local, resetAt };
        merged.progressQuestions = {};
        for (const [field, timestampField] of [
          ['answers', 'answerUpdatedAt'], ['favorites', 'favoriteUpdatedAt'],
          ['progressIndex', 'progressUpdatedAt'], ['mistakes', null]
        ]) {
          const values = {};
          const times = {};
          const keys = new Set([...Object.keys(local[field] || {}), ...Object.keys(cloud[field] || {})]);
          for (const key of keys) {
            let selected;
            let selectedTime = -1;
            let selectedSource;
            for (const source of [local, cloud]) {
              if (!Object.hasOwn(source[field] || {}, key)) continue;
              const value = source[field][key];
              const time = timestampField ? (source[timestampField]?.[key] || 0) :
                (value?.updatedAt || source.answerUpdatedAt?.[key] || 0);
              if (resetAt && time < resetAt) continue;
              const tieWins = field === 'progressIndex' ?
                (time === 0 && value !== selected ? value > selected :
                  stableStringify([value, source.progressQuestions?.[key]]) >
                  stableStringify([selected, selectedSource?.progressQuestions?.[key]])) :
                stableStringify(value) > stableStringify(selected);
              if (time > selectedTime || (time === selectedTime && tieWins)) {
                selected = value;
                selectedTime = time;
                selectedSource = source;
              }
            }
            if (selectedTime >= 0) {
              // 无时间戳的旧进度仍按更大索引合并，兼容既有存档。
              values[key] = field === 'progressIndex' && selectedTime === 0 ?
                Math.max(local[field]?.[key] || 0, cloud[field]?.[key] || 0) : selected;
              times[key] = selectedTime;
              if (field === 'progressIndex' && selectedSource?.progressQuestions?.[key]) {
                merged.progressQuestions[key] = selectedSource.progressQuestions[key];
              }
            }
          }
          merged[field] = values;
          if (timestampField) merged[timestampField] = times;
        }
        const exams = new Map();
        for (const record of [...(local.examHistory || []), ...(cloud.examHistory || [])]) {
          if (resetAt && (record.timestamp || Date.parse(record.date) || 0) < resetAt) continue;
          const key = record.id || `${record.date}_${record.score}_${record.total}`;
          exams.set(key, record);
        }
        merged.examHistory = Array.from(exams.values()).sort((a, b) =>
          (a.timestamp || Date.parse(a.date) || 0) - (b.timestamp || Date.parse(b.date) || 0));
        mergedChildren[id] = merged;
      }
      this.setStorage('profiles', mergedProfiles);
      this.setStorage('deleted_profiles', deleted);
      this.setStorage('children_data', mergedChildren);
      if (!mergedProfiles.some(p => p.id === this.getStorage('active_child_id'))) {
        this.setStorage('active_child_id', mergedProfiles[0].id);
      }
      if (cloudData._syncTs) this.setStorage('cloud_ts', cloudData._syncTs);
      return { profiles: mergedProfiles, activeProfile: this.getActiveProfile(), childrenData: mergedChildren };
    }
  }
  // 挂载到全局
  window.CloudSync = new CloudSyncEngine();

})();
