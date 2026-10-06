// 第 2-3 步验证：API 维度过滤 + 向后兼容 + 归档不泄漏 + RLS 越权
import { readFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { createClient } from "@supabase/supabase-js";

const BASE = "http://127.0.0.1:3000";
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const CDP_PORT = "9395";
const USER_DATA = "D:/my-website/.edge-profile-api7";

const env = readFileSync("D:/my-website/my-toolbox/.env.local", "utf8").split(/\r?\n/);
const SUPABASE_URL = env.find((l) => l.startsWith("NEXT_PUBLIC_SUPABASE_URL=")).split("=")[1].trim();
const ANON_KEY = env.find((l) => l.startsWith("NEXT_PUBLIC_SUPABASE_ANON_KEY=")).split("=").slice(1).join("=").trim();
const info = JSON.parse(readFileSync("D:/my-website/my-toolbox/.test-users.json", "utf8"));
const adminEmail = info.users.find((u) => u.email.startsWith("rolea-")).email;
const userEmail = info.users.find((u) => u.email.startsWith("roleb-")).email;
const PASSWORD = info.password;

const results = [];
const record = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`${pass ? "PASS" : "FAIL"} | ${name}${detail ? ` | ${detail}` : ""}`);
};

// ---------- 浏览器（用于带会话调 API）----------
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
      setTimeout(() => this.pending.has(id) && (this.pending.delete(id), rej(new Error("timeout " + method))), 30000);
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

// 启动生产服务器（dev 模式在本沙箱 hydration 失效）
const pid = spawnSync("powershell", ["-NoProfile", "-Command", "(Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue).OwningProcess"], { encoding: "utf8" }).stdout.trim();
if (pid) spawnSync("powershell", ["-NoProfile", "-Command", `Stop-Process -Id ${pid} -Force`], { encoding: "utf8" });
await sleep(2000);
const srv = spawn("C:\\Users\\郭庆杰\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\node\\bin\\node.exe",
  ["D:\\my-website\\my-toolbox\\node_modules\\next\\dist\\bin\\next", "start", "-p", "3000"],
  { cwd: "D:\\my-website\\my-toolbox", stdio: "ignore" });
for (let i = 0; i < 60; i++) {
  await sleep(500);
  try { if ((await fetch(`${BASE}/login`)).status === 200) break; } catch { /* 等待 */ }
}

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
async function goto(p, w = 3500) {
  cdp.clear();
  await cdp.send("Page.navigate", { url: BASE + p }, sessionId);
  await cdp.waitForEvent("Page.loadEventFired").catch(() => {});
  await sleep(w);
}
async function login(email) {
  await cdp.send("Network.clearBrowserCookies", {}, sessionId);
  await goto("/login", 1500);
  for (let i = 0; i < 40; i++) { if (await ev(`!!document.querySelector('input[name="email"]')`).catch(() => false)) break; await sleep(250); }
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
  // 确认会话真的建立；未建立则重试一次（避免静默失败导致后续断言全崩）
  for (let attempt = 0; attempt < 2; attempt++) {
    const st = await ev(`fetch('/api/feedback/data?stage=senior&subject=math',{credentials:'same-origin'}).then(r=>r.status)`);
    if (st === 200) return;
    await cdp.send("Network.clearBrowserCookies", {}, sessionId);
    await goto("/login", 1500);
    for (let i = 0; i < 40; i++) { if (await ev(`!!document.querySelector('form input[name="email"]')`).catch(() => false)) break; await sleep(250); }
    await ev(`
      (() => { const f=document.querySelector("form"); const d=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value");
        d.set.call(f.querySelector('input[name="email"]'), ${JSON.stringify(email)}); f.querySelector('input[name="email"]').dispatchEvent(new Event("input",{bubbles:true}));
        d.set.call(f.querySelector('input[name="password"]'), ${JSON.stringify(password)}); f.querySelector('input[name="password"]').dispatchEvent(new Event("input",{bubbles:true}));
        return true; })()
    `);
    await sleep(400);
    await ev(`document.querySelector("form").requestSubmit(), true`);
    for (let i = 0; i < 60; i++) { await sleep(500); if ((await ev("location.pathname")) !== "/login") break; }
    await sleep(1200);
  }
}
/** 在页面上下文（带会话）调 API */
const api = (qs) =>
  ev(`fetch('/api/feedback/data${qs}',{credentials:'same-origin',cache:'no-store'}).then(r=>r.json().then(j=>({status:r.status,...j})))`);

const db = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
await db.auth.signInWithPassword({ email: adminEmail, password: PASSWORD });

// 用权威查库确定期望值，避免凭记忆写断言
const dbCount = async (build) => {
  let q = db.from("feedback_keywords").select("*", { count: "exact", head: true }).is("archived_at", null);
  const { count } = await build(q);
  return count;
};
const EXPECT = {
  // 数学高中：不带教材/章节归属的通用词（内容类的通用词 + 6 个通用分类）
  mathSeniorGenericContent: await dbCount((q) => q.eq("subject", "math").eq("stage", "senior").eq("category", "课堂内容").is("chapter_id", null)),
  mathSeniorGenericNext: await dbCount((q) => q.eq("subject", "math").eq("stage", "senior").eq("category", "下节课内容").is("chapter_id", null)),
  mathSeniorPerf: await dbCount((q) => q.eq("subject", "math").eq("stage", "senior").eq("category", "课堂表现（正面）")),
  // 教材数从库里查，不写死。写死会随数据增长而失效：
  // 从前这里断言 10 / 3 / 1，而库里实际已是 29 / 21 / 6（多出的是 name='-' 的占位教材），
  // 接口并没有过滤错 —— 是断言本身过时了。
  mathSeniorBooks: (await db.from("feedback_textbooks").select("*", { count: "exact", head: true }).eq("stage", "senior").eq("subject", "math")).count,
  mathJuniorBooks: (await db.from("feedback_textbooks").select("*", { count: "exact", head: true }).eq("stage", "junior").eq("subject", "math")).count,
  chineseSeniorBooks: (await db.from("feedback_textbooks").select("*", { count: "exact", head: true }).eq("stage", "senior").eq("subject", "chinese")).count,
};
const bookRow = (await db.from("feedback_textbooks").select("id, version, name")
  .eq("version", "人教A版").eq("name", "必修第一册").maybeSingle()).data;
if (!bookRow) { console.log("❌ 未找到「人教A版 · 必修第一册」，请确认 0006 已执行"); process.exit(2); }
EXPECT.book1Chapters = (await db.from("feedback_chapters").select("*", { count: "exact", head: true }).eq("textbook_id", bookRow.id)).count;
EXPECT.book1Content = await dbCount((q) => q.eq("textbook_id", bookRow.id).eq("category", "课堂内容"));
console.log("权威期望值:", JSON.stringify(EXPECT));

try {
  await login(adminEmail);

  // ============ 1. 维度参数现在是必传的 ============
  console.log("\n--- 1. 不带参数必须被拒绝 ---");
  {
    // 从前这里是「向后兼容：不带参数返回整棵 keywordTree」。
    // 但那个分支受 PostgREST 1000 行上限影响，8992 行里只返回 1000 行
    // （静默丢 89% 数据，旧断言写的 634 条早已不符），故改为强制带维度参数。
    const j = await api("");
    record("不带参数返回 400", j.status === 400, `status=${j.status}`);
    record("400 带 scope_required 标记", j.code === "scope_required", `code=${j.code}`);
    record("不再返回残缺的 keywordTree", !j.keywordTree, `keywordTree=${j.keywordTree ? "有" : "无"}`);
  }

  // ============ 2. 按学段+科目过滤 ============
  console.log("\n--- 2. 维度过滤 ---");
  {
    const j = await api("?stage=senior&subject=math");
    record("stage/subject 生效", j.ok === true && j.stage === "senior" && j.subject === "math", `stage=${j.stage} subject=${j.subject}`);
    record("返回 8 个分类（来自数据库）", (j.categories ?? []).length === 8, `${(j.categories ?? []).length}`);
    record("hasTextbook=true（数学有教材）", j.hasTextbook === true, `${j.hasTextbook}`);
    record(`返回 ${EXPECT.mathSeniorBooks} 本数学教材（按 subject 过滤）`, (j.textbooks ?? []).length === EXPECT.mathSeniorBooks, `${(j.textbooks ?? []).length} 本`);
    record("未选章节时章节清单为空", (j.chapters ?? []).length === 0, `${(j.chapters ?? []).length}`);
    const content = j.categoryKeywords?.["课堂内容"] ?? [];
    const next = j.categoryKeywords?.["下节课内容"] ?? [];
    record(`课堂内容 = 通用内容词 ${EXPECT.mathSeniorGenericContent} 条`, content.length === EXPECT.mathSeniorGenericContent, `${content.length} 条`);
    record(`下节课内容 = 通用内容词 ${EXPECT.mathSeniorGenericNext} 条`, next.length === EXPECT.mathSeniorGenericNext, `${next.length} 条`);
    record("通用内容词不含章节词（无『集合的概念与关系』）", !content.includes("集合的概念与关系") && !next.includes("集合的概念与关系"), "");
    const perf = j.categoryKeywords?.["课堂表现（正面）"] ?? [];
    record(`通用分类词数正确（课堂表现正面 ${EXPECT.mathSeniorPerf}）`, perf.length === EXPECT.mathSeniorPerf, `${perf.length}`);
  }

  // ============ 3. 选教材 ============
  console.log("\n--- 3. 选教材 ---");
  let bookId = null;
  {
    const j0 = await api("?stage=senior&subject=math");
    const book = (j0.textbooks ?? []).find((t) => t.version === "人教A版" && t.name === "必修第一册");
    bookId = book?.id ?? null;
    record("找到「人教A版 必修第一册」", bookId !== null, `id=${bookId}`);

    const j = await api(`?stage=senior&subject=math&textbook=${bookId}`);
    record(`该教材返回 ${EXPECT.book1Chapters} 个章节`, (j.chapters ?? []).length === EXPECT.book1Chapters, `${(j.chapters ?? []).length}`);
    record(`选定教材后课堂内容 = ${EXPECT.book1Content} 条（该书该分类全部章节词）`,
      (j.categoryKeywords?.["课堂内容"] ?? []).length === EXPECT.book1Content,
      `${(j.categoryKeywords?.["课堂内容"] ?? []).length}`);
    record("含『集合的概念与关系』", (j.categoryKeywords?.["课堂内容"] ?? []).includes("集合的概念与关系"), "");
    record("不含通用内容词『综合练习』（避免与章节词混淆）", !(j.categoryKeywords?.["课堂内容"] ?? []).includes("综合练习"), "");
    record("selectedTextbookId 回显", j.selectedTextbookId === bookId, `${j.selectedTextbookId}`);
  }

  // ============ 4. 选章节 ============
  console.log("\n--- 4. 选章节 ---");
  {
    const jBook = await api(`?stage=senior&subject=math&textbook=${bookId}`);
    const ch = (jBook.chapters ?? []).find((c) => c.name === "集合的基本运算") ?? jBook.chapters?.[1];
    const j = await api(`?stage=senior&subject=math&textbook=${bookId}&chapter=${ch.id}`);
    record("选定章节后课堂内容 = 1 条（该章词）", (j.categoryKeywords?.["课堂内容"] ?? []).length === 1,
      `${(j.categoryKeywords?.["课堂内容"] ?? []).length}`);
    record("该章词正确", (j.categoryKeywords?.["课堂内容"] ?? [])[0] === ch.name, `${(j.categoryKeywords?.["课堂内容"] ?? [])[0]}`);
    record("下节课内容同样 = 1 条", (j.categoryKeywords?.["下节课内容"] ?? []).length === 1, `${(j.categoryKeywords?.["下节课内容"] ?? []).length}`);
    record("通用分类不受章节影响（课堂表现正面）", (j.categoryKeywords?.["课堂表现（正面）"] ?? []).length === EXPECT.mathSeniorPerf,
      `${(j.categoryKeywords?.["课堂表现（正面）"] ?? []).length}`);
    record("selectedChapterId 回显", j.selectedChapterId === ch.id, `${j.selectedChapterId}`);
  }

  // ============ 5. 无教材科目 ============
  console.log("\n--- 5. 无教材/其它科目 ---");
  {
    const j = await api("?stage=junior&subject=politics");
    record("初中政治不报错", j.ok === true, `status=${j.status}`);
    record("初中政治教材为空（政治无初中）", (j.textbooks ?? []).length === 0, `${(j.textbooks ?? []).length}`);
    const j2 = await api("?stage=senior&subject=general");
    record("通用科目 hasTextbook=false", j2.hasTextbook === false, `${j2.hasTextbook}`);
    const j3 = await api("?stage=junior&subject=math");
    record(`初中数学有 ${EXPECT.mathJuniorBooks} 本教材`, (j3.textbooks ?? []).length === EXPECT.mathJuniorBooks, `${(j3.textbooks ?? []).length}`);
    const j4 = await api("?stage=senior&subject=chinese");
    record(`高中语文有 ${EXPECT.chineseSeniorBooks} 本教材`, (j4.textbooks ?? []).length === EXPECT.chineseSeniorBooks, `${(j4.textbooks ?? []).length}`);
  }

  // ============ 6. 非法参数被忽略 ============
  console.log("\n--- 6. 非法参数 ---");
  {
    const j = await api("?stage=xxx&subject=__bad__&textbook=-1&chapter=abc");
    record("非法参数被忽略但仍成功", j.ok === true && j.stage === null && j.subject === null, `stage=${j.stage} subject=${j.subject}`);
    const j2 = await api("?stage=senior&subject=mathscript");
    record("未注册科目被忽略", j2.subject === null, `${j2.subject}`);
  }

  // ============ 7. RLS 越权（普通用户）============
  console.log("\n--- 7. RLS 越权 ---");
  {
    await login(userEmail);
    const j = await api("?stage=senior&subject=math");
    record("普通用户可读维度数据", j.ok === true && (j.textbooks ?? []).length === EXPECT.mathSeniorBooks, `教材 ${(j.textbooks ?? []).length}`);
    record("普通用户非管理员", j.isAdmin === false, `${j.isAdmin}`);
  }
  {
    const ub = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
    await ub.auth.signInWithPassword({ email: userEmail, password: PASSWORD });
    const w = await ub.from("feedback_textbooks").insert({ stage: "senior", subject: "math", name: "__越权__", sort_order: 999 }).select();
    record("普通用户写教材被拒 42501", w.error?.code === "42501", w.error?.code ?? "竟然成功");
    const w2 = await ub.from("feedback_chapters").insert({ textbook_id: 1, name: "__越权__", sort_order: 999 }).select();
    record("普通用户写章节被拒 42501", w2.error?.code === "42501", w2.error?.code ?? "竟然成功");
    const w3 = await ub.from("feedback_categories").insert({ name: "__越权__", sort_order: 999 }).select();
    record("普通用户写分类被拒 42501", w3.error?.code === "42501", w3.error?.code ?? "竟然成功");
  }
  {
    // 归档词不能通过接口拿到（关键安全点）
    const r = await fetch(`${BASE}/api/feedback/data?stage=senior&subject=math`);
    const txt = await r.text();
    record("归档词『二模试卷讲解』未出现在接口响应", !txt.includes("二模试卷讲解"), "");
  }

  // ============ 8. 管理员可写 ============
  console.log("\n--- 8. 管理员可写 ---");
  {
    const book = (await db.from("feedback_textbooks").select("id,version,name").eq("version", "人教A版").eq("name", "必修第一册").maybeSingle()).data;
    const upd = await db.from("feedback_textbooks").update({ sort_order: 11 }).eq("id", book.id).select("id,sort_order");
    record("管理员可改教材（改名/排序）", (upd.data ?? []).length === 1, JSON.stringify(upd.data?.[0] ?? upd.error));
    await db.from("feedback_textbooks").update({ sort_order: 10 }).eq("id", book.id);
    const ins = await db.from("feedback_chapters").insert({ textbook_id: book.id, name: "__测试章节__", sort_order: 999 }).select("id");
    record("管理员可加章节", (ins.data ?? []).length === 1, JSON.stringify(ins.data?.[0] ?? ins.error));
    if (ins.data?.[0]) await db.from("feedback_chapters").delete().eq("id", ins.data[0].id);
    const cat = await db.from("feedback_categories").insert({ name: "__测试分类__", sort_order: 999 }).select("id");
    record("管理员可加分类", (cat.data ?? []).length === 1, JSON.stringify(cat.data?.[0] ?? cat.error));
    if (cat.data?.[0]) await db.from("feedback_categories").delete().eq("id", cat.data[0].id);
  }
} catch (err) {
  console.error("测试异常:", err.message);
} finally {
  try { await cdp.send("Browser.close"); } catch { edge.kill(); }
  srv.kill();
}

console.log("\n=== SUMMARY ===");
const passed = results.filter((r) => r.pass).length;
console.log(`${passed}/${results.length} passed`);
process.exit(passed === results.length && results.length > 0 ? 0 : 1);
