/* ==========================================================================
   试卷分析工作台 · 主逻辑
   --------------------------------------------------------------------------
   三步流程：
     ① 粘贴学科网「试卷分析报告」→ 解析出逐题难度系数与知识点
     ② 录入学生逐题得分（只填失分题即可）+ 学情补充
     ③ 生成《锐满分教育试卷分析表》，可 AI 重写建议段、导出、存档
   引擎全部由 js/ 下的四个纯函数模块提供，这里只做界面与编排。
   ========================================================================== */
(function () {
'use strict';

const $  = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
const val = id => { const e = document.getElementById(id); return e ? String(e.value).trim() : ''; };
const esc = t => String(t == null ? '' : t).replace(/[&<>"]/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[m]));
const num = x => { const v = parseFloat(x); return isNaN(v) ? 0 : v; };
const round2 = x => Math.round(num(x) * 100) / 100;

/* ==========================================================================
   阶段3：统一学生 API（/api/students）
   --------------------------------------------------------------------------
   为什么要有这一层：以前学生档案与历史只存在**本机浏览器** localStorage ——
   换台电脑就没了、清缓存就没了，而且三个工具各存各的。0014 迁移之后
   全站共用 `feedback_students` / `feedback_history` 两张表，接口是 `/api/students`。

   ⚠️ **写入必须用合并语义的 upsert**（POST 只发变化的字段）：
      0014 之后同一行装了三个工具的字段，feedback 那条老路径是**整行覆盖**，
      会把别家工具的字段静默清空。`/api/students` 就是为合并语义做的。

   ⚠️ 工具专属字段（这里的 `cls`）进 `extra` jsonb，**不要**去改表结构。

   ⚠️ 只在**云端模式**（NEXT_HOST）启用。本机版 / 自建 server.js 的部署
      保持不变（那边没有 /api/students）。见 CLOUD_STORE.enabled。
   ========================================================================== */
const K_SKIP_MIGRATE = 'paper_analysis_skip_migrate_v1';

const CLOUD_STORE = {
  enabled: false,        // detectServer() 成功且是本站部署时才打开

  /** 读取全部档案（+历史） */
  async loadAll(){
    const d = await apiFetch('/api/students?withHistory=1');
    if(!d || !d.ok) throw new Error('读取失败');
    return { students: d.students || {}, history: d.history || {} };
  },

  /** 保存一位学生的档案（合并语义） */
  async saveStudent(name, s){
    return apiFetch('/api/students', {
      method:'POST',
      body:{
        name,
        gender: s.gender || '',
        grade: s.grade || '',
        subject: s.subject || '',
        teacher: s.teacher || '',
        manager: s.manager || '',
        class_name: s.cls || '',
        attitude: s.attitude || '',
        // 工具专属字段进 extra；⚠️ 必须是对象，不能是 null / 数组（0014 有 CHECK 约束）
        extra: { cls: s.cls || '' },
      },
    });
  },

  /** 删除一位学生（连同历史） */
  async deleteStudent(name){
    return apiFetch('/api/students?name=' + encodeURIComponent(name), { method:'DELETE' });
  },

  /** 删除**单条**历史记录（阶段3 给 /api/students 补的 `?id=` 分支） */
  async deleteHistory(id){
    return apiFetch('/api/students?id=' + encodeURIComponent(id), { method:'DELETE' });
  },

  /** 批量导入考试记录（幂等：重复跑返回 inserted:0 / skipped:N） */
  async importHistory(items){
    if(!items || !items.length) return { inserted:0, skipped:0, dateUnparsed:0 };
    return apiFetch('/api/students', { method:'POST', body:{ op:'import', items } });
  },
};

/** 云端档案行 → 本工具内部的档案形状（本工具的字段名叫 `cls`，表里叫 `class_name`） */
function studentFromCloud(row){
  return {
    gender: row.gender || '',
    grade: row.grade || '',
    subject: row.subject || '',
    teacher: row.teacher || '',
    manager: row.manager || '',
    cls: row.class_name || (row.extra && row.extra.cls) || '',
    attitude: row.attitude || '',
    updated: row.updated || '',
  };
}

/** 云端历史行 → 本工具内部的形状。
 *  ⚠️ 映射关系（0014 加的列就是为这个准备的）：
 *      tool='paper' / title=examName / score=score / full_score=full */
function historyFromCloud(row){
  return {
    text: row.text || '',
    // `date` 在云端已经被格式化成「10月7日」这种给人看的写法（feedback-db 的
    // formatDisplayDate）——与本工具原来的 localStorage 形状一致，直接复用即可。
    date: row.date || '',
    examName: row.title || '',
    score: row.score,
    full: row.fullScore,
    saved: row.saved || '',
    cloudId: row.id,
  };
}

/** 本工具的历史 → 导入接口要的形状 */
function historyToImport(name, h){
  return {
    student_name: name,
    text: h.text,
    date: h.date,               // 服务端用同一个 parseDisplayDate 解析
    tool: 'paper',
    title: h.examName || '',
    score: (h.score === '' || h.score == null) ? null : Number(h.score),
    full_score: (h.full === '' || h.full == null) ? null : Number(h.full),
  };
}

/** 本机是否存着「值得迁移」的旧数据 */
function localLegacy(){
  const stu = loadJSON(K_STU, {}) || {};
  const hist = loadJSON(K_HIST, {}) || {};
  const stuN = Object.keys(stu).length;
  const histN = Object.values(hist).reduce((a, l) => a + (Array.isArray(l) ? l.length : 0), 0);
  return { stu, hist, stuN, histN, any: stuN > 0 || histN > 0 };
}

/**
 * 首次进入时，问用户要不要把本机旧数据上传到账号。
 *
 * ⚠️ **绝不静默上传**（用户明确要求）：学生姓名是真实信息，老师必须自己确认。
 * ⚠️ 上传后**保留本机数据**作后悔药（不删 localStorage）。
 * ⚠️ 日期解析不出来的条数**如实报出来**，不静默丢。
 */
function maybeOfferMigration(){
  if(!CLOUD_STORE.enabled) return;
  let skipped = false;
  try{ skipped = localStorage.getItem(K_SKIP_MIGRATE) === '1'; }catch(e){}
  if(skipped) return;

  const legacy = localLegacy();
  if(!legacy.any) return;

  const box = $('#migrateSummary');
  if(box){
    box.innerHTML = '本机现有：<b>' + legacy.stuN + '</b> 位学生档案、<b>' + legacy.histN + '</b> 条历史报告。';
  }
  const m = $('#maskMigrate');
  if(m) m.classList.add('on');
}

function bindMigrateDialog(){
  const close = () => { const m = $('#maskMigrate'); if(m) m.classList.remove('on'); };
  const later = $('#btnMigrateLater');
  if(later) later.onclick = close;   // 下次再问
  const skip = $('#btnMigrateSkip');
  if(skip) skip.onclick = () => {
    try{ localStorage.setItem(K_SKIP_MIGRATE, '1'); }catch(e){}
    close();
    toast('好的，以后不再询问');
  };
  const go = $('#btnMigrateGo');
  if(go) go.onclick = async () => {
    go.disabled = true;
    const old = go.textContent;
    go.textContent = '正在上传…';
    try{
      const r = await migrateLocalToCloud();
      close();
      toast('已保存到账号：' + r.stuOk + ' 位学生、' + r.ins + ' 条历史'
        + (r.dateUnparsed ? '（有 ' + r.dateUnparsed + ' 条日期没认出来，已按空日期保存）' : ''), 5200);
      await loadFromCloud();
    }catch(e){
      toast('上传失败：' + (e && e.message ? e.message : e), 4200);
    }finally{
      go.disabled = false;
      go.textContent = old;
    }
  };
}

/** 真的执行迁移；返回统计（供提示语使用） */
async function migrateLocalToCloud(){
  const legacy = localLegacy();
  let stuOk = 0, stuFail = 0;

  // ① 档案：逐个 upsert（合并语义，只发本工具拥有的字段）
  for(const name of Object.keys(legacy.stu)){
    try{ await CLOUD_STORE.saveStudent(name, legacy.stu[name]); stuOk++; }
    catch(e){ stuFail++; }
  }

  // ② 历史：一次批量导入（接口幂等，重复点不会造重复数据）
  const items = [];
  for(const name of Object.keys(legacy.hist)){
    const list = Array.isArray(legacy.hist[name]) ? legacy.hist[name] : [];
    for(const h of list){
      if(!h || !h.text) continue;        // 没有正文的没法用（接口也会跳过）
      items.push(historyToImport(name, h));
    }
  }
  let ins = 0, skipped = 0, dateUnparsed = 0;
  if(items.length){
    const d = await CLOUD_STORE.importHistory(items);
    ins = d.inserted || 0;
    skipped = d.skipped || 0;
    dateUnparsed = d.dateUnparsed || 0;
  }
  // 档案失败要如实说，不能只报成功的
  if(stuFail) toast('有 ' + stuFail + ' 位学生的档案没能保存', 3600);
  return { stuOk, stuFail, ins, skipped, dateUnparsed };
}

/** 从云端拉全量（档案 + 历史），覆盖内存态并重绘 */
async function loadFromCloud(){
  const d = await CLOUD_STORE.loadAll();
  students = {};
  for(const [name, row] of Object.entries(d.students || {})) students[name] = studentFromCloud(row);
  history = {};
  for(const [name, list] of Object.entries(d.history || {})){
    history[name] = (Array.isArray(list) ? list : []).map(historyFromCloud);
  }
  renderStuChips();
  renderHist();
  return { stuN: Object.keys(students).length, histN: Object.values(history).reduce((a, l) => a + l.length, 0) };
}

/* ---------- 存储 ---------- */
const K_PAPER = 'paper_analysis_paper_v1';
const K_STU   = 'paper_analysis_students_v1';
const K_HIST  = 'paper_analysis_history_v1';
const K_TOKEN = 'paper_analysis_token_v1';

/* ---------- 状态 ---------- */
let paper = null;          // 解析后的试卷
let scoreAssign = null;    // 分值分配
let scoreExpand = new Set();  // 已展开逐题分值的题型（不持久化，刷新回全收起）
let baselineTotals = {};   // 题型 → assignScores 刚算出的应有总分（用于「与预设不一致」提示）
let records = {};          // 题号 → {full, got, note}
let students = {};         // 姓名 → 档案
let history = {};          // 姓名 → [报告]
let lastReport = '';
let lastAdviceCtx = null;

/* ---------- 常量 ---------- */
const GRADES = ['高一','高二','高三','新高一','新高二','新高三','初一','初二','初三'];
const SUBJECTS = ['数学','英语','语文','物理','化学','生物','历史','地理','政治'];

/* ==========================================================================
   运行模式：本机版 / 云端版（接入 my-toolbox）
   --------------------------------------------------------------------------
   三种情形：
     ① 挂在本站 /tools/paper-analysis 下  → 云端模式
          接口走 /api/paper-analysis/*，AI Key 由服务器保管
     ② 放在别的服务器上跑原来的 server.js → 联网模式（保留原逻辑，接口仍是 api/*）
     ③ 直接双击 HTML（file://）            → 本机模式，数据存浏览器、AI 用自己填的 Key
   ②③ 的行为与接入前完全一致，不受影响。
   ========================================================================== */
const NEXT_HOST = (location.protocol === 'http:' || location.protocol === 'https:')
  && /^\/tools\/paper-analysis(\/|$)/.test(location.pathname);
const API_BASE = NEXT_HOST ? '/api/paper-analysis' : 'api';

const API = { mode:'local', isAdmin:false, serverCfg:{}, writeToken:'' };

async function apiFetch(path, opts){
  const o = Object.assign({credentials:'same-origin'}, opts || {});
  if(o.body && typeof o.body === 'object' && !(o.body instanceof FormData)){
    o.headers = Object.assign({'Content-Type':'application/json'}, o.headers || {});
    o.body = JSON.stringify(o.body);
  }
  const p = getAccessPass();
  if(p) o.headers = Object.assign({'x-fb-pass': p}, o.headers || {});
  const r = await fetch(path, o);
  // 云端模式下没有"访问口令"这套机制（站点登录已是鉴权边界），不要弹口令框
  if(r.status === 401 && !NEXT_HOST){ try{ const d = await r.clone().json(); if(d.needPass !== false) askAccessPass(); }catch(e){} }
  if(!r.ok){ let msg = '接口 ' + path + ' 返回 ' + r.status; try{ const d = await r.json(); if(d.error) msg = d.error; }catch(e){} throw new Error(msg); }
  return r.json();
}
const getAccessPass = () => { try{ return sessionStorage.getItem('fb_pass') || ''; }catch(e){ return ''; } };
const setAccessPass = v => { try{ v ? sessionStorage.setItem('fb_pass', v) : sessionStorage.removeItem('fb_pass'); }catch(e){} };
let _passAsked = false;
function askAccessPass(){
  if(_passAsked) return; _passAsked = true;
  const m = $('#maskPass'); if(m){ m.classList.add('on'); const i = $('#passInput'); if(i) i.focus(); }
}
const getWriteToken = () => { if(API.writeToken) return API.writeToken; try{ return sessionStorage.getItem(K_TOKEN) || ''; }catch(e){ return ''; } };
const setWriteToken = t => { API.writeToken = t || ''; try{ sessionStorage.setItem(K_TOKEN, API.writeToken); }catch(e){} };

function detectServer(){
  if(location.protocol !== 'http:' && location.protocol !== 'https:') return Promise.resolve(false);
  return apiFetch(API_BASE + '/mode').then(d=>{
    if(d && d.ok){
      API.mode = 'server'; API.isAdmin = !!d.isAdmin; API.serverCfg = d.config || {};
      return true;
    }
    return false;
  }).catch(()=>false);
}
function updateModeBadge(){
  const b = $('#modeBadge'); if(!b) return;
  if(API.mode === 'server'){
    const cloud = NEXT_HOST;
    b.textContent = cloud
      ? (API.isAdmin ? '☁️ 云端·管理员' : '☁️ 云端版')
      : (API.isAdmin ? '🌐 联网·管理员' : '🌐 联网版');
    b.title = API.serverCfg.hasKey ? '服务器已配置 AI' : '服务器未配置 AI';
  }else{
    b.textContent = '💾 本机版';
    b.title = '数据保存在这台电脑的浏览器里';
  }
}

/* ==========================================================================
   工具
   ========================================================================== */
let _toastT;
function toast(msg, ms){
  const t = $('#toast'); t.textContent = msg; t.classList.add('on');
  clearTimeout(_toastT); _toastT = setTimeout(()=>t.classList.remove('on'), ms || 2200);
}
function switchStep(id){
  $$('.steps button').forEach(b => b.classList.toggle('on', b.dataset.col === id));
  $$('.col').forEach(c => c.classList.toggle('on', c.id === id));
  if(window.innerWidth <= 1080) window.scrollTo({top:0, behavior:'smooth'});
}
function loadJSON(key, def){
  try{ const s = localStorage.getItem(key); return s ? JSON.parse(s) : def; }catch(e){ return def; }
}
function saveJSON(key, v){ try{ localStorage.setItem(key, JSON.stringify(v)); }catch(e){} }

/* ==========================================================================
   ① 解析试卷
   ========================================================================== */
function fillPresetSelect(){
  const sel = $('#examPreset');
  sel.innerHTML = '<option value="">自动判断</option>' +
    PaperParser.TYPE_PRESETS.map(p => `<option value="${esc(p.name)}">${esc(p.name)}</option>`).join('');
}

/** 把一段文本解析成试卷；成功返回 true */
function adoptPaperText(txt, sourceLabel){
  const box = $('#parseResult');
  const type = PaperParser.detectDocType(txt);

  if(type === 'teacher'){
    box.innerHTML = '<div class="errbox">这看起来是<b>「学生试卷分析表」</b>（含"错题分析""失分情况及原因分析"），不是学科网的「试卷分析报告」。'
      + '请找那份含<b>「整体难度／试卷题型／试卷难度／细目表分析／知识点分析」</b>的报告。</div>';
    return false;
  }
  let r;
  try { r = PaperParser.parse(txt); }
  catch(e){ box.innerHTML = '<div class="errbox">解析失败：' + esc(e.message) + '</div>'; return false; }

  if(!r.questions.length){
    box.innerHTML = '<div class="errbox">没有解析到题目。可能原因：① 粘贴/上传的不是完整报告（缺「细目表分析」那段）；'
      + '② 来源是扫描图片版，文字没被正确提取。<br>可以试试：改用 <b>.docx</b> 文件上传，或把文字复制粘贴进来。</div>';
    return false;
  }
  paper = r;
  $('#paperPaste').value = txt;

  // 应用解析结果到表单
  $('#paperTitle').textContent = r.title || '';
  $('#examName').value = r.title && r.title.length <= 20 ? r.title : (r.title || '');
  $('#examDiff').value = r.overallDifficulty || '';
  $('#examScope').value = (r.scope || []).join(',');
  computeScores();

  const warn = (r.warnings || []).filter(w => !/没有解析到试卷标题/.test(w));
  let html = `<div class="okbox">✅ 解析成功${sourceLabel ? '（来源：' + esc(sourceLabel) + '）' : ''}：共 <b>${r.questions.length}</b> 道题，`
    + `考试范围 <b>${(r.scope||[]).length}</b> 个模块，整体难度「${esc(r.overallDifficulty||'未填')}」。`
    + `每道题的<b>难度系数</b>与<b>考察知识点</b>已自动填入。</div>`;
  html += `<div class="tip" style="margin-top:8px">难度系数换算：` +
    '<span class="tag easy">≥0.80 → 较易</span><span class="tag mid">0.50–0.79 → 中等</span>' +
    '<span class="tag hard">0.30–0.49 → 较难</span><span class="tag vh">&lt;0.30 → 难</span>' +
    '（阈值已对真实报告验证，可 100% 复现学科网的题数分布）</div>';
  if(warn.length) html += '<div class="warnbox">⚠ ' + warn.map(esc).join('<br>⚠ ') + '</div>';
  box.innerHTML = html;

  $('#paperPanel').style.display = '';
  $('#qPanel').style.display = '';
  $('#paperHint').textContent = r.questions.length + ' 题 · ' + (r.title || '').slice(0, 14);
  // 注意：分值分配表在 computeScores() 里已经渲染过了（见本函数上方），
  // 这里原来还调用了一次 renderScoreTable()——那个函数并不存在（实际叫
  // renderScoreAssignTable），会抛 ReferenceError 并中断本函数，
  // 导致紧随其后的 renderQuestionList() 从不执行、「解析结果」面板永远是空的。
  renderQuestionList();
  renderScoreList();
  saveJSON(K_PAPER, { text: txt, meta: collectPaperMeta() });
  // ⚠️ **刻意不跳转到「② 录入成绩」**（2026-10 的行为变更，用户要求）。
  //    原因：老师导入试卷后紧接着要核对**卷面结构**（决定每题分值），而
  //    「卷面总分 / 卷面结构下拉 / 分值分配表」全在**① 试卷页**上（见 index.html）。
  //    以前这里 switchStep('cScore') 会把人直接踢到录入页，老师必须再点回来才能改分值。
  //    北京卷这类「同一题号每年分值不同」的卷子尤其需要先改分值再录分。
  //    改成停在试卷页 + 一句提示，老师改完自己点「② 录入成绩」。
  toast('解析成功，共 ' + r.questions.length + ' 题 —— 请先核对下方「分值分配」，改完点「② 录入成绩」');
  return true;
}

/** 从粘贴框解析 */
function parsePaper(){
  const txt = $('#paperPaste').value;
  if(!txt.trim()){ toast('请先粘贴或上传内容'); return; }
  adoptPaperText(txt, '');
}

/* ---------- 文件上传 ---------- */
function toDataUrl(file){
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = () => rej(new Error('读取文件失败'));
    r.readAsDataURL(file);
  });
}

/** .docx 在浏览器里也能自己解包（不依赖服务器） */
function extractDocxInBrowser(arrayBuffer){
  const u8 = new Uint8Array(arrayBuffer);
  const dv = new DataView(arrayBuffer);
  // 找中央目录里的 word/document.xml
  let found = null;
  for(let i = 0; i + 46 <= u8.length - 4; i++){
    if(u8[i] !== 0x50 || u8[i+1] !== 0x4B || u8[i+2] !== 0x01 || u8[i+3] !== 0x02) continue;
    const method = dv.getUint16(i + 10, true);
    let csize = dv.getUint32(i + 20, true);
    const nlen = dv.getUint16(i + 28, true);
    const elen = dv.getUint16(i + 30, true);
    const clen = dv.getUint16(i + 32, true);
    const lho  = dv.getUint32(i + 42, true);
    const name = new TextDecoder('utf-8').decode(u8.subarray(i + 46, i + 46 + nlen));
    if(name === 'word/document.xml'){ found = { method, csize, lho }; break; }
    i += 46 + nlen + elen + clen - 1;
  }
  if(!found) throw new Error('不是有效的 .docx');
  const lnameLen = dv.getUint16(found.lho + 26, true);
  const lextraLen = dv.getUint16(found.lho + 28, true);
  const start = found.lho + 30 + lnameLen + lextraLen;
  let raw = u8.subarray(start, start + found.csize);
  let xml;
  if(found.method === 0) xml = new TextDecoder('utf-8').decode(raw);
  else if(found.method === 8) xml = new TextDecoder('utf-8').decode(pako_inflateRaw(raw));
  else throw new Error('不支持的压缩方式 ' + found.method);
  return docxXmlToText_(xml);
}
/** 极简 deflate-raw 解压（调用浏览器内置 DecompressionStream 不可用时回退） */
function pako_inflateRaw(u8){
  if(typeof DecompressionStream === 'undefined') throw new Error('这个浏览器不支持本地解压，请改用粘贴文字或让服务器解析');
  // DecompressionStream 是流式的，需要同步返回 → 这里改用纯 JS 的 inflate
  return inflateRawSync(u8);
}
/* 纯 JS inflate（raw deflate），保证任何浏览器都能离线解 docx */
function inflateRawSync(input){
  const src = input, len = src.length;
  let bitPos = 0, bytePos = 0;
  const bits = (n) => { let v = 0; for(let i = 0; i < n; i++){ v |= ((src[bytePos] >> bitPos) & 1) << i; bitPos++; if(bitPos === 8){ bitPos = 0; bytePos++; } } return v; };
  const out = [];
  const LBASE = [3,4,5,6,7,8,9,10,11,13,15,17,19,23,27,31,35,43,51,59,67,83,99,115,131,163,195,227,258];
  const LEXT  = [0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2,3,3,3,3,4,4,4,4,5,5,5,5,0];
  const DBASE = [1,2,3,4,5,7,9,13,17,25,33,49,65,97,129,193,257,385,513,769,1025,1537,2049,3073,4097,6145,8193,12289,16385,24577];
  const DEXT  = [0,0,0,0,1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,8,9,9,10,10,11,11,12,12,13,13];
  const buildHuff = (lens) => {
    const maxBits = Math.max.apply(null, lens), blCount = new Array(maxBits+1).fill(0);
    lens.forEach(l => { if(l) blCount[l]++; });
    const nextCode = new Array(maxBits+1).fill(0);
    let code = 0;
    for(let b = 1; b <= maxBits; b++){ code = (code + blCount[b-1]) << 1; nextCode[b] = code; }
    const map = {};
    lens.forEach((l, sym) => { if(l) map[l + '_' + nextCode[l]++] = sym; });
    return { map, maxBits };
  };
  const decode = (huff) => {
    let code = 0;
    for(let b = 1; b <= huff.maxBits; b++){
      code = (code << 1) | bits(1);
      const sym = huff.map[b + '_' + code];
      if(sym !== undefined) return sym;
    }
    throw new Error('inflate: 无效的哈夫曼码');
  };
  let final = 0;
  do{
    final = bits(1);
    const type = bits(2);
    if(type === 0){
      if(bitPos) { bitPos = 0; bytePos++; }
      const l = src[bytePos] | (src[bytePos+1] << 8);
      bytePos += 4;
      for(let i = 0; i < l; i++) out.push(src[bytePos++]);
    }else if(type === 1){
      const lit = []; for(let i = 0; i < 144; i++) lit.push(8);
      for(let i = 144; i < 256; i++) lit.push(9);
      for(let i = 256; i < 280; i++) lit.push(7);
      for(let i = 280; i < 288; i++) lit.push(8);
      const dist = new Array(30).fill(5);
      run(buildHuff(lit), buildHuff(dist));
    }else if(type === 2){
      const hlit = bits(5) + 257, hdist = bits(5) + 1, hclen = bits(4) + 4;
      const order = [16,17,18,0,8,7,9,6,10,5,11,4,12,3,13,2,14,1,15];
      const clLens = new Array(19).fill(0);
      for(let i = 0; i < hclen; i++) clLens[order[i]] = bits(3);
      const clHuff = buildHuff(clLens);
      const lens = [];
      while(lens.length < hlit + hdist){
        const sym = decode(clHuff);
        if(sym < 16) lens.push(sym);
        else if(sym === 16){ const prev = lens[lens.length-1], n = 3 + bits(2); for(let i=0;i<n;i++) lens.push(prev); }
        else if(sym === 17){ const n = 3 + bits(3); for(let i=0;i<n;i++) lens.push(0); }
        else { const n = 11 + bits(7); for(let i=0;i<n;i++) lens.push(0); }
      }
      run(buildHuff(lens.slice(0, hlit)), buildHuff(lens.slice(hlit)));
    }else throw new Error('inflate: 保留类型');
  }while(!final);
  function run(litHuff, distHuff){
    for(;;){
      const sym = decode(litHuff);
      if(sym < 256) out.push(sym);
      else if(sym === 256) return;
      else{
        const li = sym - 257;
        const length = LBASE[li] + bits(LEXT[li]);
        const ds = decode(distHuff);
        const dist = DBASE[ds] + bits(DEXT[ds]);
        const start = out.length - dist;
        for(let i = 0; i < length; i++) out.push(out[start + i]);
      }
    }
  }
  return new Uint8Array(out);
}
/**
 * 与服务器端同逻辑：把 document.xml 转成带 <TABLE> 的文本
 *
 * ⚠ 所有标签的正则都必须允许带属性，例如 `<w:tc w:rsidR="00AB">`
 *   或 `<w:tr w14:paraId="3336BAB3">`。早期写成 `<w:tc>` 这种
 *   不带属性的形式，遇到真实 Word 导出的文件就会一格都抓不到。
 */
function docxXmlToText_(xml){
  const out = [];
  const parts = xml.split(/(<w:tbl(?:\s[^>]*)?>[\s\S]*?<\/w:tbl>)/g);
  parts.forEach(seg => {
    if(/^<w:tbl[\s>]/.test(seg)){
      out.push('<TABLE>');
      (seg.match(/<w:tr(?:\s[^>]*)?>[\s\S]*?<\/w:tr>/g) || []).forEach(tr => {
        const cells = [];
        (tr.match(/<w:tc(?:\s[^>]*)?>[\s\S]*?<\/w:tc>/g) || []).forEach(tc => {
          const paras = tc.match(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g) || [tc];
          const txt = paras.map(p =>
            (p.match(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g) || [])
              .map(t => t.replace(/<[^>]+>/g, '')).join('')
          ).filter(Boolean).join(' ');
          cells.push(xmlUnesc_(txt.trim()));
        });
        out.push(cells.join(' | '));
      });
      out.push('</TABLE>');
    }else{
      (seg.match(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g) || []).forEach(p => {
        const txt = (p.match(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g) || [])
          .map(t => t.replace(/<[^>]+>/g, '')).join('');
        const s = xmlUnesc_(txt.trim());
        if(s) out.push(s);
      });
    }
  });
  return out.join('\n');
}
function xmlUnesc_(s){
  return String(s).replace(/&lt;/g,'<').replace(/&gt;/g,'>')
    .replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&amp;/g,'&');
}

/** 上传文件 → 抽文本 → 解析；本地能处理的就不麻烦服务器 */
async function handleFile(file){
  const box = $('#parseResult');
  const ext = (file.name.match(/\.([a-zA-Z0-9]+)$/) || [,''])[1].toLowerCase();
  const hint = $('#uploadHint');
  box.innerHTML = '<div class="tip">⏳ 正在读取「' + esc(file.name) + '」…</div>';

  try{
    // ① docx：浏览器本地解包，最快也最准
    if(ext === 'docx'){
      const buf = await file.arrayBuffer();
      let text = '';
      try { text = extractDocxInBrowser(buf); }
      catch(e){ text = ''; }
      if(text.trim()){
        hint.innerHTML = '✅ 已从 <b>' + esc(file.name) + '</b> 抽出文本（本地解析，未上传）';
        if(adoptPaperText(text, file.name)) return;
        // 解析不出就展示原文，让老师看到抽到了什么
        box.innerHTML += '<details class="cat"><summary><span class="arw">▶</span>查看从文件里抽到的文本</summary>'
          + '<div class="body"><pre style="white-space:pre-wrap;font-size:12px;max-height:300px;overflow:auto">'
          + esc(text.slice(0, 6000)) + '</pre></div></details>';
        return;
      }
    }
    // ② 其它格式交给服务器
    if(API.mode !== 'server'){
      box.innerHTML = '<div class="errbox">这个格式需要服务器帮忙解析。<br>'
        + '当前是<b>本机版</b>（直接双击打开的），能本地处理的只有 <b>.docx</b>。<br>'
        + '解决办法：① 把内容复制粘贴进来；② 或把文件放到服务器上访问后用「上传文件解析」'
        + '（<b>PDF 与图片识别都要用服务器上的模型</b>）。</div>';
      return;
    }
    const data = await toDataUrl(file);
    const d = await apiFetch(API_BASE + '/parse-file', { method:'POST', body:{ name:file.name, data } });
    if(!d || !d.ok) throw new Error(d && d.error ? d.error : '服务器解析失败');
    const gotText = String(d.text || '').trim();

    // ★ 扫描版 PDF：服务器抽不到文字（或只抽到零星几个字）→ **在浏览器里**用 pdf.js 逐页渲图，
    //    再走视觉识别那条统一管线（用户 2026-10 选了"引入 pdf.js 把扫描版 PDF 也做上"）。
    //    ⚠️ 阈值 120 字：真扫描版是 0 字；个别 PDF 只嵌了几个字（页眉）也算没文字层。
    if(d.kind === 'pdf' && gotText.length < 120){
      hint.innerHTML = 'ℹ️ 这份 PDF 没有（或几乎没有）文字层，按 <b>扫描版</b>处理：正在逐页渲染后识别…';
      const r = await pdfToPageSources(file, (i, t) => {
        $('#visionPreview').innerHTML = '<div class="tip">⏳ 正在渲染第 ' + i + '/' + t + ' 页…</div>';
      });
      if(!r.sources.length) throw new Error('这份 PDF 里没有可渲染的页面');
      if(r.truncated) toast('这份 PDF 共 ' + r.total + ' 页，本次只识别前 ' + PDF_MAX_PAGES + ' 页', 3600);
      await runVisionSources(r.sources);
      return;
    }

    if(d.note) hint.innerHTML = 'ℹ️ ' + esc(d.note);
    if(gotText){
      if(!adoptPaperText(d.text, file.name)){
        box.innerHTML += '<details class="cat"><summary><span class="arw">▶</span>查看从文件里抽到的文本</summary>'
          + '<div class="body"><pre style="white-space:pre-wrap;font-size:12px;max-height:300px;overflow:auto">'
          + esc(d.text.slice(0, 6000)) + '</pre></div></details>';
      }
    }else{
      box.innerHTML = '<div class="warnbox">没有从文件里抽到可用文本。' + esc(d.note || '') + '</div>';
    }
  }catch(e){
    box.innerHTML = '<div class="errbox">处理文件失败：' + esc(e.message) + '</div>';
  }
}

/* ==========================================================================
   ③ 图片 / 截图识别（★ 2026-10 第六批）
   --------------------------------------------------------------------------
   干什么：把**学科网报告的截图 / 拍照**交给服务端视觉模型**逐字抄录**，拿回文本后
   先给老师**核对（可编辑）**，再一键填进导入框走原有解析流程。

   ⚠️ 用户 2026-10 定的四条口径（改之前先看这里）：
     1. **一页一张、分别识别再合并**（不拼长图，避免小字糊掉；也让失败那页可单独重试）；
     2. **尽力识别 + 标出不确定的地方**（服务端提示词要求把看不清处写成「[看不清]」，
        这里据此给 ⚠️ 提示，绝不假装那几处是准的）；
     3. **先预览核对、再一键填进导入框**（不直接生成报告）；
     4. **免费**（服务端只校验"登录+未封禁"，不是会员专属）。
   ⚠️ **扫描版 PDF 不支持**：浏览器里没有 PDF 渲染器（本工具坚持零第三方依赖），
      所以提示老师把 PDF 每页截图后按图片上传。要做需要引入 pdf.js（另议）。
   ========================================================================== */
const VISION_MAX_SIDE = 1600;   // 长边上限（够认字，又不至于太大）
const VISION_QUALITY = 0.82;

/* ---- 扫描版 PDF：用 pdf.js 在**浏览器里**逐页渲成图（★ 2026-10 第七批） ----
   ⚠️ 为什么要把库放进仓库（`vendor/`）：本工具一直坚持"双击 HTML 就能离线用"，
      所以**不走 CDN**；这两个文件来自 `pdfjs-dist@3.11.174`（Apache-2.0），
      升级时整包替换即可（`build/pdf.min.js` + `build/pdf.worker.min.js`）。
   ⚠️ 路径用**相对**的（与 `js/app.js` 同样的基准），
      这样服务器上（/tools/paper-analysis/index.html）和本机双击（file://）都能加载。 */
const PDFJS_SRC = 'vendor/pdf.min.js';
const PDFJS_WORKER = 'vendor/pdf.worker.min.js';
/** 一次最多渲染/识别多少页（与"单次最多 10 页"的口径一致；超了明确提示，不静默截断） */
const PDF_MAX_PAGES = 10;

/** 只注入一次的 <script>（pdf.js 约 320KB，**只有真要渲染 PDF 时才拉**，平时不影响打开速度） */
function loadScriptOnce(src){
  return new Promise((resolve, reject) => {
    const exists = document.querySelector('script[data-src="' + src + '"]');
    if(exists){
      if(exists.dataset.loaded) return resolve();
      exists.addEventListener('load', () => resolve());
      exists.addEventListener('error', () => reject(new Error('加载 ' + src + ' 失败')));
      return;
    }
    const s = document.createElement('script');
    s.src = src;
    s.dataset.src = src;
    s.onload = () => { s.dataset.loaded = '1'; resolve(); };
    s.onerror = () => reject(new Error('加载 ' + src + ' 失败'));
    document.head.appendChild(s);
  });
}

async function ensurePdfjs(){
  if(!window.pdfjsLib) await loadScriptOnce(PDFJS_SRC);
  if(!window.pdfjsLib) throw new Error('pdf.js 加载后仍不可用');
  try { window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER; } catch(e){ /* 忽略 */ }
  return window.pdfjsLib;
}

/** 扫描版 PDF → 每页一张 JPEG（长边约 1600）。
 *  返回 { sources:[{label,dataUrl}], total, truncated }；**渲不出的页会明确报错**，不静默跳过。
 *  @param limit 最多渲染多少页（学科网报告那条路用默认 10；学校卷子那条路按上限 20 调） */
async function pdfToPageSources(file, onProgress, limit){
  const max = Math.max(1, Number(limit) || PDF_MAX_PAGES);
  const pdfjs = await ensurePdfjs();
  const buf = await file.arrayBuffer();
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf) }).promise;
  const total = doc.numPages;
  const n = Math.min(total, max);
  const sources = [];
  for(let i = 1; i <= n; i++){
    if(onProgress) onProgress(i, n);
    const page = await doc.getPage(i);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(3, Math.max(1, VISION_MAX_SIDE / Math.max(base.width, base.height)));
    const vp = page.getViewport({ scale });
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round(vp.width));
    cv.height = Math.max(1, Math.round(vp.height));
    await page.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise;
    sources.push({ label: '第 ' + i + ' 页', dataUrl: cv.toDataURL('image/jpeg', VISION_QUALITY) });
  }
  return { sources, total, truncated: total > n };
}

/** 图片压到「长边 ≤1600 + JPEG 0.82」：省流量、省费用、避免撞 4MB 上限。
 *  ⚠️ 压不动（解码失败等）就**原样返回**，让服务端去判断，不要在这里静默失败。 */
async function compressImageFile(file){
  const raw = await toDataUrl(file);
  try{
    const img = await new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => rej(new Error('图片解码失败'));
      i.src = raw;
    });
    const scale = Math.min(1, VISION_MAX_SIDE / Math.max(img.naturalWidth || img.width, img.naturalHeight || img.height));
    const w = Math.max(1, Math.round((img.naturalWidth || img.width) * scale));
    const h = Math.max(1, Math.round((img.naturalHeight || img.height) * scale));
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    cv.getContext('2d').drawImage(img, 0, 0, w, h);
    let out = cv.toDataURL('image/jpeg', VISION_QUALITY);
    // 还太大就降一档（服务端上限 4MB，这里留足余量）
    if(out.length > 2600000) out = cv.toDataURL('image/jpeg', 0.6);
    return { dataUrl: out, w, h, scaled: scale < 1 };
  }catch(e){
    return { dataUrl: raw, w: 0, h: 0, scaled: false, err: String((e && e.message) || e) };
  }
}

/** 本批识别的结果（顺序 = 上传顺序） */
let visionPages = [];
let visionBusy = false;

/** 图片文件 → 识别（先逐张压缩，再走统一的识别管线） */
async function visionRun(files){
  const list = Array.from(files || []);
  const box = $('#visionPreview');
  if(!list.length) return;
  if(API.mode !== 'server'){
    box.innerHTML = '<div class="errbox">图片识别要用服务器上的视觉模型。<br>'
      + '当前是<b>本机版</b>（直接双击打开的 HTML）：请改用「粘贴文字」，'
      + '或访问线上站点里的试卷分析工具再试。</div>';
    return;
  }
  if(visionBusy){ toast('上一批还在识别，请稍等'); return; }
  const sources = [];
  for(let i = 0; i < list.length; i++){
    box.innerHTML = '<div class="tip">⏳ 正在处理第 ' + (i + 1) + '/' + list.length + ' 张…</div>';
    const c = await compressImageFile(list[i]);
    sources.push({ label: (list[i].name || ('第 ' + (i + 1) + ' 张')), dataUrl: c.dataUrl });
  }
  await runVisionSources(sources);
}

/** **统一的识别管线**：sources = [{label, dataUrl}]（来自图片文件，或扫描版 PDF 的逐页渲染）。
 *  ⚠️ 图片与 PDF 共用这一条路：识别 → 预览（可改）→ 填进导入框。
 *     新增来源（比如将来的截图粘贴）也应当走这里，不要另写一套。 */
async function runVisionSources(sources){
  const box = $('#visionPreview');
  if(!sources.length) return;
  if(API.mode !== 'server'){
    box.innerHTML = '<div class="errbox">识别要用服务器上的视觉模型。<br>'
      + '当前是<b>本机版</b>：请改用「粘贴文字」，或访问线上站点里的试卷分析工具再试。</div>';
    return;
  }
  if(visionBusy){ toast('上一批还在识别，请稍等'); return; }
  visionBusy = true;
  visionPages = [];
  try{
    for(let i = 0; i < sources.length; i++){
      box.innerHTML = '<div class="tip">⏳ 正在识别 ' + esc(sources[i].label) + '（' + (i + 1) + '/' + sources.length + '）…</div>';
      const d = await apiFetch(API_BASE + '/vision-paper', { method:'POST', body:{ image: sources[i].dataUrl } });
      if(!d || !d.ok) throw new Error((d && d.error) || '识别失败');
      visionPages.push({
        label: sources[i].label,
        text: d.text || '',
        empty: !!d.empty,
        uncertain: !!d.uncertain,
      });
    }
    renderVisionPreview();
  }catch(e){
    box.innerHTML = '<div class="errbox">识别失败：' + esc(e.message) + '</div>';
  }finally{
    visionBusy = false;
  }
}

function renderVisionPreview(){
  const box = $('#visionPreview');
  const uncertainN = visionPages.filter(p => p.uncertain).length;
  const emptyN = visionPages.filter(p => p.empty).length;
  let html = '<div style="margin-top:12px;border:1px dashed var(--line,#d4d4d8);border-radius:8px;padding:10px">'
    + '<b>🔍 识别结果（请对照原图核对，可直接改，确认后再填进导入框）</b>'
    + '<p class="tip">共 ' + visionPages.length + ' 张。'
    + (uncertainN ? '<b>有 ' + uncertainN + ' 张里出现了「[看不清]」—— 那几处必须你补</b>。' : '没有标出看不清的地方。')
    + (emptyN ? '<b>有 ' + emptyN + ' 张一个字都没认出来（可能太模糊或拍歪）</b>。' : '')
    + '</p>';
  visionPages.forEach((p, i) => {
    html += '<div class="f" style="margin-top:8px"><label>' + esc(p.label || ('第 ' + (i + 1) + ' 张'))
      + (p.uncertain ? ' ⚠️ 含「[看不清]」' : '') + (p.empty ? ' ⚠️ 没认出文字' : '') + '</label>'
      + '<textarea data-vision="' + i + '" style="min-height:130px">' + esc(p.text) + '</textarea></div>';
  });
  html += '<div class="btn-row" style="margin-top:8px">'
    + '<button class="btn btn-pri" id="btnVisionAdopt">✅ 确认填进导入框</button>'
    + '<button class="btn btn-gh" id="btnVisionCancel">取消</button></div></div>';
  box.innerHTML = html;
  $('#btnVisionAdopt').onclick = adoptVisionText;
  $('#btnVisionCancel').onclick = () => { box.innerHTML = ''; visionPages = []; };
}

/** 把（老师改过的）识别文本合并后填进导入框并解析 */
function adoptVisionText(){
  const merged = visionPages.map((p, i) => {
    const el = document.querySelector('[data-vision="' + i + '"]');
    const t = (el ? el.value : p.text) || '';
    return (visionPages.length > 1 ? '--- ' + (p.label || ('第 ' + (i + 1) + ' 张')) + ' ---\n' : '') + t.trim();
  }).join('\n\n').trim();

  if(!merged){ toast('识别结果是空的，没有可填入的内容'); return; }
  const box = $('#parseResult');
  // ⚠️ 解析失败**不丢文本**：直接把识别结果摊开给老师复制（否则这一段白识别了）
  if(!adoptPaperText(merged, '图片识别')){
    box.innerHTML = '<div class="warnbox">识别出的文字没能自动解析成试卷结构（可能这不是学科网那份报告，或排版差异较大）。'
      + '下面是识别原文，可以复制到「粘贴文字」里手工整理。</div>'
      + '<details class="cat" open><summary><span class="arw">▶</span>识别出的文字</summary>'
      + '<div class="body"><pre style="white-space:pre-wrap;font-size:12px;max-height:320px;overflow:auto">'
      + esc(merged.slice(0, 8000)) + '</pre></div></details>';
  }
  $('#visionPreview').innerHTML = '';
  visionPages = [];
}

/* ==========================================================================
   🏫 学校卷子识别（★ 2026-10 第七批）
   --------------------------------------------------------------------------
   与「📥 从学科网导入试卷」**彻底分开**：学校卷子（空白卷/批改卷）没有学科网那份
   「整体难度／细目表分析」报告，走报告解析器只会得到"没有解析到题目"。
   这一条是让 AI **看懂卷子**，直接产出**题目结构**（题型分块 + 逐题知识点 +
   卷面印着的分值 + 批改卷的得分），再交给**现有**机制去算分值、统计、生成报告。

   ⚠️ 用户 2026-10 定的口径（改之前先看）：
     1. **免费**（服务端只校验登录+未封禁）；
     2. **知识点由 AI 自由写**，前端用**已有的** `KnowledgeClassifier` 归类到模块
        （预览里会显示每题落到哪个模块 —— 落到「其他」太多的题要留意）；
     3. **多页上限 20 页**：1–10 页一个批次，11–20 页自动分批推进，**用户无感**；
        超过 20 页明确拒绝，提示分两次上传；
     4. **每页一次调用**（不是"一批一次"）：一批 10 页塞进一次请求，
        JSON 会有 200+ 题、必然超过输出上限被截断（一断整批就废），图加起来也可能撞 4MB 请求体。
        批次只影响**推进与进度显示**，**合并只有一份实现**（mergeStructures）。
     5. 难度：**默认不让 AI 估**（逐题留空 + 用界面上的"整卷难度"，你可手打）；
        想估就点那个按钮，结果标 🤖 并注明"仅供参考"。
   ========================================================================== */
const SCHOOL_MAX_PAGES = 20;
const SCHOOL_BATCH_SIZE = 10;
const SCHOOL_TYPES = ['单选题', '多选题', '填空题', '判断题', '解答题', '其他'];

/**
 * AI 估的难度档位 → **代表系数**（★ 2026-10 第九批修 bug 加的关键一步）
 *
 * ⚠️ 为什么必须映射成数字：工具里「难度」的**唯一权威是数字系数 `coeff`**，
 *    `difficulty`（标签）与 `grade`（档位）都由它派生（`PaperParser.coeffToLabel/coeffToGrade`）。
 *    只写标签不写系数，会让**所有按系数判断的功能静默失效** ——
 *    「容易题满分·其余留空」按钮就是这么坏的（用户实测：AI 估了难度，点按钮没反应）。
 *
 * 取值与 `paper-parser.js` 的 `DIFF_LEVELS` 阈值**对齐**：≥0.80 较易 / ≥0.50 中等 /
 * ≥0.30 较难 / <0.30 难（取各档中值附近，保证 `coeffToLabel(映射值)` 能还原回原档位，
 * 这一点有测试钉住）。⚠️ 这是"档位换算"不是"测出来的系数"，界面上仍标 🤖 并在报告里注明"仅供参考"。
 */
const SCHOOL_LEVEL_COEFF = { '较易': 0.85, '中等': 0.65, '较难': 0.40, '难': 0.20 };

/** 难度输入（档位文字，或老师直接打的数字/百分数）→ 数字系数；认不出返回 null */
function coeffOfLabel(label){
  const s = String(label == null ? '' : label).trim();
  if(!s) return null;
  if(SCHOOL_LEVEL_COEFF[s] != null) return SCHOOL_LEVEL_COEFF[s];
  const v = parseFloat(s.replace('%', ''));
  if(isNaN(v)) return null;
  return /%$/.test(s) ? round2(v / 100) : v;
}

let schoolBusy = false;
/** 识别出来的结构（预览里改过之后会先回写到这里，再建 paper） */
let schoolStructure = null;

function setSchoolStatus(html){
  const box = $('#schoolPreview');
  if(box) box.innerHTML = '<div class="tip">' + html + '</div>';
}

/** 文件（图片 / 扫描版 PDF）→ 题目结构 */
async function schoolRun(files){
  const list = Array.from(files || []);
  if(!list.length) return;
  if(API.mode !== 'server'){
    setSchoolStatus('这个功能要用服务器上的视觉模型。<br>当前是<b>本机版</b>（直接双击打开的 HTML）：'
      + '请访问线上站点里的试卷分析工具再试，或改用「粘贴文字」。');
    return;
  }
  if(schoolBusy){ toast('上一批还在识别，请稍等'); return; }
  schoolBusy = true;
  schoolStructure = null;
  try{
    // ---------- ① 先把文件变成"每页一张图" ----------
    const pages = [];
    for(const f of list){
      const isPdf = /\.pdf$/i.test(f.name || '') || f.type === 'application/pdf';
      if(isPdf){
        // ⚠️ 学校卷子的 PDF **一律渲染成图**再识别：即使它有文字层，那也不是学科网报告格式，
        //    交给报告解析器一样认不出（实测过）。
        const r = await pdfToPageSources(f, (i, t) => setSchoolStatus('🖨 正在渲染 PDF 第 ' + i + '/' + t + ' 页…'), SCHOOL_MAX_PAGES);
        if(r.truncated) toast('这份 PDF 共 ' + r.total + ' 页，本次只处理前 ' + SCHOOL_MAX_PAGES + ' 页', 4000);
        r.sources.forEach(s => pages.push({ label: s.label + '（' + (f.name || 'PDF') + '）', dataUrl: s.dataUrl }));
      }else{
        const c = await compressImageFile(f);
        pages.push({ label: f.name || ('图片 ' + (pages.length + 1)), dataUrl: c.dataUrl });
      }
    }
    if(!pages.length) throw new Error('没有可识别的页面');
    if(pages.length > SCHOOL_MAX_PAGES){
      throw new Error('这份共 ' + pages.length + ' 页，超过上限 ' + SCHOOL_MAX_PAGES + ' 页，请分两次上传。');
    }

    // ---------- ② 分批推进（每批 ≤10 页，**批内逐页调用**） ----------
    const parts = [];
    const rawPages = [];
    for(let start = 0; start < pages.length; start += SCHOOL_BATCH_SIZE){
      const batch = pages.slice(start, start + SCHOOL_BATCH_SIZE);
      for(let i = 0; i < batch.length; i++){
        const idx = start + i;
        const batchNote = pages.length > SCHOOL_BATCH_SIZE
          ? '（第 ' + (Math.floor(idx / SCHOOL_BATCH_SIZE) + 1) + ' 批 / 共 ' + Math.ceil(pages.length / SCHOOL_BATCH_SIZE) + ' 批）'
          : '';
        setSchoolStatus('🔍 正在识别第 ' + (idx + 1) + '/' + pages.length + ' 页…' + batchNote);
        const d = await apiFetch(API_BASE + '/vision-paper-structure', {
          method:'POST',
          body:{ image: batch[i].dataUrl, page: idx + 1, totalPages: pages.length },
        });
        if(!d || !d.ok) throw new Error((d && d.error) || '识别失败');
        if(d.structure) parts.push(d.structure);
        else if(d.raw) rawPages.push({ page: idx + 1, raw: d.raw });
      }
    }

    schoolStructure = mergeStructures(parts);
    if(!schoolStructure.questions.length){
      const box = $('#schoolPreview');
      box.innerHTML = '<div class="warnbox">没有认出任何题目。可能是：① 图太模糊/拍歪；② 这不是卷子（比如是学生成绩单）；'
        + '③ 整页都是答题卡而没有题干。<br>建议重拍一张更清晰的，或改用「粘贴文字」。</div>'
        + (rawPages.length ? '<details class="cat" open><summary><span class="arw">▶</span>AI 返回的原文（不是合法 JSON 时才有）</summary>'
            + '<div class="body"><pre style="white-space:pre-wrap;font-size:12px;max-height:300px;overflow:auto">'
            + esc(rawPages.map(p => '--- 第 ' + p.page + ' 页 ---\n' + p.raw).join('\n\n')) + '</pre></div></details>' : '');
      return;
    }
    renderSchoolPreview(rawPages);
  }catch(e){
    setSchoolStatus('识别失败：' + esc(e.message) + '<br>可以重试，或换一张更清晰的图；也可以改用「粘贴文字」。');
  }finally{
    schoolBusy = false;
  }
}

/** 多页/多批的**唯一**合并实现（分批只影响循环，不影响这里）
 *  规则（都写死，别在别处再写一套）：
 *   · 同一题号出现多次（跨页重复、或两页拍到同一题）→ **合并知识点**，取第一个非空的分值/得分
 *   · 按题号升序排列（题号缺失的排在最后，保持原顺序）
 *   · blocks 按题型累计题量；title/totalScore 取第一个非空；uncertainNotes 拼接、去重
 */
function mergeStructures(parts){
  const list = (parts || []).filter(Boolean);
  const byNo = new Map();
  const noOrder = [];
  const notes = [];
  let title = '', totalScore = null;
  const blockCount = {};

  list.forEach(p => {
    if(!title && p.title) title = p.title;
    if(totalScore == null && p.totalScore) totalScore = p.totalScore;
    (p.uncertainNotes || []).forEach(n => { if(n && notes.indexOf(n) < 0) notes.push(n); });
    (p.blocks || []).forEach(b => { blockCount[b.type] = (blockCount[b.type] || 0) + (Number(b.count) || 0); });
    (p.questions || []).forEach(q => {
      const key = q.no == null ? ('?' + noOrder.length) : String(q.no);
      if(!byNo.has(key)){
        byNo.set(key, { no: q.no, type: q.type, knowledge: (q.knowledge || []).slice(), score: q.score, got: q.got, uncertain: !!q.uncertain });
        noOrder.push(key);
      }else{
        const old = byNo.get(key);
        (q.knowledge || []).forEach(k => { if(old.knowledge.indexOf(k) < 0) old.knowledge.push(k); });
        if(old.score == null && q.score != null) old.score = q.score;
        if(old.got == null && q.got != null) old.got = q.got;
        old.uncertain = old.uncertain || !!q.uncertain;
      }
    });
  });

  const questions = noOrder.map(k => byNo.get(k));
  questions.sort((a, b) => {
    const an = a.no == null ? Infinity : Number(a.no);
    const bn = b.no == null ? Infinity : Number(b.no);
    return an - bn;
  });

  // 题型分块：优先用模型给的 count（多页累计），缺失时按题目实际数量算
  let blocks = Object.keys(blockCount).length
    ? SCHOOL_TYPES.filter(t => blockCount[t]).map(t => ({ type: t, count: blockCount[t], perScore: null }))
    : [];
  if(!blocks.length){
    const c = {};
    questions.forEach(q => { c[q.type] = (c[q.type] || 0) + 1; });
    blocks = SCHOOL_TYPES.filter(t => c[t]).map(t => ({ type: t, count: c[t], perScore: null }));
  }
  return { title, totalScore, blocks, questions, uncertainNotes: notes };
}

/** 渲染结构化预览（可改）。这是"先给你核对再生成"的那一步。 */
function renderSchoolPreview(rawPages){
  const s = schoolStructure;
  const box = $('#schoolPreview');
  // 归类统计：AI 自由写的知识点落到「其他」的有多少（太多了说明该补词典或换措辞）
  const moduleOf = (kps) => {
    const names = [];
    (kps || []).forEach(k => {
      const n = KnowledgeClassifier.classifyName(k);
      if(n && names.indexOf(n) < 0) names.push(n);
    });
    return names.join('、');
  };
  let otherCount = 0;
  s.questions.forEach(q => {
    const ms = moduleOf(q.knowledge).split('、').filter(Boolean);
    if(ms.length && ms.every(m => m === '其他')) otherCount++;
  });

  let html = '<div style="margin-top:12px;border:1px dashed var(--line,#d4d4d8);border-radius:8px;padding:10px">'
    + '<b>🔍 识别结果（请对着卷子核对，可直接改；确认后再生成题目结构）</b>'
    + '<div class="f2" style="margin-top:8px">'
    + '<div class="f"><label>卷子标题</label><input type="text" id="schoolTitle" value="' + esc(s.title || '') + '"></div>'
    + '<div class="f"><label>卷面总分（没印就留空）</label><input type="text" id="schoolTotal" value="' + (s.totalScore != null ? s.totalScore : '') + '"></div>'
    + '</div>'
    + '<p class="tip">共 <b>' + s.questions.length + '</b> 道题；题型分块：'
    + (s.blocks.map(b => esc(b.type) + ' ' + (b.count != null ? b.count : '?') + ' 题').join('、') || '（未识别到分块）')
    + (otherCount ? '；⚠️ <b>' + otherCount + ' 道题的知识点没能归类到模块（落到「其他」）</b>，倒数第二列请留意' : '')
    + '</p>';
  if(s.uncertainNotes.length){
    html += '<div class="warnbox">⚠️ AI 标出这些看不清的地方：<br>' + s.uncertainNotes.map(esc).join('<br>') + '</div>';
  }

  html += '<div style="overflow:auto;max-height:420px;border:1px solid var(--line,#e4e4e7);border-radius:6px">'
    + '<table style="width:100%;border-collapse:collapse;font-size:12px">'
    + '<thead><tr>'
    + ['题号','题型','分值','知识点（可改，多个用；分隔）','归类模块','得分（批改卷）','难度','⚠'].map(h => '<th style="text-align:left;padding:4px 6px;border-bottom:1px solid var(--line,#e4e4e7)">' + h + '</th>').join('')
    + '</tr></thead><tbody>';
  s.questions.forEach((q, i) => {
    html += '<tr>'
      + '<td style="padding:3px 6px"><input data-sq="no" data-i="' + i + '" type="text" value="' + (q.no != null ? q.no : '') + '" style="width:52px"></td>'
      + '<td style="padding:3px 6px"><select data-sq="type" data-i="' + i + '">'
      + SCHOOL_TYPES.map(t => '<option value="' + t + '"' + (t === q.type ? ' selected' : '') + '>' + t + '</option>').join('')
      + '</select></td>'
      + '<td style="padding:3px 6px"><input data-sq="score" data-i="' + i + '" type="text" value="' + (q.score != null ? q.score : '') + '" placeholder="按惯例" style="width:56px"></td>'
      + '<td style="padding:3px 6px"><input data-sq="knowledge" data-i="' + i + '" type="text" value="' + esc((q.knowledge || []).join('；')) + '" style="width:100%"></td>'
      + '<td style="padding:3px 6px;color:#71717a">' + esc(moduleOf(q.knowledge) || '—') + '</td>'
      + '<td style="padding:3px 6px"><input data-sq="got" data-i="' + i + '" type="text" value="' + (q.got != null ? q.got : '') + '" placeholder="没批改留空" style="width:70px"></td>'
      // 难度：**默认留空，你可以手打**（档位「较易/中等/较难/难」或直接写系数如 0.85）；
      // 点了「让 AI 估每题难度」才会被填上（并标 🤖）。生成的 paper 里会换算成数字系数。
      + '<td style="padding:3px 6px"><input data-sq="difficulty" data-i="' + i + '" type="text" value="' + esc(q.difficulty || '') + '" placeholder="留空" style="width:60px" title="' + (q.aiDifficulty ? 'AI 估计，可改' : '可填 较易/中等/较难/难，或直接写系数') + (coeffOfLabel(q.difficulty) != null ? '（按系数 ' + coeffOfLabel(q.difficulty) + ' 计）' : '') + '"></td>'
      + '<td style="padding:3px 6px">' + (q.uncertain ? '⚠️' : '') + (q.aiDifficulty ? '🤖' : '') + '</td>'
      + '</tr>';
  });
  html += '</tbody></table></div>';

  html += '<div class="btn-row" style="margin-top:8px">'
    + '<button class="btn btn-pri" id="btnSchoolBuild">✅ 生成题目结构</button>'
    + '<button class="btn btn-gh" id="btnSchoolDiff">🤖 让 AI 估每题难度</button>'
    + '<button class="btn btn-gh" id="btnSchoolCancel">取消</button>'
    + '</div>'
    + '<p class="tip">难度默认<b>不估</b>（留空；整卷难度用下面的输入框，你可以手打）。'
    + '点「让 AI 估每题难度」才走 AI，结果会标 🤖 并可再改。</p></div>';

  if(rawPages && rawPages.length){
    html += '<details class="cat"><summary><span class="arw">▶</span>有 ' + rawPages.length + ' 页 AI 没按 JSON 返回（原文在此，可复制）</summary>'
      + '<div class="body"><pre style="white-space:pre-wrap;font-size:12px;max-height:300px;overflow:auto">'
      + esc(rawPages.map(p => '--- 第 ' + p.page + ' 页 ---\n' + p.raw).join('\n\n')) + '</pre></div></details>';
  }

  box.innerHTML = html;
  $('#btnSchoolBuild').onclick = buildSchoolPaper;
  $('#btnSchoolDiff').onclick = schoolEstimateDifficulty;
  $('#btnSchoolCancel').onclick = clearSchool;
}

/** 把预览里（老师改过的）表格读回来 */
function readSchoolRows(){
  const rows = schoolStructure.questions.map((q, i) => {
    const val = (key) => {
      const el = document.querySelector('[data-sq="' + key + '"][data-i="' + i + '"]');
      return el ? String(el.value || '').trim() : '';
    };
    const noRaw = val('no');
    const scoreRaw = val('score');
    const gotRaw = val('got');
    return {
      no: noRaw === '' ? q.no : Number(noRaw),
      type: val('type') || q.type,
      score: scoreRaw === '' ? null : Number(scoreRaw),
      knowledge: val('knowledge').split(/[；;]/).map(s => s.trim()).filter(Boolean),
      got: gotRaw === '' ? null : Number(gotRaw),
      /** 难度：**你手打的优先**；没打就用 AI 估的（或空） */
      difficulty: val('difficulty') || q.difficulty || '',
      uncertain: q.uncertain,
    };
  });
  return rows.filter(r => r.type);
}

/** 预览 → 真正的 paper 对象 → 交给**现有**流程（分值分配、逐题得分、报告） */
function buildSchoolPaper(){
  const rows = readSchoolRows();
  if(!rows.length){ toast('没有题目，无法生成'); return; }
  const title = String(($('#schoolTitle') || {}).value || '').trim();
  const totalRaw = String(($('#schoolTotal') || {}).value || '').trim();
  const total = Number(totalRaw);

  // ① 题型分块（按题目实际数量算，顺序固定，保证报告里的题型顺序稳定）
  const cnt = {};
  rows.forEach(r => { cnt[r.type] = (cnt[r.type] || 0) + 1; });
  const typeDist = SCHOOL_TYPES.filter(t => cnt[t]).map(t => ({ type: t, count: cnt[t] }));

  // ② 题目（形状与 PaperParser.parse 的产出**完全一致**，下游一行都不用改）
  const questions = rows.map(r => {
    // ⚠️ 难度落成**数字系数**（见 SCHOOL_LEVEL_COEFF 的说明）：标签与档位都由系数派生，
    //    这样「容易题满分」「难度分布」「系数列」等所有按系数判断的功能一起生效。
    //    老师在预览里手打的档位（较易/中等…）或直接打的数字都走这里。
    const coeff = coeffOfLabel(r.difficulty);
    return {
      no: r.no, section: r.type,
      coeff,
      difficulty: coeff == null ? '' : PaperParser.coeffToLabel(coeff),
      grade: coeff == null ? '' : PaperParser.coeffToGrade(coeff),
      knowledge: r.knowledge,
    };
  });

  paper = {
    title, overallDifficulty: '', scope: [],
    typeDist, diffDist: [], questions, knowledgeGroups: [], warnings: [],
  };
  if(schoolStructure && schoolStructure.aiDifficulty){
    paper.warnings.push('逐题难度由 AI 估计，仅供参考（可在报告里手动改）');
  }
  $('#paperTitle').textContent = title;
  if(title && title.length <= 20) $('#examName').value = title;
  if(Number.isFinite(total) && total > 0) $('#examTotal').value = total;
  // ⚠️ 刻意**不清空** #paperPaste：这一路不是"粘贴/上传报告"来的，
  //    留空更诚实（老师若点「解析文字」会明确得到"没有解析到题目"，而不是解析出一份假结构）。

  computeScores();   // → scoreAssign（按题型惯例分配逐题分值）+ seedRecords()

  // ③ 卷面印了分值的题：走**现成的** applyTypeCell（spread 是唯一权威源）
  const seen = {};
  let scoreN = 0;
  rows.forEach(r => {
    if(!(r.score > 0)) return;
    seen[r.type] = seen[r.type] || 0;
    const idx = seen[r.type]++;
    applyTypeCell(r.type, idx, r.score);
    scoreN++;
  });

  // ④ 批改卷的得分：预填 records[no].got（与「拍照识别答题卡」同一套数据模型）
  let gotN = 0;
  rows.forEach(r => {
    if(r.got == null || !records[r.no]) return;
    const full = num(records[r.no].full);
    let got = num(r.got);
    if(!(got >= 0)) got = 0;
    if(got > full) got = full;
    records[r.no].got = got;
    gotN++;
  });
  if(gotN) renderScoreList();

  // ⑤ 汇总反馈
  const mods = {};
  rows.forEach(r => r.knowledge.forEach(k => { const n = KnowledgeClassifier.classifyName(k); mods[n] = (mods[n] || 0) + 1; }));
  const modList = Object.keys(mods).sort((a, b) => mods[b] - mods[a]);
  let html = '<div class="okbox">✅ 已生成题目结构：共 <b>' + rows.length + '</b> 道题，'
    + '题型：' + typeDist.map(t => esc(t.type) + ' ' + t.count + ' 题').join('、') + '；'
    + (scoreN ? '其中 <b>' + scoreN + '</b> 道题的分值来自卷面；' : '')
    + (gotN ? '<b>' + gotN + '</b> 道题已预填批改得分（请核对）；' : '')
    + '没印分值的题已按题型惯例分配，可在下方分值表逐题微调。</div>';
  if(modList.length){
    html += '<p class="tip">知识点归到这些模块：' + modList.map(m => esc(m) + '（' + mods[m] + '）').join('、') + '</p>';
  }
  if(paper.warnings.length) html += '<div class="warnbox">⚠ ' + paper.warnings.map(esc).join('<br>⚠ ') + '</div>';
  $('#parseResult').innerHTML = html;

  // ⑥ 页面状态：★ 2026-10 第九批修 bug —— 这一路以前**漏了这几步**，
  //    结果老师只看到"已生成题目结构"那句话，「📋 试卷信息」和「🔎 解析结果」两个面板
  //    因为默认 display:none 一直不出现，看起来"缺了一块"（用户实测反馈）。
  //    ⚠️ 与 `adoptPaperText()`（学科网那条路）保持**同一套收尾步骤**，以后改这里先看那边。
  $('#paperPanel').style.display = '';
  $('#qPanel').style.display = '';
  $('#paperHint').textContent = rows.length + ' 题 · ' + (title || '').slice(0, 14);
  renderQuestionList();   // 填「🔎 解析结果」面板（题号/题型/难度系数/难度/知识点）
  renderScoreList();      // 逐题得分区（批改卷预填的得分也在这里显示）

  // ⚠️ **刻意不写 K_PAPER**：那个键的形状是 `{ text, meta }`，`text` 是恢复时的唯一来源
  //    （见 init() 里的 `if(saved && saved.text)`）。这一路没有"粘贴的文字"，
  //    存空 text 会把老师上一份报告的文字抹掉，且恢复时什么也还原不了。
  //    ⇒ 学校卷子这条路目前**刷新后需要重识别**（已知限制，记在交接文档里）。

  $('#schoolPreview').innerHTML = '';
  schoolStructure = null;
  toast('已生成题目结构，请核对分值后继续录入得分');
}

/** 让 AI 估每题难度（**点了才走**；默认不估）
 *  ⚠️ 这是**文本**任务（只给题号/题型/知识点，不发图），但同样走免费口径与护栏；
 *     结果标 `aiDifficulty`（预览里显示 🤖、报告里带一条"仅供参考"的提示）。 */
async function schoolEstimateDifficulty(){
  if(!schoolStructure) return;
  const btn = $('#btnSchoolDiff'); const old = btn.textContent;
  btn.disabled = true; btn.textContent = '⏳ 估计中…';
  try{
    // 先把你已经改过的表格读回来，避免估完难度把你的修改冲掉
    const rows = readSchoolRows();
    schoolStructure.questions = schoolStructure.questions.map((q, i) => {
      const r = rows[i];
      return r ? { ...q, no: r.no, type: r.type, knowledge: r.knowledge, score: r.score, got: r.got } : q;
    });
    const d = await apiFetch(API_BASE + '/vision-paper-structure', {
      method:'POST',
      body:{ mode:'difficulty', questions: rows.map(r => ({ no:r.no, type:r.type, knowledge:r.knowledge })) },
    });
    if(!d || !d.ok) throw new Error((d && d.error) || '估计失败');
    const map = {};
    (d.difficulties || []).forEach(x => { map[String(x.no)] = String(x.level || '').trim(); });
    let n = 0;
    schoolStructure.questions.forEach(q => {
      const lv = map[String(q.no)];
      if(lv){ q.difficulty = lv; q.aiDifficulty = true; n++; }
    });
    if(!n) throw new Error(d.note || 'AI 没给出可用的难度');
    schoolStructure.aiDifficulty = true;
    renderSchoolPreview([]);
    toast('已按 AI 估计填入 ' + n + ' 题的难度（标了 🤖，可手改）', 4000);
  }catch(e){
    toast('难度估计失败：' + e.message, 3600);
  }finally{
    btn.disabled = false; btn.textContent = old;
  }
}

function clearSchool(){
  schoolStructure = null;
  const box = $('#schoolPreview');
  if(box) box.innerHTML = '';
}

/** 计算并渲染分值分配 */
function computeScores(){  if(!paper) return;
  const total = num($('#examTotal').value) || 150;
  const preset = $('#examPreset').value || '';
  scoreAssign = PaperParser.assignScores(paper.typeDist, total, preset);
  // 抓「应有总分」快照：此后老师在界面上改的每一笔都跟它比对，
  // 不一致就给温和提示（只提示、不阻止）。换总分/换预设会重跑本函数，快照随之更新。
  baselineTotals = {};
  Object.entries(scoreAssign.perType).forEach(([type, v]) => { baselineTotals[type] = round2(v.total); });
  scoreExpand = new Set();   // 换卷面后题号会变，展开态一律复位
  renderScoreAssignTable();
  seedRecords();
}

/** 画分值分配表（仅此处负责 scoreTable 的 DOM） */
function renderScoreAssignTable(){
  const t = $('#scoreTable');
  if(!t){ return; }
  if(!scoreAssign){ t.innerHTML = ''; return; }
  const types = Object.keys(scoreAssign.perType);
  types.forEach(ensureSpread);

  let html = '<thead><tr><th>题型</th><th>题量</th><th>每题分值</th><th>总分值</th></tr></thead><tbody>';
  let sumCount = 0;
  types.forEach(type => {
    const info = scoreAssign.perType[type];
    sumCount += info.count;
    const open = scoreExpand.has(type);
    const avg = info.count ? info.total / info.count : 0;
    html += `<tr class="trow">
      <td class="tname"><button type="button" class="tgl" data-tgl="${esc(type)}" data-open="${open ? 1 : 0}">${open ? '▼' : '▶'}</button>${esc(type)}</td>
      <td>${info.count}</td>
      <td class="percell">平均 ${round2(avg)}</td>
      <td class="typetotal" data-totalcell="${esc(type)}">${round2(info.total)}</td>
    </tr>`;
    html += `<tr class="sub" data-subrow="${esc(type)}"${open ? '' : ' hidden'}>`
      + `<td colspan="4">${typeDetailHtml(type)}</td></tr>`;
  });
  html += `<tr><th>合计</th><th>${sumCount}</th>`
    + `<th>—</th><th id="sumCell">${round2(scoreAssign.fullScore)}</th></tr></tbody>`;
  t.innerHTML = html;
  buildScoreSumHint();
}

/** 画一个题型的逐题编辑区 + 区间批量设置 */
function typeDetailHtml(type){
  const info = scoreAssign.perType[type];
  const nos = typeQuestionNos(type);
  let h = '<div class="detail">';
  for(let i = 0; i < info.count; i++){
    const no = nos[i] != null ? nos[i] : (i + 1);
    h += `<div class="qcell"><span class="qno">第${no}题</span>`
      + `<input type="number" step="0.5" min="0" value="${round2(info.spread[i])}" data-scell="${esc(type)}" data-i="${i}">`
      + `<span class="qunit">分</span></div>`;
  }
  const lo = nos[0] != null ? nos[0] : 1;
  const hi = nos[info.count - 1] != null ? nos[info.count - 1] : info.count;
  h += '<div class="batch">按区间批量设：第 '
    + `<input type="number" class="bnum" min="1" step="1" value="${lo}" data-bfrom="${esc(type)}"> 到 `
    + `<input type="number" class="bnum" min="1" step="1" value="${hi}" data-bto="${esc(type)}"> 题，每题 `
    + `<input type="number" class="bnum" min="0" step="0.5" placeholder="分值" data-bval="${esc(type)}"> 分 `
    + `<button type="button" class="bbtn" data-bapply="${esc(type)}">应用</button></div>`;
  return h + '</div>';
}

/**
 * 该题型下「每道题」的题号（按 paper.questions 出现次序），
 * 下标与 spread 一一对应。批量设置按题号操作，靠它换算成 spread 下标。
 */
function typeQuestionNos(type){
  if(!paper || !paper.questions) return [];
  return paper.questions.filter(q => q.section === type).map(q => q.no);
}

/**
 * 保证每个题型都有 spread（逐题分值数组），且长度与题量一致。
 * assignScores 在「非预设」分支下不给客观题生成 spread，这里就地补齐；
 * spread 是这批改造后的唯一权威数据源，info.per/total 都由它派生。
 */
function ensureSpread(type){
  const info = scoreAssign.perType[type]; if(!info) return;
  const n = info.count || 0;
  if(!Array.isArray(info.spread) || info.spread.length !== n){
    info.spread = Array.from({length: n}, () => num(info.per));
  }
}

/** 改一道题的分值；只动 spread[i]，不再把整列压回平均 */
function applyTypeCell(type, i, rawValue){
  const info = scoreAssign.perType[type]; if(!info) return;
  ensureSpread(type);
  const inp = $(`#scoreTable input[data-scell="${type}"][data-i="${i}"]`);
  let v = num(rawValue);
  if(!(v >= 0)) v = 0;                     // 空值/负数/NaN 一律当 0，并回写输入框
  if(inp && num(inp.value) !== v) inp.value = round2(v);
  info.spread[i] = v;
  syncTypeAfterEdit(type);
}

/** 批量设置某题型内 [fromNo, toNo] 题号区间的每题分值 */
function applyBatch(type){
  const info = scoreAssign.perType[type]; if(!info) return;
  ensureSpread(type);
  const nos = typeQuestionNos(type);
  const fromEl = $(`#scoreTable input[data-bfrom="${type}"]`);
  const toEl   = $(`#scoreTable input[data-bto="${type}"]`);
  const vEl    = $(`#scoreTable input[data-bval="${type}"]`);
  if(!fromEl || !toEl || !vEl) return;
  const from = num(fromEl.value);
  const to   = num(toEl.value);
  const v    = num(vEl.value);
  if(!vEl.value.trim()){ toast('请先填每题分值'); vEl.focus(); return; }
  if(!from || !to){ toast('请填题号区间'); return; }
  if(from > to){ toast('起始题号不能大于结束题号'); return; }
  const hit = [];
  for(let i = 0; i < info.count; i++){
    const no = nos[i] != null ? nos[i] : (i + 1);
    if(no >= from && no <= to) hit.push(i);
  }
  if(!hit.length){ toast(`这个区间里没有「${type}」的题（本区题号：${nos.join('、')}）`); return; }
  hit.forEach(i => { info.spread[i] = v; });
  // 同步该题型逐题输入框的显示值
  hit.forEach(i => {
    const inp = $(`#scoreTable input[data-scell="${type}"][data-i="${i}"]`);
    if(inp) inp.value = round2(v);
  });
  syncTypeAfterEdit(type);
  toast(`已把「${type}」第 ${from}–${to} 题设为每题 ${round2(v)} 分`);
}

/**
 * 逐题分值改动后的统一收尾：
 *   spread → 题型总分(逐题之和) → 整卷合计 → 刷新该行/合计/提示 → 重算逐题记录。
 * 只改单元格内容、重建该题型的子行，不对整表调 renderScoreAssignTable()——
 * 全表重渲染会打断输入焦点，也是第一批「监听器在自身处理器里叠加」的根源。
 */
function syncTypeAfterEdit(type){
  const info = scoreAssign.perType[type]; if(!info) return;
  info.total = round2(info.spread.reduce((a, x) => a + num(x), 0));
  info.per = info.count ? round2(info.total / info.count) : 0;   // 仅作收起态展示与兜底

  const totalCell = $(`[data-totalcell="${type}"]`);
  if(totalCell) totalCell.textContent = round2(info.total);
  const perCell = totalCell && totalCell.parentElement ? totalCell.parentElement.querySelector('.percell') : null;
  if(perCell) perCell.textContent = '平均 ' + round2(info.per);

  const mainRow = totalCell ? totalCell.closest('tr') : null;
  const subRow = mainRow ? mainRow.nextElementSibling : null;
  if(subRow && subRow.classList.contains('sub')){
    subRow.innerHTML = `<td colspan="4">${typeDetailHtml(type)}</td>`;
  }
  updateScoreTotals();
  seedRecords();       // 保留既有得分：按 got/full 比例缩放 + clamp
  renderScoreList();
}

/** 重算整卷合计并刷新合计单元格与提示 */
function updateScoreTotals(){
  if(!scoreAssign) return;
  scoreAssign.fullScore = round2(Object.values(scoreAssign.perType).reduce((a, x) => a + num(x.total), 0));
  const cell = $('#sumCell'); if(cell) cell.textContent = round2(scoreAssign.fullScore);
  buildScoreSumHint();
}

/** 提示行：分值方案 + assignScores 的告警 + 「与应有总分不一致」的温和提醒 */
function buildScoreSumHint(){
  const hint = $('#scoreSumHint'); if(!hint || !scoreAssign) return;
  let h = `分值方案：<b>${esc(scoreAssign.preset)}</b>`;
  if(scoreAssign.warnings && scoreAssign.warnings.length)
    h += '<br><span style="color:var(--warn)">⚠ ' + scoreAssign.warnings.map(esc).join('<br>⚠ ') + '</span>';
  const drift = [];
  Object.keys(scoreAssign.perType).forEach(type => {
    const now = round2(scoreAssign.perType[type].total);
    const want = baselineTotals[type];
    if(want != null && now !== want)
      drift.push(`${esc(type)}总分现在是 <b>${now}</b> 分，与卷面预设的 ${want} 分不一致，是否调整？`);
  });
  if(drift.length)
    h += '<br><span style="color:var(--warn)">💡 ' + drift.join('<br>💡 ') + '</span>';
  hint.innerHTML = h;
}

/**
 * 按分值分配初始化逐题记录
 *
 * 分值可能被老师改（改卷面结构 / 改单题分值），此时要**保留已经填好的得分**：
 *   · 分值没变            → 得分原样保留
 *   · 分值变了但原来是满分 → 视为"没单独填过"，给新满分
 *   · 分值变了且原来是部分分 → 按比例缩放（got/full 不变），并 clamp 到 [0, 新满分]
 * 早期实现是"分值一变就把得分清成满分"，等于老师一改分值，
 * 之前辛苦填的失分全丢，所以这里必须缩放。
 */
function seedRecords(){
  if(!paper || !scoreAssign) return;
  const idx = {}, next = {};
  paper.questions.forEach(q => {
    const type = q.section;
    const info = scoreAssign.perType[type];
    if(!info) return;
    idx[type] = idx[type] || 0;
    // 逐题分值以 info.spread 为准；下标越界或缺失时回落到题型平均分（正常路径不会走到）
    const sp = info.spread;
    const spv = Array.isArray(sp) ? sp[idx[type]] : undefined;
    const full = num(spv != null ? spv : info.per);
    idx[type]++;

    const old = records[q.no];
    let got = full;
    if(old && typeof old.full === 'number' && old.full > 0){
      if(old.full === full){
        got = old.got;                                   // 分值未变，原样保留
      }else if(old.got >= old.full){
        got = full;                                      // 原本满分 → 给新满分
      }else{
        // 部分分 → 按比例缩放后 clamp
        const ratio = old.got / old.full;
        got = Math.round(full * ratio * 100) / 100;
      }
    }
    // 统一 clamp 到 [0, full]
    if(!(got >= 0)) got = 0;
    if(got > full) got = full;
    if(got < 0) got = 0;

    next[q.no] = { full, got, note: old ? old.note : '' };
  });
  records = next;
}

/* ==========================================================================
   ② 逐题得分
   ========================================================================== */
function renderScoreList(){
  const wrap = $('#scoreList');
  if(!paper){ wrap.innerHTML = '<p class="tip">请先在「① 导入试卷」里解析一份试卷。</p>'; return; }
  let html = '';
  paper.questions.forEach(q => {
    const r = records[q.no] || { full:0, got:0, note:'' };
    const g = q.grade || '';
    html += `<div class="qitem" data-no="${q.no}">
      <div class="no">${q.no}</div>
      <div class="kp">
        <div>${esc((q.knowledge||[]).join('；') || '（无知识点）')}</div>
        <div class="tags">
          <span class="tag ${g}">${esc(q.difficulty || '未标注')}</span>
          <span class="tag">${esc(q.section||'')}</span>
          <span class="tag">满分 ${round2(r.full)}</span>
          <span class="tag">系数 ${q.coeff == null ? '—' : q.coeff}</span>
        </div>
      </div>
      <div class="sc"><input type="number" step="0.5" min="0" value="${round2(r.got)}" data-got="${q.no}" title="得分"></div>
      <div class="note"><input type="text" placeholder="备注（可选）：如 第二问空白 / 分类讨论漏了一种情况" value="${esc(r.note||'')}" data-note="${q.no}"></div>
    </div>`;
  });
  wrap.innerHTML = html;
  $$('#scoreList input[data-got]').forEach(inp => {
    inp.addEventListener('input', () => {
      const n = +inp.dataset.got; if(records[n]) records[n].got = num(inp.value);
      updateScoreTotal();
    });
  });
  $$('#scoreList input[data-note]').forEach(inp => {
    inp.addEventListener('input', () => {
      const n = +inp.dataset.note; if(records[n]) records[n].note = inp.value;
    });
  });
  updateScoreTotal();
}

function updateScoreTotal(){
  const full = Object.values(records).reduce((a,r)=>a+r.full,0);
  const got  = Object.values(records).reduce((a,r)=>a+r.got,0);
  const wrong = Object.values(records).filter(r => r.full > 0 && r.got < r.full).length;
  const el = $('#scoreTotal');
  if(el){
    el.innerHTML = `总分 <b>${round2(got)}</b> / ${round2(full)}　`
      + `得分率 <b>${full ? (got/full*100).toFixed(1) : 0}%</b>　`
      + `错题 <b>${wrong}</b> 道　`
      + `<span class="tip" style="margin:0">（没填的题按满分计）</span>`;
  }
  const h = $('#scoreHint'); if(h) h.textContent = `${wrong} 道错题`;
  const st = $('#stWrong'); if(st) st.textContent = wrong;
}

/* 批量填充 */
function fillAll(mode){
  if(!paper){ toast('请先解析试卷'); return; }
  paper.questions.forEach(q => {
    const r = records[q.no]; if(!r) return;
    if(mode === 'full') r.got = r.full;
    else if(mode === 'zero') r.got = 0;
    else if(mode === 'easy'){
      // ⚠️ 兜底（2026-10 第九批）：难度档位**首选** q.grade（由数字系数派生，正常路径都有）；
      //    万一某个来源只写了文字难度没写系数，就用现成的 labelToGrade 现算一次 ——
      //    这样"容易题满分"不会因为来源不同而静默失效（这正是用户踩到的那个 bug）。
      const g = q.grade || PaperParser.labelToGrade(q.difficulty);
      r.got = (g === 'easy') ? r.full : r.got;
    }
  });
  renderScoreList();
  toast(mode === 'full' ? '已全部按满分' : mode === 'zero' ? '已全部清零' : '容易题已置满分');
}

/* ==========================================================================
   ③ 生成报告
   ========================================================================== */
function collectCtx(){
  const band = ErrorEngine.bandOf(Object.values(records).reduce((a,r)=>a+r.got,0),
                                  Object.values(records).reduce((a,r)=>a+r.full,0) || 150);
  const diags = ErrorEngine.diagnoseAll(paper, records);
  const modules = ErrorEngine.byModule(diags, KnowledgeClassifier, paper.questions, records);
  const typeAgg = ErrorEngine.byType(diags);
  const questionRows = Narrator.buildQuestionRows(paper, records, diags);
  const typeSummary = Narrator.buildTypeSummary(paper, records);
  const score = round2(Object.values(records).reduce((a,r)=>a+r.got,0));
  const full  = round2(Object.values(records).reduce((a,r)=>a+r.full,0));
  const skeleton = ErrorEngine.pickSkeleton(val('examName') || '测试', score);
  return { diags, modules, typeAgg, questionRows, typeSummary, band, skeleton, score, full };
}

function generateReport(){
  if(!paper){ toast('请先在「① 导入试卷」里解析试卷'); switchStep('cPaper'); return; }
  const name = val('stuName');
  if(!name){ toast('请先填学生姓名'); switchStep('cScore'); return; }
  const ctx = collectCtx();
  const attitude = val('stuAttitude');
  const advice = Narrator.buildAdvice({
    name, score:ctx.score, full:ctx.full, band:ctx.band, skeleton:ctx.skeleton,
    questionRows:ctx.questionRows, modules:ctx.modules, typeAgg:ctx.typeAgg, diags:ctx.diags,
    examType: val('examName') || '测试', attitude, teacherNote: val('stuNote')
  });
  lastAdviceCtx = { name, ctx, attitude, skeleton:ctx.skeleton };

  const report = Narrator.buildReport({
    name, gender: val('stuGender'), grade: val('stuGrade'), subject: val('stuSubject'),
    teacher: val('stuTeacher') || '郭庆杰', manager: val('stuManager'),
    paper, records,
    score:ctx.score, full:ctx.full,
    examDate: val('examDate'), examName: val('examName'),
    duration: val('examDuration') || '120min',
    examScope: val('examScope') || (paper.scope||[]).join(','),
    taughtContent: val('examTaught'),
    progress: val('stuProgress'),
    band:ctx.band, questionRows:ctx.questionRows, typeSummary:ctx.typeSummary,
    advice, teacher: val('stuTeacher') || '郭庆杰'
  });

  $('#reportText').textContent = report;
  lastReport = report;
  updateReportMeta(name, ctx);
  if(API.mode !== 'server'){ /* 本机模式不自动存档 */ }
  switchStep('cReport');
  toast('报告已生成');
}

function updateReportMeta(name, ctx){
  $('#pvName').textContent = name + ' · 试卷分析报告';
  $('#pvMeta').textContent = (val('examName') || '') + '　' + ctx.score + '/' + ctx.full + ' 分';
  $('#stChars').textContent = $('#reportText').innerText.length;
  $('#stWrong').textContent = ctx.diags.length;
  const warn = [];
  if(!val('examDate')) warn.push('未填考试日期');
  if(!val('examName')) warn.push('未填考试名称');
  $('#stHint').textContent = warn.length ? '⚠ ' + warn.join('、') : '✓ 信息完整';
  $('#stHint').style.color = warn.length ? 'var(--warn)' : 'var(--ok)';
}

/* ==========================================================================
   AI：① 重写「教学辅导建议」段  ② 润色【错题分析】的「原因」列
   ========================================================================== */
/**
 * AI 改写「教学辅导建议与安排」段（会员专属）
 *
 * @param opts 可选 `{ btn, silent }`：
 *   · `btn`    用**哪个按钮**显示"⏳ 生成中"（默认老按钮 `#btnAIAdvice`）。
 *              合并到报告头那个「✨ AI 润色」之后，点谁谁转圈（老版本载入态打在了另一个按钮上，
 *              从报告头点进去看着像没反应）。
 *   · `silent` 不弹自己的 toast（由调用方给一条汇总）——`polishAll()` 用。
 * @returns `{ ok:true }` 或 `{ ok:false, error }`（**不再只靠 toast**，调用方才能决定重试与汇总）
 */
async function aiAdvice(opts){
  const o = (opts && (opts.btn || opts.silent)) ? opts : {};
  if(!lastAdviceCtx){ toast('请先生成报告'); return { ok:false, error:'请先生成报告' }; }
  const { name, ctx, attitude } = lastAdviceCtx;
  const btn = o.btn || $('#btnAIAdvice'); const old = btn.textContent;
  btn.disabled = true; btn.textContent = '⏳ AI 生成中';

  // 给 AI 的输入：已经算好的结构化诊断结论（不让它猜数据）
  const payload = {
    task: 'advice',
    name,
    subject: val('stuSubject') || '数学',
    examName: val('examName') || '测试',
    score: ctx.score, full: ctx.full,
    scoreRate: round2(ctx.score / ctx.full * 100) + '%',
    band: ctx.band.stage,
    bandStrategy: ctx.band.strategy,
    examTypeForSkeleton: ctx.skeleton.name,
    attitude: attitude || '整体认真、愿意动笔',
    typeSummary: ctx.typeSummary.map(t => ({ 题型: t.type, 题量: t.n, 满分: round2(t.full), 得分: round2(t.got), 得分率: (t.rate*100).toFixed(0)+'%' })),
    modules: ctx.modules.map(m => ({ 模块: m.name, 满分: round2(m.full), 得分: round2(m.got), 失分: round2(m.lost), 题号: m.questions, 主要失分类型: m.topTypes.slice(0,3), 建议方向: m.advice })),
    blanks: ctx.questionRows.filter(r => r.full > 0 && r.got === 0).map(r => r.no),
    wrongItems: ctx.diags.slice(0, 60).map(d => ({
      题号: d.no, 题型: d.section, 分值: d.full, 得分: d.got, 难度: d.difficulty,
      知识点: d.knowledge, 失分类型: d.types, 已有原因: d.note || ''
    })),
    teacherNote: val('stuNote')
  };

  try{
    let text = '';
    if(API.mode === 'server' && API.serverCfg.hasKey){
      const d = await apiFetch(API_BASE + '/ai-advice', { method:'POST', body: payload });
      if(!d || !d.ok) throw new Error(d && d.error ? d.error : '服务器未返回内容');
      text = d.text || '';
    }else{
      text = await callAI(JSON.stringify(payload));
    }
    if(!text.trim()) throw new Error('返回内容为空');
    // 用 AI 的文本替换报告里的「教学辅导建议/安排」段
    const cur = $('#reportText').textContent;
    const marker = '【教学辅导建议/安排】';
    const idx = cur.indexOf(marker);
    const sigIdx = cur.indexOf('分析人：');
    if(idx < 0 || sigIdx < 0) throw new Error('报告结构异常，请重新生成');
    const head = cur.slice(0, idx + marker.length);
    const tail = cur.slice(sigIdx);
    const merged = head + '\n' + text.trim() + '\n\n' + tail;
    $('#reportText').textContent = merged;
    lastReport = merged;
    $('#stChars').textContent = merged.length;
    if(!o.silent) toast('建议段已由 AI 重写，可继续手动修改');
    return { ok:true };
  }catch(e){
    if(!o.silent) toast('AI 生成失败：' + e.message, 3400);
    return { ok:false, error:e.message };
  }finally{
    btn.disabled = false; btn.textContent = old;
  }
}

/* ==========================================================================
   AI ②：只润色【错题分析】表的「失分情况及原因分析」列（★ 2026-10 第五批）
   --------------------------------------------------------------------------
   为什么只润色这一列：报告里其它内容（分数、题型分布、逐题分值）都是**算出来的**，
   不能碰；而这一列是程序按规则生成的**原始诊断口气**，会冒出"知识体系尚未建立"
   "能力严重不足"这类**重话** —— 直接给家长看很扎人。
   用户 2026-10 的要求：不只是改通顺，**还要把口吻改对**（面向家长、措辞温和、不下定论）。

   ⚠️ 三条硬约束（做错任何一条都会毁掉报告或错位）：
     1. **只动最后一格**：按 ` | ` 切开后前 6 列原样拼回去，分数与题号一个不碰；
     2. **段数必须一致**：服务端已经强制校验，本机模式这边再校验一次；
     3. **失败不动原文**：任何一步抛错都只 toast，报告保持原样（宁可不润色，不能弄乱）。
   ========================================================================== */
const ATTR_MARK = '【错题分析】';

/** 从报告文本里挑出「需要润色」的原因单元格。
 *  返回 { lines, targets:[{lineIdx, reason}] }；全对的题程序写的是「无」，不润色。
 *  ⚠️ 只认**表头之后、下一个【…】或签字行之前**的行 —— 报告里别的表格也有 ` | `。 */
function pickAttrReasons(text){
  const lines = String(text || '').split('\n');
  const start = lines.findIndex(l => l.trim() === ATTR_MARK);
  if(start < 0) return { lines, targets: [] };
  let end = lines.length;
  for(let i = start + 1; i < lines.length; i++){
    const t = lines[i].trim();
    if(t.startsWith('【') || t.startsWith('分析人：')){ end = i; break; }
  }
  const targets = [];
  for(let i = start + 1; i < end; i++){
    const raw = lines[i];
    if(raw.indexOf(' | ') < 0) continue;
    const parts = raw.split(' | ');
    if(parts.length < 7) continue;
    if(parts[0].trim() === '题号') continue;        // 表头
    const reason = parts.slice(6).join(' | ').trim();
    if(!reason || reason === '无') continue;
    targets.push({ lineIdx: i, reason });
  }
  return { lines, targets };
}

/**
 * AI 润色【错题分析】表的最后一列「失分情况及原因分析」（会员专属）
 *
 * @param opts 同 `aiAdvice()`：`{ btn, silent }`（合并后点谁谁转圈；silent 时由调用方汇总）
 * @returns `{ ok:true, count }` 或 `{ ok:false, error }`
 */
async function aiPolishAttribution(opts){
  const o = (opts && (opts.btn || opts.silent)) ? opts : {};
  const btn = o.btn || $('#btnAIPolishAttr'); const old = btn.textContent;
  const cur = $('#reportText').textContent;
  if(!cur.trim()){ toast('请先生成报告'); return { ok:false, error:'请先生成报告' }; }
  const { lines, targets } = pickAttrReasons(cur);
  if(!targets.length){
    toast('没有需要润色的错因（全对、或还没填失分题）');
    return { ok:false, error:'没有需要润色的错因（全对、或还没填失分题）' };
  }

  btn.disabled = true; btn.textContent = '⏳ 润色中';
  try{
    const paragraphs = targets.map(t => t.reason);
    let out = [];
    if(API.mode === 'server' && API.serverCfg.hasKey){
      const d = await apiFetch(API_BASE + '/ai-advice', { method:'POST', body:{
        section: 'attribution',
        paragraphs,
        context: { subject: val('stuSubject') || '数学', examName: val('examName') || '' },
      }});
      if(!d || !d.ok) throw new Error(d && d.error ? d.error : '服务器未返回内容');
      out = d.lines || [];
    }else{
      const txt = await callAI(JSON.stringify({ paragraphs }), {
        system: LOCAL_ATTR_SYS, temperature: 0.3, maxTokens: 4000,
      });
      out = String(txt || '').split(/\r?\n/)
        .map(s => s.trim().replace(/^[*\-–—•]\s*/, '').replace(/^\d+[.、)]\s*/, '').replace(/^["“”']|["“”']$/g, '').trim())
        .filter(Boolean);
    }
    if(out.length !== paragraphs.length){
      throw new Error('返回段落数与原文不一致（' + out.length + '/' + paragraphs.length + '），请重试');
    }

    // 逐行替换：**只换最后一格**，前 6 列原样拼回
    targets.forEach((t, i) => {
      const parts = lines[t.lineIdx].split(' | ');
      const head = parts.slice(0, 6).join(' | ');
      // ⚠️ 防一手：AI 万一在正文里写了 ` | `，会把这一行多切出一列、破坏表格
      const safe = String(out[i]).replace(/\s*\|\s*/g, '／').trim();
      lines[t.lineIdx] = head + ' | ' + safe;
    });

    const merged = lines.join('\n');
    $('#reportText').textContent = merged;
    lastReport = merged;
    $('#stChars').textContent = merged.length;
    if(!o.silent) toast('错因列已润色 ' + out.length + ' 处（分数与题号未动），可继续手动修改');
    return { ok:true, count: out.length };
  }catch(e){
    if(!o.silent) toast('错因润色失败：' + e.message, 3600);
    return { ok:false, error:e.message };
  }finally{
    btn.disabled = false; btn.textContent = old;
  }
}

/* ==========================================================================
   ✨ 报告头那个「AI 润色」：**一次点击，串行润两部分**（★ 2026-10 第十批，用户定的）
   --------------------------------------------------------------------------
   用户口径（2026-10 明确）：
     ① 点**一次** = 「建议段」+「错因列」都润；面板里那两个单独按钮**保留**（想只润一个就点它）；
     ② **串行**两步 —— 两个函数都是"读整篇报告 → 改自己那部分 → 整篇写回"，
        **并行会互相覆盖**（后写回的会用旧文本盖掉前者的成果），所以不能图快并行；
     ③ 失败策略：**失败的那一步自动重试一次**；仍失败就**保留另一步的成果**并如实说明，
        **绝不整篇回滚** —— 回滚等于白花已经付钱的那次调用；
     ④ 非会员：第一步就会被拒（403「AI 建议为会员专属功能」）→ **不重试、也不再打第二步**
        （省一次一定失败的调用）。
   ========================================================================== */
async function polishAll(){
  const btn = $('#btnPolishAll'); const old = btn.textContent;
  if(!lastAdviceCtx){ toast('请先生成报告'); return; }
  if(!$('#reportText').textContent.trim()){ toast('请先生成报告'); return; }
  btn.disabled = true;

  /** 跑一步：失败自动重试一次；会员/封禁类错误不重试（重试也没用） */
  const step = async (label, fn) => {
    btn.textContent = '⏳ ' + label + '…';
    let r = await fn();
    if(!r.ok && !/会员|封禁/.test(String(r.error || ''))){
      btn.textContent = '⏳ ' + label + '（重试一次）…';
      const again = await fn();
      if(again.ok){ r = again; r.retried = true; }
    }
    return Object.assign({ label }, r);
  };

  const a = await step('① 润色建议段 1/2', () => aiAdvice({ btn, silent:true }));
  const b = /会员|封禁/.test(String(a.ok ? '' : a.error || ''))
    ? { ok:false, error:'未执行（先把会员开通后再点）', count:0 }
    : await step('② 润色错因列 2/2', () => aiPolishAttribution({ btn, silent:true }));

  btn.disabled = false;
  const calls = [a, b].reduce((n, x) => n + (x.ok ? 1 : 0) + (x.retried ? 1 : 0), 0);
  const mark = (x) => x.ok ? (x.retried ? '已润色（重试后成功）' : '已润色') : '没成：' + (x.error || '未知原因');
  const summary = '建议段' + mark(a) + '；错因列' + mark(b) + (b.ok ? '（' + b.count + ' 处）' : '');
  const allOk = a.ok && b.ok;
  toast((allOk ? '✅ AI 润色完成：' : '⚠️ 只完成了一部分：') + summary
    + '（本次 ' + calls + ' 次 AI 调用）' + (allOk ? '' : '　已成功的那部分保留着，可再点一次重跑'),
    allOk ? 4200 : 8000);
  btn.title = '上次润色：' + summary;
  btn.textContent = allOk ? old : '✨ AI 润色（有一步没成，可再点）';
}

/** 本机模式（BYOK）下「建议段」的 system 提示词 —— 与服务端 ADVICE_PROMPT 同一口径 */
const DEFAULT_ADVICE_SYS = '你是一位有十几年经验的高中数学教师，正在给学生家长写《试卷分析表》里的「教学辅导建议与安排」。'
  + '请严格依据我提供的结构化诊断数据来写，不要编造数据，不要改动任何分数与题号。'
  + '文风要求：先给阶段性定性，再讲优势，然后按题型/模块点出短板与归因，最后给分阶段的、可执行的教学安排与预期分数。'
  + '要具体到"哪道题、哪个模块、什么原因、下一步怎么做"，多用"首先/其次/第三/第四"这样的层次词，'
  + '篇幅 800–1400 字，直接输出正文，不要标题、不要 markdown 符号。';

/** 本机模式（BYOK）下「错因列润色」的 system 提示词 —— 与服务端 ATTRIBUTION_PROMPT 同一口径。
 *  ⚠️ 两处必须保持同一口径（服务端那份在 `src/app/api/paper-analysis/ai-advice/route.ts`）：
 *     改一处就要改另一处，否则"云端模式"和"本机模式"给家长的措辞会不一样。 */
const LOCAL_ATTR_SYS = '你是一位有十几年经验的高中数学教师，正在润色《试卷分析表》里「错题分析」表中「失分情况及原因分析」这一列的文字。这份表会交给学生家长看。'
  + '我会给你若干段程序生成的原始表述，请逐段改写。'
  + '必须保留每一段里的全部事实：知识点名称、题型、错误类型、失分表现、具体做法要求；一个都不能删、不能改、不能新增；不要写分数与题号。'
  + '要改的是口吻：面向家长、客观、专业、措辞温和，不下定论 ——'
  + '不要用「能力严重缺失／能力差／知识体系尚未建立／态度有问题／不用心」这类给孩子贴标签的说法，'
  + '改成描述当前状态并且可改进的表述（例如「这一块目前还不够稳定」）；不做性格与智力评价；不用「孩子」这类口语称呼；不夸大也不淡化。'
  + '每段 40–90 字，一句话说清「错在哪 + 下一步怎么改」。'
  + '输出格式：输入的每一段对应输出的一行，行数必须与输入完全一致、顺序不变；只输出这些行，不要编号、不要题号、不要小标题、不要 markdown 符号。';

/** 本机模式：直接用浏览器里的 Key 调 OpenAI 兼容接口
 *  @param userContent 发给模型的 user 内容
 *  @param opts        可选覆盖：{ system, temperature, maxTokens }（默认值 = 老行为，一字不变） */
async function callAI(userContent, opts){
  const cfg = loadApiCfg();
  if(!cfg.apiKey){ toast('请先配置 API Key（点「服务器与AI设置」）'); openServerModal(); throw new Error('未配置 API Key'); }
  const sys = (opts && opts.system) || DEFAULT_ADVICE_SYS;
  const temperature = (opts && typeof opts.temperature === 'number') ? opts.temperature : 0.7;
  const maxTokens = (opts && typeof opts.maxTokens === 'number') ? opts.maxTokens : 2500;
  const r = await fetch(cfg.apiBase.replace(/\/+$/,'') + '/chat/completions', {
    method:'POST',
    headers:{'Content-Type':'application/json','Authorization':'Bearer ' + cfg.apiKey},
    body: JSON.stringify({
      model: cfg.model,
      messages: [{ role:'system', content: sys }, { role:'user', content: userContent }],
      temperature, max_tokens: maxTokens
    })
  });
  if(!r.ok) throw new Error('接口返回 ' + r.status);
  const d = await r.json();
  return (d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || '';
}

/* ==========================================================================
   拍照识别答题卡（视觉模型，可选）
   ========================================================================== */
function photoPick(){ $('#photoInput').click(); }

async function photoRun(file){
  if(!paper){ toast('请先解析试卷'); return; }
  if(!API.serverCfg.visionModel){ toast('未配置视觉模型，请在「服务器与AI设置」里填写', 3200); return; }
  const btn = $('#btnPhoto'); const old = btn.textContent;
  btn.disabled = true; btn.textContent = '⏳ 识别中';
  try{
    const dataUrl = await fileToDataUrl(file);
    const list = paper.questions.map(q => ({
      题号: q.no, 题型: q.section, 满分: records[q.no] ? records[q.no].full : 0,
      知识点: q.knowledge
    }));
    const d = await apiFetch(API_BASE + '/vision-scores', {
      method:'POST',
      body:{ image: dataUrl, questions: list, model: API.serverCfg.visionModel }
    });
    if(!d || !d.ok) throw new Error(d && d.error ? d.error : '识别失败');
    const items = d.scores || [];
    let n = 0;
    items.forEach(it => {
      const qno = parseInt(it.no, 10);
      if(records[qno] && it.got != null){ records[qno].got = num(it.got); n++; }
    });
    renderScoreList();
    toast(`已识别并填入 ${n} 道题的得分，请逐题核对后再生成报告`, 3600);
  }catch(e){
    toast('识别失败：' + e.message, 3600);
  }finally{
    btn.disabled = false; btn.textContent = old;
  }
}
function fileToDataUrl(file){
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = () => rej(new Error('读取图片失败'));
    r.readAsDataURL(file);
  });
}

/* ==========================================================================
   复制 / 导出
   ========================================================================== */
/**
 * 导出成 Word 文档
 *
 * 两种模式：
 *   ① 模板模式（首选）：读 templates 里的 Word 模板，替换 {{占位符}}，
 *      格式由你自己的模板决定，程序一个字都不改。
 *      （模板以 base64 内嵌在 js/template-data.js，见 templates/build-template.py）
 *   ② 自带模式（兜底）：模板不可用时，用内置渲染器生成（老实现）。
 *
 * 数据从「当前预览」里取，保证导出内容与你屏幕上看到的一致
 * （包括你手动改过的文字和 AI 重写过的建议段）。
 */
function exportDocx(){
  if(!paper){ toast('请先解析试卷'); switchStep('cPaper'); return; }
  const name = val('stuName');
  if(!name){ toast('请先填学生姓名'); switchStep('cScore'); return; }
  const ctx = collectCtx();

  // 建议段从预览里取（老师可能已手改或 AI 重写）
  let adviceText = '';
  const cur = $('#reportText').innerText;
  const mi = cur.indexOf('【教学辅导建议/安排】');
  const si = cur.indexOf('分析人：');
  if(mi >= 0 && si > mi) adviceText = cur.slice(mi + '【教学辅导建议/安排】'.length, si).trim();
  if(!adviceText){
    adviceText = Narrator.buildAdvice({
      name, score:ctx.score, full:ctx.full, band:ctx.band, skeleton:ctx.skeleton,
      questionRows:ctx.questionRows, modules:ctx.modules, typeAgg:ctx.typeAgg, diags:ctx.diags,
      examType: val('examName') || '测试', attitude: val('stuAttitude'), teacherNote: val('stuNote')
    });
  }

  // 班级：勾选了才填，否则留空（老师手填）
  const fillClassEl = document.getElementById('fillClass');
  const fillClass = !!(fillClassEl && fillClassEl.checked);
  const className = fillClass ? ((students[name] && students[name].cls) || val('stuClass') || '') : '';

  const payload = {
    name, gender: val('stuGender'), grade: val('stuGrade'), subject: val('stuSubject'),
    teacher: val('stuTeacher') || '郭庆杰', manager: val('stuManager'),
    score: ctx.score, full: ctx.full,
    examDate: val('examDate'), examName: val('examName'),
    duration: val('examDuration') || '120min',
    examScope: val('examScope') || (paper.scope || []).join('，'),
    taughtContent: val('examTaught'), progress: val('stuProgress'),
    paper, records,
    questionRows: ctx.questionRows,
    typeSummary: ctx.typeSummary,
    advice: adviceText,
    fillClass: fillClass && !!className,
    className
  };

  let bin = null, usedTemplate = false, warnings = [];

  // ① 模板模式
  if(window.ReportTemplate && window.TemplateData){
    try{
      const r = window.ReportTemplate.build(payload, { template: window.TemplateData });
      bin = r.blob; usedTemplate = true; warnings = r.warnings || [];
    }catch(e){
      warnings.push('模板导出失败，已改用内置渲染：' + e.message);
    }
  }

  // ② 兜底：内置渲染器
  if(!bin){
    if(!window.ReportDocx){ toast('导出模块没加载，请刷新页面'); return; }
    try{
      bin = window.ReportDocx.build(payload);
    }catch(e){
      toast('导出失败：' + e.message, 3400); return;
    }
  }

  try{
    const blob = new Blob([bin], { type:'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${name}-${(val('examName') || '试卷分析').replace(/[\\/:*?"<>|]/g,'')}-试卷分析.docx`;
    document.body.appendChild(a); a.click();
    setTimeout(()=>{ URL.revokeObjectURL(a.href); a.remove(); }, 1200);

    if(warnings.length){
      toast('已导出，但有提醒：' + warnings[0], 4200);
      warnings.forEach(w => console.warn('[导出]', w));
    }else{
      toast(usedTemplate ? '已按你的 Word 模板导出' : '已用内置格式导出');
    }
  }catch(e){
    toast('导出失败：' + e.message, 3400);
  }
}

/* ==========================================================================
   🏢 公司模板导出（★ 2026-10 第十二批，**新增模块**）
   --------------------------------------------------------------------------
   红线（用户 2026-10 明确）：**不动现有生成逻辑**。这里只"读现有数据、输出 docx"。
   数据全部来自已经算好的东西：`lastAdviceCtx.ctx`（生成报告时的诊断）+ 表单 + 档案字段。
   底稿是公司原件切分出来的三个模板（`public/tools/company-template/templates/`），
   填充引擎在 `../company-template/company-docx.js`（按标签定位、只改文字）。

   用户定的口径（7 条，改之前先看 `docs/company-export-plan.md`）：
     ① 以公司模板为底、只替换文字；三个附件各一个 docx；附件1/2 导出时选（旧导出保留）
     ② 考试类型 = 下拉（校考/月考/期中/期末/内部考）
     ③ 排名 = 手填（有就填、没有留空）
     ④ 附件2「题目」列 = **用知识点顶替**（工具里没有题干）
     ⑤ 过程列（三次课后/阶段总结/效果评估）**一期留空**，老师在 Word 里写
     ⑥ 「已学课时」= 手填（实际已上，不是计划）
     ⑦ 签字栏留空（打印后手写）
   ========================================================================== */

/** 从页面与已生成的报告里取数据（**只读**，不改任何现有状态） */
function collectCompanyData(){
  const ctx = lastAdviceCtx && lastAdviceCtx.ctx ? lastAdviceCtx.ctx : null;
  // 错题行：直接用报告里已经算好的逐题行（no/full/got/knowledge/reason），不重算
  const rows = (ctx && ctx.questionRows ? ctx.questionRows : [])
    .filter(r => num(r.got) < num(r.full))
    .map(r => ({
      no: r.no,
      topic: (r.knowledge || '').split(/[；;,，]/)[0].trim(),   // 「题目」列 = 知识点（用户口径④）
      point: r.knowledge || '',
      reason: r.reason || (records[r.no] && records[r.no].note) || '',
    }));
  const curScore = String($('#coCurrentScore').value || '').trim() ||
    String(round2(Object.values(records).reduce((a, r) => a + num(r.got), 0)));
  return {
    student: val('stuName'), school: $('#coSchool').value.trim(), grade: val('stuGrade'),
    teacher: val('stuTeacher') || '郭庆杰', subject: val('stuSubject') || '数学',
    learnedHours: $('#coLearnedHours').value.trim(), totalHours: $('#coTotalHours').value.trim(),
    examType: $('#coExamType').value,
    entryScore: $('#coEntryScore').value.trim(), entryRank: $('#coEntryRank').value.trim(),
    currentScore: curScore, currentRank: $('#coCurrentRank').value.trim(),
    wrongRows: rows,
    longTexts: {},        // 一期留空：六段长文由老师在 Word 里写（口径⑤）
  };
}

/** 导出所选附件 → 下载 .docx */
function exportCompany(){
  const att = ($('#coAtt2') && $('#coAtt2').checked) ? '附件2' : '附件1';
  if(!window.CompanyDocx || !window.CompanyTemplateData){
    toast('导出模块没加载，请刷新页面'); return;
  }
  if(!lastAdviceCtx){ toast('请先「✨ 生成报告」，导出要用报告里算好的错题与原因'); return; }
  if(!val('stuName')){ toast('请先填学生姓名'); return; }
  let bin;
  try{
    bin = window.CompanyDocx.build(att, collectCompanyData());
  }catch(e){
    toast('导出失败：' + e.message, 4200); return;
  }
  const blob = new Blob([bin], { type:'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${val('stuName')}-${att}-${(val('examName') || '试卷分析').replace(/[\\/:*?"<>|]/g,'')}.docx`;
  document.body.appendChild(a); a.click();
  setTimeout(()=>{ URL.revokeObjectURL(a.href); a.remove(); }, 1200);
  const blank = att === '附件2'
    ? '（附件2：抬头 + 逐题错题表已填；三段措施、签字栏留空）'
    : '（附件1：抬头已填；六段归因/措施、签字栏留空）';
  $('#coHint').textContent = `已导出 ${att} ${blank}`;
  toast(`已按公司模板导出 ${att}`, 3600);
}

/** 测试钩子（与 math-plan 的 MathPlanHooks 同一做法）：让测试能拿到字节与数据 */
window.CompanyExportHooks = {
  collect: () => collectCompanyData(),
  buildBytes: (att) => {
    if(!window.CompanyDocx) return null;
    const a = att || (($('#coAtt2') && $('#coAtt2').checked) ? '附件2' : '附件1');
    const bytes = window.CompanyDocx.build(a, collectCompanyData());
    return { att: a, bytes: Array.prototype.slice.call(bytes) };
  },
};

function copyReport(){
  const txt = $('#reportText').innerText;
  if(!txt.trim()){ toast('还没有生成报告'); return; }
  if(navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(txt).then(()=>toast('报告已复制')).catch(()=>fallbackCopy(txt));
  }else fallbackCopy(txt);
}
function fallbackCopy(txt){
  const ta = document.createElement('textarea');
  ta.value = txt; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select();
  try{ document.execCommand('copy'); toast('已复制'); }catch(e){ toast('复制失败，请手动选择'); }
  ta.remove();
}
function exportWord(){
  const txt = $('#reportText').innerText;
  if(!txt.trim()){ toast('还没有生成报告'); return; }
  const name = val('stuName') || '学生';
  const body = txt.split('\n').map(l => l.trim() === ''
    ? '<p style="margin:0">&nbsp;</p>'
    : `<p style="margin:0 0 3pt 0;line-height:1.55">${esc(l)}</p>`).join('');
  const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office"
      xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">
  <head><meta charset="utf-8"><title>${esc(name)}试卷分析</title>
  <!--[if gte mso 9]><xml><w:WordDocument><w:View>Print</w:View></w:WordDocument></xml><![endif]-->
  <style>@page{size:A4;margin:1.8cm 1.6cm}
    body{font-family:"宋体",SimSun,serif;font-size:10.5pt;line-height:1.5}
    p{margin:0 0 3pt 0}</style></head><body>${body}</body></html>`;
  const blob = new Blob(['\ufeff', html], {type:'application/msword;charset=utf-8'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${name}-${(val('examName')||'试卷分析').replace(/[\\/:*?"<>|]/g,'')}.doc`;
  document.body.appendChild(a); a.click();
  setTimeout(()=>{ URL.revokeObjectURL(a.href); a.remove(); }, 900);
  toast('已导出 Word 文档');
}

/* ==========================================================================
   学生档案与历史
   ========================================================================== */
/* ---------- 档案/历史的读写入口（云端走 API，本机走 localStorage） ----------
   ⚠️ 四种写法（增改档案 / 删档案 / 存历史 / 删历史）集中在这里，
      调用点只调它们。**不要让调用点自己去 fetch** —— 那会造成
      「同一件事有两个来源」，正是本项目反复踩过的坑。 */

/** 保存/更新一位学生的档案 */
async function persistStudent(name, s){
  if(CLOUD_STORE.enabled){
    await CLOUD_STORE.saveStudent(name, s);   // 合并语义：只发本工具的字段
    return;
  }
  students[name] = s;
  saveJSON(K_STU, students);
}

/** 删除一位学生（连带历史） */
async function removeStudent(name){
  if(CLOUD_STORE.enabled){
    await CLOUD_STORE.deleteStudent(name);
    delete students[name];
    delete history[name];
    return;
  }
  delete students[name]; delete history[name];
  saveJSON(K_STU, students); saveJSON(K_HIST, history);
}

/** 存一条历史报告。
 *  ⚠️ 云端用 `op:'import'`（幂等），存完**重新拉一次**，让列表拿到真实 id ——
 *     否则「删一条」没有 id 可用。 */
async function persistHistory(name, entry){
  if(CLOUD_STORE.enabled){
    const d = await CLOUD_STORE.importHistory([historyToImport(name, entry)]);
    await loadFromCloud();
    return d;
  }
  history[name] = history[name] || [];
  history[name].push(entry);
  saveJSON(K_HIST, history);
  return { inserted: 1 };
}

/** 删除某学生的一条历史（按下标；云端用它的 id） */
async function removeHistory(name, idx){
  if(CLOUD_STORE.enabled){
    const h = (history[name] || [])[idx];
    if(!h || !h.cloudId){
      toast('这条记录还没有云端编号，请刷新后重试', 3200);
      return;
    }
    await CLOUD_STORE.deleteHistory(h.cloudId);
    history[name].splice(idx, 1);
    return;
  }
  if(!history[name]) return;
  history[name].splice(idx, 1);
  saveJSON(K_HIST, history);
}

function renderStuChips(){
  const names = Object.keys(students);
  const box = $('#stuChips');
  if(!names.length){ box.innerHTML = '<span class="tip">还没有学生档案。填好信息后点下面「保存档案」。</span>'; return; }
  box.innerHTML = names.map(n =>
    `<span class="tag" style="cursor:pointer;padding:5px 11px" data-stu="${esc(n)}">${esc(n)}<span data-del="${esc(n)}" style="opacity:.6;margin-left:5px">×</span></span>`
  ).join('') + '<button class="btn btn-out btn-sm" id="btnSaveStu">💾 保存当前信息为档案</button>';
  $$('#stuChips [data-stu]').forEach(el => el.onclick = e => {
    if(e.target.dataset.del) return;
    pickStudent(el.dataset.stu);
  });
  $$('#stuChips [data-del]').forEach(x => x.onclick = async e => {
    e.stopPropagation();
    const n = x.dataset.del;
    if(confirm('删除「' + n + '」的档案与历史记录？')){
      try{
        await removeStudent(n);
        renderStuChips(); renderHist(); toast('已删除');
      }catch(err){ toast('删除失败：' + (err && err.message ? err.message : err), 3600); }
    }
  });
  const b = $('#btnSaveStu'); if(b) b.onclick = saveCurrentStudent;
}
function pickStudent(n){
  const s = students[n]; if(!s) return;
  $('#stuName').value = n;
  if(s.gender) $('#stuGender').value = s.gender;
  if(s.grade) $('#stuGrade').value = s.grade;
  if(s.subject) $('#stuSubject').value = s.subject;
  if(s.teacher) $('#stuTeacher').value = s.teacher;
  if(s.manager) $('#stuManager').value = s.manager;
  if(s.cls) $('#stuClass').value = s.cls; else $('#stuClass').value = '';
  if(s.attitude) $('#stuAttitude').value = s.attitude;
  renderHist(); toast('已带出「' + n + '」的信息');
}
function saveCurrentStudent(){
  const n = val('stuName');
  if(!n){ toast('请先填学生姓名'); return; }
  const rec = {
    gender: val('stuGender'), grade: val('stuGrade'), subject: val('stuSubject'),
    teacher: val('stuTeacher'), manager: val('stuManager'), cls: val('stuClass'),
    attitude: val('stuAttitude'),
    updated: new Date().toISOString().slice(0,10)
  };
  // 先写本地内存（界面立刻正确），再落盘到该去的地方（云端 / 本机）
  students[n] = rec;
  renderStuChips();
  Promise.resolve()
    .then(() => persistStudent(n, rec))
    .then(() => toast('已保存「' + n + '」的档案'))
    .catch(err => toast('保存失败：' + (err && err.message ? err.message : err), 4000));
}
function renderHist(){
  const n = val('stuName');
  const list = (n && history[n]) ? history[n] : [];
  $('#histCount').textContent = list.length ? list.length + ' 条' : '';
  $('#histList').innerHTML = list.length
    ? list.slice().reverse().map((h, i) => {
        const ri = list.length - 1 - i;
        return `<div class="hist">
          <div class="h"><b>${esc(h.date || '未填日期')}</b><span>${esc(h.examName || '')}</span>
            <span>${esc(h.score)} / ${esc(h.full)}</span><span class="spacer" style="flex:1"></span>
            <button class="btn btn-gh btn-xs" data-load="${ri}">载入</button>
            <button class="btn btn-gh btn-xs" data-dh="${ri}">删</button></div>
          <div class="t" data-t="${ri}">${esc(h.text)}</div>
          <span class="tag" style="cursor:pointer" data-more="${ri}">展开全文</span>
        </div>`;
      }).join('')
    : '<p class="tip">生成报告后点「存入该生记录」，这里会累积历史，方便对比同一学生几次考试的变化。</p>';
  $$('#histList [data-load]').forEach(b => b.onclick = () => {
    const h = list[+b.dataset.load]; if(!h) return;
    $('#reportText').textContent = h.text; lastReport = h.text;
    $('#stChars').textContent = h.text.length;
    toast('已载入历史报告，可继续修改');
  });
  $$('#histList [data-dh]').forEach(b => b.onclick = async () => {
    const n2 = val('stuName'); if(!history[n2]) return;
    try{
      await removeHistory(n2, +b.dataset.dh);
      renderHist();
    }catch(err){ toast('删除失败：' + (err && err.message ? err.message : err), 3600); }
  });
  $$('#histList [data-more]').forEach(b => b.onclick = () => {
    const t = document.querySelector(`#histList .t[data-t="${b.dataset.more}"]`);
    t.classList.toggle('open');
    b.textContent = t.classList.contains('open') ? '收起' : '展开全文';
  });
}
function saveToHistory(){
  const n = val('stuName');
  const txt = $('#reportText').innerText.trim();
  if(!n){ toast('请先填学生姓名'); return; }
  if(!txt){ toast('还没有生成报告'); return; }
  const ctx = collectCtx();
  const entry = {
    text: txt, date: val('examDate'), examName: val('examName'),
    score: ctx.score, full: ctx.full, saved: new Date().toISOString()
  };
  // 先入本地内存并重绘，再落盘（云端模式下 persistHistory 会重新拉一次拿到真实 id）
  history[n] = history[n] || [];
  history[n].push(entry);
  renderHist();
  Promise.resolve()
    .then(() => persistHistory(n, entry))
    .then(() => {
      renderHist();
      toast('已存入「' + n + '」的记录（共 ' + history[n].length + ' 条）');
    })
    .catch(err => toast('保存失败：' + (err && err.message ? err.message : err), 4400));
}

/* ==========================================================================
   服务器与 AI 设置
   ========================================================================== */
function loadApiCfg(){
  const def = { apiKey:'', apiBase:'https://api.deepseek.com/v1', model:'deepseek-chat' };
  try{ const s = localStorage.getItem('paper_analysis_ai_v1'); if(s) return Object.assign(def, JSON.parse(s)); }catch(e){}
  return def;
}
function saveApiCfg(){
  localStorage.setItem('paper_analysis_ai_v1', JSON.stringify({
    apiKey: val('serverKeyInput'), apiBase: val('serverBaseInput'), model: val('serverModelInput')
  }));
}
function openServerModal(){
  const info = $('#serverModeInfo');
  const isServer = API.mode === 'server';
  // 云端模式下服务器配置来自环境变量，不由网页保存 —— 隐藏那段表单，
  // 但**不能提前 return**：否则 openMask 不会被调用，弹窗根本打不开
  if(NEXT_HOST){
    const body = document.querySelector('#maskServer .mbody');
    if(body) body.style.display = 'none';
    if(info){
      info.innerHTML = '<b>当前：云端版</b><br>'
        + '试卷文件在你自己的浏览器里解析，<b>不会上传</b>；只有点「AI 改写建议段」时，'
        + '会把<b>已经算好的分数与失分统计</b>发给服务器由 AI 处理。<br>'
        + '服务器端 AI：' + (API.serverCfg.hasKey ? '✅ 已配置（会员可用）' : '❌ 未配置')
        + '　答题卡识别：' + (API.serverCfg.visionModel ? '✅ ' + esc(API.serverCfg.visionModel) : '❌ 未启用');
    }
    openMask('#maskServer');
    return;
  }
  const cfg = isServer ? API.serverCfg : loadApiCfg();
  if(info){
    info.innerHTML = isServer
      ? `<b>当前：联网版</b><br>试卷数据与报告都在你自己的浏览器里处理，<b>不会上传</b>。
         AI 请求走服务器代理，Key 存在服务器上。<br>
         服务器端 AI：${API.serverCfg.hasKey ? '✅ 已配置' : '❌ 未配置'}　
         视觉模型：${API.serverCfg.visionModel ? '✅ ' + esc(API.serverCfg.visionModel) : '❌ 未配置（拍照识别不可用）'}`
      : `<b>当前：本机版</b><br>这份文件是直接打开的，AI 需要你自己填 Key（只存在本机浏览器）。
         放到服务器上访问会自动切换为联网版，Key 由服务器统一管理。`;
  }
  const lc = loadApiCfg();
  $('#writeTokenInput').value = getWriteToken();
  $('#serverKeyInput').value = isServer ? '' : (lc.apiKey || '');
  $('#serverBaseInput').value = (isServer ? API.serverCfg.apiBase : lc.apiBase) || 'https://api.deepseek.com/v1';
  $('#serverModelInput').value = (isServer ? API.serverCfg.model : lc.model) || 'deepseek-chat';
  $('#visionModelInput').value = (isServer ? API.serverCfg.visionModel : '') || '';
  openMask('#maskServer');
}
function openMask(id){ $(id).classList.add('on'); }
function closeMask(id){ $(id).classList.remove('on'); }

async function saveServerCfg(){
  const tok = val('writeTokenInput'); if(tok) setWriteToken(tok);
  if(API.mode !== 'server'){
    saveApiCfg(); toast('已保存到本机浏览器'); return;
  }
  try{
    const d = await apiFetch(API_BASE + '/config', { method:'POST', body:{
      writeToken: getWriteToken(),
      apiKey: val('serverKeyInput'), apiBase: val('serverBaseInput'),
      model: val('serverModelInput'), visionModel: val('visionModelInput')
    }});
    if(d && d.ok){
      API.isAdmin = true;
      API.serverCfg.hasKey = API.serverCfg.hasKey || !!val('serverKeyInput');
      API.serverCfg.visionModel = val('visionModelInput');
      updateModeBadge(); toast('已保存到服务器'); closeMask('#maskServer');
    }else toast('保存失败：' + (d && d.error ? d.error : '口令可能不对'), 3200);
  }catch(e){ toast('保存失败：' + e.message, 3200); }
}
async function testServerCfg(){
  if(API.mode !== 'server'){
    const cfg = loadApiCfg();
    if(!cfg.apiKey){ toast('请先填 API Key'); return; }
    toast('测试中…');
    try{
      const r = await fetch(cfg.apiBase.replace(/\/+$/,'') + '/models', { headers:{Authorization:'Bearer ' + cfg.apiKey} });
      toast(r.ok ? '连接成功' : '连接失败：' + r.status);
    }catch(e){ toast('无法连接，检查地址或网络'); }
    return;
  }
  toast('测试中…');
  try{
    const d = await apiFetch(API_BASE + '/health');
    toast(d && d.ok ? '服务器正常（AI ' + (d.hasKey ? '已配置' : '未配置') + '）' : '服务器异常');
  }catch(e){ toast('无法连接服务器：' + e.message); }
}

/* ==========================================================================
   保存 / 恢复试卷元数据
   ========================================================================== */
function collectPaperMeta(){
  return {
    examName: val('examName'), examDate: val('examDate'), examDuration: val('examDuration'),
    examTotal: val('examTotal'), examPreset: val('examPreset'), examScope: val('examScope'),
    examTaught: val('examTaught'), examDiff: val('examDiff')
  };
}
function applyPaperMeta(m){
  if(!m) return;
  ['examName','examDate','examDuration','examTotal','examPreset','examScope','examTaught','examDiff']
    .forEach(k => { const e = document.getElementById(k); if(e && m[k] != null) e.value = m[k]; });
}

/* ==========================================================================
   解析结果里的题目清单（给老师核对用）
   ========================================================================== */
function renderQuestionList(){
  if(!paper) return;
  $('#qCount').textContent = paper.questions.length + ' 题';
  let html = '<table class="kv"><thead><tr><th>题号</th><th>题型</th><th>难度系数</th><th>难度</th><th>考察知识点</th></tr></thead><tbody>';
  paper.questions.forEach(q => {
    html += `<tr><td>${q.no}</td><td>${esc(q.section||'')}</td><td>${q.coeff==null?'—':q.coeff}</td>`
      + `<td><span class="tag ${q.grade||''}">${esc(q.difficulty||'')}</span></td>`
      + `<td style="text-align:left">${esc((q.knowledge||[]).join('；'))}</td></tr>`;
  });
  html += '</tbody></table>';
  $('#qListWrap').innerHTML = html;
}

/* ==========================================================================
   示例试卷（方便老师先试一遍）
   ========================================================================== */
const DEMO = `2026年8月29日高中数学作业
整体难度：适中
考试范围：计数原理与概率统计,函数与导数
试卷题型
<TABLE>
题型 | 数量
单选题 | 10
填空题 | 5
解答题 | 8
</TABLE>
试卷难度
<TABLE>
难度 | 题数
容易 | 11
适中 | 7
困难 | 5
</TABLE>
细目表分析
<TABLE>
题号 | 难度系数 | 详细知识点
一、单选题 | 一、单选题 | 一、单选题
1 | 0.94 | 求二项展开式的第k项
2 | 0.85 | 全排列问题
3 | 0.94 | 简单复合函数的导数
4 | 0.94 | 利用导数求函数的单调区间（不含参）
5 | 0.94 | 由随机变量的分布列求概率
6 | 0.85 | 独立重复试验的概率问题
7 | 0.85 | 指定区间的概率
8 | 0.85 | 求离散型随机变量的均值；离散型随机变量的方差与标准差
9 | 0.65 | 函数（导函数）图象与极值的关系；函数极值点的辨析
10 | 0.65 | 函数不等式恒成立问题；由函数在区间上的单调性求参数
二、填空题 | 二、填空题 | 二、填空题
11 | 0.85 | 计算条件概率；计算古典概型问题的概率
12 | 0.85 | 求指定项的系数
13 | 0.65 | 分类加法计数原理；数字排列问题
14 | 0.85 | 平均变化率；瞬时变化率的概念及辨析
15 | 0.65 | 求指定项的系数；两个二项式乘积展开式的系数问题
三、解答题 | 三、解答题 | 三、解答题
16 | 0.15 | 利用导数求函数（含参）的单调区间；利用导数研究函数的零点
17 | 0.4 | 利用导数研究不等式恒成立问题；求在曲线上一点处的切线方程（斜率）
18 | 0.65 | 互斥事件的概率加法公式；求离散型随机变量的均值；计算古典概型问题的概率
19 | 0.65 | 计算条件概率；独立事件的判断；计算古典概型问题的概率
20 | 0.65 | 由导数求函数的最值（不含参）；函数单调性、极值与最值的综合应用
21 | 0.4 | 利用导数求函数（含参）的单调区间；由导数求函数的最值（不含参）
22 | 0.4 | 利用导数求函数（含参）的单调区间；利用导数研究函数的零点
23 | 0.4 | 利用导数求函数（含参）的单调区间；函数单调性、极值与最值的综合应用
</TABLE>
知识点分析
<TABLE>
序号 | 知识点 | 对应题号
1 | 计数原理与概率统计 | 1,2,5,6,7,8,11,12,13,15,18,19
2 | 函数与导数 | 3,4,9,10,14,16,17,20,21,22,23
</TABLE>`;

/* ==========================================================================
   事件绑定
   ========================================================================== */
function bind(){
  // 步骤导航
  $$('.steps button').forEach(b => b.onclick = () => switchStep(b.dataset.col));
  // 遮罩关闭
  document.addEventListener('click', e => {
    if(e.target.closest('[data-close]')){ const m = e.target.closest('.mask'); if(m) m.classList.remove('on'); }
    if(e.target.classList && e.target.classList.contains('mask')) e.target.classList.remove('on');
  });

  // ① 试卷
  $('#btnParse').onclick = parsePaper;
  $('#btnUpload').onclick = () => $('#fileInput').click();
  $('#fileInput').onchange = e => { const f = e.target.files[0]; if(f) handleFile(f); e.target.value = ''; };
  // ★ 图片/截图识别（可一次选多张，逐张识别后合并）
  $('#btnVision').onclick = () => $('#visionInput').click();
  $('#visionInput').onchange = e => { visionRun(e.target.files); e.target.value = ''; };
  // ★ 学校卷子（照片/扫描件/扫描版 PDF）→ 题目结构
  $('#btnSchool').onclick = () => $('#schoolInput').click();
  $('#schoolInput').onchange = e => { schoolRun(e.target.files); e.target.value = ''; };
  $('#btnSchoolClear').onclick = clearSchool;
  $('#btnPasteToggle').onclick = () => {
    const b = $('#pasteBox');
    const show = b.style.display === 'none';
    b.style.display = show ? '' : 'none';
    $('#btnPasteToggle').textContent = show ? '⌨️ 收起粘贴框' : '⌨️ 改用粘贴文字';
    if(show) $('#paperPaste').focus();
  };
  $('#btnDemo').onclick = () => {
    $('#pasteBox').style.display = '';
    $('#paperPaste').value = DEMO;
    toast('已载入示例，点「解析文字」试试');
  };
  $('#btnClearPaper').onclick = () => {
    $('#paperPaste').value = ''; $('#parseResult').innerHTML = '';
    $('#paperPanel').style.display = 'none'; $('#qPanel').style.display = 'none';
    paper = null; scoreAssign = null; records = {};
    scoreExpand = new Set(); baselineTotals = {};
    $('#scoreTable').innerHTML = ''; $('#scoreSumHint').innerHTML = '';
    $('#paperHint').textContent = '未导入'; toast('已清空');
  };
  $('#examTotal').oninput = computeScores;
  $('#examPreset').onchange = computeScores;

  // 分值分配表：一次性事件委托（不在渲染函数里逐个绑监听器）。
  // 第一批的坑是「在事件处理器内部重渲染整表 → change 监听器自我叠加」；
  // 改为委托后，渲染与绑定彻底分离，改一道题的分数不会再重建整张表。
  const scoreTable = $('#scoreTable');
  if(scoreTable){
    scoreTable.addEventListener('click', e => {
      const tgl = e.target.closest('button[data-tgl]');
      if(tgl){
        const type = tgl.dataset.tgl;
        const open = !scoreExpand.has(type);
        if(open) scoreExpand.add(type); else scoreExpand.delete(type);
        const row = tgl.closest('tr');
        const sub = row ? row.nextElementSibling : null;
        if(sub && sub.classList.contains('sub')) sub.hidden = !open;
        tgl.dataset.open = open ? '1' : '0';
        // 箭头字符与 data-open 保持一致（CSS 也可据此旋转）
        tgl.textContent = open ? '▼' : '▶';
        return;
      }
      const apply = e.target.closest('button[data-bapply]');
      if(apply){ applyBatch(apply.dataset.bapply); }
    });
    scoreTable.addEventListener('change', e => {
      const cell = e.target.closest('input[data-scell]');
      if(cell) applyTypeCell(cell.dataset.scell, +cell.dataset.i, cell.value);
    });
  }

  // ② 成绩
  $('#btnFillFull').onclick = () => fillAll('full');
  $('#btnFillZero').onclick = () => fillAll('zero');
  $('#btnFillEasy').onclick = () => fillAll('easy');
  $('#btnPhoto').onclick = photoPick;
  $('#photoInput').onchange = e => { const f = e.target.files[0]; if(f) photoRun(f); e.target.value = ''; };
  ['stuName','stuAttitude','stuGrade'].forEach(id => {
    const el = document.getElementById(id);
    if(el) el.addEventListener('input', renderHist);
    if(el) el.addEventListener('change', renderHist);
  });
  // 「保存档案」按钮由 renderStuChips() 动态创建，绑定也在那里完成

  // ③ 报告
  $('#btnGen').onclick = generateReport;
  $('#btnGenMobile').onclick = generateReport;
  // ⚠️ 三个 AI 润色入口（★ 2026-10 第十批）：
  //    · 报告头「✨ AI 润色」→ polishAll()：**一次点击串行润两部分**（用户定的行为）
  //    · 面板里「✨ AI 改写建议段」「✍️ AI 润色错因列」→ 各自单独润（保留，想只润一个就点它）
  //    用箭头函数包一层，避免把 MouseEvent 当成 opts 传进去（里面对 opts 做了判断，但别依赖它）
  $('#btnAIAdvice').onclick = () => aiAdvice();
  $('#btnAIPolishAttr').onclick = () => aiPolishAttribution();
  $('#btnPolishAll').onclick = () => polishAll();
  $('#btnCopy').onclick = copyReport;
  $('#btnCopy2').onclick = copyReport;
  $('#btnDocx').onclick = exportDocx;
  // ★ 公司模板导出（新增模块，不动上面的生成逻辑）
  $('#btnCompanyExport').onclick = exportCompany;
  $('#btnExport').onclick = exportDocx;
  $('#btnExport2').onclick = exportWord;
  $('#btnPrint').onclick = () => window.print();
  $('#btnSaveHist').onclick = saveToHistory;
  $('#btnRestore').onclick = () => {
    if(!lastReport){ toast('没有可还原的内容'); return; }
    $('#reportText').textContent = lastReport;
    $('#stChars').textContent = lastReport.length;
    toast('已还原为生成时的内容');
  };
  $('#reportText').addEventListener('input', () => {
    $('#stChars').textContent = $('#reportText').innerText.length;
  });

  // 服务器 / AI
  $('#btnServer').onclick = openServerModal;
  $('#btnSaveServer').onclick = saveServerCfg;
  $('#btnTestServer').onclick = testServerCfg;
  $('#btnPassOk').onclick = submitPass;
  const pi = $('#passInput');
  if(pi) pi.addEventListener('keydown', e => { if(e.key === 'Enter') submitPass(); });
}

async function submitPass(){
  const v = val('passInput');
  if(!v){ toast('请输入口令'); return; }
  setAccessPass(v);
  try{
    const d = await apiFetch(API_BASE + '/login', { method:'POST', body:{ pass:v } });
    if(d && d.ok){
      closeMask('#maskPass'); _passAsked = false;
      toast('口令正确'); updateModeBadge();
    }else{ toast('口令不正确'); setAccessPass(''); }
  }catch(e){ toast('口令不正确或连接失败'); setAccessPass(''); }
}

/* ==========================================================================
   启动
   ========================================================================== */
function init(){
  // 下拉填充
  $('#stuGrade').innerHTML = GRADES.map(g => `<option>${g}</option>`).join('');
  $('#stuGrade').value = '高三';
  $('#stuSubject').innerHTML = SUBJECTS.map(s => `<option>${s}</option>`).join('');
  fillPresetSelect();

  // 日期默认今天
  const now = new Date();
  $('#examDate').value = now.getFullYear() + '年' + (now.getMonth()+1) + '月' + now.getDate() + '日';

  // 先把本机数据读进来（**同步**，界面立刻有内容，不等网络）
  students = loadJSON(K_STU, {});
  history  = loadJSON(K_HIST, {});
  const hadLocal = Object.keys(students).length > 0
    || Object.values(history).some(l => Array.isArray(l) && l.length);

  // 恢复上次粘贴的内容
  const saved = loadJSON(K_PAPER, null);
  if(saved && saved.text){ $('#paperPaste').value = saved.text; applyPaperMeta(saved.meta); }

  bind();
  bindMigrateDialog();
  renderStuChips();
  renderHist();
  updateModeBadge();
  updateScoreTotal();

  detectServer().then(async isServer => {
    updateModeBadge();
    if(isServer && API.serverCfg && API.serverCfg.visionModel){
      $('#btnPhoto').title = '视觉模型：' + API.serverCfg.visionModel;
    }
    // 阶段3：只有**本站部署**才有 /api/students（自建 server.js 没有）
    CLOUD_STORE.enabled = !!isServer && NEXT_HOST;
    if(!CLOUD_STORE.enabled) return;

    // 以账号里的数据为准（本机那份已经在上面画出来了，这里覆盖成云端真实数据）
    try{
      const n = await loadFromCloud();
      if(hadLocal && n.histN === 0 && n.stuN === 0){
        // 本机有数据、账号里还是空的 → 正是要问用户的时候
        maybeOfferMigration();
      }
    }catch(e){
      // 拉不到就继续用本机数据，但**明确告诉用户**（不静默）
      toast('读取账号数据失败，暂时显示本机数据：' + (e && e.message ? e.message : e), 4600);
    }
  }).catch(()=>{});
}

init();
})();
