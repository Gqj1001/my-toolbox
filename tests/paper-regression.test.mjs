// 回归验证：feedback 页面（受 resolveIframeSrc 改动影响）+ dashboard 新卡片
import { readFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const BASE = "http://127.0.0.1:3000";
const CDP_PORT = "9430";
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const USER_DATA = "D:/my-website/.edge-profile-regress";
const PROJECT = "D:/my-website/my-toolbox";
const info = JSON.parse(readFileSync(`${PROJECT}/.test-users.json`, "utf8"));
const adminEmail = info.users.find((u) => u.email.startsWith("rolea-")).email;
const PASSWORD = info.password;

const results = [];
const rec = (n, p, d) => { results.push({ n, p }); console.log(`${p ? "PASS" : "FAIL"} | ${n}${d ? ` | ${d}` : ""}`); };

/** 查线上 tools 表某一行的 active —— 用来让断言跟随真实状态，而不是写死快照 */
async function toolIsActive(route) {
  const envText = readFileSync(`${PROJECT}/.env.local`, "utf8").split(/\r?\n/);
  const url = envText.find((l) => l.startsWith("NEXT_PUBLIC_SUPABASE_URL=")).split("=")[1].trim();
  const key = envText.find((l) => l.startsWith("NEXT_PUBLIC_SUPABASE_ANON_KEY=")).split("=").slice(1).join("=").trim();
  const r = await fetch(`${url}/rest/v1/tools?select=active&route=eq.${encodeURIComponent(route)}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  const rows = await r.json();
  return Array.isArray(rows) && rows.length ? rows[0].active === true : null;
}

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.events = [];
    ws.addEventListener("message", (e) => { const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) { const { resolve, reject } = this.pending.get(m.id); this.pending.delete(m.id);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result); } else if (m.method) this.events.push(m); }); }
  send(method, params = {}, sessionId) { const id = ++this.id;
    return new Promise((res, rej) => { this.pending.set(id, { resolve: res, reject: rej });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      setTimeout(() => this.pending.has(id) && (this.pending.delete(id), rej(new Error("timeout"))), 60000); }); }
  waitForEvent(method, t = 20000) { const hit = () => this.events.find((e) => e.method === method);
    if (hit()) return Promise.resolve(hit().params);
    return new Promise((res, rej) => { const t0 = Date.now();
      const tick = () => { if (hit()) return res(hit().params); if (Date.now() - t0 > t) return rej(new Error("timeout")); setTimeout(tick, 100); }; tick(); }); }
  clear() { this.events = []; }
}
async function connect() {
  const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
  const ws = new WebSocket((await r.json()).webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); });
  return new CDP(ws);
}

const pid = spawnSync("powershell", ["-NoProfile", "-Command", "(Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue).OwningProcess"], { encoding: "utf8" }).stdout.trim();
if (pid) spawnSync("powershell", ["-NoProfile", "-Command", `Stop-Process -Id ${pid} -Force`], { encoding: "utf8" });
await sleep(2000);
const srv = spawn("C:\\Users\\郭庆杰\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\node\\bin\\node.exe",
  [`${PROJECT}/node_modules/next/dist/bin/next`, "start", "-p", "3000"], { cwd: PROJECT, stdio: "ignore" });
for (let i = 0; i < 60; i++) { await sleep(500); try { if ((await fetch(`${BASE}/login`)).status === 200) break; } catch {} }

const edge = spawn(EDGE, ["--headless=new", `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${USER_DATA}`, "--no-first-run", "--no-default-browser-check", "about:blank"], { stdio: "ignore" });
let cdp;
for (let i = 0; i < 40; i++) { await sleep(500); try { cdp = await connect(); break; } catch {} }
const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
await cdp.send("Page.enable", {}, sessionId);
await cdp.send("Runtime.enable", {}, sessionId);

const ev = async (expr) => {
  const r = await cdp.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }, sessionId);
  if (r.exceptionDetails) return { __err: r.exceptionDetails.exception?.description };
  return r.result.value;
};
const goto = async (p, w = 6000) => { cdp.clear(); await cdp.send("Page.navigate", { url: BASE + p }, sessionId);
  await cdp.waitForEvent("Page.loadEventFired").catch(() => {}); await sleep(w); };

// 登录
await cdp.send("Network.clearBrowserCookies", {}, sessionId);
await goto("/login", 2000);
for (let i = 0; i < 40; i++) { if (await ev(`!!document.querySelector('form input[name="email"]')`)) break; await sleep(250); }
await ev(`(() => { const f=document.querySelector("form"); const d=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value");
  const em=f.querySelector('input[name="email"]'), pw=f.querySelector('input[name="password"]');
  d.set.call(em, ${JSON.stringify(adminEmail)}); em.dispatchEvent(new Event("input",{bubbles:true}));
  d.set.call(pw, ${JSON.stringify(PASSWORD)}); pw.dispatchEvent(new Event("input",{bubbles:true})); return true; })()`);
await sleep(400);
await ev(`document.querySelector("form").requestSubmit(), true`);
for (let i = 0; i < 60; i++) { await sleep(500); if ((await ev("location.pathname")) !== "/login") break; }
await sleep(1500);

// ---------- dashboard 卡片 ----------
console.log("\n=== dashboard 新卡片 ===");
await goto("/dashboard", 6000);
{
  const t = await ev(`document.body.innerText`);
  rec("dashboard 出现「试卷分析工作台」", /试卷分析工作台/.test(String(t)), "");
  const cards = await ev(`[...document.querySelectorAll('a')].filter(a=>a.href.includes('/tools/')).map(a=>({href:a.getAttribute('href'), text:a.innerText.replace(/\\s+/g,' ').slice(0,40)}))`);
  const paper = (cards ?? []).find((c) => String(c.href).includes("paper-analysis"));
  rec("卡片链接指向 /tools/paper-analysis", !!paper, JSON.stringify(paper ?? {}));
  // 排序：应在数学方案之后、JSON 之前
  const order = (cards ?? []).map((c) => c.text);
  const iPaper = order.findIndex((x) => /试卷分析/.test(x));
  const iJson = order.findIndex((x) => /JSON/.test(x));
  rec("卡片按 sort_order 排序（试卷分析在 JSON 之前）", iPaper >= 0 && iJson >= 0 && iPaper < iJson, `paper@${iPaper} json@${iJson}`);
  console.log(`     卡片: ${order.slice(0, 6).join(" | ")}`);
}

// ---------- feedback 页面回归 ----------
console.log("\n=== feedback 页面回归（受 resolveIframeSrc 改动影响）===");
await goto("/tools/feedback", 10000);
{
  const url = await ev("location.pathname");
  rec("feedback 页可访问", String(url) === "/tools/feedback", String(url));
  const s = await ev(`(() => { const f=document.querySelector('iframe'); if(!f) return {__err:'无 iframe'};
    const doc=f.contentDocument; if(!doc) return {__err:'无 doc'};
    return { src: f.getAttribute('src'), badge: doc.getElementById('modeBadge')?.textContent ?? '',
      hint: doc.getElementById('syncHint')?.textContent ?? '',
      hasStage: !!doc.getElementById('stageSelect'), hasSubject: !!doc.getElementById('subjectSelect') }; })()`);
  rec("iframe 加载成功", !s.__err, s.__err ?? "");
  rec("iframe src 正确", String(s.src).includes("/tools/feedback.html"), String(s.src));
  rec("feedback 工具元素就位", s.hasStage === true && s.hasSubject === true, "");
  rec("feedback 云端模式正常", /云端|联网/.test(String(s.badge)), String(s.badge));
  rec("feedback 已载入云端数据", /已载入云端数据/.test(String(s.hint)), String(s.hint).slice(0, 60));
}

// ---------- 其他工具页 ----------
console.log("\n=== 其他工具页回归 ===");
// math-plan 现在是 free（所有登录用户可开），所以路径应该留在 /tools/math-plan。
//
// json-formatter 的期望**从线上 tools 表实时读**，不写死快照：
//   · active=false（0012 执行后）→ getToolByRoute 返回 null → notFound()
//   · active=true （0012 执行前）→ 正常渲染占位页
// 为什么要这样：迁移 SQL 由用户手动执行，如果这里写死「应为 404」，那在用户执行 SQL
// **之前**套件就是红的（反过来写死「应为占位页」，执行之后就红）。两种都会让回归失去意义。
// 实测（Next 16.3.8）notFound() 的表现：**URL 不变**，页面换成内置 404，
// document.title 形如 "404: This page could not be found." —— 所以判据用 title，不能用 pathname。
const jsonFormatterActive = await toolIsActive("/tools/json-formatter");
if (jsonFormatterActive === null) {
  rec("读到了 /tools/json-formatter 的 active 状态", false, "线上查不到这条 route，无法判定期望");
}
for (const [label, path, expect404] of [
  ["math-plan（免费工具）", "/tools/math-plan", false],
  [
    `json-formatter（线上 active=${jsonFormatterActive}）`,
    "/tools/json-formatter",
    jsonFormatterActive === false,
  ],
]) {
  await goto(path, 6000);
  const r = await ev(`(() => ({ path: location.pathname, title: document.title }))()`);
  const looks404 = /^\s*404/.test(String(r.title));
  rec(
    `${label} 访问行为正确${expect404 ? "（应为 404 页）" : ""}`,
    expect404 ? looks404 : !looks404 && String(r.path) === path,
    `pathname=${JSON.stringify(r.path)} title=${JSON.stringify(r.title)}`,
  );
}

console.log("\n=== 静态资源检查（resolveIframeSrc 两种布局）===");
// 未登录时这些路径会被 proxy 拦住（307），属于设计；带 cookie 才验证"资源存在"
{
  const anon = await fetch(BASE + "/tools/feedback.html", { redirect: "manual" });
  rec("未登录访问工具静态资源被拦（307）", anon.status === 307, `HTTP ${anon.status}`);

  // 从浏览器取当前登录 cookie
  const cookies = (await cdp.send("Network.getCookies", { urls: [BASE] }, sessionId)).cookies
    .map((c) => `${c.name}=${c.value}`).join("; ");
  for (const [label, path, expect] of [
    ["单文件 feedback.html", "/tools/feedback.html", "课后反馈"],
    ["单文件 math-plan.html", "/tools/math-plan.html", "html"],
    ["目录 paper-analysis/index.html", "/tools/paper-analysis/index.html", "试卷分析"],
    ["目录 css/app.css", "/tools/paper-analysis/css/app.css", ".mask"],
    ["目录 js/app.js", "/tools/paper-analysis/js/app.js", "NEXT_HOST"],
  ]) {
    const r = await fetch(BASE + path, { headers: { cookie: cookies } });
    const body = await r.text();
    rec(`${label} 已登录可访问且内容正确`, r.status === 200 && body.includes(expect), `HTTP ${r.status} 含"${expect}"=${body.includes(expect)}`);
  }
}

try { await cdp.send("Browser.close"); } catch { edge.kill(); }
srv.kill();
const passed = results.filter((r) => r.p).length;
console.log(`\n=== SUMMARY: ${passed}/${results.length} passed ===`);
process.exit(passed === results.length ? 0 : 1);
