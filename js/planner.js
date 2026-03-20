// ── STATE ──
let plan = null;
let topicMeta = {};       // { key: { prepMins, revMins, prepDone, revDone, spentMins, revSpentMins } }
let subjectBadges = {};   // { subjId: '🏆' }
let todayMins = 0;
let bonusMins = 0;
let totalSpentMins = 0;   // total mins spent across ALL sessions (for recalibrate)
let slots = [];
let slotCounter = 0;
let currentUserId = null;
let openSubjects = new Set();
let pendingStickerSubjId = null;
let pendingStickerEl = null;
let selectedStickerEmoji = null;

const CIRCUMFERENCE = 364; // 2 * PI * 58

// ── BOOT ──
sb.auth.onAuthStateChange((event, session) => {
  if (!session) { window.location.href = 'index.html'; return; }
  if (currentUserId) return;
  currentUserId = session.user.id;
  setTimeout(() => loadPlan(), 0);
});

async function loadPlan() {
  const data = await dbLoad(currentUserId);
  if (!data || !data.subjects?.length) { localStorage.setItem('replan', '1'); window.location.href = 'index.html'; return; }
  plan = data;

  if (data.topic_meta && Object.keys(data.topic_meta).length > 0) {
    topicMeta = data.topic_meta;
    ensureAllTopicsMeta();
  } else {
    initTopicMeta();
  }

  todayMins = data.today_mins || 0;
  bonusMins = data.bonus_mins || 0;
  totalSpentMins = data.total_spent_mins || 0;
  subjectBadges = data.subject_badges || {};

  // Reset today_mins if last session was a different day
  const today = new Date().toDateString();
  const lastSaved = data.last_saved_date || '';
  if (lastSaved !== today) {
    todayMins = 0;
    bonusMins = 0;
  }

  // Restore openSubjects from localStorage
  const savedOpen = localStorage.getItem('openSubjects');
  if (savedOpen) {
    try { JSON.parse(savedOpen).forEach(id => openSubjects.add(id)); } catch(e) {}
  }

  document.getElementById('planner-loading').style.display = 'none';
  document.getElementById('planner-screen').style.display = 'block';
  renderTopicsTable();
  updateDashboard();

  // Restore active slots from localStorage
  restoreSlotsFromStorage();
}

// ── TIME BUDGET ──

// Count available study mins between two dates using plan's daily hours
function calcBudgetBetween(startStr, endStr) {
  if (!startStr || !endStr) return 0;
  let wd = 0, we = 0;
  const cur = new Date(startStr), end = new Date(endStr);
  cur.setHours(0,0,0,0); end.setHours(0,0,0,0);
  while (cur < end) {
    const d = cur.getDay();
    if (d === 0 || d === 6) we++; else wd++;
    cur.setDate(cur.getDate() + 1);
  }
  return Math.round((wd * (parseFloat(plan.weekday_hrs)||0) + we * (parseFloat(plan.weekend_hrs)||0)) * 60);
}

// Per-subject budget: use subject's own exam_date if set, else global exam_start
function calcSubjectBudgetMins(subj) {
  const examDate = subj.exam_date || plan.exam_start;
  return calcBudgetBetween(plan.study_start, examDate);
}

// Global budget (for dashboard ring — use latest exam date across all subjects)
function calcTotalBudgetMins() {
  let latest = plan.exam_start;
  (plan.subjects||[]).forEach(s => {
    if (s.exam_date && (!latest || s.exam_date > latest)) latest = s.exam_date;
  });
  return calcBudgetBetween(plan.study_start, latest || plan.exam_start);
}

function calcTodayBudgetMins() {
  const d = new Date().getDay();
  const hrs = (d === 0 || d === 6) ? (parseFloat(plan.weekend_hrs)||0) : (parseFloat(plan.weekday_hrs)||0);
  return Math.round(hrs * 60);
}

function diffWeight(diff) {
  if (diff === 'easy') return 1;
  if (diff === 'hard') return 2;
  return 1.5;
}

// Days until a subject's exam (for urgency coaching)
function daysUntilExam(subj) {
  const examDate = subj.exam_date || plan.exam_start;
  if (!examDate) return null;
  const today = new Date(); today.setHours(0,0,0,0);
  const exam = new Date(examDate); exam.setHours(0,0,0,0);
  return Math.ceil((exam - today) / 86400000);
}

// ── TOPIC META ──
// Each subject gets its own budget based on its exam date.
// prepMins per topic = subjectBudget / topicCountInSubject * difficultyWeight (normalised within subject)
function calcTopicPrepMins(subj) {
  const totalBudget = calcTotalBudgetMins();
  const topics = subj.topics || [];
  if (!topics.length) return 0;

  // Total weighted topic count across ALL subjects
  const totalWeightedTopics = (plan.subjects || []).reduce((sum, s) => {
    return sum + (s.topics || []).length * diffWeight(s.difficulty);
  }, 0);
  if (!totalWeightedTopics) return 0;

  // This subject's share = its weighted topics / total weighted topics
  const subjWeight = topics.length * diffWeight(subj.difficulty);
  const subjBudget = (subjWeight / totalWeightedTopics) * totalBudget;

  // Split evenly across this subject's topics (difficulty already applied at subject level)
  return Math.max(5, Math.round(subjBudget / topics.length));
}

function initTopicMeta() {
  plan.subjects.forEach(s => {
    const prepMins = calcTopicPrepMins(s);
    (s.topics||[]).forEach((t, i) => {
      const key = `${s.id}_${i}`;
      if (!topicMeta[key]) {
        topicMeta[key] = {
          prepMins,
          revMins: Math.max(5, Math.round(prepMins * 0.25)),
          prepDone: false, revDone: false, spentMins: 0, revSpentMins: 0
        };
      }
    });
  });
}

function ensureAllTopicsMeta() {
  plan.subjects.forEach(s => {
    const prepMins = calcTopicPrepMins(s);
    (s.topics||[]).forEach((t, i) => {
      const key = `${s.id}_${i}`;
      if (!topicMeta[key]) {
        topicMeta[key] = {
          prepMins,
          revMins: Math.max(5, Math.round(prepMins * 0.25)),
          prepDone: false, revDone: false, spentMins: 0, revSpentMins: 0
        };
      }
    });
  });
}

// ── RECALIBRATE ──
// Per subject: remaining = subjectBudget - spentMins across that subject's topics
// Redistribute remaining across unfinished topics in that subject
function recalibrate() {
  // Use same shared budget logic as initTopicMeta
  // Total budget split across all subjects weighted by difficulty
  const totalBudget = calcTotalBudgetMins();
  const totalWeightedTopics = (plan.subjects || []).reduce((sum, s) => {
    return sum + (s.topics || []).length * diffWeight(s.difficulty);
  }, 0);
  if (!totalWeightedTopics) return;

  plan.subjects.forEach(s => {
    const topics = s.topics || [];
    if (!topics.length) return;

    // This subject's share of total budget
    const subjWeight = topics.length * diffWeight(s.difficulty);
    const subjBudget = (subjWeight / totalWeightedTopics) * totalBudget;

    // How much already spent on this subject
    let subjectSpent = 0;
    topics.forEach((t, i) => {
      const meta = topicMeta[`${s.id}_${i}`];
      if (meta) subjectSpent += (meta.spentMins || 0);
    });

    const remaining = Math.max(0, subjBudget - subjectSpent);
    const unfinished = topics.filter((t, i) => {
      const meta = topicMeta[`${s.id}_${i}`];
      return meta && !meta.prepDone;
    });
    if (!unfinished.length) return;

    const minsPerTopic = Math.max(5, Math.round(remaining / unfinished.length));
    unfinished.forEach(t => {
      const i = topics.indexOf(t);
      const meta = topicMeta[`${s.id}_${i}`];
      if (meta) {
        meta.prepMins = minsPerTopic;
        meta.revMins = Math.max(5, Math.round(minsPerTopic * 0.25));
      }
    });
  });

  renderTopicsTable();
  updateDashboard();
  savePlannerState();
  showToast('Plan recalibrated! 🔄');
}

// ── RENDER ──
function renderTopicsTable() {
  const container = document.getElementById('topics-table');
  container.innerHTML = '';

  const today = new Date(); today.setHours(0,0,0,0);
  const studyStart = plan.study_start ? new Date(plan.study_start) : null;
  const examStart  = plan.exam_start  ? new Date(plan.exam_start)  : null;

  let shouldNudge = false;
  if (studyStart && examStart) {
    const totalDays = Math.max(1, (examStart - studyStart) / 86400000);
    const daysGone  = Math.max(0, (today - studyStart) / 86400000);
    if (daysGone / totalDays > 0.2 && calcTopicsDonePct() < 0.1) shouldNudge = true;
  }
  document.getElementById('nudge-banner').style.display = shouldNudge ? 'block' : 'none';

  // Coach banner — find most urgent subject
  const coachBanner = document.getElementById('coach-banner');
  if (coachBanner) {
    const urgent = plan.subjects
      .map(s => ({ s, days: daysUntilExam(s) }))
      .filter(x => x.days !== null && x.days >= 0)
      .sort((a, b) => a.days - b.days)[0];
    if (urgent && urgent.days <= 7) {
      const d = urgent.days;
      const msg = d === 0 ? `${urgent.s.emoji} ${urgent.s.name} exam is TODAY! 🚨`
        : d === 1 ? `${urgent.s.emoji} ${urgent.s.name} exam is TOMORROW — focus here first! 🔥`
        : `${urgent.s.emoji} ${urgent.s.name} exam in ${d} days — drag these topics first! 💪`;
      coachBanner.textContent = msg;
      coachBanner.style.display = 'block';
    } else {
      coachBanner.style.display = 'none';
    }
  }

  plan.subjects.forEach(s => {
    if (!s.topics?.length) return;

    let subjTotal = 0, subjDone = 0;
    s.topics.forEach((t, i) => {
      const meta = topicMeta[`${s.id}_${i}`];
      if (!meta) return;
      subjTotal++;
      if (meta.prepDone) subjDone++;
    });
    const subjPct = subjTotal > 0 ? subjDone / subjTotal : 0;
    const isAmber = shouldNudge && subjDone === 0;
    const isOpen  = openSubjects.has(s.id);
    const badge   = subjectBadges[s.id] || '';
    const days = daysUntilExam(s);
    const urgencyBadge = days !== null && days <= 7 && days >= 0
      ? ` <span style="font-size:0.62rem;background:#fff0e0;color:#c06000;border:1px solid #f0c080;border-radius:8px;padding:1px 6px;font-weight:800;">🔥 ${days === 0 ? 'Today!' : days === 1 ? 'Tomorrow!' : `${days}d left`}</span>`
      : '';

    const group = document.createElement('div');
    group.className = 'subject-group';

    const subjectRow = document.createElement('div');
    subjectRow.className = `subject-row${isAmber ? ' amber' : ''}${isOpen ? ' open' : ''}`;
    subjectRow.dataset.subjId = s.id;
    subjectRow.innerHTML = `
      <span class="subj-row-emoji">${s.emoji}</span>
      <span class="subj-row-name">${s.name}${badge ? ' <span class="subj-badge">'+badge+'</span>' : ''}${urgencyBadge}</span>
      <span class="subj-row-pct">${Math.round(subjPct*100)}%</span>
      <div class="subj-prog-wrap"><div class="subj-prog-bar" style="width:${Math.round(subjPct*100)}%"></div></div>
      <span class="chevron">▼</span>
    `;
    subjectRow.onclick = () => toggleSubject(s.id);

    const topicsList = document.createElement('div');
    topicsList.className = `topics-list${isOpen ? ' open' : ''}`;
    topicsList.id = `topics-${s.id}`;

    s.topics.forEach((topic, i) => {
      const key = `${s.id}_${i}`;
      const meta = topicMeta[key];
      if (!meta) return;

      // Prep row
      const row = document.createElement('div');
      row.className = `topic-row${isAmber && !meta.prepDone ? ' amber-topic' : ''}`;
      row.dataset.key = key;
      row.draggable = !meta.prepDone;
      if (!meta.prepDone) {
        row.addEventListener('dragstart', e => {
          e.dataTransfer.setData('text/plain', key);
          e.dataTransfer.effectAllowed = 'copy';
        });
      }

      const nameEl = document.createElement('span');
      nameEl.className = `topic-name${meta.prepDone ? ' done-text' : ''}`;
      nameEl.textContent = topic;

      const remaining = Math.max(0, meta.prepMins - (meta.spentMins || 0));
      const timeEl = document.createElement('span');
      timeEl.className = `topic-time${meta.prepDone ? ' faded' : ''}`;
      timeEl.textContent = meta.prepDone ? formatMins(meta.prepMins) : formatMins(remaining) + (meta.spentMins > 0 ? ' left' : '');

      const check = document.createElement('div');
      check.className = `topic-check${meta.prepDone ? ' checked' : ''}`;
      check.onclick = e => { e.stopPropagation(); togglePrepDone(key, s.id); };

      const handle = document.createElement('span');
      handle.className = 'topic-drag-handle';
      handle.textContent = '⠿';

      row.appendChild(nameEl);
      row.appendChild(timeEl);
      row.appendChild(check);
      row.appendChild(handle);
      topicsList.appendChild(row);

      // Revision row — only after prep done
      if (meta.prepDone) {
        const revRow = document.createElement('div');
        revRow.className = 'topic-row revision-row';
        revRow.dataset.key = key;
        revRow.draggable = !meta.revDone;
        if (!meta.revDone) {
          revRow.addEventListener('dragstart', e => {
            e.dataTransfer.setData('text/plain', key + '|rev');
            e.dataTransfer.effectAllowed = 'copy';
          });
        }

        const revName = document.createElement('span');
        revName.className = `topic-name${meta.revDone ? ' done-text' : ''}`;
        revName.textContent = `↩ ${topic} (Revision)`;
        revName.style.color = meta.revDone ? '#bbb' : '#5090c0';
        revName.style.fontSize = '0.78rem';

        const revTime = document.createElement('span');
        revTime.className = `topic-time revision-time${meta.revDone ? ' faded' : ''}`;
        revTime.textContent = formatMins(meta.revMins);

        const revCheck = document.createElement('div');
        revCheck.className = `topic-check rev-check${meta.revDone ? ' checked' : ''}`;
        revCheck.onclick = e => { e.stopPropagation(); toggleRevDone(key, s.id); };

        const revHandle = document.createElement('span');
        revHandle.className = 'topic-drag-handle';
        revHandle.textContent = '⠿';

        revRow.appendChild(revName);
        revRow.appendChild(revTime);
        revRow.appendChild(revCheck);
        revRow.appendChild(revHandle);
        topicsList.appendChild(revRow);
      }
    });

    group.appendChild(subjectRow);
    group.appendChild(topicsList);
    container.appendChild(group);
  });
}

function toggleSubject(subjId) {
  if (openSubjects.has(subjId)) openSubjects.delete(subjId);
  else openSubjects.add(subjId);
  localStorage.setItem('openSubjects', JSON.stringify([...openSubjects]));
  renderTopicsTable();
}

function togglePrepDone(key, subjId) {
  const meta = topicMeta[key];
  if (!meta) return;
  meta.prepDone = !meta.prepDone;
  if (!meta.prepDone) {
    meta.revDone = false;
    // Deduct the credited time back from todayMins and totalSpentMins
    const credited = meta.spentMins || 0;
    todayMins = Math.max(0, todayMins - credited);
    totalSpentMins = Math.max(0, totalSpentMins - credited);
    meta.spentMins = 0;
  }
  openSubjects.add(subjId);
  if (meta.prepDone) {
    // Credit full prepMins to todayMins and spentMins if not already spent
    const alreadySpent = meta.spentMins || 0;
    const remaining = Math.max(0, meta.prepMins - alreadySpent);
    if (remaining > 0) {
      meta.spentMins = meta.prepMins;
      todayMins += remaining;
      totalSpentMins += remaining;
    }
    confettiBomb();
    balloonBomb();
    showToast(randomMsg('prep'));
    checkSubjectComplete(subjId);
  }
  renderTopicsTable();
  updateDashboard();
  savePlannerState();
}

function toggleRevDone(key, subjId) {
  const meta = topicMeta[key];
  if (!meta) return;
  meta.revDone = !meta.revDone;
  openSubjects.add(subjId);
  if (!meta.revDone) {
    // Deduct the credited rev time back
    const credited = meta.revSpentMins || 0;
    todayMins = Math.max(0, todayMins - credited);
    totalSpentMins = Math.max(0, totalSpentMins - credited);
    meta.revSpentMins = 0;
  }
  if (meta.revDone) {
    // Credit full revMins to todayMins and revSpentMins if not already spent
    const alreadySpent = meta.revSpentMins || 0;
    const remaining = Math.max(0, meta.revMins - alreadySpent);
    if (remaining > 0) {
      meta.revSpentMins = meta.revMins;
      todayMins += remaining;
      totalSpentMins += remaining;
    }
    confettiBomb();
    showToast(randomMsg('revision'));
    checkSubjectComplete(subjId);
  }
  renderTopicsTable();
  updateDashboard();
  savePlannerState();
}

function checkSubjectComplete(subjId) {
  const s = plan.subjects.find(s => s.id === subjId);
  if (!s || !s.topics?.length) return;
  const allDone = s.topics.every((t, i) => {
    const meta = topicMeta[`${s.id}_${i}`];
    return meta && meta.prepDone;
  });
  if (allDone && !subjectBadges[subjId]) {
    // show sticker picker
    pendingStickerSubjId = subjId;
    document.getElementById('sticker-overlay').classList.add('open');
  }
}

// ── STICKER PICKER ──
function selectSticker(el, emoji) {
  document.querySelectorAll('.sticker-opt').forEach(o => o.classList.remove('selected'));
  el.classList.add('selected');
  selectedStickerEmoji = emoji;
}

function confirmSticker() {
  if (!selectedStickerEmoji || !pendingStickerSubjId) return;
  subjectBadges[pendingStickerSubjId] = selectedStickerEmoji;
  document.getElementById('sticker-overlay').classList.remove('open');
  fireStickerBurst(selectedStickerEmoji);
  selectedStickerEmoji = null;
  pendingStickerSubjId = null;
  document.querySelectorAll('.sticker-opt').forEach(o => o.classList.remove('selected'));
  renderTopicsTable();
  savePlannerState();
}

function fireStickerBurst(emoji) {
  for (let i = 0; i < 18; i++) {
    setTimeout(() => {
      const el = document.createElement('div');
      el.style.cssText = `
        position:fixed; pointer-events:none; z-index:9996;
        font-size:2.5rem; left:${10 + Math.random() * 80}vw; top:${10 + Math.random() * 70}vh;
      `;
      el.textContent = emoji;
      document.body.appendChild(el);
      const rot = (Math.random() * 60 - 30);
      const dur = 1200 + Math.random() * 1200;
      el.animate([
        { opacity: 0, transform: `scale(0) rotate(${rot}deg)` },
        { opacity: 1, transform: `scale(1.3) rotate(${rot}deg)`, offset: 0.3 },
        { opacity: 1, transform: `scale(1) rotate(${rot}deg)`, offset: 0.7 },
        { opacity: 0, transform: `scale(0.5) rotate(${rot}deg)` }
      ], { duration: dur, easing: 'ease-out' });
      setTimeout(() => el.remove(), dur + 100);
    }, i * 80);
  }
}

// ── DASHBOARD ──
function calcTopicsDonePct() {
  let total = 0, done = 0;
  Object.values(topicMeta).forEach(m => { total++; if (m.prepDone) done++; });
  return total > 0 ? done / total : 0;
}

function updateDashboard() {
  const todayBudget = calcTodayBudgetMins();
  const totalBudget = calcTotalBudgetMins();

  // Ring 1: Today
  const todayPct = todayBudget > 0 ? Math.min(1, todayMins / todayBudget) : 0;
  setRing('ring-today-fill', todayPct, 364);
  document.getElementById('ring-today-val').textContent = todayMins;
  document.getElementById('ring-today-unit').textContent = `/ ${todayBudget} mins`;

  // Ring 2: Topics done
  const topicsPct = calcTopicsDonePct();
  setRing('ring-topics-fill', topicsPct, 364);
  document.getElementById('ring-topics-val').textContent = Math.round(topicsPct * 100) + '%';

  // Ring 3: Bonus mins (fills at 60 bonus mins)
  const bonusPct = Math.min(1, bonusMins / 60);
  setRing('ring-bonus-fill', bonusPct, 364);
  document.getElementById('ring-bonus-val').textContent = bonusMins;
}

function setRing(id, pct, circ) {
  const el = document.getElementById(id);
  if (el) el.style.strokeDashoffset = circ * (1 - Math.max(0, Math.min(1, pct)));
}

// ── SPEED MODE (for testing) ──
let speedMode = false;
function toggleSpeedMode() {
  speedMode = !speedMode;
  const btn = document.getElementById('speed-btn');
  btn.textContent = `⚡ Speed Mode: ${speedMode ? 'ON' : 'OFF'}`;
  btn.style.background = speedMode ? '#fde080' : '';
  btn.style.color = speedMode ? '#a07000' : '';
}

// ── ANIMATIONS via canvas-confetti ──

// Topic session done — cannon burst from both sides
function confettiBomb() {
  const count = 120;
  confetti({ particleCount: count/2, angle: 60, spread: 70, origin: { x: 0, y: 0.6 }, colors: ['#c8b8f8','#f9c74f','#ff6b9d','#43aa8b','#f94144'] });
  confetti({ particleCount: count/2, angle: 120, spread: 70, origin: { x: 1, y: 0.6 }, colors: ['#c8b8f8','#f9c74f','#ff6b9d','#43aa8b','#f94144'] });
}

// Full topic done — fireworks
function balloonBomb() {
  const duration = 2000;
  const end = Date.now() + duration;
  (function frame() {
    confetti({ particleCount: 6, angle: 60, spread: 55, origin: { x: 0, y: 0.7 }, colors: ['#ff6b9d','#f9c74f','#c8b8f8'] });
    confetti({ particleCount: 6, angle: 120, spread: 55, origin: { x: 1, y: 0.7 }, colors: ['#43aa8b','#f94144','#c8b8f8'] });
    if (Date.now() < end) requestAnimationFrame(frame);
  })();
  // Emoji burst in the middle
  confetti({ particleCount: 30, spread: 120, origin: { x: 0.5, y: 0.5 },
    shapes: ['circle'], colors: ['#ff6b9d','#f9c74f','#43aa8b','#c8b8f8','#f94144'],
    scalar: 2, ticks: 300
  });
}

// Extra effort — muscle emojis explode everywhere
function muscleExplosion() {
  // Gold stars burst — canvas-confetti native star shape
  const starDefaults = {
    spread: 360, ticks: 80, gravity: 0, decay: 0.94, startVelocity: 28,
    colors: ['#FFE400', '#FFBD00', '#E89400', '#FFCA6C', '#FDFFB8'],
  };
  const shoot = () => {
    confetti({ ...starDefaults, particleCount: 50, scalar: 1.3, shapes: ['star'] });
    confetti({ ...starDefaults, particleCount: 15, scalar: 0.7, shapes: ['circle'] });
  };
  shoot();
  setTimeout(shoot, 120);
  setTimeout(shoot, 240);

  // 💪 emoji confetti via shapeFromText
  const scalar = 2;
  const muscle = confetti.shapeFromText({ text: '💪', scalar });
  setTimeout(() => {
    confetti({
      shapes: [muscle], scalar, spread: 80, particleCount: 20,
      origin: { x: 0.5, y: 0.6 }, startVelocity: 20,
      ticks: 100, gravity: 0.5, decay: 0.95,
    });
  }, 200);
}

// Subject complete — sticker burst (already working, keep as is)
function activateBonusStardust() { muscleExplosion(); }
function pulseRing() {}
function triggerSparkleTrail() {}

// ── TOAST ──
let toastTimeout = null;
function showToast(msg) {
  const el = document.getElementById('toast-msg');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => el.classList.remove('show'), 3000);
}

function randomMsg(type) {
  const msgs = {
    prep: ['Mission Accomplished! You\'re on fire! 🔥', 'Level Up! Brain power +10! 💪', 'Nailed it! 🎯', 'Keep going, superstar! 🌟'],
    revision: ['Memory Locked! 🔒', 'Revision Master! Making it look easy. ✨', 'Double done! 💪', 'Sharp as a tack! 🧠'],
    bonus: ['Bonus Power earned! 🏆', 'Unstoppable energy! ⚡', 'Going above and beyond! 🚀', 'Extra effort = extra awesome! 🌟'],
  };
  const list = msgs[type] || msgs.prep;
  return list[Math.floor(Math.random() * list.length)];
}

// ── SLOTS ──
function addSlot() {
  const id = ++slotCounter;
  slots.push({ id, topicKey: null, isRev: false, durationMins: 0, allocMins: 0, selectedMoreMins: 0, effortType: null, timerInterval: null, remainingSecs: 0, paused: false });

  const card = document.createElement('div');
  card.className = 'slot-card';
  card.id = `slot-${id}`;
  card.innerHTML = `
    <div class="slot-drop-zone" id="slot-drop-${id}">Drop a topic here to begin 👆</div>
    <div class="slot-topic-loaded" id="slot-loaded-${id}">
      <div class="slot-topic-name" id="slot-tname-${id}"></div>
      <div class="slot-topic-meta" id="slot-tmeta-${id}"></div>
      <div class="slot-progress-bar-wrap"><div class="slot-progress-bar" id="slot-prog-${id}" style="width:0%"></div></div>
    </div>
    <div class="slot-duration-pick" id="slot-dur-${id}">
      <div class="dur-label">How long is this session?</div>
      <div class="dur-btns" id="slot-dur-btns-${id}"></div>
      <div class="dur-custom">
        <input type="number" min="1" placeholder="custom" id="slot-custom-${id}">
        <span class="dur-max-note" id="slot-maxnote-${id}"></span>
      </div>
      <button class="start-timer-btn" onclick="startTimer(${id})">🚀 Start Timer!</button>
    </div>
    <div class="slot-timer" id="slot-timer-${id}">
      <div class="timer-display" id="slot-time-${id}">00:00</div>
      <div class="timer-controls">
        <button class="timer-btn pause" id="slot-pause-${id}" onclick="pauseTimer(${id})">⏸ Pause</button>
        <button class="timer-btn stop" onclick="stopTimer(${id})">⏹ Stop</button>
      </div>
    </div>
    <div class="slot-done-ask" id="slot-done-${id}">
      <div class="done-ask-title">⏰ Time's up! Are you done?</div>
      <div class="done-ask-btns">
        <button class="done-yes-btn" onclick="markDone(${id})">✅ Yes, Done!</button>
        <button class="done-more-btn" onclick="showMoreTime(${id})">⏱ Need More Time</button>
      </div>
    </div>
    <div class="slot-more-time" id="slot-more-${id}">
      <div class="more-time-label">How many more minutes?</div>
      <div class="more-time-mins">
        <button class="more-min-btn" onclick="selectMoreMins(${id},10,this)">10m</button>
        <button class="more-min-btn" onclick="selectMoreMins(${id},15,this)">15m</button>
        <button class="more-min-btn" onclick="selectMoreMins(${id},20,this)">20m</button>
        <button class="more-min-btn" onclick="selectMoreMins(${id},30,this)">30m</button>
      </div>
      <div class="more-time-type-label">Is this from your plan or extra effort?</div>
      <div class="more-time-type">
        <button class="effort-btn" id="slot-budget-btn-${id}" onclick="selectEffortType(${id},'budget')">📅 From my plan</button>
        <button class="effort-btn" id="slot-bonus-btn-${id}" onclick="selectEffortType(${id},'bonus')">⭐ Extra effort!</button>
      </div>
      <button class="confirm-more-btn" onclick="confirmMoreTime(${id})">▶ Continue studying</button>
    </div>
    <div class="slot-footer">
      <button class="remove-slot-btn" onclick="removeSlot(${id})">✕ Remove</button>
    </div>
  `;
  document.getElementById('slots-list').appendChild(card);
  setupSlotDrop(id);
}

function setupSlotDrop(id) {
  const zone = document.getElementById(`slot-drop-${id}`);
  const card = document.getElementById(`slot-${id}`);
  zone.addEventListener('dragover', e => { e.preventDefault(); card.classList.add('drag-over'); });
  zone.addEventListener('dragleave', () => card.classList.remove('drag-over'));
  zone.addEventListener('drop', e => {
    e.preventDefault();
    card.classList.remove('drag-over');
    const data = e.dataTransfer.getData('text/plain');
    const isRev = data.endsWith('|rev');
    const key = isRev ? data.replace('|rev', '') : data;
    loadTopicIntoSlot(id, key, isRev);
    highlightTopicRow(key, isRev);
  });
}

function loadTopicIntoSlot(slotId, key, isRev) {
  const slot = slots.find(s => s.id === slotId);
  if (!slot) return;
  const meta = topicMeta[key];
  if (!meta) return;

  const [subjId, topicIdx] = key.split('_');
  const subj = plan.subjects.find(s => s.id === subjId);
  const topicName = subj?.topics?.[parseInt(topicIdx)] || 'Topic';
  const allocMins = isRev ? meta.revMins : meta.prepMins;
  const spentSoFar = isRev ? (meta.revSpentMins || 0) : (meta.spentMins || 0);
  const remaining = Math.max(5, allocMins - spentSoFar);

  slot.topicKey = key;
  slot.isRev = isRev;
  slot.allocMins = remaining; // remaining, not total

  // Persist slot to localStorage so it survives refresh
  saveSlotToStorage(slotId, key, isRev);

  document.getElementById(`slot-drop-${slotId}`).style.display = 'none';
  const loaded = document.getElementById(`slot-loaded-${slotId}`);
  loaded.style.display = 'block';
  document.getElementById(`slot-tname-${slotId}`).textContent = isRev ? `↩ ${topicName} (Revision)` : topicName;
  document.getElementById(`slot-tmeta-${slotId}`).textContent = `${subj?.emoji||''} ${subj?.name||''} · ${formatMins(remaining)} remaining`;

  // Progress bar
  const pct = allocMins > 0 ? Math.round(spentSoFar / allocMins * 100) : 0;
  const prog = document.getElementById(`slot-prog-${slotId}`);
  if (prog) prog.style.width = pct + '%';

  if (isRev) {
    slot.durationMins = remaining;
    document.getElementById(`slot-dur-${slotId}`).style.display = 'none';
    startTimerDirect(slotId);
  } else {
    const btns = document.getElementById(`slot-dur-btns-${slotId}`);
    btns.innerHTML = '';
    [20, 30, 45, 60].forEach(m => {
      const b = document.createElement('button');
      b.className = 'dur-btn' + (m > remaining ? ' disabled-dur' : '');
      b.textContent = m + 'm';
      b.onclick = () => selectDur(slotId, m, b);
      btns.appendChild(b);
    });
    document.getElementById(`slot-maxnote-${slotId}`).textContent = `max ${formatMins(remaining)}`;
    document.getElementById(`slot-custom-${slotId}`).max = remaining;
    document.getElementById(`slot-dur-${slotId}`).style.display = 'flex';
  }
}

function selectDur(slotId, mins, btn) {
  const slot = slots.find(s => s.id === slotId);
  if (slot) slot.durationMins = mins;
  document.querySelectorAll(`#slot-dur-btns-${slotId} .dur-btn`).forEach(b => b.classList.remove('selected'));
  btn.classList.add('selected');
  document.getElementById(`slot-custom-${slotId}`).value = '';
}

function startTimer(slotId) {
  const slot = slots.find(s => s.id === slotId);
  if (!slot) return;
  const customEl = document.getElementById(`slot-custom-${slotId}`);
  if (customEl?.value) {
    const custom = parseInt(customEl.value);
    if (custom > slot.allocMins) { alert(`Max allowed is ${formatMins(slot.allocMins)}`); return; }
    slot.durationMins = custom;
  }
  if (!slot.durationMins || slot.durationMins < 1) { alert('Please select a duration first.'); return; }
  document.getElementById(`slot-dur-${slotId}`).style.display = 'none';
  startTimerDirect(slotId);
}

function startTimerDirect(slotId) {
  const slot = slots.find(s => s.id === slotId);
  if (!slot) return;
  slot.remainingSecs = slot.durationMins * 60;
  slot.paused = false;
  document.getElementById(`slot-timer-${slotId}`).style.display = 'flex';
  updateTimerDisplay(slotId);
  runTimer(slotId);
}

function runTimer(slotId) {
  const slot = slots.find(s => s.id === slotId);
  if (!slot) return;
  clearInterval(slot.timerInterval);
  const tick = speedMode ? Math.round(1000/60) : 1000;
  const decrement = speedMode ? 60 : 1;
  slot.timerInterval = setInterval(() => {
    if (slot.paused) return;
    slot.remainingSecs -= decrement;
    if (slot.remainingSecs < 0) slot.remainingSecs = 0;
    updateTimerDisplay(slotId);
    if (slot.remainingSecs <= 0) {
      clearInterval(slot.timerInterval);
      // Store pending mins — only log to todayMins when user clicks Yes Done
      slot.pendingMins = (slot.pendingMins || 0) + slot.durationMins;
      timerDone(slotId);
    }
  }, tick);
}

function updateTimerDisplay(slotId) {
  const slot = slots.find(s => s.id === slotId);
  if (!slot) return;
  const m = Math.floor(slot.remainingSecs / 60);
  const s = slot.remainingSecs % 60;
  const el = document.getElementById(`slot-time-${slotId}`);
  if (el) {
    el.textContent = `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
    el.className = `timer-display${slot.remainingSecs <= 60 ? ' warning' : ''}`;
  }
}

function pauseTimer(slotId) {
  const slot = slots.find(s => s.id === slotId);
  if (!slot) return;
  slot.paused = !slot.paused;
  const btn = document.getElementById(`slot-pause-${slotId}`);
  if (btn) btn.textContent = slot.paused ? '▶ Resume' : '⏸ Pause';
}

function stopTimer(slotId) {
  const slot = slots.find(s => s.id === slotId);
  if (!slot) return;
  clearInterval(slot.timerInterval);
  const secsStudied = (slot.durationMins * 60) - slot.remainingSecs;
  // Store mins on slot — only log to todayMins/meta when user confirms Yes Done
  slot.pendingMins = (slot.pendingMins || 0) + Math.max(0, Math.round(secsStudied / 60));
  timerDone(slotId);
}

function timerDone(slotId) {
  document.getElementById(`slot-timer-${slotId}`).style.display = 'none';
  document.getElementById(`slot-done-${slotId}`).style.display = 'flex';
}

function markDone(slotId) {
  const slot = slots.find(s => s.id === slotId);
  if (!slot || !slot.topicKey) return;
  const meta = topicMeta[slot.topicKey];
  const [subjId] = slot.topicKey.split('_');

  document.getElementById(`slot-done-${slotId}`).style.display = 'none';

  // NOW log the pending mins to todayMins and topic meta
  if (slot.pendingMins) {
    logStudyTime(slot, slot.pendingMins);
    slot.pendingMins = 0;
  }

  // Yes Done always marks topic complete
  if (meta) {
    const spent = slot.isRev ? (meta.revSpentMins || 0) : (meta.spentMins || 0);
    const alloc = slot.isRev ? meta.revMins : meta.prepMins;
    const overAllocated = !slot.isRev && spent > alloc;
    if (slot.isRev) {
      meta.revDone = true;
      confettiBomb();
      showToast(randomMsg('revision'));
    } else {
      meta.prepDone = true;
      confettiBomb();
      balloonBomb();
      if (overAllocated) {
        const subj = plan.subjects.find(s => s.id === subjId);
        const subjName = subj ? subj.name : 'this subject';
        setTimeout(() => showToast(`This topic took longer than planned. Hit Recalibrate to adjust remaining ${subjName} topics 🔄`), 2500);
      } else {
        showToast(randomMsg('prep'));
      }
      checkSubjectComplete(subjId);
    }
    openSubjects.add(subjId);
  }

  renderTopicsTable();
  updateDashboard();
  savePlannerState();
  removeSlot(slotId);
}

function showMoreTime(slotId) {
  document.getElementById(`slot-done-${slotId}`).style.display = 'none';
  document.getElementById(`slot-more-${slotId}`).style.display = 'flex';
  const slot = slots.find(s => s.id === slotId);
  if (slot) { slot.selectedMoreMins = 0; slot.effortType = null; }
}

function selectMoreMins(slotId, mins, btn) {
  const slot = slots.find(s => s.id === slotId);
  if (slot) slot.selectedMoreMins = mins;
  document.querySelectorAll(`#slot-more-${slotId} .more-min-btn`).forEach(b => b.classList.remove('selected'));
  btn.classList.add('selected');
}

function selectEffortType(slotId, type) {
  const slot = slots.find(s => s.id === slotId);
  if (slot) slot.effortType = type;
  document.getElementById(`slot-budget-btn-${slotId}`).className = 'effort-btn' + (type === 'budget' ? ' selected-budget' : '');
  document.getElementById(`slot-bonus-btn-${slotId}`).className  = 'effort-btn' + (type === 'bonus'  ? ' selected-bonus'  : '');
}

function confirmMoreTime(slotId) {
  const slot = slots.find(s => s.id === slotId);
  if (!slot) return;
  if (!slot.selectedMoreMins) { alert('Please select how many more minutes.'); return; }
  if (!slot.effortType) { alert('Please select if this is from your plan or extra effort.'); return; }

  // Tag the slot so logStudyTime knows what to do when this timer ends
  slot.extraEffortType = slot.effortType;

  if (slot.effortType === 'bonus') {
    // Bonus: add to bonusMins display, but do NOT touch topic's spentMins
    bonusMins += slot.selectedMoreMins;
    activateBonusStardust();
    showToast(randomMsg('bonus'));
  }
  // Both types: restart timer for the extra duration
  document.getElementById(`slot-more-${slotId}`).style.display = 'none';
  slot.durationMins = slot.selectedMoreMins;
  startTimerDirect(slotId);
  updateDashboard();
}

function logStudyTime(slot, mins) {
  if (mins <= 0) return;
  todayMins += mins;

  if (slot.topicKey) {
    const meta = topicMeta[slot.topicKey];
    if (meta) {
      if (slot.isRev) {
        meta.revSpentMins = (meta.revSpentMins || 0) + mins;
      } else if (slot.extraEffortType === 'bonus') {
        // Bonus effort: only count toward today + bonusMins, NOT topic's spentMins
        // bonusMins already added in confirmMoreTime, just track total
        totalSpentMins += mins;
      } else {
        // Normal session or "from plan" — counts toward topic progress
        meta.spentMins = (meta.spentMins || 0) + mins;
        totalSpentMins += mins;
      }
    }
  } else {
    totalSpentMins += mins;
  }

  // Reset extraEffortType after logging
  slot.extraEffortType = null;
  updateDashboard();
}

function removeSlot(slotId) {
  const slot = slots.find(s => s.id === slotId);
  if (slot) clearInterval(slot.timerInterval);
  slots = slots.filter(s => s.id !== slotId);
  const card = document.getElementById(`slot-${slotId}`);
  if (card) card.remove();
  removeSlotFromStorage(slotId);
}

// ── SLOT STORAGE ──
function saveSlotToStorage(slotId, key, isRev) {
  const stored = JSON.parse(localStorage.getItem('activeSlots') || '[]');
  const existing = stored.findIndex(s => s.slotId === slotId);
  const entry = { slotId, key, isRev };
  if (existing >= 0) stored[existing] = entry;
  else stored.push(entry);
  localStorage.setItem('activeSlots', JSON.stringify(stored));
}

function removeSlotFromStorage(slotId) {
  const stored = JSON.parse(localStorage.getItem('activeSlots') || '[]');
  localStorage.setItem('activeSlots', JSON.stringify(stored.filter(s => s.slotId !== slotId)));
}

function restoreSlotsFromStorage() {
  const stored = JSON.parse(localStorage.getItem('activeSlots') || '[]');
  stored.forEach(({ slotId, key, isRev }) => {
    // Only restore if topic still exists in plan
    if (!topicMeta[key]) return;
    addSlot();
    const newSlot = slots[slots.length - 1];
    loadTopicIntoSlot(newSlot.id, key, isRev);
  });
}

function highlightTopicRow(key, isRev) {
  // Remove highlight from all rows first
  document.querySelectorAll('.topic-row.in-slot').forEach(r => r.classList.remove('in-slot'));
  // Find and highlight the dropped topic row
  const selector = isRev ? `[data-key="${key}"].revision-row` : `[data-key="${key}"]:not(.revision-row)`;
  const row = document.querySelector(selector);
  if (row) row.classList.add('in-slot');
}

// ── SAVE ──
async function savePlannerState() {
  if (!currentUserId || !plan) return;
  await dbSave(currentUserId, {
    ...plan,
    topic_meta: topicMeta,
    today_mins: todayMins,
    bonus_mins: bonusMins,
    total_spent_mins: totalSpentMins,
    subject_badges: subjectBadges,
    last_saved_date: new Date().toDateString(),
  });
}

// ── HELPERS ──
function formatMins(mins) {
  if (!mins) return '0m';
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function goReplan() { localStorage.setItem('replan', '1'); window.location.href = 'index.html'; }
