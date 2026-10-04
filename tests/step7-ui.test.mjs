// 第 4-5 步端到端验证：管理页级联选择 + 工具页「学段 × 科目 × 教材」
import { readFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { createClient } from "@supabase/supabase-js";

const BASE = "http://127.0.0.1:3000";
const CDP_PORT = "9396";
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const USER_DATA = "D:/my-website/.edge-profile-step45";

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
async function goto(p, w = 4000) {
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
/** 工具页 iframe 的 DOM 查询 */
const inTool = (body) =>
  ev(`
    (() => {
      const f=document.querySelector('iframe'); if(!f) return {__err:'无 iframe'};
      const doc=f.contentDocument; if(!doc) return {__err:'无 contentDocument'};
      const w=f.contentWindow;
      try { ${body} } catch(e){ return {__err:String(e && e.message || e)}; }
    })()
  `);

const db = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
await db.auth.signInWithPassword({ email: adminEmail, password: PASSWORD });
const bookRow = (await db.from("feedback_textbooks").select("id,version,name").eq("version", "人教A版").eq("name", "必修第一册").maybeSingle()).data;
const chRow = (await db.from("feedback_chapters").select("id,name").eq("textbook_id", bookRow.id).order("sort_order").limit(1).maybeSingle()).data;
console.log(`测试教材 id=${bookRow.id} 章节 id=${chRow.id} (${chRow.name})`);

const TEST_KW = "__第7步章节关键词__";

try {
  // ================= A. 管理页 =================
  console.log("\n--- A. 管理页级联选择 ---");
  await login(adminEmail);

  await goto("/admin/feedback-keywords");
  {
    const hasStage = await ev(`!!document.querySelector('#stageSelect, select[aria-label="科目"]')`);
    record("管理页有学段/科目选择器", hasStage === true, "");
    const text = await ev("document.body.innerText");
    record("显示概况统计", /共 \d+ 个关键词/.test(text) && /教材/.test(text), text.split("\n").find((l) => /共 \d+ 个关键词/.test(l))?.slice(0, 60) ?? "");
    record("未选科目时提示先选", /请先在上方选择/.test(text), "");
  }

  await goto("/admin/feedback-keywords?stage=senior&subject=math", 5000);
  {
    const info = await ev(`
      (() => {
        const tb = document.querySelector('select[aria-label="教材版本"]');
        return { hasTextbookSelect: !!tb, options: tb ? tb.options.length : 0 };
      })()
    `);
    record("高中·数学 出现教材下拉", info.hasTextbookSelect === true, `${info.options} 项`);
    const cats = await ev(`[...document.querySelectorAll('section header button')].map(b=>b.textContent.replace(/[▼▶]/g,'').trim()).filter(t=>/课堂|表现|评价|建议|作业|下节课/.test(t))`);
    record("显示 8 个通用分类", (cats ?? []).length >= 8, `${(cats ?? []).length} 个`);
  }

  await goto(`/admin/feedback-keywords?stage=senior&subject=math&textbook=${bookRow.id}`, 5500);
  {
    const j = await ev(`
      (() => {
        const chSel = document.querySelector('select[aria-label="章节"]');
        const chips = [...document.querySelectorAll('a[href*="chapter="]')].length;
        return { hasChapterSelect: !!chSel, chapterOptions: chSel ? chSel.options.length : 0, chapterChips: chips };
      })()
    `);
    record("选教材后出现章节下拉", j.hasChapterSelect === true, `${j.chapterOptions} 项`);
    record("章节快捷链接渲染", j.chapterChips >= 20, `${j.chapterChips} 个`);
  }

  await goto(`/admin/feedback-keywords?stage=senior&subject=math&textbook=${bookRow.id}&chapter=${chRow.id}`, 5500);
  {
    // 新增一个章节关键词
    const addRes = await ev(`
      (() => {
        const form = [...document.querySelectorAll('form')].find(f=>{
          const i=f.querySelector('input[name="keyword"]');
          const c=f.querySelector('input[name="category"]');
          return i && c && c.value === '课堂内容';
        });
        if(!form) return '未找到表单';
        const inp = form.querySelector('input[name="keyword"]');
        const d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value');
        d.set.call(inp, ${JSON.stringify(TEST_KW)});
        inp.dispatchEvent(new Event('input',{bubbles:true}));
        [...form.querySelectorAll('button')].find(b=>/添加/.test(b.textContent)).click();
        return 'ok';
      })()
    `);
    await sleep(2600);
    const rows = await db.from("feedback_keywords").select("id, category, chapter_id").eq("keyword", TEST_KW);
    record("章节新增表单可提交", addRes === "ok", String(addRes));
    record("章节关键词写入两个内容分类", (rows.data ?? []).length === 2, `${(rows.data ?? []).length} 行`);
    record("两行都归属该章节", (rows.data ?? []).every((r) => r.chapter_id === chRow.id), JSON.stringify((rows.data ?? []).map((r) => r.chapter_id)));
  }

  {
    // 删除刚加的章节关键词（应一次删掉两行）
    // 先重新加载页面，确保拿到包含新增关键词的最新渲染
    await goto(`/admin/feedback-keywords?stage=senior&subject=math&textbook=${bookRow.id}&chapter=${chRow.id}`, 6000);
    const delRes = await ev(`
      (() => {
        try {
          window.confirm = () => true;
          const inputs=[...document.querySelectorAll('input[name="keyword"]')];
          // 新增表单的输入框是非受控的，提交后 value 仍留在 DOM 里，
          // 所以必须排除它在的那一行，只挑「保存」行（KeywordItem）
          const hit = inputs
            .map(i=>({t:i, li:i.closest('li')}))
            .find(x => x.li && x.t.value === ${JSON.stringify(TEST_KW)});
          if(!hit) {
            const rows = [...document.querySelectorAll('input[name="keyword"]')].filter(i=>i.closest('li'));
            const sections = [...document.querySelectorAll('section')].map(s=>{
              const h=[...s.querySelectorAll('header button')][0];
              const n=[...s.querySelectorAll('input[name="keyword"]')].filter(i=>i.closest('li')).length;
              return (h?h.textContent.replace(/[▼▶]/g,'').trim():'?') + ':' + n;
            });
            return '未找到目标行 | 行数=' + rows.length + ' | 值=' + JSON.stringify(rows.map(i=>i.value))
              + ' | 分区=' + JSON.stringify(sections);
          }
          const btn=[...hit.li.querySelectorAll('button')].find(b=>/删除/.test(b.textContent));
          if(!btn) return '未找到删除按钮';
          btn.click();
          return 'ok';
        } catch(e) { return 'ERR: ' + (e && e.message || e); }
      })()
    `);
    await sleep(3000);
    const left = await db.from("feedback_keywords").select("id, category").eq("keyword", TEST_KW);
    const msg = await ev(`
      (() => {
        const inputs=[...document.querySelectorAll('input[name="keyword"]')];
        const t=inputs.find(i=>i.value === ${JSON.stringify(TEST_KW)});
        return t ? (t.closest('li').innerText.replace(/\\s+/g,' ').slice(0,120)) : '(该行已从界面消失)';
      })()
    `);
    record("删除按钮可点击", delRes === "ok", String(delRes));
    record("删除章节关键词一次删两行", (left.data ?? []).length === 0, `剩 ${(left.data ?? []).length} 行 ${JSON.stringify((left.data ?? []).map((r) => r.category))} | 界面: ${msg}`);
  }

  {
    // 教材改名（两级：version + name 两个输入框）
    const newVersion = "人教A版（改名测试）";
    const newVolume = "必修第一册（改名测试）";
    await ev(`
      (() => {
        const b=[...document.querySelectorAll('button')].find(x=>/教材与章节管理/.test(x.textContent));
        if(b) b.click();
        return true;
      })()
    `);
    await sleep(600);
    const r = await ev(`
      (() => {
        const inputs=[...document.querySelectorAll('input[name="name"]')];
        const t=inputs.find(i=>i.value === '必修第一册');
        if(!t) return '未找到册次输入框: ' + JSON.stringify(inputs.map(i=>i.value));
        const form = t.closest('form');
        const verInput = form.querySelector('input[name="version"]');
        const d=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value');
        if(verInput){ d.set.call(verInput, ${JSON.stringify(newVersion)}); verInput.dispatchEvent(new Event('input',{bubbles:true})); }
        d.set.call(t, ${JSON.stringify(newVolume)});
        t.dispatchEvent(new Event('input',{bubbles:true}));
        [...form.querySelectorAll('button')].find(b=>/保存/.test(b.textContent)).click();
        return 'ok';
      })()
    `);
    await sleep(2600);
    const after = await db.from("feedback_textbooks").select("version,name").eq("id", bookRow.id).maybeSingle();
    record("管理页可改教材版本+册次", r === "ok" && after.data?.version === newVersion && after.data?.name === newVolume,
      `${after.data?.version} / ${after.data?.name}`);
    // 改回
    await db.from("feedback_textbooks").update({ version: "人教A版", name: "必修第一册" }).eq("id", bookRow.id);
    const back = await db.from("feedback_textbooks").select("version,name").eq("id", bookRow.id).maybeSingle();
    record("教材名已还原", back.data?.version === "人教A版" && back.data?.name === "必修第一册",
      `${back.data?.version} / ${back.data?.name}`);
  }

  // ================= B. 工具页 =================
  console.log("\n--- B. 工具页 学段/科目/教材 ---");
  // 工具页把学段/科目记在 localStorage；先清掉，避免被同一浏览器上一次的测试污染
  await goto("/tools/feedback", 1500);
  await ev(`localStorage.removeItem('fb_stage_v1'); localStorage.removeItem('fb_subject_v1'); localStorage.removeItem('fb_textbook_v1'); localStorage.removeItem('fb_chapter_v1'); true`);
  await goto("/tools/feedback", 7000);
  {
    const s = await inTool(`
      return {
        hasStage: !!doc.getElementById('stageSelect'),
        stageValue: doc.getElementById('stageSelect')?.value ?? '',
        subjectOptions: [...(doc.getElementById('subjectSelect')?.options ?? [])].map(o=>o.value+':'+o.text),
        tbFieldVisible: (doc.getElementById('textbookField')?.style.display ?? 'none') !== 'none',
        badge: doc.getElementById('modeBadge')?.textContent ?? '',
        syncHint: doc.getElementById('syncHint')?.textContent ?? '',
      };
    `);
    record("工具页有学段下拉", s.hasStage === true, `当前=${s.stageValue}`);
    record("科目下拉含九大科目（含生物/地理）", s.subjectOptions.some((o) => o.startsWith("biology:")) && s.subjectOptions.some((o) => o.startsWith("geography:")), s.subjectOptions.join(" "));
    record("科目不含「通用」", !s.subjectOptions.some((o) => o.startsWith("general:")), "");
    record("云端模式徽章", /云端/.test(String(s.badge)), String(s.badge));
    record("显示已载入云端数据", /已载入云端数据/.test(String(s.syncHint)), String(s.syncHint).slice(0, 70));
  }

  {
    // 切到数学（高中）应出现教材下拉
    const s = await inTool(`
      const sel=doc.getElementById('subjectSelect');
      const d=Object.getOwnPropertyDescriptor(w.HTMLSelectElement.prototype,'value');
      d.set.call(sel,'math'); sel.dispatchEvent(new w.Event('change',{bubbles:true}));
      return 'ok';
    `);
    await sleep(3500);
    const t = await inTool(`
      const field=doc.getElementById('textbookField');
      const ver=doc.getElementById('textbookVersionSelect');
      const vol=doc.getElementById('textbookSelect');
      return {
        visible: (field?.style.display ?? 'none') !== 'none',
        versions: [...(ver?.options ?? [])].map(o=>o.value+':'+o.text),
        volVisible: (vol?.style.display ?? 'none') !== 'none',
        syncHint: doc.getElementById('syncHint')?.textContent ?? '',
        contentCount: [...doc.querySelectorAll('#generateCategories input[type=checkbox]')].length,
      };
    `);
    record("数学显示教材版本下拉", t.visible === true, `${t.versions.length} 项`);
    record("教材版本下拉含 5 个数学版本", t.versions.some((o) => o.includes("人教A版")) && t.versions.some((o) => o.includes("湘教版")), t.versions.join(" | "));
    record("未选版本时册次下拉隐藏", t.volVisible === false, "");
    record("未选教材时显示通用内容词", t.contentCount >= 45, `${t.contentCount} 个复选框`);
  }

  {
    // 两级下拉：先选版本 → 册次出现 → 再选册次
    await inTool(`
      const ver=doc.getElementById('textbookVersionSelect');
      if(!ver) return '无版本下拉';
      const dv=Object.getOwnPropertyDescriptor(w.HTMLSelectElement.prototype,'value');
      dv.set.call(ver,'人教A版'); ver.dispatchEvent(new w.Event('change',{bubbles:true}));
      return 'ok';
    `);
    await sleep(4500);
    const r = await inTool(`
      const ts=doc.getElementById('textbookSelect');
      if((ts?.style.display ?? 'none') === 'none') return {err:'册次下拉未出现'};
      const opt=[...ts.options].find(o=>o.text === '必修第一册');
      if(!opt) return {err:'未找到必修第一册', options:[...ts.options].map(o=>o.text)};
      const d=Object.getOwnPropertyDescriptor(w.HTMLSelectElement.prototype,'value');
      d.set.call(ts, opt.value); ts.dispatchEvent(new w.Event('change',{bubbles:true}));
      return {ok:true, picked: opt.text};
    `);
    await sleep(4000);
    const t = await inTool(`
      const boxes=[...doc.querySelectorAll('#generateCategories input[type=checkbox]')];
      const kws=boxes.map(b=>b.dataset.keyword).filter(Boolean);
      return {
        total: boxes.length,
        hasSet: kws.includes('集合的概念与关系'),
        hasGeneral: kws.includes('综合练习'),
        syncHint: doc.getElementById('syncHint')?.textContent ?? '',
      };
    `);
    record("选教材后载入章节词", t.hasSet === true, `共 ${t.total} 个复选框`);
    record("章节词替代了通用词（无『综合练习』）", t.hasGeneral === false, "");
    record("状态行显示已限定教材", /已限定教材/.test(String(t.syncHint)), String(t.syncHint).slice(0, 80));
  }

  {
    // 切到语文：语文本应也有教材（统编版），验证科目切换清空
    const r = await inTool(`
      const sel=doc.getElementById('subjectSelect');
      const d=Object.getOwnPropertyDescriptor(w.HTMLSelectElement.prototype,'value');
      d.set.call(sel,'chinese'); sel.dispatchEvent(new w.Event('change',{bubbles:true}));
      return 'ok';
    `);
    // 等版本下拉真正切到语文的教材（统编版），避免读到上一个科目的残留
    let verOpts = [];
    for (let i = 0; i < 20; i++) {
      await sleep(500);
      verOpts = await inTool(`return [...(doc.getElementById('textbookVersionSelect')?.options ?? [])].map(o=>o.text)`);
      if (Array.isArray(verOpts) && verOpts.some((o) => o.includes("统编版"))) break;
    }
    const t = await inTool(`
      const field=doc.getElementById('textbookField');
      const ver=doc.getElementById('textbookVersionSelect');
      const vol=doc.getElementById('textbookSelect');
      return {
        visible: (field?.style.display ?? 'none') !== 'none',
        versions: [...(ver?.options ?? [])].map(o=>o.text),
        volVisible: (vol?.style.display ?? 'none') !== 'none',
        checked: [...doc.querySelectorAll('#generateCategories input[type=checkbox]')].filter(b=>b.checked).length,
        subject: doc.getElementById('subjectSelect')?.value ?? '',
      };
    `);
    record("切到语文成功", t.subject === "chinese", t.subject);
    record("语文显示统编版教材版本", t.visible === true && t.versions.some((o) => o.includes("统编版")), t.versions.join(" | "));
    record("语文不显示册次下拉（单册版本）", t.volVisible === false, "");
    record("切换科目后已选清空", t.checked === 0, `已选 ${t.checked}`);
  }

  {
    // 切到初中：科目列表应变化（政治无初中）
    const r = await inTool(`
      const sel=doc.getElementById('stageSelect');
      const d=Object.getOwnPropertyDescriptor(w.HTMLSelectElement.prototype,'value');
      d.set.call(sel,'junior'); sel.dispatchEvent(new w.Event('change',{bubbles:true}));
      return 'ok';
    `);
    await sleep(3500);
    const t = await inTool(`
      return {
        stage: doc.getElementById('stageSelect')?.value ?? '',
        subjects: [...(doc.getElementById('subjectSelect')?.options ?? [])].map(o=>o.value),
        subject: doc.getElementById('subjectSelect')?.value ?? '',
      };
    `);
    record("切到初中学段生效", t.stage === "junior", t.stage);
    record("初中科目列表不含政治", !t.subjects.includes("politics"), t.subjects.join(","));
    record("初中默认科目已重置", t.subjects.includes(t.subject), `subject=${t.subject}`);
  }

  // ================= C. 免费用户 =================
  console.log("\n--- C. 免费用户 ---");
  {
    await db.from("user_roles").update({ plan: "free", expires_at: null }).eq("user_id", (await db.rpc("admin_list_users")).data.find((u) => u.email === adminEmail)?.user_id);
    await login(userEmail);
    await goto("/tools/feedback", 1500);
    await ev(`localStorage.removeItem('fb_stage_v1'); localStorage.removeItem('fb_subject_v1'); localStorage.removeItem('fb_textbook_v1'); localStorage.removeItem('fb_chapter_v1'); true`);
    await goto("/tools/feedback", 7000);
    const url = await ev("location.pathname + location.search");
    record("免费用户可打开工具页（不再被引导升级）", url === "/tools/feedback", url);
    const s = await inTool(`
      return {
        hasStage: !!doc.getElementById('stageSelect'),
        modeBadge: doc.getElementById('modeBadge')?.textContent ?? '',
        keywords: [...doc.querySelectorAll('#generateCategories input[type=checkbox]')].length,
        aiHint: (()=>{ const b=[...doc.querySelectorAll('button')].find(x=>/AI/.test(x.textContent)); return b ? '有AI按钮' : '无AI按钮'; })(),
      };
    `);
    record("免费用户也能选学段/科目并看到关键词", s.hasStage === true && s.keywords > 30, `关键词 ${s.keywords} 个`);
    const ai = await ev(`fetch('/api/feedback/ai',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:'测试',prompt:'润色'})}).then(r=>r.status)`);
    record("免费用户调 AI 仍被拒 403", ai === 403, `HTTP ${ai}`);
  }
} catch (err) {
  console.error("测试异常:", err.message);
} finally {
  try { await db.from("feedback_keywords").delete().eq("keyword", TEST_KW); } catch { /* ignore */ }
  try {
    const { data: list } = await db.rpc("admin_list_users");
    const aid = list.find((u) => u.email === adminEmail)?.user_id;
    await db.from("user_roles").update({ plan: "free", expires_at: null, status: "active" }).eq("user_id", aid);
  } catch { /* ignore */ }
  try { await db.from("feedback_textbooks").update({ name: "必修第一册" }).eq("id", bookRow.id); } catch { /* ignore */ }
  try { await cdp.send("Browser.close"); } catch { edge.kill(); }
  srv.kill();
}

console.log("\n=== SUMMARY ===");
const passed = results.filter((r) => r.pass).length;
console.log(`${passed}/${results.length} passed`);
process.exit(passed === results.length && results.length > 0 ? 0 : 1);
