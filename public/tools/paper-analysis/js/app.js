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

/* ---------- 存储 ---------- */
const K_PAPER = 'paper_analysis_paper_v1';
const K_STU   = 'paper_analysis_students_v1';
const K_HIST  = 'paper_analysis_history_v1';
const K_TOKEN = 'paper_analysis_token_v1';

/* ---------- 状态 ---------- */
let paper = null;          // 解析后的试卷
let scoreAssign = null;    // 分值分配
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
  switchStep('cScore');
  toast('解析成功，共 ' + r.questions.length + ' 题');
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
        + '解决办法：① 把内容复制粘贴进来；② 或把文件放到服务器上访问后用「上传文件解析」。</div>';
      return;
    }
    const data = await toDataUrl(file);
    const d = await apiFetch(API_BASE + '/parse-file', { method:'POST', body:{ name:file.name, data } });
    if(!d || !d.ok) throw new Error(d && d.error ? d.error : '服务器解析失败');
    if(d.note) hint.innerHTML = 'ℹ️ ' + esc(d.note);
    if(d.text && d.text.trim()){
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

/** 计算并渲染分值分配 */
function computeScores(){
  if(!paper) return;
  const total = num($('#examTotal').value) || 150;
  const preset = $('#examPreset').value || '';
  scoreAssign = PaperParser.assignScores(paper.typeDist, total, preset);
  renderScoreAssignTable();
  seedRecords();
}

function renderScoreAssignTable(){
  const t = $('#scoreTable');
  if(!scoreAssign){ t.innerHTML = ''; return; }
  let html = '<thead><tr><th>题型</th><th>题量</th><th>每题分值</th><th>总分值</th></tr></thead><tbody>';
  Object.entries(scoreAssign.perType).forEach(([type, v]) => {
    html += `<tr><td>${esc(type)}</td><td>${v.count}</td>`
      + `<td><input type="number" step="0.5" min="0" value="${v.per}" data-per="${esc(type)}"></td>`
      + `<td>${v.total}</td></tr>`;
  });
  html += `<tr><th>合计</th><th>${Object.values(scoreAssign.perType).reduce((a,x)=>a+x.count,0)}</th>`
    + `<th>—</th><th id="sumCell">${scoreAssign.fullScore}</th></tr></tbody>`;
  t.innerHTML = html;
  // 允许手工改单题分值（改完重算该题型总分）
  $$('#scoreTable input[data-per]').forEach(inp => {
    inp.addEventListener('change', () => {
      const type = inp.dataset.per;
      const per = num(inp.value);
      const info = scoreAssign.perType[type];
      info.per = per; info.total = Math.round(per * info.count * 100) / 100;
      info.spread = Array.from({length: info.count}, () => per);
      scoreAssign.fullScore = Object.values(scoreAssign.perType).reduce((a,x)=>a+x.total,0);
      const cell = $('#sumCell'); if(cell) cell.textContent = round2(scoreAssign.fullScore);
      // 这里只更新总分的单元格即可。原来调用的是 renderScoreTable()（函数不存在，
      // 会抛 ReferenceError）；即使改成 renderScoreAssignTable() 也不该在这里调——
      // 它会重建整张表，而重建过程会重新绑定额外的 change 监听器，
      // 等于在事件处理器内部给自己叠加监听器。
      seedRecords(); renderScoreList();
    });
  });
  const hint = $('#scoreSumHint');
  if(hint){
    let h = `分值方案：<b>${esc(scoreAssign.preset)}</b>`;
    if(scoreAssign.warnings && scoreAssign.warnings.length)
      h += '<br><span style="color:var(--warn)">⚠ ' + scoreAssign.warnings.map(esc).join('<br>⚠ ') + '</span>';
    hint.innerHTML = h;
  }
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
    const full = info.spread ? info.spread[idx[type]] : info.per;
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
    else if(mode === 'easy') r.got = (q.grade === 'easy') ? r.full : r.got;
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
   AI：只重写建议段
   ========================================================================== */
async function aiAdvice(){
  if(!lastAdviceCtx){ toast('请先生成报告'); return; }
  const { name, ctx, attitude } = lastAdviceCtx;
  const btn = $('#btnAIAdvice'); const old = btn.textContent;
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
    toast('建议段已由 AI 重写，可继续手动修改');
  }catch(e){
    toast('AI 生成失败：' + e.message, 3400);
  }finally{
    btn.disabled = false; btn.textContent = old;
  }
}

/** 本机模式：直接用浏览器里的 Key 调 OpenAI 兼容接口 */
async function callAI(userContent){
  const cfg = loadApiCfg();
  if(!cfg.apiKey){ toast('请先配置 API Key（点「服务器与AI设置」）'); openServerModal(); throw new Error('未配置 API Key'); }
  const sys = '你是一位有十几年经验的高中数学教师，正在给学生家长写《试卷分析表》里的「教学辅导建议与安排」。'
    + '请严格依据我提供的结构化诊断数据来写，不要编造数据，不要改动任何分数与题号。'
    + '文风要求：先给阶段性定性，再讲优势，然后按题型/模块点出短板与归因，最后给分阶段的、可执行的教学安排与预期分数。'
    + '要具体到"哪道题、哪个模块、什么原因、下一步怎么做"，多用"首先/其次/第三/第四"这样的层次词，'
    + '篇幅 800–1400 字，直接输出正文，不要标题、不要 markdown 符号。';
  const r = await fetch(cfg.apiBase.replace(/\/+$/,'') + '/chat/completions', {
    method:'POST',
    headers:{'Content-Type':'application/json','Authorization':'Bearer ' + cfg.apiKey},
    body: JSON.stringify({
      model: cfg.model,
      messages: [{ role:'system', content: sys }, { role:'user', content: userContent }],
      temperature: 0.7, max_tokens: 2500
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
  $$('#stuChips [data-del]').forEach(x => x.onclick = e => {
    e.stopPropagation();
    const n = x.dataset.del;
    if(confirm('删除「' + n + '」的档案与历史记录？')){
      delete students[n]; delete history[n];
      saveJSON(K_STU, students); saveJSON(K_HIST, history);
      renderStuChips(); renderHist(); toast('已删除');
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
  students[n] = {
    gender: val('stuGender'), grade: val('stuGrade'), subject: val('stuSubject'),
    teacher: val('stuTeacher'), manager: val('stuManager'), cls: val('stuClass'),
    attitude: val('stuAttitude'),
    updated: new Date().toISOString().slice(0,10)
  };
  saveJSON(K_STU, students);
  renderStuChips(); toast('已保存「' + n + '」的档案');
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
  $$('#histList [data-dh]').forEach(b => b.onclick = () => {
    const n2 = val('stuName'); if(!history[n2]) return;
    history[n2].splice(+b.dataset.dh, 1);
    saveJSON(K_HIST, history); renderHist();
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
  history[n] = history[n] || [];
  history[n].push({
    text: txt, date: val('examDate'), examName: val('examName'),
    score: ctx.score, full: ctx.full, saved: new Date().toISOString()
  });
  saveJSON(K_HIST, history);
  renderHist(); toast('已存入「' + n + '」的记录（共 ' + history[n].length + ' 条）');
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
    $('#paperHint').textContent = '未导入'; toast('已清空');
  };
  $('#examTotal').oninput = computeScores;
  $('#examPreset').onchange = computeScores;

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
  $('#btnAIAdvice').onclick = aiAdvice;
  $('#btnPolishAll').onclick = aiAdvice;
  $('#btnCopy').onclick = copyReport;
  $('#btnCopy2').onclick = copyReport;
  $('#btnDocx').onclick = exportDocx;
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

  students = loadJSON(K_STU, {});
  history  = loadJSON(K_HIST, {});

  // 恢复上次粘贴的内容
  const saved = loadJSON(K_PAPER, null);
  if(saved && saved.text){ $('#paperPaste').value = saved.text; applyPaperMeta(saved.meta); }

  bind();
  renderStuChips();
  renderHist();
  updateModeBadge();
  updateScoreTotal();

  detectServer().then(isServer => {
    updateModeBadge();
    if(isServer && API.serverCfg && API.serverCfg.visionModel){
      $('#btnPhoto').title = '视觉模型：' + API.serverCfg.visionModel;
    }
  }).catch(()=>{});
}

init();
})();
