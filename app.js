/**
 * 美丽中国·版图小达人 - 刷题 App 核心逻辑脚本
 * 功能：题库筛选、顺序练习、随机速刷、全真模考、错题消灭战、收藏夹、答题卡、
 *       Web Audio音效、五彩纸屑撒花、知识手册全彩阅读器、LocalStorage进度持久化
 */

(function () {
  'use strict';

  // ==========================================
  // 1. 全局状态与持久化配置
  // ==========================================
  const AppState = {
    currentBankKey: 'unified', // unified, elem, middle, history, contest25, images, high_freq
    currentMode: 'sequence',   // sequence, random, exam, mistakes, favorites
    studyMode: 'practice',     // practice (做题模式), recite (背题模式)
    soundEnabled: true,
    theme: 'light',
    
    // 题目列表
    activeQuestions: [],
    currentIndex: 0,
    practiceAnswers: {},
    retryUids: new Set(),
    activeChildId: null,
    
    // 模拟考试状态
    exam: {
      active: false,
      reviewing: false,
      questions: [],
      userAnswers: {},
      timeRemaining: 1800, // 30 分钟 (秒)
      timerInterval: null
    },

    // 随机速刷状态
    randomCount: 20,

    // 多选暂存
    multiSelected: new Set(),

    // 用户学习数据 (持久化)
    userData: {
      progressIndex: {},        // { [bankKey]: index }
      progressQuestions: {},    // { [bankKey]: { uid, revision } }
      answers: {},              // { [uid]: choice }; 更新时间由 CloudSync 保存
      favorites: {},            // { [uid]: boolean }
      mistakes: {},             // { [uid]: { errorCount: number, consecutiveCorrect: number, mastered: boolean } }
      examHistory: [],          // [{ date, score, total, elapsed }]
      streakDays: 1,
      lastActiveDate: new Date().toISOString().slice(0, 10)
    }
  };

  // ==========================================
  // 2. 音效生成器 (Web Audio API - 零外部依赖)
  // ==========================================
  let audioCtx = null;
  function getAudioContext() {
    if (!audioCtx) {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (AudioContext) {
        audioCtx = new AudioContext();
      }
    }
    if (audioCtx && audioCtx.state === 'suspended') {
      audioCtx.resume();
    }
    return audioCtx;
  }

  const Sound = {
    playSuccess() {
      if (!AppState.soundEnabled) return;
      try {
        const ctx = getAudioContext();
        if (!ctx) return;
        const now = ctx.currentTime;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        
        osc.type = 'sine';
        osc.frequency.setValueAtTime(587.33, now); // D5
        osc.frequency.setValueAtTime(880, now + 0.08); // A5
        gain.gain.setValueAtTime(0.2, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
        osc.start(now);
        osc.stop(now + 0.35);
      } catch (e) {}
    },

    playError() {
      if (!AppState.soundEnabled) return;
      try {
        const ctx = getAudioContext();
        if (!ctx) return;
        const now = ctx.currentTime;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(220, now);
        osc.frequency.setValueAtTime(164.81, now + 0.1);
        gain.gain.setValueAtTime(0.2, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.3);
        osc.start(now);
        osc.stop(now + 0.3);
      } catch (e) {}
    },

    playClick() {
      if (!AppState.soundEnabled) return;
      try {
        const ctx = getAudioContext();
        if (!ctx) return;
        const now = ctx.currentTime;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.frequency.setValueAtTime(800, now);
        gain.gain.setValueAtTime(0.05, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.05);
        osc.start(now);
        osc.stop(now + 0.05);
      } catch (e) {}
    },

    playFanfare() {
      if (!AppState.soundEnabled) return;
      try {
        const ctx = getAudioContext();
        if (!ctx) return;
        const notes = [523.25, 659.25, 783.99, 1046.50];
        notes.forEach((freq, idx) => {
          const now = ctx.currentTime + idx * 0.1;
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.frequency.setValueAtTime(freq, now);
          gain.gain.setValueAtTime(0.18, now);
          gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
          osc.start(now);
          osc.stop(now + 0.35);
        });
      } catch (e) {}
    }
  };

  // ==========================================
  // 3. 庆祝纸屑特效 (Canvas Confetti)
  // ==========================================
  function launchConfetti() {
    const canvas = document.getElementById('confetti-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;

    const particles = [];
    const colors = ['#10b981', '#0284c7', '#f59e0b', '#ec4899', '#8b5cf6'];
    for (let i = 0; i < 90; i++) {
      particles.push({
        x: canvas.width / 2,
        y: canvas.height / 2,
        r: Math.random() * 6 + 3,
        color: colors[Math.floor(Math.random() * colors.length)],
        vx: (Math.random() - 0.5) * 16,
        vy: (Math.random() - 0.5) * 16 - 3,
        gravity: 0.35,
        alpha: 1
      });
    }

    function render() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      let alive = false;
      particles.forEach(p => {
        p.x += p.vx;
        p.y += p.vy;
        p.vy += p.gravity;
        p.alpha -= 0.015;
        if (p.alpha > 0) {
          alive = true;
          ctx.save();
          ctx.globalAlpha = p.alpha;
          ctx.fillStyle = p.color;
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        }
      });
      if (alive) {
        requestAnimationFrame(render);
      } else {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      }
    }
    render();
  }

  // ==========================================
  // 4. 数据存取与本地恢复 (基于 CloudSync 多孩子引擎)
  // ==========================================
  function loadUserData() {
    try {
      if (window.CloudSync) {
        AppState.userData = window.CloudSync.getActiveChildData();
        migrateBankProgress();
        AppState.activeChildId = window.CloudSync.getActiveProfile().id;
        updateChildChipUI();
      }
      const savedTheme = localStorage.getItem('beautiful_china_theme');
      if (savedTheme) {
        AppState.theme = savedTheme;
        document.documentElement.setAttribute('data-theme', savedTheme);
      }
      const savedSound = localStorage.getItem('beautiful_china_sound');
      if (savedSound !== null) {
        AppState.soundEnabled = savedSound === 'true';
      }
    } catch (e) {
      console.warn('loadUserData error', e);
    }
  }

  function saveUserData() {
    try {
      if (window.CloudSync) {
        window.CloudSync.saveActiveChildData(AppState.userData);
      }
    } catch (e) {
      console.warn('saveUserData error', e);
    }
  }

  function updateChildChipUI() {
    if (!window.CloudSync) return;
    const p = window.CloudSync.getActiveProfile();
    const avatarEl = document.getElementById('child-chip-avatar');
    const nameEl = document.getElementById('child-chip-name');
    if (avatarEl) avatarEl.textContent = p.avatar || '🦁';
    if (nameEl) nameEl.textContent = p.name || '大宝';
  }

  function updateSyncBadgeUI(statusInfo) {
    const badgeBtn = document.getElementById('sync-badge-btn');
    const iconEl = document.getElementById('sync-icon');
    const textEl = document.getElementById('sync-status-text');
    if (!badgeBtn || !textEl) return;

    badgeBtn.classList.remove('syncing', 'error', 'success');

    if (statusInfo.status === 'syncing') {
      badgeBtn.classList.add('syncing');
      if (iconEl) iconEl.textContent = '🔄';
      textEl.textContent = '同步中';
    } else if (statusInfo.status === 'error') {
      badgeBtn.classList.add('error');
      if (iconEl) iconEl.textContent = '⚠️';
      textEl.textContent = '同步异常';
    } else if (statusInfo.status === 'success') {
      badgeBtn.classList.add('success');
      if (iconEl) iconEl.textContent = '☁️';
      textEl.textContent = '已同步';
    } else {
      const code = window.CloudSync ? window.CloudSync.getSyncCode() : '';
      if (iconEl) iconEl.textContent = '☁️';
      textEl.textContent = code ? '已绑定' : '未绑定';
    }

    // 同步弹窗内的状态同步
    const modalStatus = document.getElementById('modal-sync-status-text');
    const modalLastTime = document.getElementById('modal-last-sync-time');
    if (modalStatus) {
      modalStatus.textContent = statusInfo.message || (window.CloudSync && window.CloudSync.getSyncCode() ? '已绑定' : '未绑定');
      modalStatus.style.color = statusInfo.status === 'error' ? 'var(--danger)' : 'var(--primary)';
    }
    if (modalLastTime && window.CloudSync) {
      const last = window.CloudSync.getStorage('last_sync_time');
      modalLastTime.textContent = last ? new Date(last).toLocaleTimeString() : '暂无记录';
    }
  }

  // ==========================================
  // 5. 题库检索与过滤
  // ==========================================
  function getRawQuestionsForBank(bankKey) {
    const data = window.BEAUTIFUL_CHINA_DATA;
    if (!data) return [];

    switch (bankKey) {
      case 'unified':
        return data.unified || [];
      case 'elem':
        return (data.banks && data.banks.elem) ? adaptRawList(data.banks.elem, '小学组样题库') : [];
      case 'middle':
        return (data.banks && data.banks.middle) ? adaptRawList(data.banks.middle, '中学组样题库') : [];
      case 'history':
        return (data.banks && data.banks.history) ? adaptRawList(data.banks.history, '历年真题汇编') : [];
      case 'contest25':
        return (data.banks && data.banks.contest25) ? adaptRawList(data.banks.contest25, '2025大赛题库') : [];
      case 'images':
        // 专精所有带配图/地图的考题
        return (data.unified || []).filter(q => q.images && q.images.length > 0);
      case 'high_freq':
        // 多题库交叉出现的超高频必考题
        return (data.unified || []).filter(q => q.sources && q.sources.length > 1);
      default:
        return data.unified || [];
    }
  }

  function adaptRawList(rawList, sourceTag) {
    return rawList.map(item => ({
      ...item,
      uid: item.id,
      question: item.title,
      options: item.options,
      answer: item.answer || '',
      type: item.type || 'single',
      images: item.images || [],
      sources: [sourceTag],
      original_id: item.id
    }));
  }

  function canGrade(q) {
    return !!q.answer && q.scorable !== false;
  }

  function pendingLabel(q) {
    return ({ source_conflict: '答案来源冲突', missing_diagram: '原资料缺少配图',
      invalid_options: '选项待核验' })[q.answer_status] || '答案待核验';
  }

  function escapeText(value) {
    return String(value).replace(/[&<>"']/g, char =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  }

  function evidenceHtml(q) {
    const evidence = q.conflicting_answers || q.answer_evidence || [];
    const seen = new Set();
    return evidence.filter(entry => {
      const reference = entry.reference || entry;
      const key = reference.file + ':' + reference.question_number;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, 4).map(entry => {
      const reference = entry.reference || entry;
      const label = reference.file + ' · 第 ' + reference.question_number + ' 题';
      const href = entry.url || encodeURI(reference.file) + (reference.page ? '#page=' + reference.page : '');
      return `<div><a href="${escapeText(href)}" target="_blank" rel="noopener">${escapeText(entry.url ? '共享核对记录 · 第 ' + reference.question_number + ' 题' : label)}</a>` +
        (entry.answer ? `（原题答案 ${escapeText(entry.answer)}）` : '') + '</div>';
    }).join('');
  }

  function updateBankLabels() {
    const select = document.getElementById('bank-select');
    const names = { unified: '⭐ 全库精选', elem: '🧒 小学组官方样题', middle: '🧑 中学组官方样题',
      history: '📜 历年真题模拟汇编', contest25: '🏆 2025大赛题库',
      images: '🗺️ 地图识图专项', high_freq: '🔥 多题库高频题' };
    if (select) Array.from(select.options).forEach(option => {
      const questions = getRawQuestionsForBank(option.value);
      option.textContent = `${names[option.value]} · ${questions.length}题`;
    });
  }

  function migrateBankProgress() {
    const data = window.BEAUTIFUL_CHINA_DATA;
    const revision = data?.summary?.bank_revision;
    if (!revision) return;
    AppState.userData.progressQuestions ||= {};
    for (const [bank, oldIndex] of Object.entries(AppState.userData.progressIndex || {})) {
      const saved = AppState.userData.progressQuestions[bank];
      const priorRevision = saved?.revision || AppState.userData.bankRevision;
      if (priorRevision === revision && !saved?.uid) continue;
      const oldOrder = data.progress_migrations?.[priorRevision]?.[bank] ||
        (!priorRevision ? data.original_bank_order?.[bank] : null);
      const oldUid = saved?.uid || oldOrder?.[oldIndex] ||
        (!priorRevision && bank === 'unified' ? 'Q_' + String(oldIndex + 1).padStart(4, '0') : null);
      const questions = getRawQuestionsForBank(bank).filter(canGrade);
      const mapped = data.summary.legacy_uid_map[oldUid] || oldUid;
      let index = questions.findIndex(q => q.uid === mapped);
      // If the saved question was retired, resume at the next surviving question.
      if (index < 0 && oldOrder) {
        for (const uid of oldOrder.slice(oldIndex + 1)) {
          index = questions.findIndex(q => q.uid === (data.summary.legacy_uid_map[uid] || uid));
          if (index >= 0) break;
        }
      }
      if (index < 0) index = 0;
      AppState.userData.progressIndex[bank] = index;
      if (questions[index]) AppState.userData.progressQuestions[bank] = {uid: questions[index].uid, revision};
    }
    AppState.userData.bankRevision = revision;
    saveUserData();
  }

  let allQuestions = null;
  function getAllQuestions() {
    if (!allQuestions) {
      const catalog = new Map();
      for (const bank of ['unified', 'elem', 'middle', 'history', 'contest25']) {
        getRawQuestionsForBank(bank).filter(canGrade).forEach(q => {
          catalog.set(q.uid, q);
          (q.legacy_uids || []).forEach(uid => catalog.set(uid, { ...q, uid }));
        });
      }
      allQuestions = Array.from(catalog.values());
    }
    return allQuestions;
  }

  function answerChoice(record) {
    return typeof record === 'string' ? record : record?.choice;
  }

  function currentAnswer(q) {
    if (AppState.currentMode === 'exam') return AppState.exam.userAnswers[q.uid];
    if (AppState.currentMode !== 'sequence') return AppState.practiceAnswers[q.uid];
    if (AppState.retryUids.has(q.uid)) return undefined;
    const keys = [q.uid, ...(q.legacy_uids || [])].sort((a, b) =>
      (AppState.userData.answerUpdatedAt?.[b] || 0) - (AppState.userData.answerUpdatedAt?.[a] || 0));
    return answerChoice(AppState.userData.answers[keys.find(uid => AppState.userData.answers[uid])]);
  }

  function stopExam() {
    AppState.exam.active = false;
    AppState.exam.reviewing = false;
    clearInterval(AppState.exam.timerInterval);
    AppState.exam.timerInterval = null;
  }

  function saveSequenceProgress() {
    if (AppState.currentMode !== 'sequence' || !AppState.activeQuestions.length) return;
    AppState.userData.progressIndex[AppState.currentBankKey] = AppState.currentIndex;
    AppState.userData.progressQuestions ||= {};
    AppState.userData.progressQuestions[AppState.currentBankKey] = {
      uid: AppState.activeQuestions[AppState.currentIndex].uid,
      revision: window.BEAUTIFUL_CHINA_DATA.summary.bank_revision
    };
    saveUserData();
  }

  // 根据当前主模式过滤题目集
  function prepareActiveQuestions() {
    stopExam();
    AppState.multiSelected.clear();
    AppState.practiceAnswers = {};
    AppState.retryUids.clear();
    let baseList = getRawQuestionsForBank(AppState.currentBankKey).filter(canGrade);

    if (AppState.currentMode === 'sequence') {
      AppState.activeQuestions = baseList;
      AppState.currentIndex = AppState.userData.progressIndex[AppState.currentBankKey] || 0;
      if (AppState.currentIndex >= AppState.activeQuestions.length) {
        AppState.currentIndex = 0;
      }
    } else if (AppState.currentMode === 'random') {
      const shuffled = [...baseList].sort(() => Math.random() - 0.5);
      AppState.activeQuestions = shuffled.slice(0, Math.min(AppState.randomCount, shuffled.length));
      AppState.currentIndex = 0;
    } else if (AppState.currentMode === 'exam') {
      // 全真模拟考：随机挑选50题
      const shuffled = [...baseList].sort(() => Math.random() - 0.5);
      AppState.activeQuestions = shuffled.slice(0, Math.min(50, shuffled.length));
      AppState.currentIndex = 0;
      AppState.exam.active = AppState.activeQuestions.length > 0;
      AppState.exam.userAnswers = {};
      AppState.exam.timeRemaining = 1800;
      if (AppState.exam.active) startExamTimer();
    } else if (AppState.currentMode === 'mistakes') {
      const mistakeUids = Object.keys(AppState.userData.mistakes).filter(uid => !AppState.userData.mistakes[uid].mastered);
      const allUnified = getAllQuestions();
      AppState.activeQuestions = allUnified.filter(q => canGrade(q) && mistakeUids.includes(q.uid));
      AppState.currentIndex = 0;
    } else if (AppState.currentMode === 'favorites') {
      const favUids = Object.keys(AppState.userData.favorites).filter(uid => AppState.userData.favorites[uid]);
      const allUnified = getAllQuestions();
      AppState.activeQuestions = allUnified.filter(q => canGrade(q) && favUids.includes(q.uid));
      AppState.currentIndex = 0;
    }

    renderCurrentQuestion();
    updateProgressUI();
    saveSequenceProgress();
  }

  // ==========================================
  // 6. 渲染核心试题卡片
  // ==========================================
  function renderCurrentQuestion() {
    const container = document.getElementById('question-card-container');
    if (!container) return;

    if (AppState.activeQuestions.length === 0) {
      let emptyTip = '当前模式下暂无试题';
      if (AppState.currentMode === 'mistakes') emptyTip = '太棒了！错题本空空如也，全部已消灭！🎉';
      if (AppState.currentMode === 'favorites') emptyTip = '暂无收藏题目，在答题时点击右上角★即可收藏。';
      if (AppState.currentMode === 'pending') emptyTip = '当前题库没有待核验题，可以切换题库继续学习。';
      if (AppState.currentMode === 'exam' || AppState.currentMode === 'random') emptyTip = '当前题库暂无已核定答案的题目，请切换题库或使用顺序刷题。';
      container.innerHTML = `
        <div style="text-align: center; padding: 48px 20px; color: var(--text-muted);">
          <div style="font-size: 48px; margin-bottom: 12px;">🌟</div>
          <h3 style="color: var(--text-main); margin-bottom: 8px;">${emptyTip}</h3>
          <p style="font-size: 0.9rem;">可以切换到【全库去重纯享版】或【顺序刷题】继续练习</p>
          <button class="nav-btn primary" style="margin-top: 18px;" onclick="window.AppBridge.switchMode('sequence'); window.AppBridge.switchBank('unified')">返回全库练习</button>
        </div>
      `;
      document.getElementById('prev-btn').disabled = true;
      document.getElementById('next-btn').disabled = true;
      return;
    }

    const q = AppState.activeQuestions[AppState.currentIndex];
    const isStarred = !!AppState.userData.favorites[q.uid];
    const userRecord = currentAnswer(q);
    const takingExam = AppState.currentMode === 'exam' && !AppState.exam.reviewing;

    const isReciteMode = AppState.studyMode === 'recite' && AppState.currentMode !== 'exam';
    const hasAnswered = !!userRecord || isReciteMode || AppState.exam.reviewing;
    const isMulti = q.type === 'multi' || (q.answer && q.answer.length > 1);

    // 来源徽章
    const sourceBadges = (q.sources || []).map(s => `<span class="q-source-badge">${escapeText(s)}</span>`).join('');
    const reference = q.source_reference;
    const sourceLink = reference ? `<a class="q-source-badge" href="${encodeURI(reference.file)}${reference.page ? '#page=' + reference.page : ''}" target="_blank" rel="noopener">原文件第 ${reference.question_number} 题</a>` : '';
    const isHot = (q.sources || []).length > 1;

    // 配图
    let imagesHtml = '';
    if (q.images && q.images.length > 0) {
      imagesHtml = `
        <div class="q-images-gallery">
          ${q.images.map(img => `
            <div class="q-img-wrap" onclick="window.AppBridge.zoomImage('${img}')">
              <img src="${img}" alt="试题配图" class="q-img" loading="lazy" />
              <span class="q-img-zoom-tip">🔍 点击查看大图</span>
            </div>
          `).join('')}
        </div>
      `;
    }

    // 选项列表
    let optionsHtml = '';
    const letters = ['A', 'B', 'C', 'D', 'E', 'F'];
    if (q.options && q.options.length > 0) {
      optionsHtml = `
        <div class="options-list">
          ${q.options.map((optStr, optIdx) => {
            const letter = letters[optIdx] || optStr.charAt(0);
            const cleanText = escapeText(optStr.replace(/^[A-F][\.、\uff0e\s]*/, '').replace(new RegExp('^' + letter + '[.、．\\s]+'), ''));
            
            let itemClass = 'option-item';
            let isOptionCorrect = q.answer && q.answer.includes(letter);

            if (takingExam) {
              if (userRecord && userRecord.includes(letter)) {
                itemClass += ' selected';
              }
            } else {
              // 练习模式或背题模式
              if (hasAnswered) {
                itemClass += ' disabled';
                if (!canGrade(q) && userRecord && userRecord.includes(letter)) {
                  itemClass += ' selected';
                } else if (isOptionCorrect) {
                  itemClass += ' correct';
                } else if (canGrade(q) && userRecord && userRecord.includes(letter)) {
                  itemClass += ' wrong';
                }
              } else if (isMulti && AppState.multiSelected.has(letter)) {
                itemClass += ' selected';
              }
            }

            return `
              <div class="${itemClass}" onclick="window.AppBridge.selectOption('${letter}')">
                <span class="opt-letter">${letter}</span>
                <span class="opt-text">${cleanText}</span>
                ${q.answer_mode === 'ordered' && (userRecord || Array.from(AppState.multiSelected).join('')).includes(letter) ?
                  `<span class="selection-order">第 ${(userRecord || Array.from(AppState.multiSelected).join('')).indexOf(letter) + 1} 空</span>` : ''}
              </div>
            `;
          }).join('')}
        </div>
      `;
    }

    // 多选提交按钮
    let multiSubmitHtml = '';
    if (isMulti && !hasAnswered && AppState.currentMode !== 'exam') {
      multiSubmitHtml = `
        <button class="multi-submit-btn" onclick="window.AppBridge.submitMultiAnswer()">
          ${q.answer_mode === 'ordered' ? '按顺序填空 · ' + (Array.from(AppState.multiSelected).join(' → ') || '请依次选择') : '确认提交多选 (已选 ' + AppState.multiSelected.size + ' 项)'}
        </button>
      `;
    }

    // 答案解析面板
    let resultBannerHtml = '';
    if (!canGrade(q) && !hasAnswered) {
      resultBannerHtml = `<div class="result-banner"><div class="result-header">📖 ${pendingLabel(q)}</div>` +
        `<div class="result-explanation">${escapeText(q.pending_reason || '尚无可核验的答案')}。此题不计分，可收藏后继续学习。</div></div>`;
    }
    if (hasAnswered && !takingExam) {
      const isCorrect = userRecord && userRecord === q.answer;
      if (!canGrade(q)) {
        resultBannerHtml = `
          <div class="result-banner">
            <div class="result-header">📖 ${pendingLabel(q)}${userRecord ? ' · 你的选择：' + userRecord : ''}</div>
            <div class="result-explanation">${escapeText(q.pending_reason || '尚无可核验的答案')}。此题不计对错，也不加入错题本。</div>
          </div>`;
      } else if (isReciteMode) {
        resultBannerHtml = `
          <div class="result-banner correct">
            <div class="result-header">📖 背题速记模式 · 正确答案：${q.answer || '参考手册'}</div>
            <div class="result-explanation">
              💡 提示：本题考查国家版图核心知识点，建议结合《国家版图知识手册》深度理解。
            </div>
          </div>
        `;
      } else if (isCorrect) {
        resultBannerHtml = `
          <div class="result-banner correct">
            <div class="result-header">✅ 回答正确！标准答案：${q.answer}</div>
            <div class="result-explanation">太棒了！已为你巩固该知识点。</div>
          </div>
        `;
      } else {
        resultBannerHtml = `
          <div class="result-banner wrong">
            <div class="result-header">❌ 回答错误！正确答案是：【${q.answer || '待核定'}】</div>
            <div class="result-explanation">
              已将该题自动收录至【错题消灭战】。连续答对 2 次即可彻底消灭！
            </div>
          </div>
        `;
      }
      const evidence = evidenceHtml(q);
      if (q.answer_explanation) resultBannerHtml += `<div class="result-explanation answer-note">${escapeText(q.answer_explanation)}</div>`;
      if (evidence) resultBannerHtml += `<div class="result-explanation" style="margin-top: 12px;">答案依据：${evidence}</div>`;
      if (q.answer_status === 'matched') resultBannerHtml += '<div class="result-explanation">本题答案已按选项内容对应；参考题的字母属于参考题自己的选项顺序。</div>';
      if (!isReciteMode && AppState.currentMode !== 'exam') {
        resultBannerHtml += '<button class="nav-btn" style="margin-top: 12px;" onclick="window.AppBridge.retryQuestion()">🔁 再答一次</button>';
      }
    }

    container.innerHTML = `
      <div class="q-meta-row">
        <div class="q-tags">
          <span class="q-type-badge">${q.answer_mode === 'ordered' ? '按顺序填空' : q.type === 'unknown' ? '题型待核验' : isMulti ? '多选题' : '单选题'}</span>
          ${!canGrade(q) ? `<span class="q-source-badge">${pendingLabel(q)} · 不计分</span>` : ''}
          ${isHot ? '<span class="q-hot-badge">🔥 超高频考题</span>' : ''}
          ${sourceBadges}
          ${sourceLink}
        </div>
        <button class="q-fav-toggle ${isStarred ? 'starred' : ''}" onclick="window.AppBridge.toggleFavorite('${q.uid}')" title="收藏此题">
          ${isStarred ? '★' : '☆'}
        </button>
      </div>

      <div class="q-title">
        <span style="color: var(--primary); font-weight: 700; margin-right: 6px;">第 ${AppState.currentIndex + 1} 题.</span>
        ${escapeText(q.question)}
      </div>

      ${imagesHtml}
      ${optionsHtml}
      ${multiSubmitHtml}
      ${resultBannerHtml}
    `;

    // 导航按钮状态
    document.getElementById('prev-btn').disabled = AppState.currentIndex === 0;
    document.getElementById('next-btn').disabled = AppState.currentIndex >= AppState.activeQuestions.length - 1;

  }

  // ==========================================
  // 7. 用户答题与交互处理
  // ==========================================
  function handleSelectOption(letter) {
    if (AppState.activeQuestions.length === 0) return;
    const q = AppState.activeQuestions[AppState.currentIndex];
    if (!q.options.some(option => option[0] === letter)) return;
    const isMulti = q.type === 'multi' || (q.answer && q.answer.length > 1);

    Sound.playClick();

    // 模考模式
    if (AppState.currentMode === 'exam') {
      if (!AppState.exam.active) return;
      if (isMulti) {
        let current = AppState.exam.userAnswers[q.uid] || '';
        if (current.includes(letter)) {
          current = current.replace(letter, '');
        } else {
          current = q.answer_mode === 'ordered' ? current + letter : (current + letter).split('').sort().join('');
        }
        AppState.exam.userAnswers[q.uid] = current;
      } else {
        AppState.exam.userAnswers[q.uid] = letter;
      }
      renderCurrentQuestion();
      updateProgressUI();
      return;
    }

    // 普通练习模式
    if (AppState.studyMode === 'recite') return; // 背题模式点击不触发回答

    // 本轮已提交的题目通过“再答一次”重新作答。
    if (currentAnswer(q)) return;

    if (isMulti) {
      if (AppState.multiSelected.has(letter)) {
        AppState.multiSelected.delete(letter);
      } else {
        AppState.multiSelected.add(letter);
      }
      renderCurrentQuestion();
    } else {
      // 单选题即选即判定
      processUserAnswer(letter, q);
    }
  }

  function submitMultiAnswer() {
    if (AppState.multiSelected.size === 0 || AppState.studyMode === 'recite' || AppState.currentMode === 'exam') return;
    const q = AppState.activeQuestions[AppState.currentIndex];
    if (!q || currentAnswer(q)) return;
    const selected = Array.from(AppState.multiSelected);
    const finalAnswer = (q.answer_mode === 'ordered' ? selected : selected.sort()).join('');
    AppState.multiSelected.clear();
    processUserAnswer(finalAnswer, q);
  }

  function recordLearningAnswer(choice, q) {
    const isCorrect = choice === q.answer;

    // 记录答题记录
    AppState.userData.answers[q.uid] = choice;
    AppState.userData.answerUpdatedAt ||= {};
    AppState.userData.answerUpdatedAt[q.uid] = Math.max(Date.now(),
      (AppState.userData.answerUpdatedAt[q.uid] || 0) + 1, AppState.userData.resetAt || 0);
    if (!canGrade(q)) return;

    // 错题消灭战逻辑
    if (!isCorrect) {
      if (!AppState.userData.mistakes[q.uid]) {
        AppState.userData.mistakes[q.uid] = { errorCount: 0, consecutiveCorrect: 0, mastered: false };
      }
      AppState.userData.mistakes[q.uid].errorCount += 1;
      AppState.userData.mistakes[q.uid].consecutiveCorrect = 0;
      AppState.userData.mistakes[q.uid].mastered = false;
    } else {
      if (AppState.userData.mistakes[q.uid]) {
        AppState.userData.mistakes[q.uid].consecutiveCorrect += 1;
        if (AppState.userData.mistakes[q.uid].consecutiveCorrect >= 2) {
          AppState.userData.mistakes[q.uid].mastered = true;
        }
      }
    }
  }

  function processUserAnswer(choice, q) {
    recordLearningAnswer(choice, q);
    AppState.practiceAnswers[q.uid] = choice;
    AppState.retryUids.delete(q.uid);
    if (canGrade(q)) {
      if (choice === q.answer) Sound.playSuccess();
      else Sound.playError();
      if (AppState.userData.mistakes[q.uid]?.mastered) launchConfetti();
    }

    saveUserData();
    renderCurrentQuestion();
    updateProgressUI();

    // 若做对了，自动微延迟播放撒花（整套刷完或里程碑）
    checkMilestones();
  }

  function checkMilestones() {
    // 若当前是随机速刷并且全部答完，弹出成绩卡
    if (AppState.currentMode === 'random') {
      const allDone = AppState.activeQuestions.every(q => AppState.practiceAnswers[q.uid]);
      if (allDone) {
        showRandomResultReport();
      }
    }
  }

  function showRandomResultReport() {
    let correctCount = 0;
    AppState.activeQuestions.forEach(q => {
      if (AppState.practiceAnswers[q.uid] === q.answer) correctCount++;
    });
    const total = AppState.activeQuestions.length;
    const score = Math.round((correctCount / total) * 100);

    Sound.playFanfare();
    launchConfetti();

    const modal = document.getElementById('report-modal');
    const content = document.getElementById('report-content');
    if (modal && content) {
      content.innerHTML = `
        <div class="report-card">
          <div class="report-score-circle">
            <span class="report-score-num">${score}</span>
            <span class="report-score-label">速刷得分</span>
          </div>
          <h3 style="margin-top: 6px;">🎉 本组速刷挑战完成！</h3>
          <p style="color: var(--text-muted); font-size: 0.9rem;">
            共 ${total} 题，答对 ${correctCount} 题，正确率 ${score}%
          </p>
          <div class="report-stats-grid">
            <div class="report-stat-item">
              <div class="report-stat-val" style="color: var(--success);">${correctCount}</div>
              <div class="report-stat-lbl">答对题数</div>
            </div>
            <div class="report-stat-item">
              <div class="report-stat-val" style="color: var(--danger);">${total - correctCount}</div>
              <div class="report-stat-lbl">错题已入库</div>
            </div>
            <div class="report-stat-item">
              <div class="report-stat-val" style="color: var(--warning);">${score}%</div>
              <div class="report-stat-lbl">正确率</div>
            </div>
          </div>
          <button class="nav-btn primary" style="margin-top: 14px;" onclick="window.AppBridge.closeModal('report-modal'); window.AppBridge.switchMode('random');">
            再来一组 (20题)
          </button>
        </div>
      `;
      modal.classList.add('active');
    }
  }

  // ==========================================
  // 8. 模拟考试系统与倒计时
  // ==========================================
  function startExamTimer() {
    if (AppState.exam.timerInterval) clearInterval(AppState.exam.timerInterval);
    AppState.exam.timerInterval = setInterval(() => {
      if (!AppState.exam.active) {
        clearInterval(AppState.exam.timerInterval);
        return;
      }
      AppState.exam.timeRemaining--;
      updateExamTimerDisplay();
      if (AppState.exam.timeRemaining <= 0) {
        clearInterval(AppState.exam.timerInterval);
        finishExam();
      }
    }, 1000);
  }

  function updateExamTimerDisplay() {
    const timerEl = document.getElementById('exam-timer-display');
    if (!timerEl) return;
    const m = Math.floor(AppState.exam.timeRemaining / 60);
    const s = AppState.exam.timeRemaining % 60;
    timerEl.textContent = `⏱️ 倒计时: ${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }

  function finishExam() {
    if (!AppState.exam.active || AppState.currentMode !== 'exam') return;
    AppState.exam.active = false;
    clearInterval(AppState.exam.timerInterval);
    AppState.exam.timerInterval = null;

    let correctCount = 0;
    AppState.activeQuestions.forEach(q => {
      if (AppState.exam.userAnswers[q.uid] === q.answer) {
        correctCount++;
      }
      if (AppState.exam.userAnswers[q.uid]) recordLearningAnswer(AppState.exam.userAnswers[q.uid], q);
    });

    const total = AppState.activeQuestions.length;
    const score = Math.round((correctCount / total) * 100);
    const elapsed = 1800 - AppState.exam.timeRemaining;

    // 记录历史
    AppState.userData.examHistory.push({
      id: 'exam_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
      timestamp: Date.now(),
      date: new Date().toLocaleString(),
      score: score,
      total: total,
      correct: correctCount,
      elapsed: elapsed
    });
    saveUserData();
    updateProgressUI();

    Sound.playFanfare();
    launchConfetti();

    const modal = document.getElementById('report-modal');
    const content = document.getElementById('report-content');
    if (modal && content) {
      let badge = '🥉 继续努力';
      if (score >= 90) badge = '👑 版图金牌卫士！';
      else if (score >= 80) badge = '🥈 测绘小标兵！';
      else if (score >= 60) badge = '🥉 达标小卫士！';

      content.innerHTML = `
        <div class="report-card">
          <div class="report-score-circle">
            <span class="report-score-num">${score}</span>
            <span class="report-score-label">模考总分</span>
          </div>
          <h2 style="margin-top: 4px; color: var(--primary);">${badge}</h2>
          <p style="color: var(--text-muted); font-size: 0.9rem;">
            共 ${total} 题，耗时 ${Math.floor(elapsed / 60)} 分 ${elapsed % 60} 秒
          </p>
          <div class="report-stats-grid">
            <div class="report-stat-item">
              <div class="report-stat-val" style="color: var(--success);">${correctCount}</div>
              <div class="report-stat-lbl">答对题数</div>
            </div>
            <div class="report-stat-item">
              <div class="report-stat-val" style="color: var(--danger);">${total - correctCount}</div>
              <div class="report-stat-lbl">答错题数</div>
            </div>
            <div class="report-stat-item">
              <div class="report-stat-val" style="color: var(--warning);">${score} 分</div>
              <div class="report-stat-lbl">折合百分制</div>
            </div>
          </div>
          <div style="display: flex; gap: 10px; margin-top: 14px;">
            <button class="nav-btn primary" onclick="window.AppBridge.reviewExam()">
              查看全部答卷解析
            </button>
            <button class="nav-btn" onclick="window.AppBridge.closeModal('report-modal'); window.AppBridge.switchMode('exam');">
              重新考一次
            </button>
          </div>
        </div>
      `;
      modal.classList.add('active');
    }
  }

  // ==========================================
  // 9. 界面更新与统计展示
  // ==========================================
  function updateProgressUI() {
    const timer = document.getElementById('exam-timer-display');
    if (timer) timer.style.display = AppState.exam.active ? '' : 'none';
    const submit = document.getElementById('exam-submit-btn');
    if (submit) submit.style.display = AppState.exam.active ? '' : 'none';
    if (AppState.exam.active) updateExamTimerDisplay();
    const total = AppState.activeQuestions.length;
    const cur = AppState.currentIndex + 1;
    const percent = total > 0 ? (cur / total) * 100 : 0;

    const fill = document.getElementById('progress-fill');
    if (fill) fill.style.width = `${percent}%`;

    const info = document.getElementById('progress-text');
    if (info) info.textContent = total > 0 ? `${cur} / ${total}` : '0 / 0';

    // 统计正确与错误
    let correctTotal = 0;
    let wrongTotal = 0;
    const allUnified = getAllQuestions();
    allUnified.forEach(q => {
      const rec = answerChoice(AppState.userData.answers[q.uid]);
      if (rec && canGrade(q)) {
        if (rec === q.answer) correctTotal++;
        else wrongTotal++;
      }
    });

    const correctBadge = document.getElementById('correct-count-badge');
    if (correctBadge) correctBadge.textContent = `✓ ${correctTotal}`;

    const wrongBadge = document.getElementById('wrong-count-badge');
    if (wrongBadge) wrongBadge.textContent = `✗ ${wrongTotal}`;
  }

  // ==========================================
  // 10. 答题卡抽屉 (Question Drawer)
  // ==========================================
  function openQuestionSheet() {
    const modal = document.getElementById('sheet-modal');
    const grid = document.getElementById('sheet-grid');
    if (!modal || !grid) return;

    grid.innerHTML = AppState.activeQuestions.map((q, idx) => {
      let cls = 'grid-cell';
      if (idx === AppState.currentIndex) cls += ' current';
      
      const userAns = currentAnswer(q);

      if (userAns) {
        if (AppState.currentMode === 'exam' && !AppState.exam.reviewing) {
          cls += ' correct'; // 模考中做过就亮色
        } else {
          if (canGrade(q)) cls += userAns === q.answer ? ' correct' : ' wrong';
        }
      }

      if (AppState.userData.favorites[q.uid]) {
        cls += ' starred';
      }

      return `
        <div class="${cls}" onclick="window.AppBridge.jumpToQuestion(${idx})">
          ${idx + 1}
        </div>
      `;
    }).join('');

    modal.classList.add('active');
  }

  // ==========================================
  // 11. 《国家版图知识手册》全彩画册阅读器
  // ==========================================
  let currentHandbookPage = 1;
  const TOTAL_HANDBOOK_PAGES = 39;

  function openHandbookReader(page = 1) {
    currentHandbookPage = Math.max(1, Math.min(TOTAL_HANDBOOK_PAGES, page));
    renderHandbookPage();
    const modal = document.getElementById('handbook-modal');
    if (modal) modal.classList.add('active');
  }

  function renderHandbookPage() {
    const imgEl = document.getElementById('handbook-viewer-img');
    const indicator = document.getElementById('handbook-page-indicator');
    if (imgEl) {
      const pageNumStr = currentHandbookPage.toString().padStart(2, '0');
      imgEl.src = `assets/handbook/handbook_p${pageNumStr}.jpg`;
    }
    if (indicator) {
      indicator.textContent = `第 ${currentHandbookPage} / ${TOTAL_HANDBOOK_PAGES} 页`;
    }
    // 更新章节按钮高亮
    document.querySelectorAll('.chapter-btn').forEach(btn => {
      const p = parseInt(btn.dataset.page, 10);
      btn.classList.toggle('active', p === currentHandbookPage);
    });
  }

  function changeHandbookPage(delta) {
    currentHandbookPage = Math.max(1, Math.min(TOTAL_HANDBOOK_PAGES, currentHandbookPage + delta));
    renderHandbookPage();
  }

  // ==========================================
  // 12. 学情看板与成就徽章
  // ==========================================
  function openStatsModal() {
    const modal = document.getElementById('stats-modal');
    const content = document.getElementById('stats-modal-content');
    if (!modal || !content) return;

    const allUnified = getAllQuestions();
    let answeredCount = 0;
    let gradedCount = 0;
    let correctCount = 0;

    allUnified.forEach(q => {
      const rec = answerChoice(AppState.userData.answers[q.uid]);
      if (rec) {
        answeredCount++;
        if (canGrade(q)) {
          gradedCount++;
          if (rec === q.answer) correctCount++;
        }
      }
    });

    const accuracy = gradedCount > 0 ? Math.round((correctCount / gradedCount) * 100) : 0;
    const verifiedUids = new Set(allUnified.filter(canGrade).map(q => q.uid));
    const masteredCount = Object.keys(AppState.userData.mistakes).filter(uid =>
      verifiedUids.has(uid) && AppState.userData.mistakes[uid].mastered).length;

    content.innerHTML = `
      <div style="display: flex; flex-direction: column; gap: 20px;">
        <div class="stats-summary-grid">
          <div class="stats-metric">
            <div style="font-size: 1.5rem; font-weight: 800; color: var(--primary);">${answeredCount}</div>
            <div style="font-size: 0.8rem; color: var(--text-muted);">已练题数</div>
          </div>
          <div class="stats-metric">
            <div style="font-size: 1.5rem; font-weight: 800; color: var(--warning);">${accuracy}%</div>
            <div style="font-size: 0.8rem; color: var(--text-muted);">正确率</div>
          </div>
          <div class="stats-metric">
            <div style="font-size: 1.5rem; font-weight: 800; color: var(--success);">${masteredCount}</div>
            <div style="font-size: 0.8rem; color: var(--text-muted);">消灭错题</div>
          </div>
        </div>

        <div>
          <h4 style="margin-bottom: 10px; color: var(--text-main);">🏅 备赛荣誉勋章</h4>
          <div class="stats-medals-grid">
            <div style="padding: 12px; border-radius: var(--radius-md); border: 1px solid ${answeredCount >= 10 ? 'var(--primary)' : 'var(--border-color)'}; background: ${answeredCount >= 10 ? 'var(--primary-light)' : 'var(--bg-main)'}; display: flex; align-items: center; gap: 10px;">
              <span style="font-size: 26px;">🌱</span>
              <div>
                <div style="font-weight: 700; font-size: 0.9rem;">初出茅庐</div>
                <div style="font-size: 0.75rem; color: var(--text-muted);">完成任意 10 道题目</div>
              </div>
            </div>
            <div style="padding: 12px; border-radius: var(--radius-md); border: 1px solid ${answeredCount >= 100 ? 'var(--primary)' : 'var(--border-color)'}; background: ${answeredCount >= 100 ? 'var(--primary-light)' : 'var(--bg-main)'}; display: flex; align-items: center; gap: 10px;">
              <span style="font-size: 26px;">🗺️</span>
              <div>
                <div style="font-weight: 700; font-size: 0.9rem;">测绘小达人</div>
                <div style="font-size: 0.75rem; color: var(--text-muted);">累计刷题满 100 道</div>
              </div>
            </div>
            <div style="padding: 12px; border-radius: var(--radius-md); border: 1px solid ${masteredCount >= 10 ? 'var(--primary)' : 'var(--border-color)'}; background: ${masteredCount >= 10 ? 'var(--primary-light)' : 'var(--bg-main)'}; display: flex; align-items: center; gap: 10px;">
              <span style="font-size: 26px;">⚔️</span>
              <div>
                <div style="font-weight: 700; font-size: 0.9rem;">错题消灭勇士</div>
                <div style="font-size: 0.75rem; color: var(--text-muted);">攻克消灭 10 道错题</div>
              </div>
            </div>
            <div style="padding: 12px; border-radius: var(--radius-md); border: 1px solid ${accuracy >= 85 && gradedCount >= 50 ? 'var(--primary)' : 'var(--border-color)'}; background: ${accuracy >= 85 && gradedCount >= 50 ? 'var(--primary-light)' : 'var(--bg-main)'}; display: flex; align-items: center; gap: 10px;">
              <span style="font-size: 26px;">👑</span>
              <div>
                <div style="font-weight: 700; font-size: 0.9rem;">版图金牌卫士</div>
                <div style="font-size: 0.75rem; color: var(--text-muted);">正确率超过 85%</div>
              </div>
            </div>
          </div>
        </div>

        <div class="stats-actions">
          <button class="nav-btn" onclick="window.AppBridge.exportProgress()">📤 导出备份</button>
          <button class="nav-btn" style="color: var(--danger);" onclick="window.AppBridge.resetProgress()">⚠️ 重置进度</button>
        </div>
      </div>
    `;
    modal.classList.add('active');
  }

  // ==========================================
  // 13. 数据备份与重置
  // ==========================================
  function exportProgress() {
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(AppState.userData));
    const dlAnchor = document.createElement('a');
    dlAnchor.setAttribute("href", dataStr);
    dlAnchor.setAttribute("download", `版图知识竞赛刷题进度_${new Date().toISOString().slice(0, 10)}.json`);
    document.body.appendChild(dlAnchor);
    dlAnchor.click();
    dlAnchor.remove();
  }

  function resetProgress() {
    if (confirm('确认清空所有历史做题记录与错题本吗？此操作无法撤销。')) {
      AppState.userData = {
        progressIndex: {},
        answers: {},
        favorites: {},
        mistakes: {},
        examHistory: [],
        streakDays: 1,
        lastActiveDate: new Date().toISOString().slice(0, 10),
        resetAt: Date.now()
      };
      saveUserData();
      alert('已重置进度！');
      location.reload();
    }
  }

  // ==========================================
  // 14. 键盘事件监听 (快捷刷题)
  // ==========================================
  window.addEventListener('keydown', (e) => {
    // 忽略在输入框中的按键
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName) || document.querySelector('.modal-overlay.active')) return;

    if (e.key === 'ArrowLeft') {
      window.AppBridge.prevQuestion();
    } else if (e.key === 'ArrowRight' || e.key === 'Enter') {
      window.AppBridge.nextQuestion();
    } else if (['1', '2', '3', '4', '5', '6', 'a', 'b', 'c', 'd', 'e', 'f', 'A', 'B', 'C', 'D', 'E', 'F'].includes(e.key)) {
      const map = { '1': 'A', '2': 'B', '3': 'C', '4': 'D', '5': 'E', '6': 'F' };
      const letter = map[e.key] || e.key.toUpperCase();
      window.AppBridge.selectOption(letter);
    }
  });

  // ==========================================
  // 15. 暴露全局 Bridge 供 HTML 绑定
  // ==========================================
  window.AppBridge = {
    switchBank(bankKey) {
      AppState.currentBankKey = bankKey;
      const selectEl = document.getElementById('bank-select');
      if (selectEl) selectEl.value = bankKey;
      updateBankLabels();
      prepareActiveQuestions();
    },

    switchMode(modeKey) {
      if (!['sequence', 'random', 'exam', 'mistakes', 'favorites'].includes(modeKey)) modeKey = 'sequence';
      AppState.currentMode = modeKey;
      document.querySelectorAll('.mode-pills .pill-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.mode === modeKey);
      });
      prepareActiveQuestions();
    },

    toggleStudyMode() {
      AppState.studyMode = AppState.studyMode === 'practice' ? 'recite' : 'practice';
      const btn = document.getElementById('study-mode-toggle-btn');
      if (btn) {
        btn.textContent = AppState.studyMode === 'practice' ? '🎯 做题模式' : '📖 背题模式';
      }
      renderCurrentQuestion();
    },

    selectOption(letter) {
      handleSelectOption(letter);
    },

    submitMultiAnswer() {
      submitMultiAnswer();
    },

    retryQuestion() {
      const q = AppState.activeQuestions[AppState.currentIndex];
      if (!q || AppState.currentMode === 'exam') return;
      if (AppState.currentMode === 'sequence') AppState.retryUids.add(q.uid);
      delete AppState.practiceAnswers[q.uid];
      AppState.multiSelected.clear();
      renderCurrentQuestion();
    },

    nextQuestion() {
      if (AppState.currentIndex < AppState.activeQuestions.length - 1) {
        AppState.currentIndex++;
        AppState.multiSelected.clear();
        renderCurrentQuestion();
        updateProgressUI();
        saveSequenceProgress();
      }
    },

    prevQuestion() {
      if (AppState.currentIndex > 0) {
        AppState.currentIndex--;
        AppState.multiSelected.clear();
        renderCurrentQuestion();
        updateProgressUI();
        saveSequenceProgress();
      }
    },

    jumpToQuestion(idx) {
      if (!Number.isInteger(idx) || idx < 0 || idx >= AppState.activeQuestions.length) return;
      AppState.currentIndex = idx;
      AppState.multiSelected.clear();
      renderCurrentQuestion();
      updateProgressUI();
      saveSequenceProgress();
      window.AppBridge.closeModal('sheet-modal');
    },

    toggleFavorite(uid) {
      AppState.userData.favorites[uid] = !AppState.userData.favorites[uid];
      saveUserData();
      renderCurrentQuestion();
    },

    openQuestionSheet() {
      openQuestionSheet();
    },

    openHandbook(page) {
      openHandbookReader(page);
    },

    changeHandbookPage(delta) {
      changeHandbookPage(delta);
    },

    openStats() {
      openStatsModal();
    },

    exportProgress() {
      exportProgress();
    },

    resetProgress() {
      resetProgress();
    },

    toggleSound() {
      AppState.soundEnabled = !AppState.soundEnabled;
      localStorage.setItem('beautiful_china_sound', AppState.soundEnabled);
      const btn = document.getElementById('sound-toggle-btn');
      if (btn) btn.textContent = AppState.soundEnabled ? '🔊' : '🔇';
    },

    toggleTheme() {
      AppState.theme = AppState.theme === 'light' ? 'dark' : 'light';
      document.documentElement.setAttribute('data-theme', AppState.theme);
      localStorage.setItem('beautiful_china_theme', AppState.theme);
      const btn = document.getElementById('theme-toggle-btn');
      if (btn) btn.textContent = AppState.theme === 'light' ? '🌙' : '☀️';
    },

    zoomImage(src) {
      const modal = document.getElementById('image-zoom-modal');
      const img = document.getElementById('zoom-modal-img');
      if (modal && img) {
        img.src = src;
        modal.classList.add('active');
      }
    },

    closeModal(modalId) {
      const modal = document.getElementById(modalId);
      if (modal) modal.classList.remove('active');
    },

    submitExam() {
      if (!AppState.exam.active) return;
      if (confirm('确认现在提交试卷并查看得分成绩吗？')) {
        finishExam();
      }
    },

    reviewExam() {
      if (AppState.currentMode !== 'exam' || AppState.exam.active) return;
      AppState.exam.reviewing = true;
      AppState.currentIndex = 0;
      window.AppBridge.closeModal('report-modal');
      renderCurrentQuestion();
      updateProgressUI();
    },

    // --- 孩子档案管理 Bridge ---
    openChildModal() {
      const modal = document.getElementById('child-modal');
      const listEl = document.getElementById('children-card-list');
      if (!modal || !listEl || !window.CloudSync) return;

      const profiles = window.CloudSync.getProfiles();
      const active = window.CloudSync.getActiveProfile();
      const allChildrenData = window.CloudSync.getStorage('children_data', {});

      listEl.innerHTML = profiles.map(p => {
        const cData = allChildrenData[p.id] || { answers: {} };
        const answeredCount = Object.keys(cData.answers || {}).length;
        const isActive = p.id === active.id;

        return `
          <div class="child-profile-card ${isActive ? 'active' : ''}" onclick="window.AppBridge.switchChild('${p.id}')">
            <div class="child-card-left">
              <div class="child-avatar-circle">${escapeText(p.avatar || '🦁')}</div>
              <div>
                <div class="child-info-name">
                  ${escapeText(p.name)}
                  ${isActive ? '<span class="child-active-tag">正在刷题</span>' : ''}
                </div>
                <div class="child-info-meta">
                  ${escapeText(p.grade || '小学组')} · 已答 ${answeredCount} 题
                </div>
              </div>
            </div>
            ${profiles.length > 1 ? `
              <button onclick="event.stopPropagation(); window.AppBridge.deleteChild('${p.id}')" title="删除该孩子档案" style="background:none; border:none; color:var(--text-muted); cursor:pointer; font-size:16px; padding:4px;">
                🗑️
              </button>
            ` : ''}
          </div>
        `;
      }).join('');

      // 绑定头像选择器交互
      document.querySelectorAll('#new-child-avatar-picker .avatar-pick-item').forEach(item => {
        item.onclick = () => {
          document.querySelectorAll('#new-child-avatar-picker .avatar-pick-item').forEach(i => i.classList.remove('selected'));
          item.classList.add('selected');
        };
      });

      modal.classList.add('active');
    },

    switchChild(childId) {
      if (!window.CloudSync) return;
      window.CloudSync.setActiveProfile(childId);
      window.AppBridge.closeModal('child-modal');
    },

    addNewChild() {
      if (!window.CloudSync) return;
      const nameInput = document.getElementById('new-child-name');
      const gradeSelect = document.getElementById('new-child-grade');
      const selectedAvatar = document.querySelector('#new-child-avatar-picker .avatar-pick-item.selected');

      const name = nameInput ? nameInput.value.trim() : '';
      if (!name) {
        alert('请输入孩子的昵称！');
        return;
      }
      const grade = gradeSelect ? gradeSelect.value : '小学组';
      const avatar = selectedAvatar ? selectedAvatar.dataset.avatar : '🦁';

      const newChild = window.CloudSync.addProfile({ name, avatar, grade });
      if (newChild) {
        if (nameInput) nameInput.value = '';
        window.AppBridge.closeModal('child-modal');
      }
    },

    deleteChild(childId) {
      if (!window.CloudSync) return;
      if (confirm('确认删除该孩子的档案及全部做题记录吗？')) {
        window.CloudSync.deleteProfile(childId);
        window.AppBridge.openChildModal();
      }
    },

    // --- 云同步设置 Bridge ---
    openSyncModal() {
      const modal = document.getElementById('sync-modal');
      const input = document.getElementById('sync-code-input');
      const autoBox = document.getElementById('auto-sync-checkbox');
      if (!modal || !window.CloudSync) return;

      if (input) input.value = window.CloudSync.getSyncCode();
      if (autoBox) autoBox.checked = window.CloudSync.isAutoSyncEnabled();

      updateSyncBadgeUI({ status: 'idle' });
      modal.classList.add('active');
    },

    async saveSyncCode() {
      if (!window.CloudSync) return;
      const input = document.getElementById('sync-code-input');
      const code = input ? input.value.trim() : '';
      if (code && (code.length < 4 || code.length > 32)) {
        alert('同步码长度建议为 4-32 位字符！');
        return;
      }
      window.CloudSync.setSyncCode(code);
      updateSyncBadgeUI({ status: 'idle', message: code ? '已绑定同步码' : '未绑定' });

      if (code) {
        const result = await window.CloudSync.syncToCloud();
        if (!result.ok) {
          alert('同步码已保存，但同步未完成：' + result.error);
          return;
        }
      }
      alert(code ? `同步码【${code}】已保存！` : '已清除同步码');
    },

    async syncNow() {
      if (!window.CloudSync) return;
      if (!window.CloudSync.getSyncCode()) {
        alert('请先输入并保存同步码！');
        return;
      }
      const res = await window.CloudSync.syncToCloud();
      if (res.ok) {
        alert('同步成功！已完成与云端数据双向合并。');
      } else {
        alert('同步遇到问题：' + (res.error || '网络超时'));
      }
    },

    async pushToCloud() {
      if (!window.CloudSync) return;
      if (!window.CloudSync.getSyncCode()) {
        alert('请先输入并保存同步码！');
        return;
      }
      if (confirm('确认将当前设备数据强制上传覆盖云端吗？')) {
        const res = await window.CloudSync.syncToCloud(true);
        if (res.ok) alert('上传成功！云端已更新。');
        else alert('上传失败：' + (res.error || '网络异常'));
      }
    },

    async pullFromCloud() {
      if (!window.CloudSync) return;
      if (!window.CloudSync.getSyncCode()) {
        alert('请先输入并保存同步码！');
        return;
      }
      if (confirm('确认从云端重新拉取并合并数据吗？')) {
        const res = await window.CloudSync.syncFromCloud();
        if (res.ok) alert('拉取成功！已同步至最新数据。');
        else alert('拉取失败：' + (res.error || '网络异常'));
      }
    },

    toggleAutoSync(enabled) {
      if (!window.CloudSync) return;
      window.CloudSync.setAutoSyncEnabled(enabled);
    }
  };

  // ==========================================
  // 16. 初始化启动
  // ==========================================
  window.addEventListener('DOMContentLoaded', () => {
    loadUserData();
    updateBankLabels();
    prepareActiveQuestions();
    updateSyncBadgeUI({ status: 'idle' });

    // 监听云同步事件与档案切换事件
    if (window.CloudSync) {
      window.CloudSync.on('sync-status', (info) => updateSyncBadgeUI(info));
      window.CloudSync.on('profile-change', () => {
        const previousId = AppState.activeChildId;
        loadUserData();
        if (previousId !== AppState.activeChildId) window.AppBridge.switchMode('sequence');
        else renderCurrentQuestion();
      });
      window.CloudSync.on('data-merged', () => {
        const previousId = AppState.activeChildId;
        loadUserData();
        if (previousId !== AppState.activeChildId) window.AppBridge.switchMode('sequence');
        else {
          renderCurrentQuestion();
          updateProgressUI();
        }
      });
    }

    // 更新音效与主题按钮初始状态
    const soundBtn = document.getElementById('sound-toggle-btn');
    if (soundBtn) soundBtn.textContent = AppState.soundEnabled ? '🔊' : '🔇';

    const themeBtn = document.getElementById('theme-toggle-btn');
    if (themeBtn) themeBtn.textContent = AppState.theme === 'light' ? '🌙' : '☀️';

    // 绑定题库下拉框事件
    const bankSelect = document.getElementById('bank-select');
    if (bankSelect) {
      bankSelect.addEventListener('change', (e) => {
        window.AppBridge.switchBank(e.target.value);
      });
    }
  });

})();
