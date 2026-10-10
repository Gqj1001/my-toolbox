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

// ---------- 工具列表（= 个人中心）的卡片 ----------
// ⚠️ 2026-10 起这里从 `/dashboard` 改成 `/tools`：
//    工具列表才是主落地页（`/` 与登录后都直接去它），百宝箱要改成「学员档案」页。
//    卡片内容与排序的断言**一条都没放松**，只是换了页面。
console.log("\n=== 工具列表（个人中心）的卡片 ===");
await goto("/tools", 6000);
{
  const t = await ev(`document.body.innerText`);
  rec("工具列表出现「试卷分析工作台」", /试卷分析工作台/.test(String(t)), "");
  const cards = await ev(`[...document.querySelectorAll('a')].filter(a=>a.href.includes('/tools/')).map(a=>({href:a.getAttribute('href'), text:a.innerText.replace(/\\s+/g,' ').slice(0,40)}))`);
  const paper = (cards ?? []).find((c) => String(c.href).includes("paper-analysis"));
  rec("卡片链接指向 /tools/paper-analysis", !!paper, JSON.stringify(paper ?? {}));
  // 排序：0012 之后普通用户只看到 3 张卡，顺序应为 math-plan(1) → paper-analysis(6) → feedback(15)。
  // ⚠️ 旧断言写的是「试卷分析在 JSON 之前」——JSON 已被 0012 下线，卡片不再存在，
  //    那条断言永远失败（而且它想抓的「顺序错乱」现在由下面的相对顺序覆盖）。
  const order = (cards ?? []).map((c) => c.text);
  const iMath = order.findIndex((x) => /辅导方案/.test(x));
  const iPaper = order.findIndex((x) => /试卷分析/.test(x));
  const iFeedback = order.findIndex((x) => /课后反馈/.test(x));
  rec(
    "三张卡片按 sort_order 排序（辅导方案 → 试卷分析 → 课后反馈）",
    iMath >= 0 && iPaper >= 0 && iFeedback >= 0 && iMath < iPaper && iPaper < iFeedback,
    `math@${iMath} paper@${iPaper} feedback@${iFeedback}`,
  );
  rec("已下线的 4 个空壳工具不再出现（JSON/密码/vip-batch/vip-report）",
    !order.some((x) => /JSON|密码生成|批量数据|高级报表/.test(x)),
    order.slice(0, 8).join(" | "));

  // ---------- 个人中心：会员状态卡（2026-10 新增）----------
  // 这张卡接替了原来散在「顶栏 + /dashboard 正文」的会员信息，所以要有断言钉住它。
  const pc = await ev(`(() => {
    const body = document.body.innerText.replace(/\\s+/g,' ');
    const btns = [...document.querySelectorAll('button')].map(b => b.innerText.replace(/\\s+/g,' ').trim());
    const links = [...document.querySelectorAll('a')].map(a => a.getAttribute('href'));
    return { body, hasSignOut: btns.some(x => /退出登录/.test(x)),
             signOutCount: btns.filter(x => /退出登录/.test(x)).length,
             hasUpgrade: links.includes('/upgrade'),
             hasToolsNav: links.filter(h => h === '/tools').length };
  })()`);
  rec("★个人中心：账号邮箱显示出来了",
    /@/.test(String(pc?.body ?? "")), String(pc?.body ?? "").slice(0, 90));
  rec("★个人中心：会员等级显示出来了（免费版/会员版）",
    /(免费版|会员版)/.test(String(pc?.body ?? "")), "");
  rec("★个人中心：有「退出登录」按钮，而且**只有一个**",
    pc?.hasSignOut === true && pc?.signOutCount === 1, `个数=${pc?.signOutCount}`);
  rec("★个人中心：非会员时给出「查看会员权益」入口", pc?.hasUpgrade === true, JSON.stringify(pc?.hasUpgrade));
  console.log(`     卡片: ${order.slice(0, 6).join(" | ")}`);
}

// ---------- /dashboard 仍然打得开（它正在被改造成「学员档案」页）----------
// ⚠️ 这一条是**临时**的：等学员档案上线，这里要改成断言「学员档案」的内容。
//    现在钉住的是「改造期间它没被弄坏、也没 404」。
await goto("/dashboard", 4000);
{
  const st = await ev(`({ path: location.pathname, hasBody: document.body.innerText.length > 0 })`);
  rec("（过渡期）/dashboard 仍可访问且不是空页（它将被改造成学员档案）",
    st?.path === "/dashboard" && st?.hasBody === true, JSON.stringify(st));
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
  // ⚠️ 不能只认「✓ 已载入云端数据」这一种措辞：
  //    客户端缓存（IndexedDB）命中时，`loadCloudScoped` 会把提示写成
  //    「✓ 已载入云端数据…（本机缓存，已核对最新数据）」或
  //    「（此前显示的是本机缓存，服务端已更新，画面已刷新）」；
  //    核对还没回来时则是「⚡ 已用本机缓存立即显示…」。
  //    三种都是**正常**的云端态。只认第一种会让这条断言依赖
  //    「这台机器上恰好没有缓存」，随运行顺序随机变红（本轮实测踩到）。
  //    真正要守的是「已经不是本机版了」，所以下面按这个口径断言。
  rec("feedback 已进入云端态（不是「本机版」）",
    /已载入云端数据|已用本机缓存|本机缓存/.test(String(s.hint)) && !/本机版/.test(String(s.hint)),
    String(s.hint).slice(0, 80));
}

// ---------- 其他工具页 ----------
console.log("\n=== 其他工具页回归 ===");
// ⚠️ 这里**不能**再靠 anon key 去查 tools 表的 active 来判断期望值。
//    踩过的坑：tools 的 RLS 对 anon **只放行 active=true 的行**，所以已下线的
//    json-formatter 用 anon 查是「查不到这条 route」，会被误读成「不存在」。
//    改成断言一个**与环境无关、且真正有价值**的性质：
//      json-formatter 是免费工具，但它没有 public/tools/json-formatter.html，
//      所以只要它没被下线就会渲染「功能开发中」占位页；被下线（0012）则渲染 404。
//    → 两种状态**都合法**，但「渲染出功能开发中占位页」永远不该发生。
//      （若真发生了，说明 0012 没执行 / 被回滚 —— 这才是要抓的回归。）
//    实测（Next 16.3.8）notFound()：URL 不变，页面换成内置 404，
//    document.title 形如 "404: This page could not be found."（判据用 title，不能用 pathname）。
{
  await goto("/tools/math-plan", 6000);
  const r = await ev(`(() => ({ path: location.pathname, title: document.title }))()`);
  rec(
    "math-plan（免费工具）访问行为正确",
    !/^\s*404/.test(String(r.title)) && String(r.path) === "/tools/math-plan",
    `pathname=${JSON.stringify(r.path)} title=${JSON.stringify(r.title)}`,
  );
}
{
  await goto("/tools/json-formatter", 6000);
  const r = await ev(
    `(() => ({ path: location.pathname, title: document.title, body: document.body.innerText }))()`,
  );
  const is404 = /^\s*404/.test(String(r.title));
  const isPlaceholder = /功能开发中/.test(String(r.body));
  rec(
    "json-formatter 要么 404（已下线）要么正常页，但绝不出现「功能开发中」占位页",
    !isPlaceholder && (is404 || String(r.path) === "/tools/json-formatter"),
    `title=${JSON.stringify(r.title)} 占位页=${isPlaceholder}`,
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
