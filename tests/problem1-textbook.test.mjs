// 问题1 验证：教材「版本 + 册次」两级下拉
// ⚠️ 需要先在 Supabase SQL Editor 执行 0006_textbook_version.sql
import { readFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { createClient } from "@supabase/supabase-js";

const BASE = "http://127.0.0.1:3000";
const CDP_PORT = "9402";
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const USER_DATA = "D:/my-website/.edge-profile-v1";
const env = readFileSync("D:/my-website/my-toolbox/.env.local", "utf8").split(/\r?\n/);
const SUPABASE_URL = env.find((l) => l.startsWith("NEXT_PUBLIC_SUPABASE_URL=")).split("=")[1].trim();
const ANON_KEY = env.find((l) => l.startsWith("NEXT_PUBLIC_SUPABASE_ANON_KEY=")).split("=").slice(1).join("=").trim();
const info = JSON.parse(readFileSync("D:/my-website/my-toolbox/.test-users.json", "utf8"));
const adminEmail = info.users.find((u) => u.email.startsWith("rolea-")).email;
const PASSWORD = info.password;

const results = [];
const record = (name, pass, detail) => { results.push({ name, pass }); console.log(`${pass ? "PASS" : "FAIL"} | ${name}${detail ? ` | ${detail}` : ""}`); };

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
      setTimeout(() => this.pending.has(id) && (this.pending.delete(id), rej(new Error("timeout"))), 30000);
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

const pid = spawnSync("powershell", ["-NoProfile", "-Command", "(Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue).OwningProcess"], { encoding: "utf8" }).stdout.trim();
if (pid) spawnSync("powershell", ["-NoProfile", "-Command", `Stop-Process -Id ${pid} -Force`], { encoding: "utf8" });
await sleep(2000);
const srv = spawn("C:\\Users\\郭庆杰\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\node\\bin\\node.exe",
  ["D:\\my-website\\my-toolbox\\node_modules\\next\\dist\\bin\\next", "start", "-p", "3000"],
  { cwd: "D:\\my-website\\my-toolbox", stdio: "ignore" });
for (let i = 0; i < 60; i++) { await sleep(500); try { if ((await fetch(`${BASE}/login`)).status === 200) break; } catch { /* 等待 */ } }

const edge = spawn(EDGE, ["--headless=new", `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${USER_DATA}`, "--no-first-run", "--no-default-browser-check", "about:blank"], { stdio: "ignore" });
let cdp;
for (let i = 0; i < 40; i++) { await sleep(500); try { cdp = await connect(); break; } catch { /* 等待 */ } }
const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
await cdp.send("Page.enable", {}, sessionId);
await cdp.send("Runtime.enable", {}, sessionId);

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
const inTool = (body) =>
  ev(`(() => { const f=document.querySelector('iframe'); if(!f) return {__err:'无 iframe'};
    const doc=f.contentDocument; const w=f.contentWindow; if(!doc) return {__err:'无 doc'};
    try { ${body} } catch(e){ return {__err:String(e && e.message || e)}; } })()`);

const db = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
await db.auth.signInWithPassword({ email: adminEmail, password: PASSWORD });

// ---------- 0. SQL 是否已执行 ----------
console.log("=== 0. 数据库结构检查 ===");
const probe = await db.from("feedback_textbooks").select("id, stage, subject, version, name, sort_order").limit(1);
if (probe.error) {
  console.log(`❌ 读取 version 列失败: ${probe.error.code} ${probe.error.message}`);
  console.log("   → 请先在 Supabase SQL Editor 执行 supabase/migrations/0006_textbook_version.sql");
  process.exit(2);
}
record("feedback_textbooks 已有 version 列", true, "");
const { data: allTb } = await db.from("feedback_textbooks").select("id, stage, subject, version, name").order("id");
record("教材总数 41", allTb.length === 41, `${allTb.length}`);
const verCount = new Set(allTb.map((t) => t.version)).size;
record("版本数 >= 12", verCount >= 12, `${verCount} 个版本`);
const seniorMath = allTb.filter((t) => t.stage === "senior" && t.subject === "math");
const mathAVersions = [...new Set(seniorMath.map((t) => t.version))];
record("高中数学含 人教A版/人教B版/北师大版/苏教版/湘教版",
  ["人教A版", "人教B版", "北师大版", "苏教版", "湘教版"].every((v) => mathAVersions.includes(v)),
  mathAVersions.join("/"));
const renjiaoA = seniorMath.filter((t) => t.version === "人教A版");
record("人教A版有 6 册", renjiaoA.length === 6, `${renjiaoA.length}`);
record("人教A版册次名不含版本前缀", renjiaoA.every((t) => !t.name.includes("人教A版")), renjiaoA.map((t) => t.name).join("/"));
record("册次名正确（必修第一册…）", renjiaoA.some((t) => t.name === "必修第一册"), renjiaoA.map((t) => t.name).join("/"));
const single = allTb.filter((t) => t.name === "-");
record("纯版本条目 name='-'（如人教B版、统编版）", single.length > 0, `${single.length} 条`);

// 引用完整性
const { count: chCount } = await db.from("feedback_chapters").select("*", { count: "exact", head: true });
record("章节总数 272（未受影响）", chCount === 272, `${chCount}`);
const { count: kwWithCh } = await db.from("feedback_keywords").select("*", { count: "exact", head: true }).not("chapter_id", "is", null);
record("带章节的关键词 188（未受影响）", kwWithCh === 188, `${kwWithCh}`);
{
  const ids = new Set(allTb.map((t) => t.id));
  const { data: chs } = await db.from("feedback_chapters").select("textbook_id");
  const orphans = (chs ?? []).filter((c) => !ids.has(c.textbook_id));
  record("无孤立章节", orphans.length === 0, `${orphans.length} 条孤立`);
}

// ---------- 登录 ----------
// ---------- 登录（带健壮性检查，避免"表单没填上会话丢了"这种静默失败）----------
await cdp.send("Network.clearBrowserCookies", {}, sessionId);
await goto("/login", 2000);
{
  // 若残留会话导致被自动跳走，再清一次并回到登录页
  const p = await ev("location.pathname");
  if (p !== "/login") {
    await cdp.send("Network.clearBrowserCookies", {}, sessionId);
    await goto("/login", 2000);
  }
}
for (let i = 0; i < 40; i++) {
  if (await ev(`!!document.querySelector('form input[name="email"]')`).catch(() => false)) break;
  await sleep(250);
}
{
  const hasForm = await ev(`!!document.querySelector('form input[name="email"]')`);
  if (!hasForm) {
    console.log("❌ 登录页表单未出现，无法继续");
    process.exit(3);
  }
}
await ev(`
  (() => { const f=document.querySelector("form"); const d=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value");
    d.set.call(f.querySelector('input[name="email"]'), ${JSON.stringify(adminEmail)}); f.querySelector('input[name="email"]').dispatchEvent(new Event("input",{bubbles:true}));
    d.set.call(f.querySelector('input[name="password"]'), ${JSON.stringify(PASSWORD)}); f.querySelector('input[name="password"]').dispatchEvent(new Event("input",{bubbles:true}));
    return true; })()
`);
await sleep(400);
await ev(`document.querySelector("form").requestSubmit(), true`);
for (let i = 0; i < 60; i++) { await sleep(500); if ((await ev("location.pathname")) !== "/login") break; }
await sleep(1200);

// 确认会话真的建立了
{
  const who = await ev(`fetch('/api/feedback/data?stage=senior&subject=math',{credentials:'same-origin'}).then(r=>r.status)`);
  console.log(`   登录后 /api/feedback/data 状态: ${who}（200=会话有效）`);
  if (who !== 200) {
    console.log("❌ 会话未建立，测试无法继续");
    process.exit(3);
  }
}

// ---------- A. 管理页 ----------
console.log("\n=== A. 管理页两级下拉 ===");
await goto("/admin/feedback-keywords?stage=senior&subject=math", 5500);
{
  const url = await ev("location.pathname + location.search");
  record("管理页未被重定向（会话有效）", url.startsWith("/admin/feedback-keywords"), url);
  if (!url.startsWith("/admin/feedback-keywords")) {
    record("管理页有「教材版本」下拉", false, "页面被重定向，跳过");
    record("版本列表含 5 个数学版本", false, "跳过");
    record("未选版本时无册次下拉", false, "跳过");
  } else {
    const r = await ev(`
      (() => {
        const ver = document.querySelector('select[aria-label="教材版本"]');
        const vol = document.querySelector('select[aria-label="册次"]');
        return {
          hasVersion: !!ver,
          versions: ver ? [...ver.options].map(o=>o.text) : [],
          hasVolume: !!vol,
          volumeOptions: vol ? [...vol.options].map(o=>o.text) : [],
        };
      })()
    `);
    record("管理页有「教材版本」下拉", r.hasVersion === true, `${(r.versions ?? []).length} 项`);
    record("版本列表含 5 个数学版本", ["人教A版", "人教B版", "北师大版", "苏教版", "湘教版"].every((v) => (r.versions ?? []).includes(v)), (r.versions ?? []).join("/"));
    record("未选版本时无册次下拉", r.hasVolume === false, "");
  }
}

{
  // 选版本 人教A版 → 应出现册次下拉
  const r = await ev(`
    (() => {
      const ver = document.querySelector('select[aria-label="教材版本"]');
      const opt = [...ver.options].find(o=>o.value==='人教A版');
      if(!opt) return {err:'未找到人教A版'};
      const d = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value');
      d.set.call(ver, '人教A版');
      ver.dispatchEvent(new Event('change',{bubbles:true}));
      return {ok:true};
    })()
  `);
  await sleep(3500);
  const t = await ev(`
    (() => {
      const vol = document.querySelector('select[aria-label="册次"]');
      return { hasVolume: !!vol, volumes: vol ? [...vol.options].map(o=>o.text) : [],
        url: location.search };
    })()
  `);
  record("选版本后出现册次下拉", t.hasVolume === true, `${t.volumes.length} 项`);
  record("册次为 6 册且不含版本前缀", t.volumes.length === 6 && t.volumes.every((v) => !v.includes("人教A版")), t.volumes.join("/"));
  record("URL 只带 textbook id（版本是 UI 层筛选）", /textbook=\d+/.test(t.url) && !/version=/.test(t.url), t.url);
}

{
  // 换版本 人教B版（只有 1 条 → 不应出现册次下拉）
  const r = await ev(`
    (() => {
      const ver = document.querySelector('select[aria-label="教材版本"]');
      const d = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value');
      d.set.call(ver, '人教B版');
      ver.dispatchEvent(new Event('change',{bubbles:true}));
      return 'ok';
    })()
  `);
  await sleep(3500);
  const t = await ev(`
    (() => {
      const vol = document.querySelector('select[aria-label="册次"]');
      return { hasVolume: !!vol, url: location.search };
    })()
  `);
  record("单册版本（人教B版）不显示册次下拉", t.hasVolume === false, `url=${t.url}`);
}

// ---------- B. 工具页 ----------
console.log("\n=== B. 工具页两级下拉 ===");
await goto("/tools/feedback", 1500);
await ev(`localStorage.removeItem('fb_stage_v1'); localStorage.removeItem('fb_subject_v1'); localStorage.removeItem('fb_textbook_v1'); localStorage.removeItem('fb_chapter_v1'); true`);
await goto("/tools/feedback", 7000);

{
  const url = await ev("location.pathname + location.search");
  if (!url.startsWith("/tools/feedback")) {
    record("工具页可访问（会话有效）", false, `被重定向到 ${url}`);
  } else {
    await inTool(`
      const sel=doc.getElementById('subjectSelect');
      const d=Object.getOwnPropertyDescriptor(w.HTMLSelectElement.prototype,'value');
      d.set.call(sel,'math'); sel.dispatchEvent(new w.Event('change',{bubbles:true}));
      return 'ok';
    `);
    await sleep(4500);
  }
}
{
  const r = await inTool(`
    const ver=doc.getElementById('textbookVersionSelect');
    const vol=doc.getElementById('textbookSelect');
    const field=doc.getElementById('textbookField');
    return {
      visible: (field?.style.display ?? 'none') !== 'none',
      versions: [...(ver?.options??[])].map(o=>o.text),
      volVisible: (vol?.style.display ?? 'none') !== 'none',
      label: doc.getElementById('textbookLabel')?.textContent ?? '',
    };
  `);
  record("工具页出现教材版本下拉", r.visible === true, `${r.versions.length} 项`);
  record("版本列表含 5 个数学版本", ["人教A版", "人教B版", "北师大版", "苏教版", "湘教版"].every((v) => r.versions.includes(v)), r.versions.slice(0, 6).join("/"));
  record("未选版本时册次下拉隐藏", r.volVisible === false, "");
  record("标签为「教材版本」", r.label === "教材版本", r.label);
}

{
  // 选版本 → 册次出现；再选册次 → 章节词载入
  await inTool(`
    const ver=doc.getElementById('textbookVersionSelect');
    const d=Object.getOwnPropertyDescriptor(w.HTMLSelectElement.prototype,'value');
    d.set.call(ver,'人教A版'); ver.dispatchEvent(new w.Event('change',{bubbles:true}));
    return 'ok';
  `);
  await sleep(4500);
  const r = await inTool(`
    const vol=doc.getElementById('textbookSelect');
    const ver=doc.getElementById('textbookVersionSelect');
    return {
      verValue: ver?.value ?? '',
      volVisible: (vol?.style.display ?? 'none') !== 'none',
      volumes: [...(vol?.options??[])].map(o=>o.text),
      label: doc.getElementById('textbookLabel')?.textContent ?? '',
      checkboxes: doc.querySelectorAll('#generateCategories input[type=checkbox]').length,
    };
  `);
  record("选版本后册次下拉出现", r.volVisible === true, `${r.volumes.length} 项`);
  record("册次选项为册次名（无版本前缀）", r.volumes.filter((v) => v && !v.includes("（")).every((v) => !v.includes("人教A版")), r.volumes.join("/"));
  record("标签显示当前教材（版本 · 册次）", /人教A版/.test(r.label), r.label);
}
{
  // 选到具体册次
  await inTool(`
    const vol=doc.getElementById('textbookSelect');
    const opt=[...vol.options].find(o=>o.text==='必修第一册');
    if(!opt) return '未找到必修第一册';
    const d=Object.getOwnPropertyDescriptor(w.HTMLSelectElement.prototype,'value');
    d.set.call(vol,opt.value); vol.dispatchEvent(new w.Event('change',{bubbles:true}));
    return 'ok';
  `);
  await sleep(5000);
  const r = await inTool(`
    const boxes=[...doc.querySelectorAll('#generateCategories input[type=checkbox]')];
    const kws=boxes.map(b=>b.dataset.keyword).filter(Boolean);
    return {
      hasSet: kws.includes('集合的概念与关系'),
      total: boxes.length,
      bookPanel: !!doc.querySelector('#generateCategories .grid[id^="bookGrid_"]'),
      label: doc.getElementById('textbookLabel')?.textContent ?? '',
      syncHint: doc.getElementById('syncHint')?.textContent ?? '',
    };
  `);
  record("选中册次后载入该册章节词", r.hasSet === true, `共 ${r.total} 个复选框`);
  record("显示课本面板", r.bookPanel === true, "");
  record("标签显示 版本 · 册次", /人教A版/.test(r.label) && /必修第一册/.test(r.label), r.label);
  record("状态行显示已限定教材", /已限定教材/.test(r.syncHint), r.syncHint.slice(0, 60));
}

{
  // 切到 人教B版（单册）→ 册次下拉隐藏，仍能选到该版本
  await inTool(`
    const ver=doc.getElementById('textbookVersionSelect');
    const d=Object.getOwnPropertyDescriptor(w.HTMLSelectElement.prototype,'value');
    d.set.call(ver,'人教B版'); ver.dispatchEvent(new w.Event('change',{bubbles:true}));
    return 'ok';
  `);
  await sleep(4500);
  const r = await inTool(`
    const vol=doc.getElementById('textbookSelect');
    return { volVisible: (vol?.style.display ?? 'none') !== 'none',
      label: doc.getElementById('textbookLabel')?.textContent ?? '',
      verValue: doc.getElementById('textbookVersionSelect')?.value ?? '' };
  `);
  record("人教B版（单册）不显示册次下拉", r.volVisible === false, `label=${r.label}`);
  record("版本选择保持为人教B版", r.verValue === "人教B版", r.verValue);
}

{
  // 英语科目（3 个版本，各只有 1 条）→ 只显示版本下拉
  await inTool(`
    const sel=doc.getElementById('subjectSelect');
    const d=Object.getOwnPropertyDescriptor(w.HTMLSelectElement.prototype,'value');
    d.set.call(sel,'english'); sel.dispatchEvent(new w.Event('change',{bubbles:true}));
    return 'ok';
  `);
  await sleep(4500);
  const r = await inTool(`
    const ver=doc.getElementById('textbookVersionSelect');
    const vol=doc.getElementById('textbookSelect');
    return { versions: [...(ver?.options??[])].map(o=>o.text),
      volVisible: (vol?.style.display ?? 'none') !== 'none' };
  `);
  record("英语显示 3 个版本", ["人教版", "外研版", "译林版"].every((v) => r.versions.includes(v)), r.versions.join("/"));
  record("英语无册次下拉（各版本各一条）", r.volVisible === false, "");
}

console.log("\n=== C. 会员守卫 ===");
{
  const userEmail = info.users.find((u) => u.email.startsWith("roleb-")).email;
  const { data: list } = await db.rpc("admin_list_users");
  const userId = list.find((u) => u.email === userEmail)?.user_id;

  // 先确认 roleb 是非会员，验 403
  await db.from("user_roles").update({ plan: "free", expires_at: null }).eq("user_id", userId);

  const loginAs = async (email) => {
    await cdp.send("Network.clearBrowserCookies", {}, sessionId);
    await goto("/login", 1500);
    await ev(`
      (() => { const f=document.querySelector("form"); const d=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value");
        d.set.call(f.querySelector('input[name="email"]'), ${JSON.stringify(email)}); f.querySelector('input[name="email"]').dispatchEvent(new Event("input",{bubbles:true}));
        d.set.call(f.querySelector('input[name="password"]'), ${JSON.stringify(PASSWORD)}); f.querySelector('input[name="password"]').dispatchEvent(new Event("input",{bubbles:true}));
        return true; })()
    `);
    await sleep(400);
    await ev(`document.querySelector("form").requestSubmit(), true`);
    for (let i = 0; i < 60; i++) { await sleep(500); if ((await ev("location.pathname")) !== "/login") break; }
    await sleep(1200);
  };
  const callAi = () =>
    ev(`fetch('/api/feedback/ai',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:'x',prompt:'y'})}).then(r=>r.status)`);

  await loginAs(userEmail);
  await goto("/tools/feedback", 7000);
  const r = await inTool(`
    return { hasVersion: !!doc.getElementById('textbookVersionSelect') };
  `);
  record("普通用户也能看到版本下拉", r.hasVersion === true, "");
  const aiFree = await callAi();
  record("非会员调 AI 被拒 403", aiFree === 403, `HTTP ${aiFree}`);

  // 再开通会员：应通过守卫（本地无 AI_KEY 时为 503，线上有 key 则为 200）
  await db.from("user_roles").update({ plan: "vip", expires_at: new Date(Date.now() + 86400000).toISOString() }).eq("user_id", userId);
  await sleep(800);
  await goto("/tools/feedback", 3000);
  const aiVip = await callAi();
  record("会员通过 VIP 守卫（403 之外的状态）", aiVip !== 403 && aiVip !== 401, `HTTP ${aiVip}`);

  // 还原 roleb 为非会员
  await db.from("user_roles").update({ plan: "free", expires_at: null }).eq("user_id", userId);
}

try { await cdp.send("Browser.close"); } catch { edge.kill(); }
srv.kill();

console.log("\n=== SUMMARY ===");
const passed = results.filter((r) => r.pass).length;
console.log(`${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
