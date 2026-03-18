// ── STATE ──
let subjects     = [];
let currentUserId  = null;
let currentPasteId = null;
let dbLoaded = false;   // single guard: never save before DB has loaded

const PRESETS = [
  { name:'Maths',           emoji:'🔢' },
  { name:'English',         emoji:'📝' },
  { name:'Hindi',           emoji:'🇮🇳' },
  { name:'Science',         emoji:'🔬' },
  { name:'Social Studies',  emoji:'🌍' },
  { name:'Computer Science',emoji:'💻' },
  { name:'Sanskrit',        emoji:'📜' },
  { name:'French',          emoji:'🇫🇷' },
  { name:'Geography',       emoji:'🗺️' },
  { name:'History',         emoji:'🏛️' },
];

// ── SAVE — reads DOM fresh every time ──
async function saveAll() {
  if (!currentUserId) { console.warn('saveAll: Not logged in'); return false; }
  if (!dbLoaded)      { console.warn('saveAll: DB not loaded yet — skipping save'); return false; }

  // Load existing data first so we don't wipe topic_meta and other planner fields
  const existing = await dbLoad(currentUserId) || {};

  const payload = {
    ...existing,
    subjects,
    study_start:   document.getElementById('study-start').value || null,
    exam_start:    document.getElementById('exam-start').value  || null,
    exam_end:      document.getElementById('exam-end').value    || null,
    weekday_hrs:   parseFloat(document.getElementById('weekday-hrs').value) || null,
    weekend_hrs:   parseFloat(document.getElementById('weekend-hrs').value) || null,
  };

  console.log('💾 saveAll: saving', subjects.length, 'subjects, hrs:', payload.weekday_hrs, '/', payload.weekend_hrs);
  console.log('💾 saveAll: full payload =', JSON.stringify(payload));
  const ok = await dbSave(currentUserId, payload);
  if (ok) console.log('✅ saveAll: success —', subjects.map(s => s.name + ':' + s.topics.length));
  else    console.error('❌ saveAll: dbSave returned falsy');
  updateChecklist();
  return ok;
}

// ── DROPDOWN ──
function toggleDropdown() {
  document.getElementById('subj-dropdown').classList.toggle('open');
}
document.addEventListener('click', e => {
  if (!e.target.closest('.add-subj-wrap') && !e.target.closest('.subj-dropdown'))
    document.getElementById('subj-dropdown').classList.remove('open');
});

// ── SUBJECTS ──
function addSubject(idx) {
  document.getElementById('subj-dropdown').classList.remove('open');
  const p = PRESETS[idx];
  if (subjects.find(s => s.name === p.name)) { alert(p.name + ' already added!'); return; }
  subjects.push({ id: Date.now().toString(), name: p.name, emoji: p.emoji, difficulty: 'norm', topics: [], examDate: '' });
  renderSubjects();
  saveAll();
}

function addCustomSubject() {
  document.getElementById('subj-dropdown').classList.remove('open');
  const name = prompt('Subject name:');
  if (!name?.trim()) return;
  subjects.push({ id: Date.now().toString(), name: name.trim(), emoji: '📖', difficulty: 'norm', topics: [], examDate: '' });
  renderSubjects();
  saveAll();
}

function deleteSubject(id) {
  if (!confirm('Remove this subject?')) return;
  subjects = subjects.filter(s => s.id !== id);
  renderSubjects();
  saveAll();
}

function setDifficulty(id, diff) {
  const s = subjects.find(s => s.id === id);
  if (!s) return;
  s.difficulty = diff;
  renderSubjects();
  saveAll();
}

function setExamDate(id, val) {
  const s = subjects.find(s => s.id === id);
  if (!s) return;
  if (val) {
    const today = new Date(); today.setHours(0,0,0,0);
    const chosen = new Date(val); chosen.setHours(0,0,0,0);
    if (chosen < today) {
      alert('⚠️ Exam date cannot be in the past!');
      // Reset the input visually
      const input = document.querySelector(`input[onchange*="${id}"]`);
      if (input) input.value = s.examDate || '';
      return;
    }
    const studyStart = document.getElementById('study-start').value;
    if (studyStart && val <= studyStart) {
      alert('⚠️ Exam date must be after your study start date!');
      const input = document.querySelector(`input[onchange*="${id}"]`);
      if (input) input.value = s.examDate || '';
      return;
    }
  }
  s.examDate = val;
  saveAll();
}

// ── RENDER ──
function renderSubjects() {
  const list = document.getElementById('subj-list');
  list.innerHTML = '';
  subjects.forEach(s => {
    const tc = s.topics?.length || 0;
    const d = document.createElement('div');
    d.className = 'subj-item';
    d.innerHTML = `
      <div class="si-name-wrap">
        <span class="si-emoji">${s.emoji}</span>
        <span class="si-name">${s.name}</span>
      </div>
      <div class="diff-group">
        <button class="dp easy ${s.difficulty==='easy'?'on':''}" onclick="setDifficulty('${s.id}','easy')">😊 Easy</button>
        <button class="dp norm ${s.difficulty==='norm'?'on':''}" onclick="setDifficulty('${s.id}','norm')">📚 Normal</button>
        <button class="dp hard ${s.difficulty==='hard'?'on':''}" onclick="setDifficulty('${s.id}','hard')">🔥 Hard</button>
      </div>
      <div class="upload-group">
        <button class="up-btn" onclick="document.getElementById('upl-${s.id}').click()">📄 Upload</button>
        <input type="file" id="upl-${s.id}" accept=".txt,.docx" style="display:none" onchange="handleUpload(this,'${s.id}')">
        <button class="up-btn" onclick="openPasteModal('${s.id}','${s.name}')">✏️ Paste</button>
        <span class="up-status ${tc>0?'ok':'nil'}">${tc>0?'✓ '+tc+' topics':'no topics yet'}</span>
      </div>
      <div class="exam-date-wrap">
        <div class="exam-date-label">Exam date <span class="exam-date-hint">(optional)</span></div>
        <input class="exam-date-input" type="date" value="${s.examDate||''}" onchange="setExamDate('${s.id}',this.value)">
      </div>
      <button class="del-btn" onclick="deleteSubject('${s.id}')">🗑</button>
    `;
    list.appendChild(d);
  });
  updateChecklist();
}

// ── UPLOAD ──
function handleUpload(input, subjectId) {
  const file = input.files[0]; if (!file) return;
  const apply = text => {
    const topics = parseTopics(text);
    if (!topics.length) { alert('No topics found.'); return; }
    applyTopics(subjectId, topics);
  };
  if (file.name.endsWith('.docx')) {
    const r = new FileReader();
    r.onload = e => mammoth.extractRawText({ arrayBuffer: e.target.result })
      .then(x => apply(x.value)).catch(() => alert('Try Paste instead.'));
    r.readAsArrayBuffer(file);
  } else {
    const r = new FileReader(); r.onload = e => apply(e.target.result); r.readAsText(file);
  }
}

function applyTopics(subjectId, topics) {
  const s = subjects.find(s => s.id === subjectId);
  if (!s) return;
  s.topics = topics;
  renderSubjects();
  saveAll();
}

function parseTopics(text) {
  return text.split('\n')
    .map(l => l.replace(/^[-•*\d.)\s]+/, '').trim())
    .filter(l => l.length > 2 && l.length < 200);
}

// ── PASTE MODAL ──
function openPasteModal(subjectId, subjectName) {
  currentPasteId = subjectId;
  document.getElementById('paste-modal-title').textContent = '✏️ ' + subjectName;
  const s = subjects.find(s => s.id === subjectId);
  document.getElementById('paste-textarea').value = s?.topics?.join('\n') || '';
  document.getElementById('paste-modal').classList.add('open');
}
function closePasteModal() {
  document.getElementById('paste-modal').classList.remove('open');
  currentPasteId = null;
}
function savePastedTopics() {
  const topics = parseTopics(document.getElementById('paste-textarea').value);
  if (!topics.length) { alert('One topic per line.'); return; }
  applyTopics(currentPasteId, topics);
  closePasteModal();
}

// ── CHECKLIST ──
function updateChecklist() {
  const ss = document.getElementById('study-start')?.value;
  const es = document.getElementById('exam-start')?.value;
  const ee = document.getElementById('exam-end')?.value;
  const wd = document.getElementById('weekday-hrs')?.value;
  const we = document.getElementById('weekend-hrs')?.value;

  const hasSchedule   = !!(ss && es && ee && wd && we);
  const withTopics    = subjects.filter(s => s.topics?.length > 0);
  const withoutTopics = subjects.filter(s => !s.topics?.length);
  const canBuild      = hasSchedule && withTopics.length > 0;

  let dateError = '';
  if (ss && es && ss >= es) dateError = '⚠️ Study start must be before exams start';
  if (es && ee && es > ee)  dateError = '⚠️ Exams end must be after exams start';

  document.getElementById('build-checklist').innerHTML = `
    <div class="bc-item"><div class="bc-dot ${hasSchedule?'ok':'no'}"></div><span class="bc-txt ${hasSchedule?'ok':'no'}">${hasSchedule?'Study schedule set ✓':'Complete study schedule'}</span></div>
    <div class="bc-item"><div class="bc-dot ${withTopics.length>0?'ok':'no'}"></div><span class="bc-txt ${withTopics.length>0?'ok':'no'}">${withTopics.length>0?withTopics.length+' subject'+(withTopics.length>1?'s':'')+' ready ✓':'Add topics to at least one subject'}</span></div>
    ${withoutTopics.length>0?`<div class="bc-warning">⚠️ ${withoutTopics.map(s=>s.name).join(', ')} ${withoutTopics.length===1?'has':'have'} no topics — will be skipped</div>`:''}
    ${dateError?`<div class="bc-warning">${dateError}</div>`:''}
  `;
  document.getElementById('build-btn').disabled = !canBuild || !!dateError;
}

// ── BUILD ──
async function buildPlan() {
  const btn = document.getElementById('build-btn');
  btn.textContent = 'Saving...';
  btn.disabled = true;
  await saveAll();
  setTimeout(() => { window.location.href = 'planner.html'; }, 800);
}

// ── BOOT — fires on every auth state change ──
sb.auth.onAuthStateChange((event, session) => {
  if (!session) {
    document.getElementById('login-screen').style.display = 'flex';
    document.getElementById('app-screen').style.display = 'none';
    dbLoaded = false;
    return;
  }

  if (dbLoaded && currentUserId === session.user.id) return;

  dbLoaded = false;
  currentUserId = session.user.id;

  // Defer all async Supabase calls out of the callback
  setTimeout(() => boot(session), 0);
});

async function boot(session) {
  // Keep screens hidden until we know where to go
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('app-screen').style.display = 'none';
  document.getElementById('user-name').textContent = session.user.user_metadata?.full_name || session.user.email;
  const av = session.user.user_metadata?.avatar_url;
  if (av) document.getElementById('user-avatar').src = av;
  else document.getElementById('user-avatar').style.display = 'none';

  console.log('📥 Loading from DB for user:', currentUserId);
  const data = await dbLoad(currentUserId);
  console.log('📥 DB load result:', data);
  const today = new Date(Date.now() + 5.5*60*60*1000).toISOString().split('T')[0];

  if (data) {
    subjects = data.subjects || [];
    // If plan already built, go straight to planner — unless user clicked Replan
    const replan = localStorage.getItem('replan');
    if (!replan && subjects.length && data.study_start && data.exam_start) {
      window.location.href = 'planner.html';
      return;
    }
    // Only remove flag once we know we're staying on Screen 1
    localStorage.removeItem('replan');
    document.getElementById('study-start').value = data.study_start || today;
    document.getElementById('exam-start').value  = data.exam_start  || '';
    document.getElementById('exam-end').value    = data.exam_end    || '';
    if (data.weekday_hrs) document.getElementById('weekday-hrs').value = data.weekday_hrs;
    if (data.weekend_hrs) document.getElementById('weekend-hrs').value = data.weekend_hrs;
  } else {
    document.getElementById('study-start').value = today;
  }

  // Only now show the app screen — no plan exists, show Screen 1
  document.getElementById('app-screen').style.display = 'block';
  renderSubjects();
  dbLoaded = true;
  console.log('✅ Boot complete — dbLoaded is now TRUE');

  ['study-start','exam-start','exam-end','weekday-hrs','weekend-hrs'].forEach(id => {
    const el = document.getElementById(id);
    el.removeEventListener('change', saveAll);
    el.addEventListener('change', saveAll);
  });
}