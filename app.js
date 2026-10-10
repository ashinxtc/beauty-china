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
  const STORAGE_KEY = 'beautiful_china_study_data_v2';

  const AppState = {
    currentBankKey: 'unified', // unified, elem, middle, history, contest25, images, high_freq
    currentMode: 'sequence',   // sequence, random, exam, mistakes, favorites
    studyMode: 'practice',     // practice (做题模式), recite (背题模式)
    soundEnabled: true,
    theme: 'light',
    
    // 题目列表
    activeQuestions: [],
    currentIndex: 0,
    
    // 模拟考试状态
    exam: {
      active: false,
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
      answers: {},              // { [uid]: { choice: string, isCorrect: boolean, time: number } }
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
        updateChildChipUI();
        updateSyncBadgeUI({ status: 'idle' });
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

  // 根据当前主模式过滤题目集
  function prepareActiveQuestions() {
    let baseList = getRawQuestionsForBank(AppState.currentBankKey);

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
      AppState.exam.active = true;
      AppState.exam.userAnswers = {};
      AppState.exam.timeRemaining = 1800;
      startExamTimer();
    } else if (AppState.currentMode === 'mistakes') {
      const mistakeUids = Object.keys(AppState.userData.mistakes).filter(uid => !AppState.userData.mistakes[uid].mastered);
      const allUnified = window.BEAUTIFUL_CHINA_DATA.unified || [];
      AppState.activeQuestions = allUnified.filter(q => mistakeUids.includes(q.uid));
      AppState.currentIndex = 0;
    } else if (AppState.currentMode === 'favorites') {
      const favUids = Object.keys(AppState.userData.favorites).filter(uid => AppState.userData.favorites[uid]);
      const allUnified = window.BEAUTIFUL_CHINA_DATA.unified || [];
      AppState.activeQuestions = allUnified.filter(q => favUids.includes(q.uid));
      AppState.currentIndex = 0;
    }

    renderCurrentQuestion();
    updateProgressUI();
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
      container.innerHTML = `
        <div style="text-align: center; padding: 48px 20px; color: var(--text-muted);">
          <div style="font-size: 48px; margin-bottom: 12px;">🌟</div>
          <h3 style="color: var(--text-main); margin-bottom: 8px;">${emptyTip}</h3>
          <p style="font-size: 0.9rem;">可以切换到【全库去重纯享版】或【顺序刷题】继续练习</p>
          <button class="nav-btn primary" style="margin-top: 18px;" onclick="window.AppBridge.switchBank('unified')">返回全库练习</button>
        </div>
      `;
      document.getElementById('prev-btn').disabled = true;
      document.getElementById('next-btn').disabled = true;
      return;
    }

    const q = AppState.activeQuestions[AppState.currentIndex];
    const isStarred = !!AppState.userData.favorites[q.uid];
    const userRecord = (AppState.currentMode === 'exam') 
      ? AppState.exam.userAnswers[q.uid] 
      : AppState.userData.answers[q.uid];

    const isReciteMode = AppState.studyMode === 'recite';
    const hasAnswered = !!userRecord || isReciteMode;
    const isMulti = q.type === 'multi' || (q.answer && q.answer.length > 1);

    // 来源徽章
    const sourceBadges = (q.sources || []).map(s => `<span class="q-source-badge">${s}</span>`).join('');
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
    const letters = ['A', 'B', 'C', 'D', 'E'];
    if (q.options && q.options.length > 0) {
      optionsHtml = `
        <div class="options-list">
          ${q.options.map((optStr, optIdx) => {
            const letter = letters[optIdx] || optStr.charAt(0);
            const cleanText = optStr.replace(/^[A-E][\.、\uff0e\s]*/, '');
            
            let itemClass = 'option-item';
            let isOptionCorrect = q.answer && q.answer.includes(letter);

            if (AppState.currentMode === 'exam') {
              if (userRecord && userRecord.includes(letter)) {
                itemClass += ' selected';
              }
            } else {
              // 练习模式或背题模式
              if (hasAnswered) {
                itemClass += ' disabled';
                if (isOptionCorrect) {
                  itemClass += ' correct';
                } else if (userRecord && userRecord.includes(letter)) {
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
          确认提交多选 (已选 ${AppState.multiSelected.size} 项)
        </button>
      `;
    }

    // 答案解析面板
    let resultBannerHtml = '';
    if (hasAnswered && AppState.currentMode !== 'exam') {
      const isCorrect = userRecord && userRecord === q.answer;
      if (isReciteMode) {
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
    }

    container.innerHTML = `
      <div class="q-meta-row">
        <div class="q-tags">
          <span class="q-type-badge">${isMulti ? '多选题' : '单选题'}</span>
          ${isHot ? '<span class="q-hot-badge">🔥 超高频考题</span>' : ''}
          ${sourceBadges}
        </div>
        <button class="q-fav-toggle ${isStarred ? 'starred' : ''}" onclick="window.AppBridge.toggleFavorite('${q.uid}')" title="收藏此题">
          ${isStarred ? '★' : '☆'}
        </button>
      </div>

      <div class="q-title">
        <span style="color: var(--primary); font-weight: 700; margin-right: 6px;">第 ${AppState.currentIndex + 1} 题.</span>
        ${q.question}
      </div>

      ${imagesHtml}
      ${optionsHtml}
      ${multiSubmitHtml}
      ${resultBannerHtml}
    `;

    // 导航按钮状态
    document.getElementById('prev-btn').disabled = AppState.currentIndex === 0;
    document.getElementById('next-btn').disabled = AppState.currentIndex >= AppState.activeQuestions.length - 1;

    // 自动保存进度
    if (AppState.currentMode === 'sequence') {
      AppState.userData.progressIndex[AppState.currentBankKey] = AppState.currentIndex;
      saveUserData();
    }
  }

  // ==========================================
  // 7. 用户答题与交互处理
  // ==========================================
  function handleSelectOption(letter) {
    if (AppState.activeQuestions.length === 0) return;
    const q = AppState.activeQuestions[AppState.currentIndex];
    const isMulti = q.type === 'multi' || (q.answer && q.answer.length > 1);

    Sound.playClick();

    // 模考模式
    if (AppState.currentMode === 'exam') {
      if (isMulti) {
        let current = AppState.exam.userAnswers[q.uid] || '';
        if (current.includes(letter)) {
          current = current.replace(letter, '');
        } else {
          current = (current + letter).split('').sort().join('');
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

    // 若已回答过，不可重复回答（但可自由翻页）
    if (AppState.userData.answers[q.uid]) return;

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
    if (AppState.multiSelected.size === 0) return;
    const q = AppState.activeQuestions[AppState.currentIndex];
    const finalAnswer = Array.from(AppState.multiSelected).sort().join('');
    AppState.multiSelected.clear();
    processUserAnswer(finalAnswer, q);
  }

  function processUserAnswer(choice, q) {
    const isCorrect = choice === q.answer;

    // 记录答题记录
    AppState.userData.answers[q.uid] = choice;

    // 错题消灭战逻辑
    if (!isCorrect) {
      Sound.playError();
      if (!AppState.userData.mistakes[q.uid]) {
        AppState.userData.mistakes[q.uid] = { errorCount: 0, consecutiveCorrect: 0, mastered: false };
      }
      AppState.userData.mistakes[q.uid].errorCount += 1;
      AppState.userData.mistakes[q.uid].consecutiveCorrect = 0;
      AppState.userData.mistakes[q.uid].mastered = false;
    } else {
      Sound.playSuccess();
      if (AppState.userData.mistakes[q.uid]) {
        AppState.userData.mistakes[q.uid].consecutiveCorrect += 1;
        if (AppState.userData.mistakes[q.uid].consecutiveCorrect >= 2) {
          AppState.userData.mistakes[q.uid].mastered = true;
          launchConfetti();
        }
      }
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
      const allDone = AppState.activeQuestions.every(q => AppState.userData.answers[q.uid]);
      if (allDone) {
        showRandomResultReport();
      }
    }
  }

  function showRandomResultReport() {
    let correctCount = 0;
    AppState.activeQuestions.forEach(q => {
      if (AppState.userData.answers[q.uid] === q.answer) correctCount++;
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
    AppState.exam.active = false;
    clearInterval(AppState.exam.timerInterval);

    let correctCount = 0;
    AppState.activeQuestions.forEach(q => {
      if (AppState.exam.userAnswers[q.uid] === q.answer) {
        correctCount++;
      }
    });

    const total = AppState.activeQuestions.length;
    const score = Math.round((correctCount / total) * 100);
    const elapsed = 1800 - AppState.exam.timeRemaining;

    // 记录历史
    AppState.userData.examHistory.push({
      date: new Date().toLocaleString(),
      score: score,
      total: total,
      correct: correctCount,
      elapsed: elapsed
    });
    saveUserData();

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
            <button class="nav-btn primary" onclick="window.AppBridge.closeModal('report-modal'); window.AppBridge.switchMode('sequence');">
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
    const allUnified = window.BEAUTIFUL_CHINA_DATA.unified || [];
    allUnified.forEach(q => {
      const rec = AppState.userData.answers[q.uid];
      if (rec) {
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
      
      const userAns = (AppState.currentMode === 'exam')
        ? AppState.exam.userAnswers[q.uid]
        : AppState.userData.answers[q.uid];

      if (userAns) {
        if (AppState.currentMode === 'exam') {
          cls += ' correct'; // 模考中做过就亮色
        } else {
          cls += userAns === q.answer ? ' correct' : ' wrong';
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

    const allUnified = window.BEAUTIFUL_CHINA_DATA.unified || [];
    const totalQuestions = allUnified.length;
    let answeredCount = 0;
    let correctCount = 0;

    allUnified.forEach(q => {
      const rec = AppState.userData.answers[q.uid];
      if (rec) {
        answeredCount++;
        if (rec === q.answer) correctCount++;
      }
    });

    const accuracy = answeredCount > 0 ? Math.round((correctCount / answeredCount) * 100) : 0;
    const mistakeCount = Object.keys(AppState.userData.mistakes).filter(uid => !AppState.userData.mistakes[uid].mastered).length;
    const masteredCount = Object.keys(AppState.userData.mistakes).filter(uid => AppState.userData.mistakes[uid].mastered).length;

    content.innerHTML = `
      <div style="display: flex; flex-direction: column; gap: 20px;">
        <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; text-align: center;">
          <div style="background: var(--bg-main); border: 1px solid var(--border-color); border-radius: var(--radius-md); padding: 14px;">
            <div style="font-size: 1.5rem; font-weight: 800; color: var(--primary);">${answeredCount}</div>
            <div style="font-size: 0.8rem; color: var(--text-muted);">已练题数</div>
          </div>
          <div style="background: var(--bg-main); border: 1px solid var(--border-color); border-radius: var(--radius-md); padding: 14px;">
            <div style="font-size: 1.5rem; font-weight: 800; color: var(--warning);">${accuracy}%</div>
            <div style="font-size: 0.8rem; color: var(--text-muted);">全库正确率</div>
          </div>
          <div style="background: var(--bg-main); border: 1px solid var(--border-color); border-radius: var(--radius-md); padding: 14px;">
            <div style="font-size: 1.5rem; font-weight: 800; color: var(--success);">${masteredCount}</div>
            <div style="font-size: 0.8rem; color: var(--text-muted);">已消灭错题</div>
          </div>
        </div>

        <div>
          <h4 style="margin-bottom: 10px; color: var(--text-main);">🏅 备赛荣誉勋章</h4>
          <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px;">
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
            <div style="padding: 12px; border-radius: var(--radius-md); border: 1px solid ${accuracy >= 85 && answeredCount >= 50 ? 'var(--primary)' : 'var(--border-color)'}; background: ${accuracy >= 85 && answeredCount >= 50 ? 'var(--primary-light)' : 'var(--bg-main)'}; display: flex; align-items: center; gap: 10px;">
              <span style="font-size: 26px;">👑</span>
              <div>
                <div style="font-weight: 700; font-size: 0.9rem;">版图金牌卫士</div>
                <div style="font-size: 0.75rem; color: var(--text-muted);">正确率超过 85%</div>
              </div>
            </div>
          </div>
        </div>

        <div style="display: flex; justify-content: space-between; align-items: center; padding-top: 10px; border-top: 1px solid var(--border-color);">
          <button class="nav-btn" onclick="window.AppBridge.exportProgress()">📤 导出刷题备份</button>
          <button class="nav-btn" style="color: var(--danger);" onclick="window.AppBridge.resetProgress()">⚠️ 重置刷题进度</button>
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
        lastActiveDate: new Date().toISOString().slice(0, 10)
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
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

    if (e.key === 'ArrowLeft') {
      window.AppBridge.prevQuestion();
    } else if (e.key === 'ArrowRight' || e.key === 'Enter') {
      window.AppBridge.nextQuestion();
    } else if (['1', '2', '3', '4', 'a', 'b', 'c', 'd', 'A', 'B', 'C', 'D'].includes(e.key)) {
      const map = { '1': 'A', '2': 'B', '3': 'C', '4': 'D', 'a': 'A', 'b': 'B', 'c': 'C', 'd': 'D' };
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
      prepareActiveQuestions();
    },

    switchMode(modeKey) {
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

    nextQuestion() {
      if (AppState.currentIndex < AppState.activeQuestions.length - 1) {
        AppState.currentIndex++;
        AppState.multiSelected.clear();
        renderCurrentQuestion();
        updateProgressUI();
      }
    },

    prevQuestion() {
      if (AppState.currentIndex > 0) {
        AppState.currentIndex--;
        AppState.multiSelected.clear();
        renderCurrentQuestion();
        updateProgressUI();
      }
    },

    jumpToQuestion(idx) {
      AppState.currentIndex = idx;
      AppState.multiSelected.clear();
      renderCurrentQuestion();
      updateProgressUI();
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
      if (confirm('确认现在提交试卷并查看得分成绩吗？')) {
        finishExam();
      }
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
              <div class="child-avatar-circle">${p.avatar || '🦁'}</div>
              <div>
                <div class="child-info-name">
                  ${p.name}
                  ${isActive ? '<span class="child-active-tag">正在刷题</span>' : ''}
                </div>
                <div class="child-info-meta">
                  ${p.grade || '小学组'} · 已答 ${answeredCount} 题
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
      AppState.userData = window.CloudSync.getActiveChildData();
      updateChildChipUI();
      prepareActiveQuestions();
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
        AppState.userData = window.CloudSync.getActiveChildData();
        updateChildChipUI();
        prepareActiveQuestions();
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
        await window.CloudSync.syncFromCloud();
      }
      alert(code ? `同步码【${code}】已保存！` : '已清除同步码');
    },

    async syncNow() {
      if (!window.CloudSync) return;
      if (!window.CloudSync.getSyncCode()) {
        alert('请先输入并保存同步码！');
        return;
      }
      const res = await window.CloudSync.syncFromCloud();
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
    prepareActiveQuestions();

    // 监听云同步事件与档案切换事件
    if (window.CloudSync) {
      window.CloudSync.on('sync-status', (info) => updateSyncBadgeUI(info));
      window.CloudSync.on('profile-change', () => {
        loadUserData();
        prepareActiveQuestions();
      });
      window.CloudSync.on('data-merged', () => {
        loadUserData();
        prepareActiveQuestions();
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
