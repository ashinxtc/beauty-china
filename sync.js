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

  class CloudSyncEngine {
    constructor(options = {}) {
      this.appId = options.appId || 'beautifulChina';
      this.prefix = options.prefix || 'bc_';
      this.serverUrl = options.serverUrl || 'https://sync.daka-tool.top';
      this.listeners = {};
      this.isSyncing = false;
      this.autoSyncTimer = null;
      this.debounceUploadTimer = null;

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
            createdAt: Date.now()
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
      if (legacy) {
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
        } catch (e) {}
      }

      // 绑定页面唤醒时自动检测云端更新
      if (typeof window !== 'undefined') {
        window.addEventListener('focus', () => this.checkCloudTimestamp());
        window.addEventListener('visibilitychange', () => {
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
        createdAt: Date.now()
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
        profiles[idx] = Object.assign(profiles[idx], updateData);
        this.setStorage('profiles', profiles);
        this.emit('profile-change', this.getActiveProfile());
        this.triggerDebouncedUpload();
        return true;
      }
      return false;
    }

    deleteProfile(childId) {
      let profiles = this.getProfiles();
      if (profiles.length <= 1) {
        alert('家庭中至少需要保留一名孩子档案！');
        return false;
      }
      profiles = profiles.filter(p => p.id !== childId);
      this.setStorage('profiles', profiles);
      
      // 清除该孩子的本地数据
      let childrenData = this.getStorage('children_data', {});
      delete childrenData[childId];
      this.setStorage('children_data', childrenData);

      // 切换到剩余首个孩子
      this.setActiveProfile(profiles[0].id);
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
        childrenData[active.id] = {
          answers: {},
          mistakes: {},
          favorites: {},
          progressIndex: {},
          examHistory: []
        };
        this.setStorage('children_data', childrenData);
      }
      return childrenData[active.id];
    }

    saveActiveChildData(childData) {
      const active = this.getActiveProfile();
      let childrenData = this.getStorage('children_data', {});
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
    }

    triggerDebouncedUpload() {
      if (!this.isAutoSyncEnabled()) return;
      if (!this.getSyncCode()) return;
      if (this.debounceUploadTimer) clearTimeout(this.debounceUploadTimer);
      this.debounceUploadTimer = setTimeout(() => {
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
      const profiles = this.getProfiles();
      const activeId = this.getStorage('active_child_id', '');
      const childrenData = this.getStorage('children_data', {});
      const ts = Date.now();

      return {
        _app: this.appId,
        _syncTs: ts,
        _version: 2,
        syncCode: this.getSyncCode(),
        // 兼容 Cloudflare Worker 的防减员检查
        app_profiles_v1: JSON.stringify(profiles),
        profiles: profiles,
        activeChildId: activeId,
        childrenData: childrenData
      };
    }

    // 上传到云端
    async syncToCloud(force = false) {
      const cloudCode = this._getCloudSyncParam();
      if (!cloudCode) {
        this.emit('sync-status', { status: 'idle', message: '未绑定同步码' });
        return { ok: false, error: '未绑定同步码' };
      }

      if (this.isSyncing) return { ok: false, error: '正在同步中' };
      this.isSyncing = true;
      this.emit('sync-status', { status: 'syncing', message: '正在上传到云端...' });

      try {
        const payload = this.collectPayload();
        const payloadStr = JSON.stringify(payload);
        const payloadHash = hashString(payloadStr);

        // 如果未开启强制，且内容 Hash 没有变化，则跳过上传
        const lastHash = this.getStorage('last_hash', '');
        if (!force && lastHash === payloadHash) {
          this.isSyncing = false;
          this.emit('sync-status', { status: 'success', message: '已是最新数据' });
          return { ok: true, skipped: true };
        }

        const url = `${this.serverUrl}/?code=${encodeURIComponent(cloudCode)}`;
        let resp = null;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            resp = await fetch(url, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: payloadStr
            });
            if (resp.status !== 429) break;
            await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
          } catch (netErr) {
            if (attempt === 2) throw netErr;
            await new Promise(r => setTimeout(r, 1000));
          }
        }

        if (!resp || !resp.ok) {
          const errText = resp ? await resp.text() : '网络请求失败';
          throw new Error(`上传失败 (${resp ? resp.status : '网络错误'}): ${errText}`);
        }

        this.setStorage('last_hash', payloadHash);
        this.setStorage('cloud_ts', payload._syncTs);
        this.setStorage('last_sync_time', Date.now());

        this.emit('sync-status', { status: 'success', message: '云端同步成功' });
        return { ok: true, ts: payload._syncTs };
      } catch (e) {
        console.error('[CloudSync] Upload error:', e);
        this.emit('sync-status', { status: 'error', message: e.message || '网络异常' });
        return { ok: false, error: e.message };
      } finally {
        this.isSyncing = false;
      }
    }

    // 从云端拉取并智能合并
    async syncFromCloud() {
      const cloudCode = this._getCloudSyncParam();
      if (!cloudCode) {
        this.emit('sync-status', { status: 'idle', message: '未绑定同步码' });
        return { ok: false, error: '未绑定同步码' };
      }

      if (this.isSyncing) return { ok: false, error: '正在同步中' };
      this.isSyncing = true;
      this.emit('sync-status', { status: 'syncing', message: '正在从云端拉取...' });

      try {
        const url = `${this.serverUrl}/?code=${encodeURIComponent(cloudCode)}`;
        const resp = await fetch(url);

        if (resp.status === 404) {
          // 云端尚无此同步码的数据 -> 自动初始化首传
          this.isSyncing = false;
          return await this.syncToCloud(true);
        }

        if (!resp.ok) {
          throw new Error(`拉取失败 (${resp.status})`);
        }

        const cloudPayload = await resp.json();
        const mergedResult = this.smartMerge(cloudPayload);

        this.setStorage('last_sync_time', Date.now());
        this.emit('sync-status', { status: 'success', message: '云端数据已拉取并合并' });
        this.emit('data-merged', mergedResult);
        return { ok: true, data: mergedResult };
      } catch (e) {
        console.error('[CloudSync] Pull error:', e);
        this.emit('sync-status', { status: 'error', message: e.message || '拉取异常' });
        return { ok: false, error: e.message };
      } finally {
        this.isSyncing = false;
      }
    }

    // 轻量时间戳轮询检测
    async checkCloudTimestamp() {
      const cloudCode = this._getCloudSyncParam();
      if (!cloudCode || this.isSyncing) return;

      try {
        const url = `${this.serverUrl}/ts?code=${encodeURIComponent(cloudCode)}`;
        const resp = await fetch(url);
        if (resp.ok) {
          const { ts } = await resp.json();
          const localCloudTs = this.getStorage('cloud_ts', 0);
          if (ts && ts > localCloudTs) {
            console.log('[CloudSync] Cloud timestamp is newer, pulling update...');
            await this.syncFromCloud();
          }
        }
      } catch (e) {}
    }

    // 智能双向合并算法
    smartMerge(cloudData) {
      if (!cloudData || typeof cloudData !== 'object') return null;

      // 1. 合并孩子档案列表 (并集保留，不丢弃任何孩子的记录)
      const localProfiles = this.getProfiles();
      const cloudProfiles = cloudData.profiles || [];
      const profileMap = new Map();

      // 先加本地
      localProfiles.forEach(p => profileMap.set(p.id, p));
      // 合并云端
      cloudProfiles.forEach(cp => {
        if (!profileMap.has(cp.id)) {
          profileMap.set(cp.id, cp);
        } else {
          // 若同名，取信息更完整的
          const existing = profileMap.get(cp.id);
          profileMap.set(cp.id, Object.assign({}, existing, cp));
        }
      });

      const mergedProfiles = Array.from(profileMap.values());
      this.setStorage('profiles', mergedProfiles);

      // 2. 合并各个孩子的答题做题数据
      const localChildrenData = this.getStorage('children_data', {});
      const cloudChildrenData = cloudData.childrenData || {};
      const mergedChildrenData = {};

      const allChildIds = new Set([
        ...Object.keys(localChildrenData),
        ...Object.keys(cloudChildrenData),
        ...mergedProfiles.map(p => p.id)
      ]);

      allChildIds.forEach(cid => {
        const local = localChildrenData[cid] || { answers: {}, mistakes: {}, favorites: {}, progressIndex: {}, examHistory: [] };
        const cloud = cloudChildrenData[cid] || { answers: {}, mistakes: {}, favorites: {}, progressIndex: {}, examHistory: [] };

        // 答题记录：并集，云端与本地互补
        const mergedAnswers = Object.assign({}, cloud.answers || {}, local.answers || {});

        // 错题本：取更严格的错误次数，消灭状态若任一处掌握即标记掌握
        const mergedMistakes = {};
        const mistakeUids = new Set([...Object.keys(local.mistakes || {}), ...Object.keys(cloud.mistakes || {})]);
        mistakeUids.forEach(uid => {
          const mLocal = (local.mistakes && local.mistakes[uid]) || null;
          const mCloud = (cloud.mistakes && cloud.mistakes[uid]) || null;
          if (mLocal && mCloud) {
            mergedMistakes[uid] = {
              errorCount: Math.max(mLocal.errorCount || 0, mCloud.errorCount || 0),
              consecutiveCorrect: Math.max(mLocal.consecutiveCorrect || 0, mCloud.consecutiveCorrect || 0),
              mastered: mLocal.mastered || mCloud.mastered
            };
          } else {
            mergedMistakes[uid] = mLocal || mCloud;
          }
        });

        // 收藏夹：并集
        const mergedFavorites = Object.assign({}, cloud.favorites || {}, local.favorites || {});

        // 题库进度：取更大进度索引
        const mergedProgress = {};
        const bankKeys = new Set([...Object.keys(local.progressIndex || {}), ...Object.keys(cloud.progressIndex || {})]);
        bankKeys.forEach(bk => {
          mergedProgress[bk] = Math.max(
            (local.progressIndex && local.progressIndex[bk]) || 0,
            (cloud.progressIndex && cloud.progressIndex[bk]) || 0
          );
        });

        // 模考记录：按日期时间去重合并
        const examMap = new Map();
        [...(local.examHistory || []), ...(cloud.examHistory || [])].forEach(rec => {
          const key = `${rec.date}_${rec.score}_${rec.total}`;
          examMap.set(key, rec);
        });
        const mergedExamHistory = Array.from(examMap.values());

        mergedChildrenData[cid] = {
          answers: mergedAnswers,
          mistakes: mergedMistakes,
          favorites: mergedFavorites,
          progressIndex: mergedProgress,
          examHistory: mergedExamHistory
        };
      });

      this.setStorage('children_data', mergedChildrenData);
      if (cloudData._syncTs) {
        this.setStorage('cloud_ts', cloudData._syncTs);
      }

      return {
        profiles: mergedProfiles,
        activeProfile: this.getActiveProfile(),
        childrenData: mergedChildrenData
      };
    }
  }

  // 挂载到全局
  window.CloudSync = new CloudSyncEngine();

})();
