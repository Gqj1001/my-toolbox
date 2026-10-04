// 试卷分析工作台接入 my-toolbox 的补丁
//
// 改动范围：app.js（运行模式判断 + 11 处接口地址 + 401 弹口令防护）
//           index.html（AI 设置弹窗：隐藏服务器配置、改标题、文案改「云端版」）
//
// 规则：每处替换必须精确命中一次，否则抛错并且不写任何文件。
// 改前会把原文件备份到 .backup/paper-analysis/ 。
import { readFileSync, writeFileSync, copyFileSync, mkdirSync, existsSync } from "node:fs";

const ROOT = "D:/my-website/my-toolbox/public/tools/paper-analysis";
const APP = `${ROOT}/js/app.js`;
const HTML = `${ROOT}/index.html`;
const BACKUP_DIR = "D:/my-website/my-toolbox/.backup/paper-analysis";

if (!existsSync(BACKUP_DIR)) mkdirSync(BACKUP_DIR, { recursive: true });

/** 对单个文件做一批精确替换（先备份原文，再写入） */
function patch(label, file, edits) {
  // 先读原文并备份——必须在写入之前，否则备份的就是改后的内容
  const original = readFileSync(file, "utf8");
  const backupPath = `${BACKUP_DIR}/${file.split("/").pop()}`;
  if (!existsSync(backupPath)) copyFileSync(file, backupPath); // 已存在则不覆盖（保留最初的原版）

  let text = original;
  const applied = [];
  for (const [name, from, to] of edits) {
    const first = text.indexOf(from);
    if (first === -1) throw new Error(`[${label}/${name}] 未找到匹配片段`);
    if (text.indexOf(from, first + 1) !== -1) throw new Error(`[${label}/${name}] 匹配到多处，拒绝修改`);
    text = text.slice(0, first) + to + text.slice(first + from.length);
    applied.push(name);
  }
  writeFileSync(file, text, "utf8");
  console.log(`\n[${label}] 已应用 ${applied.length} 处替换：`);
  for (const a of applied) console.log("  ✓ " + a);
}

/* ============================================================
   1. app.js
   ============================================================ */
patch("app.js", APP, [
  // ---------- 1.1 运行模式常量 ----------
  [
    "运行模式常量",
    `/* ==========================================================================
   服务器适配层（与本机模式自动切换）
   ========================================================================== */
const API = { mode:'local', isAdmin:false, serverCfg:{}, writeToken:'' };`,
    `/* ==========================================================================
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
  && /^\\/tools\\/paper-analysis(\\/|$)/.test(location.pathname);
const API_BASE = NEXT_HOST ? '/api/paper-analysis' : 'api';

const API = { mode:'local', isAdmin:false, serverCfg:{}, writeToken:'' };`,
  ],

  // ---------- 1.2 401 时不在云端模式下弹"访问口令"框 ----------
  [
    "401 口令弹窗防护",
    `  if(r.status === 401){ try{ const d = await r.clone().json(); if(d.needPass !== false) askAccessPass(); }catch(e){} }`,
    `  // 云端模式下没有"访问口令"这套机制（站点登录已是鉴权边界），不要弹口令框
  if(r.status === 401 && !NEXT_HOST){ try{ const d = await r.clone().json(); if(d.needPass !== false) askAccessPass(); }catch(e){} }`,
  ],

  // ---------- 1.3 detectServer 走新基址 ----------
  [
    "detectServer 基址",
    `  return apiFetch('api/mode').then(d=>{`,
    `  return apiFetch(API_BASE + '/mode').then(d=>{`,
  ],

  // ---------- 1.4 徽章文案改成「云端」 ----------
  [
    "徽章文案",
    `  if(API.mode === 'server'){
    b.textContent = API.isAdmin ? '🌐 联网·管理员' : '🌐 联网版';
    b.title = API.serverCfg.hasKey ? '服务器已配置 AI' : '服务器未配置 AI';
  }else{`,
    `  if(API.mode === 'server'){
    const cloud = NEXT_HOST;
    b.textContent = cloud
      ? (API.isAdmin ? '☁️ 云端·管理员' : '☁️ 云端版')
      : (API.isAdmin ? '🌐 联网·管理员' : '🌐 联网版');
    b.title = API.serverCfg.hasKey ? '服务器已配置 AI' : '服务器未配置 AI';
  }else{`,
  ],

  // ---------- 1.5 ~ 1.9 五处 api/* 调用改基址 ----------
  ["parse-file 接口", `await apiFetch('api/parse-file',`, `await apiFetch(API_BASE + '/parse-file',`],
  ["ai-advice 接口", `await apiFetch('api/ai-advice',`, `await apiFetch(API_BASE + '/ai-advice',`],
  ["vision-scores 接口", `await apiFetch('api/vision-scores',`, `await apiFetch(API_BASE + '/vision-scores',`],
  ["config 接口", `await apiFetch('api/config',`, `await apiFetch(API_BASE + '/config',`],
  ["health 接口", `await apiFetch('api/health');`, `await apiFetch(API_BASE + '/health');`],
  ["login 接口", `await apiFetch('api/login',`, `await apiFetch(API_BASE + '/login',`],

  // ---------- 1.20 云端模式下：AI 建议段由服务器代理，隐藏"保存到服务器" ----------
  [
    "设置弹窗适配云端",
    `function openServerModal(){
  const info = $('#serverModeInfo');
  const isServer = API.mode === 'server';`,
    `function openServerModal(){
  const info = $('#serverModeInfo');
  const isServer = API.mode === 'server';
  // 云端模式下服务器配置来自环境变量，不由网页保存 —— 隐藏那段表单
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
    return;
  }`,
  ],
]);

/* ============================================================
   2. index.html —— AI 设置弹窗
   ============================================================ */
patch("index.html", HTML, [
  // 2.1 按钮标题
  [
    "按钮标题改为 AI 设置",
    `<button class="btn btn-gh btn-sm" id="btnServer">🔗 服务器与AI设置</button>`,
    `<button class="btn btn-gh btn-sm" id="btnServer">⚙️ AI 设置</button>`,
  ],

  // 2.2 弹窗内容：云端模式说明 + 仅保留本机 Key（BYOK）
  [
    "弹窗内容改为 BYOK",
    `<div class="mbody">
      <div id="serverModeInfo" class="info"></div>
      <div class="f"><label>🔑 管理员口令（保存公共配置时需要）</label>
        <input type="password" id="writeTokenInput" placeholder="服务器上的 ADMIN_TOKEN" autocomplete="off"></div>
      <hr>
      <div class="f"><label>🤖 服务器端 API Key（配置后所有用户都能用 AI）</label>
        <input type="password" id="serverKeyInput" placeholder="sk-xxx" autocomplete="off"></div>
      <div class="f2">
        <div class="f"><label>API 地址</label><input type="text" id="serverBaseInput" placeholder="https://api.deepseek.com/v1"></div>
        <div class="f"><label>模型名称</label><input type="text" id="serverModelInput" placeholder="deepseek-chat"></div>
      </div>
      <div class="f2">
        <div class="f"><label>视觉模型（用于拍照识别答题卡）</label>
          <input type="text" id="visionModelInput" placeholder="如 glm-4v-flash / gpt-4o"></div>
        <div class="f"><label> </label><span class="tip">留空则关闭拍照识别功能</span></div>
      </div>
      <div class="btn-row">
        <button class="btn btn-pri btn-sm" id="btnSaveServer">保存到服务器</button>
        <button class="btn btn-gh btn-sm" id="btnTestServer">测试连接</button>
      </div>
      <p class="tip">Key 只保存在服务器上，网页源码里搜不到，学生拿不走。</p>
    </div>`,
    `<div class="mbody">
      <!-- 云端模式下这块说明由 app.js 动态填充 -->
      <div id="serverModeInfo" class="info"></div>

      <!-- 云端模式下服务器配置来自环境变量，这段表单由 app.js 隐藏；
           保留在 DOM 里是为了让本机版 / 自建 server.js 部署照常可用 -->
      <div class="f"><label>🔑 管理员口令（保存公共配置时需要）</label>
        <input type="password" id="writeTokenInput" placeholder="服务器上的 ADMIN_TOKEN" autocomplete="off"></div>
      <hr>
      <div class="f"><label>🤖 服务器端 API Key（配置后所有用户都能用 AI）</label>
        <input type="password" id="serverKeyInput" placeholder="sk-xxx" autocomplete="off"></div>
      <div class="f2">
        <div class="f"><label>API 地址</label><input type="text" id="serverBaseInput" placeholder="https://api.deepseek.com/v1"></div>
        <div class="f"><label>模型名称</label><input type="text" id="serverModelInput" placeholder="deepseek-chat"></div>
      </div>
      <div class="f2">
        <div class="f"><label>视觉模型（用于拍照识别答题卡）</label>
          <input type="text" id="visionModelInput" placeholder="如 glm-4v-flash / gpt-4o"></div>
        <div class="f"><label> </label><span class="tip">留空则关闭拍照识别功能</span></div>
      </div>
      <div class="btn-row">
        <button class="btn btn-pri btn-sm" id="btnSaveServer">保存到服务器</button>
        <button class="btn btn-gh btn-sm" id="btnTestServer">测试连接</button>
      </div>
      <p class="tip">Key 只保存在服务器上，网页源码里搜不到，学生拿不走。</p>
    </div>`,
  ],
]);

console.log(`\n原文件已备份到: ${BACKUP_DIR}`);
console.log(`app.js 行数: ${readFileSync(APP, "utf8").split("\n").length}`);
console.log(`index.html 行数: ${readFileSync(HTML, "utf8").split("\n").length}`);
