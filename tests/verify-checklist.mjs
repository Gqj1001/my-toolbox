// 验证清单第 1、2、3、5 项：管理页 + 工具页
import { readFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const BASE = "http://127.0.0.1:3000";
const CDP_PORT = "9410";
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const USER_DATA = "D:/my-website/.edge-profile-verify-promote";
const info = JSON.parse(readFileSync("D:/my-website/my-toolbox/.test-users.json", "utf8"));
const adminEmail = info.users.find((u) => u.email.startsWith("rolea-")).email;
const PASSWORD = info.password;

const results = [];
const rec = (name, pass, detail) => { results.push({ name, pass }); console.log(`${pass ? "PASS" : "FAIL"} | ${name}${detail ? ` | ${detail}` : ""}`); };

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.events = [];
    ws.addEventListener("message", (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
      } else if (m.method) this.events.push(m);
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { resolve: res, reject: rej });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      setTimeout(() => this.pending.has(id) && (this.pending.delete(id), rej(new Error("timeout " + method))), 40000);
    });
  }
  waitForEvent(method, t = 20000) {
    const hit = () => this.events.find((e) => e.method === method);
    if (hit()) return Promise.resolve(hit().params);
    return new Promise((res, rej) => {
      const t0 = Date.now();
      const tick = () => { if (hit()) return res(hit().params); if (Date.now() - t0 > t) return rej(new Error("timeout")); setTimeout(tick, 100); };
      tick();
    });
  }
  clear() { this.events = []; }
}
async function connect() {
  const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
  const { webSocketDebuggerUrl } = await r.json();
  const ws = new WebSocket(webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); });
  return new CDP(ws);
}

// 确保生产服务器在跑（测试必须跑 next start；dev 在本沙箱 hydration 有问题）
const pid = spawnSync("powershell", ["-NoProfile", "-Command", "(Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue).OwningProcess"], { encoding: "utf8" }).stdout.trim();
if (pid) spawnSync("powershell", ["-NoProfile", "-Command", `Stop-Process -Id ${pid} -Force`], { encoding: "utf8" });
await sleep(2000);
const srv = spawn("C:\\Users\\郭庆杰\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\node\\bin\\node.exe",
  ["D:\\my-website\\my-toolbox\\node_modules\\next\\dist\\bin\\next", "start", "-p", "3000"],
  { cwd: "D:\\my-website\\my-toolbox", stdio: "ignore" });
for (let i = 0; i < 60; i++) { await sleep(500); try { if ((await fetch(`${BASE}/login`)).status === 200) break; } catch {} }

const edge = spawn(EDGE, ["--headless=new", `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${USER_DATA}`, "--no-first-run", "--no-default-browser-check", "about:blank"], { stdio: "ignore" });
let cdp;
for (let i = 0; i < 40; i++) { await sleep(500); try { cdp = await connect(); break; } catch {} }
const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
await cdp.send("Page.enable", {}, sessionId);
await cdp.send("Runtime.enable", {}, sessionId);
const pageErrors = [];
cdp.ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.method === "Runtime.exceptionThrown") pageErrors.push(String(m.params.exceptionDetails?.exception?.description ?? "?").slice(0, 200));
  if (m.method === "Log.entryAdded" && m.params.entry.level === "error") pageErrors.push("[log] " + String(m.params.entry.text).slice(0, 200));
});

async function ev(expr) {
  const r = await cdp.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }, sessionId);
  if (r.exceptionDetails) return { __err: r.exceptionDetails.exception?.description };
  return r.result.value;
}
async function goto(p, w = 5000) {
  cdp.clear();
  await cdp.send("Page.navigate", { url: BASE + p }, sessionId);
  await cdp.waitForEvent("Page.loadEventFired").catch(() => {});
  await sleep(w);
}
const inTool = (body) => ev(`(() => { const f=document.querySelector('iframe'); if(!f) return {__err:'无 iframe'};
  const doc=f.contentDocument; const w=f.contentWindow; if(!doc) return {__err:'无 doc'};
  try { ${body} } catch(e){ return {__err:String(e && e.message || e)}; } })()`);

// 登录
await cdp.send("Network.clearBrowserCookies", {}, sessionId);
await goto("/login", 2000);
for (let i = 0; i < 40; i++) { if (await ev(`!!document.querySelector('form input[name="email"]')`)) break; await sleep(250); }
await ev(`(() => { const f=document.querySelector("form"); const d=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value");
  const em=f.querySelector('input[name="email"]'), pw=f.querySelector('input[name="password"]');
  d.set.call(em, ${JSON.stringify(adminEmail)}); em.dispatchEvent(new Event("input",{bubbles:true}));
  d.set.call(pw, ${JSON.stringify(PASSWORD)}); pw.dispatchEvent(new Event("input",{bubbles:true}));
  return true; })()`);
await sleep(400);
await ev(`document.querySelector("form").requestSubmit(), true`);
for (let i = 0; i < 60; i++) { await sleep(500); if ((await ev("location.pathname")) !== "/login") break; }
await sleep(1500);

// ---------- 1. 管理页显示全部已提升 ----------
console.log("\n=== 1. /admin/feedback-candidates ===");
await goto("/admin/feedback-candidates", 6000);
{
  const url = await ev("location.pathname + location.search");
  const txt = await ev("document.body.innerText");
  const has = (re) => re.test(String(txt));
  rec("管理页可访问", String(url).startsWith("/admin/feedback-candidates"), String(url));
  rec("显示候选总数 959", /候选\s*959/.test(String(txt)), (String(txt).match(/候选[^\n]{0,40}/) ?? [""])[0]);
  rec("待审 0", /待审\s*0/.test(String(txt)), (String(txt).match(/待审[^\n]{0,20}/) ?? [""])[0]);
  rec("提升按钮显示已通过未提升 0", /已通过未提升\s*0/.test(String(txt)), (String(txt).match(/已通过未提升[^\n]{0,20}/) ?? [""])[0]);
}

// ---------- 2. 工具页可打开 ----------
console.log("\n=== 2. /tools/feedback ===");
await goto("/tools/feedback", 9000);
{
  const url = await ev("location.pathname + location.search");
  rec("工具页未被门禁拦住", String(url).startsWith("/tools/feedback"), String(url));
  const s = await inTool(`
    return { badge: doc.getElementById('modeBadge')?.textContent ?? '',
      hint: doc.getElementById('syncHint')?.textContent ?? '',
      stage: doc.getElementById('stageSelect')?.value ?? '',
      subject: doc.getElementById('subjectSelect')?.value ?? '',
      checkboxes: doc.querySelectorAll('#generateCategories input[type=checkbox]').length };
  `);
  rec("iframe 正常加载", !s.__err, s.__err ?? "");
  rec("云端模式徽章", /云端/.test(String(s.badge)), String(s.badge));
  rec("状态行显示已载入", /已载入云端数据/.test(String(s.hint)), String(s.hint).slice(0, 70));
}

// ---------- 3. 高中·化学 能看到新导入的章节 ----------
console.log("\n=== 3. 高中 · 化学 ===");
{
  await inTool(`const s=doc.getElementById('stageSelect'); const d=Object.getOwnPropertyDescriptor(w.HTMLSelectElement.prototype,'value');
    d.set.call(s,'senior'); s.dispatchEvent(new w.Event('change',{bubbles:true})); return 'ok';`);
  await sleep(4000);
  await inTool(`const s=doc.getElementById('subjectSelect'); const d=Object.getOwnPropertyDescriptor(w.HTMLSelectElement.prototype,'value');
    d.set.call(s,'chemistry'); s.dispatchEvent(new w.Event('change',{bubbles:true})); return 'ok';`);
  // 轮询等待：直到 syncHint 出现「化学」且版本下拉里是化学的版本
  let t = { versions: [], checkboxes: 0, hint: '' };
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    t = await inTool(`
      const ver=doc.getElementById('textbookVersionSelect');
      return { versions: [...(ver?.options??[])].map(o=>o.text),
        checkboxes: doc.querySelectorAll('#generateCategories input[type=checkbox]').length,
        hint: doc.getElementById('syncHint')?.textContent ?? '' };
    `);
    const vs = (t.versions ?? []).join(",");
    if (/化学/.test(String(t.hint)) && /人教版/.test(vs) && /鲁科版/.test(vs)) break;
  }
  rec("高中化学有教材版本", (t.versions ?? []).length >= 3, (t.versions ?? []).join(" | "));
  // 选版本 → 选册次 → 看章
  const bookRes = await inTool(`
    const ver=doc.getElementById('textbookVersionSelect');
    const opt=[...ver.options].find(o=>o.value==='人教版');
    if(!opt) return {err:'无人教版'};
    const d=Object.getOwnPropertyDescriptor(w.HTMLSelectElement.prototype,'value');
    d.set.call(ver,'人教版'); ver.dispatchEvent(new w.Event('change',{bubbles:true}));
    return {ok:true};
  `);
  await sleep(5000);
  const vol = await inTool(`
    const vol=doc.getElementById('textbookSelect');
    return { visible: (vol?.style.display ?? 'none') !== 'none',
      options: [...(vol?.options??[])].map(o=>o.text) };
  `);
  rec("高中化学·人教版 出现册次下拉", vol.visible === true, (vol.options ?? []).join(" | ").slice(0, 120));
  // 选第一个有内容的册次
  const pick = await inTool(`
    const vol=doc.getElementById('textbookSelect');
    const opt=[...vol.options].find(o=>o.value && o.text.includes('必修第一册'));
    if(!opt) return {err:'无必修第一册', options:[...vol.options].map(o=>o.text)};
    const d=Object.getOwnPropertyDescriptor(w.HTMLSelectElement.prototype,'value');
    d.set.call(vol, opt.value); vol.dispatchEvent(new w.Event('change',{bubbles:true}));
    return {ok:true, picked: opt.text};
  `);
  await sleep(6000);
  const after = await inTool(`
    const boxes=[...doc.querySelectorAll('#generateCategories input[type=checkbox]')];
    const kws=boxes.map(b=>b.dataset.keyword).filter(Boolean);
    const grid=doc.querySelector('#generateCategories .grid[id^="bookGrid_"]');
    return { total: boxes.length, gridCount: grid ? grid.querySelectorAll('input[type=checkbox]').length : 0,
      sample: kws.slice(0,6), hint: doc.getElementById('syncHint')?.textContent ?? '' };
  `);
  rec("选中化学册次后出现章节知识点", after.gridCount > 0 || after.total > 0, `网格 ${after.gridCount} / 总 ${after.total}`);
  rec("化学章节名符合预期（走进化学世界等）", (after.sample ?? []).some((k) => /化学|物质|氧气|空气|实验/.test(k)), JSON.stringify(after.sample));
  console.log("     状态行:", String(after.hint).slice(0, 80));
}

// ---------- 5. 高中·数学·人教B版 三层结构 ----------
console.log("\n=== 5. 高中 · 数学 · 人教B版 ===");
{
  await inTool(`const s=doc.getElementById('subjectSelect'); const d=Object.getOwnPropertyDescriptor(w.HTMLSelectElement.prototype,'value');
    d.set.call(s,'math'); s.dispatchEvent(new w.Event('change',{bubbles:true})); return 'ok';`);
  await sleep(5000);
  const vers = await inTool(`return [...(doc.getElementById('textbookVersionSelect')?.options??[])].map(o=>o.value)`);
  rec("数学有 5 个版本（含人教B版）", (vers ?? []).includes("人教B版"), JSON.stringify(vers));
  await inTool(`const ver=doc.getElementById('textbookVersionSelect'); const d=Object.getOwnPropertyDescriptor(w.HTMLSelectElement.prototype,'value');
    d.set.call(ver,'人教B版'); ver.dispatchEvent(new w.Event('change',{bubbles:true})); return 'ok';`);
  await sleep(5000);
  const vol = await inTool(`const vol=doc.getElementById('textbookSelect');
    return { visible: (vol?.style.display ?? 'none') !== 'none', options: [...(vol?.options??[])].map(o=>o.text) };`);
  rec("人教B版 出现册次下拉", vol.visible === true, (vol.options ?? []).join(" | ").slice(0, 120));
  const pick = await inTool(`
    const vol=doc.getElementById('textbookSelect');
    const opt=[...vol.options].find(o=>o.value && o.text.includes('必修第一册'));
    if(!opt) return {err:'无必修第一册'};
    const d=Object.getOwnPropertyDescriptor(w.HTMLSelectElement.prototype,'value');
    d.set.call(vol, opt.value); vol.dispatchEvent(new w.Event('change',{bubbles:true}));
    return {ok:true};
  `);
  await sleep(6000);
  const after = await inTool(`
    const boxes=[...doc.querySelectorAll('#generateCategories input[type=checkbox]')];
    const kws=boxes.map(b=>b.dataset.keyword).filter(Boolean);
    const cats=[...doc.querySelectorAll('#generateCategories details.cat')].map(d=>({
      name:d.querySelector('summary').textContent.replace(/[▼▶0-9]/g,'').trim(),
      n:d.querySelectorAll('input[type=checkbox]').length }));
    return { total: boxes.length, sample: kws.slice(0,8), cats: cats.slice(0,3) };
  `);
  rec("人教B版必修一 载入章节知识点", (after.sample ?? []).length > 0, `${after.total} 个复选框`);
  rec("章节名符合人教B版（集合与常用逻辑用语/函数）", (after.sample ?? []).some((k) => /集合|函数|等式|不等式/.test(k)), JSON.stringify(after.sample));
}

// ---------- 4. 人教A版 94 个知识点不变 ----------
console.log("\n=== 4. 高中 · 数学 · 人教A版（关键：不能被覆盖）===");
{
  await inTool(`const ver=doc.getElementById('textbookVersionSelect'); const d=Object.getOwnPropertyDescriptor(w.HTMLSelectElement.prototype,'value');
    d.set.call(ver,'人教A版'); ver.dispatchEvent(new w.Event('change',{bubbles:true})); return 'ok';`);
  await sleep(5000);
  const opts = await inTool(`const vol=doc.getElementById('textbookSelect');
    return { options: [...(vol?.options??[])].map(o=>o.text), visible:(vol?.style.display??'none')!=='none' };`);
  const hasSix = (opts.options ?? []).filter((o) => o && !o.includes("（")).length;
  rec("人教A版 6 册齐全", hasSix >= 6, (opts.options ?? []).join(" | ").slice(0, 140));
  // 期望值（来自数据库，用于轮询判据——避免拿到上一册的旧数据）
  const expectedGrid = { "必修第一册": 21, "必修第二册": 19, "选择性必修第一册": 12, "选择性必修第二册": 15, "选择性必修第三册": 11, "高考专题与真题": 16 };
  const perBook = [];
  const books = Object.keys(expectedGrid);
  for (const b of books) {
    const r = await inTool(`
      const vol=doc.getElementById('textbookSelect');
      const opt=[...vol.options].find(o=>o.text === ${JSON.stringify(b)});
      if(!opt) return {err:'无此册'};
      const d=Object.getOwnPropertyDescriptor(w.HTMLSelectElement.prototype,'value');
      d.set.call(vol, opt.value); vol.dispatchEvent(new w.Event('change',{bubbles:true}));
      return {ok:true};
    `);
    if (r.err) { perBook.push({ b, n: -1, err: r.err }); continue; }
    // 轮询等待：状态行变为「已限定教材」，且课堂内容数量>0
    let c = { n: -1, grid: -1, sample: [] };
    for (let i = 0; i < 40; i++) {
      await sleep(500);
      c = await inTool(`
        const det=[...doc.querySelectorAll('#generateCategories details.cat')]
          .find(x=>x.querySelector('summary').textContent.replace(/[▼▶0-9]/g,'').trim()==='课堂内容');
        if(!det) return { n:-1, grid:-1, sample:[] };
        const grid=det.querySelector('.grid[id^="bookGrid_"]');
        const boxes=[...det.querySelectorAll('input[type=checkbox]')];
        return { n: boxes.length,
          grid: grid ? grid.querySelectorAll('input[type=checkbox]').length : 0,
          sample: [...new Set(boxes.map(x=>x.dataset.keyword).filter(Boolean))].slice(0,3) };
      `);
      if (c.grid === expectedGrid[b]) break;   // 等到真正切到该册（否则会拿到上一册的旧值）
    }
    perBook.push({ b, n: c.n, grid: c.grid, sample: c.sample });
  }
  console.log("     各册「课堂内容」中的课本网格数（= 数据库该册章节数）:");
  let sum = 0;
  for (const p of perBook) {
    const exp = expectedGrid[p.b];
    const okMark = p.grid === exp ? "✅" : "❌";
    console.log(`       ${p.b}: 网格 ${p.grid}（期望 ${exp}）${okMark}  分类合计 ${p.n}  ${JSON.stringify(p.sample ?? [])}`);
    if (p.grid > 0) sum += p.grid;
  }
  rec("人教A版 6 册课本网格合计 94（未被覆盖）", sum === 94, `${sum}`);
}

console.log("\n=== 页面错误 ===");
console.log(pageErrors.length ? pageErrors.slice(0, 8).join("\n") : "(无)");

try { await cdp.send("Browser.close"); } catch { edge.kill(); }
srv.kill();
const passed = results.filter((r) => r.pass).length;
console.log(`\n=== 验证清单 ${passed}/${results.length} 通过 ===`);
process.exit(passed === results.length ? 0 : 1);
