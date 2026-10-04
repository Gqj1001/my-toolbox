// 第 7 步 · 工具页改造补丁：学段 → 科目 → 教材/章节
// 规则：每处替换必须精确命中一次，否则抛错并且不写文件。
import { readFileSync, writeFileSync, copyFileSync } from "node:fs";

const FILE = "D:/my-website/my-toolbox/public/tools/feedback.html";
const BACKUP = "D:/my-website/my-toolbox/.backup/feedback.html.pre-step7";

let html = readFileSync(FILE, "utf8");
const applied = [];

function replaceOnce(label, from, to) {
  const first = html.indexOf(from);
  if (first === -1) throw new Error(`[${label}] 未找到匹配片段`);
  if (html.indexOf(from, first + 1) !== -1) throw new Error(`[${label}] 匹配到多处，拒绝修改`);
  html = html.slice(0, first) + to + html.slice(first + from.length);
  applied.push(label);
}

// ---------- 1. HTML：科目下方加「学段」与「教材/章节」 ----------
replaceOnce(
  "HTML-学段选择器",
  `        <div class="f"><label>科目</label><select id="subjectSelect"></select></div>
        <div class="f2">`,
  `        <div class="f"><label>学段</label><select id="stageSelect">
          <option value="senior">高中</option><option value="junior">初中</option>
        </select></div>
        <div class="f"><label>科目</label><select id="subjectSelect"></select></div>
        <div class="f" id="textbookField" style="display:none">
          <label id="textbookLabel">教材</label><select id="textbookSelect"></select>
        </div>
        <div class="f2">`,
);

// ---------- 2. SUBJECTS 改为带学段的九大科目 ----------
replaceOnce(
  "JS-科目常量",
  `const SUBJECTS = [
  ['math','数学'],['english','英语'],['chinese','语文'],['physics','物理'],
  ['history','历史'],['politics','政治'],['chemistry','化学'],['general','通用']
];
const SUBJECT_NAME = {math:'数学',english:'英语',chinese:'语文',physics:'物理',
  history:'历史',politics:'政治',chemistry:'化学',general:''};`,
  [
    "const STAGES = [{code:'senior',name:'高中'},{code:'junior',name:'初中'}];",
    "",
    "/* 九大科目 × 两个学段；general 为无教材科目的兜底 */",
    "const SUBJECTS = [",
    "  {code:'chinese',   name:'语文', stages:['senior','junior'], textbook:true},",
    "  {code:'math',      name:'数学', stages:['senior','junior'], textbook:true},",
    "  {code:'english',   name:'英语', stages:['senior','junior'], textbook:true},",
    "  {code:'physics',   name:'物理', stages:['senior','junior'], textbook:true},",
    "  {code:'chemistry', name:'化学', stages:['senior','junior'], textbook:true},",
    "  {code:'biology',   name:'生物', stages:['senior','junior'], textbook:true},",
    "  {code:'politics',  name:'政治', stages:['senior'],          textbook:true},",
    "  {code:'history',   name:'历史', stages:['senior','junior'], textbook:true},",
    "  {code:'geography', name:'地理', stages:['senior','junior'], textbook:true},",
    "  {code:'general',   name:'通用', stages:['senior','junior'], textbook:false}",
    "];",
    "const SUBJECT_NAME = {};",
    "SUBJECTS.forEach(s=>{ SUBJECT_NAME[s.code] = s.code==='general' ? '' : s.name; });",
    "function subjectsForStage(stage){",
    "  return SUBJECTS.filter(s=>s.code!=='general' && s.stages.indexOf(stage)>=0);",
    "}",
    "",
    "/* 云端模式下的维度状态（学段/教材/章节 记在 localStorage，科目也记住） */",
    "let cloudData = null;",
    "const CLOUD_STAGE_KEY = 'fb_stage_v1';",
    "const CLOUD_TB_KEY = 'fb_textbook_v1';",
    "const CLOUD_CH_KEY = 'fb_chapter_v1';",
    "const CLOUD_SUBJ_KEY = 'fb_subject_v1';",
    "function getStage(){ const el = document.getElementById('stageSelect'); return el ? el.value : 'senior'; }",
    "function isCloudSubject(subj){",
    "  if(cloudData) return !!cloudData.hasTextbook;",
    "  const d = SUBJECTS.find(s=>s.code===subj);",
    "  return !!(d && d.textbook);",
    "}",
  ].join("\n"),
);

// ---------- 3. fillSelects：先填学段，再按学段填科目 ----------
replaceOnce(
  "JS-fillSelects",
  "function fillSelects(){\n  $('#subjectSelect').innerHTML = SUBJECTS.map(([k,v])=>`<option value=\"${k}\">${v}</option>`).join('');",
  "function fillSelects(){\n  $('#stageSelect').innerHTML = STAGES.map(s=>`<option value=\"${s.code}\">${s.name}</option>`).join('');\n  fillSubjectSelect();",
);

// ---------- 4. 联动与云端载入函数 ----------
replaceOnce(
  "JS-联动函数",
  "function refreshGreetingOptions(){",
  [
    "/* 按当前学段填充科目下拉 */",
    "function fillSubjectSelect(){",
    "  const stage = getStage();",
    "  const list = subjectsForStage(stage);",
    "  const cur = $('#subjectSelect').value;",
    "  $('#subjectSelect').innerHTML = list.map(s=>`<option value=\"${s.code}\">${s.name}</option>`).join('');",
    "  if(list.some(s=>s.code===cur)) $('#subjectSelect').value = cur;",
    "}",
    "",
    "function rememberSubject(){",
    "  try{ localStorage.setItem(CLOUD_SUBJ_KEY, getSubject()); }catch(e){}",
    "}",
    "",
    "/* 清空关键词勾选（切学段/科目/教材时调用，避免把上一个科目的选择带过去） */",
    "function clearSelectedKeywords(){",
    "  $$('#generateCategories input[type=\"checkbox\"]').forEach(cb=>{ cb.checked = false; });",
    "  updateCounts();",
    "}",
    "",
    "/* 渲染「教材」下拉（仅云端模式 + 该科目有教材 + 服务器返回了教材时显示） */",
    "function renderTextbookSelect(){",
    "  const wrap = document.getElementById('textbookField');",
    "  const sel = document.getElementById('textbookSelect');",
    "  const label = document.getElementById('textbookLabel');",
    "  if(!wrap || !sel) return;",
    "  const subj = getSubject();",
    "  const c = cloudData;",
    "  const tbs = (c && c.subject===subj && c.textbooks) ? c.textbooks : [];",
    "  if(!NEXT_MODE || !isCloudSubject(subj) || !tbs.length){ wrap.style.display = 'none'; return; }",
    "  wrap.style.display = '';",
    "  const saved = localStorage.getItem(CLOUD_TB_KEY) || '';",
    "  sel.innerHTML = '<option value=\"\">（不指定教材 · 用通用内容词）</option>'",
    "    + tbs.map(t=>`<option value=\"${t.id}\">${esc(t.name)}</option>`).join('');",
    "  if(saved && tbs.some(t=>String(t.id)===String(saved))) sel.value = saved;",
    "  else sel.value = '';",
    "  const chapters = (c && c.chapters) ? c.chapters : [];",
    "  const chId = localStorage.getItem(CLOUD_CH_KEY) || '';",
    "  if(label) label.textContent = (chId && chapters.length) ? '教材 / 章节' : '教材';",
    "}",
    "",
    "/* 把服务端返回的分类关键词灌进 allData，供现有渲染逻辑使用 */",
    "function applyCloudKeywordStore(){",
    "  if(!cloudData || !cloudData.categoryKeywords) return;",
    "  const s = cloudData.subject;",
    "  if(!s) return;",
    "  const base = JSON.parse(JSON.stringify(DEFAULT_DATA[s] || DEFAULT_DATA.general));",
    "  allData[s] = { categories: base.categories.map(c=>({",
    "    name: c.name,",
    "    keywords: (cloudData.categoryKeywords[c.name] || []).slice()",
    "  })) };",
    "}",
    "",
    "/* 按当前学段/科目/教材/章节拉取云端关键词 */",
    "function loadCloudScoped(){",
    "  if(!NEXT_MODE) return Promise.resolve();",
    "  const stage = getStage();",
    "  const subject = getSubject();",
    "  const tb = localStorage.getItem(CLOUD_TB_KEY) || '';",
    "  const ch = localStorage.getItem(CLOUD_CH_KEY) || '';",
    "  const qs = new URLSearchParams({stage: stage, subject: subject});",
    "  if(tb) qs.set('textbook', tb);",
    "  if(ch) qs.set('chapter', ch);",
    "  const sh = document.getElementById('syncHint');",
    "  if(sh) sh.textContent = '⏳ 正在载入该学段/科目的关键词…';",
    "  return fetch('/api/feedback/data?' + qs.toString(), {credentials:'same-origin', cache:'no-store'})",
    "    .then(r=> r.ok ? r.json() : null)",
    "    .then(d=>{",
    "      if(!d || !d.ok){ if(sh) sh.textContent = '⚠️ 关键词载入失败，请刷新重试'; return; }",
    "      cloudData = d;",
    "      applyCloudKeywordStore();",
    "      renderTextbookSelect();",
    "      renderGenerate();",
    "      const total = Object.keys(d.categoryKeywords||{}).reduce((n,k)=>n+(d.categoryKeywords[k]||[]).length,0);",
    "      const stageName = (STAGES.find(x=>x.code===d.stage)||{}).name || '';",
    "      const extra = (ch && (d.chapters||[]).length) ? '（已限定章节）' : (tb ? '（已限定教材）' : '');",
    "      if(sh) sh.textContent = '✓ 已载入云端数据：' + (stageName ? stageName + ' · ' : '')",
    "        + (SUBJECT_NAME[subject] || subject) + extra + '，共 ' + total + ' 个关键词';",
    "    })",
    "    .catch(()=>{ if(sh) sh.textContent = '⚠️ 关键词载入失败（网络错误）'; });",
    "}",
    "",
    "/* 学段变化：重置下游选择并重新载入 */",
    "function onScopeChanged(){",
    "  fillSubjectSelect();",
    "  $('#subjectSelect').value = (subjectsForStage(getStage())[0]||{}).code || 'math';",
    "  try{ localStorage.setItem(CLOUD_STAGE_KEY, getStage()); }catch(e){}",
    "  try{ localStorage.removeItem(CLOUD_TB_KEY); localStorage.removeItem(CLOUD_CH_KEY); }catch(e){}",
    "  cloudData = null;",
    "  clearSelectedKeywords();",
    "  rememberSubject();",
    "  renderTextbookSelect();",
    "  renderGenerate();",
    "  if(NEXT_MODE) loadCloudScoped();",
    "}",
    "",
    "function refreshGreetingOptions(){",
  ].join("\n"),
);

// ---------- 5. bind() 增加学段/教材联动 ----------
replaceOnce(
  "JS-bind联动",
  "  $('#subjectSelect').onchange = ()=>{ refreshGreetingOptions(); renderGenerate(); renderManage(); };",
  [
    "  $('#stageSelect').onchange = ()=>{ onScopeChanged(); refreshGreetingOptions(); renderManage(); };",
    "  $('#subjectSelect').onchange = ()=>{",
    "    rememberSubject();",
    "    try{ localStorage.removeItem(CLOUD_TB_KEY); localStorage.removeItem(CLOUD_CH_KEY); }catch(e){}",
    "    cloudData = null;",
    "    clearSelectedKeywords();",
    "    if(NEXT_MODE) loadCloudScoped(); else renderGenerate();",
    "    refreshGreetingOptions(); renderManage();",
    "  };",
    "  $('#textbookSelect').onchange = ()=>{",
    "    const v = $('#textbookSelect').value;",
    "    try{",
    "      if(v) localStorage.setItem(CLOUD_TB_KEY, v); else localStorage.removeItem(CLOUD_TB_KEY);",
    "      localStorage.removeItem(CLOUD_CH_KEY);",
    "    }catch(e){}",
    "    clearSelectedKeywords();",
    "    loadCloudScoped();",
    "  };",
  ].join("\n"),
);

// ---------- 6. init 中恢复学段并应用云端关键词 ----------
replaceOnce(
  "JS-init恢复",
  "  renderStuList();\n  renderGenerate();\n  renderManage();\n  renderPhrases();\n  renderHist();",
  "  renderStuList();\n  applyCloudKeywordStore();\n  renderGenerate();\n  renderManage();\n  renderPhrases();\n  renderHist();",
);

// ---------- 7. bootFromApi 后按维度拉取关键词 ----------
replaceOnce(
  "JS-boot联动",
  [
    "      return bootFromApi().then(okp=>{",
    "        if(okp){",
    "          renderGenerate(); renderManage(); renderPhrases(); renderStuList(); renderHist();",
    "          if(sh) sh.textContent = '✓ 已载入云端数据';",
    "        }else if(sh){",
    "          sh.textContent = '⚠️ 云端数据载入失败，请刷新重试';",
    "        }",
    "      });",
  ].join("\n"),
  [
    "      return bootFromApi().then(okp=>{",
    "        if(okp){",
    "          renderStuList(); renderHist(); renderPhrases();",
    "          // 关键词按「学段 × 科目 × 教材/章节」维度单独拉取",
    "          try{",
    "            const st = localStorage.getItem(CLOUD_STAGE_KEY);",
    "            if(st) $('#stageSelect').value = st;",
    "            fillSubjectSelect();",
    "            const sb = localStorage.getItem(CLOUD_SUBJ_KEY);",
    "            if(sb && subjectsForStage(getStage()).some(x=>x.code===sb)) $('#subjectSelect').value = sb;",
    "          }catch(e){}",
    "          return loadCloudScoped().then(()=>{ renderManage(); });",
    "        }",
    "        if(sh) sh.textContent = '⚠️ 云端数据载入失败，请刷新重试';",
    "      });",
  ].join("\n"),
);

// ---------- 写回 ----------
copyFileSync(FILE, BACKUP);
writeFileSync(FILE, html, "utf8");

console.log(`已应用 ${applied.length} 处替换：`);
for (const a of applied) console.log("  ✓ " + a);
console.log(`\n原文件备份: ${BACKUP}`);
console.log(`新文件行数: ${html.split("\n").length}`);
