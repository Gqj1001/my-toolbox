// 试卷分析工作台接入验证
//   1. /api/paper-analysis/mode        结构与 hasKey
//   2. /api/paper-analysis/parse-file  docx 真实解析（用工具自带的模板 docx）/ pdf / doc / 异常
//   3. /api/paper-analysis/ai-advice   鉴权（401 / 403 / VIP）
//   4. /api/paper-analysis/vision-scores 降级提示
//   5. 页面与静态资源
//   6. 浏览器端到端：iframe 加载 + 模式徽章 + 接口基址
import { readFileSync, existsSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { createClient } from "@supabase/supabase-js";

const BASE = "http://127.0.0.1:3000";
const CDP_PORT = "9420";
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const USER_DATA = "D:/my-website/.edge-profile-paper";
const PROJECT = "D:/my-website/my-toolbox";
const TEMPLATE_DOCX = `${PROJECT}/public/tools/paper-analysis/templates/模板-占位符.docx`;

const env = readFileSync(`${PROJECT}/.env.local`, "utf8").split(/\r?\n/);
const SUPABASE_URL = env.find((l) => l.startsWith("NEXT_PUBLIC_SUPABASE_URL=")).split("=")[1].trim();
const ANON_KEY = env.find((l) => l.startsWith("NEXT_PUBLIC_SUPABASE_ANON_KEY=")).split("=").slice(1).join("=").trim();
const info = JSON.parse(readFileSync(`${PROJECT}/.test-users.json`, "utf8"));
const adminEmail = info.users.find((u) => u.email.startsWith("rolea-")).email;
const userEmail = info.users.find((u) => u.email.startsWith("roleb-")).email;
const PASSWORD = info.password;

const results = [];
const rec = (name, pass, detail) => { results.push({ name, pass }); console.log(`${pass ? "PASS" : "FAIL"} | ${name}${detail ? ` | ${detail}` : ""}`); };

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.events = [];
    ws.addEventListener("message", (e) => { const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) { const { resolve, reject } = this.pending.get(m.id); this.pending.delete(m.id);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result); } else if (m.method) this.events.push(m); }); }
  send(method, params = {}, sessionId) { const id = ++this.id;
    return new Promise((res, rej) => { this.pending.set(id, { resolve: res, reject: rej });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      setTimeout(() => this.pending.has(id) && (this.pending.delete(id), rej(new Error("timeout " + method))), 60000); }); }
  waitForEvent(method, t = 20000) { const hit = () => this.events.find((e) => e.method === method);
    if (hit()) return Promise.resolve(hit().params);
    return new Promise((res, rej) => { const t0 = Date.now();
      const tick = () => { if (hit()) return res(hit().params); if (Date.now() - t0 > t) return rej(new Error("timeout")); setTimeout(tick, 100); }; tick(); }); }
  clear() { this.events = []; }
}
async function connect() {
  const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
  const { webSocketDebuggerUrl } = await r.json();
  const ws = new WebSocket(webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); });
  return new CDP(ws);
}

// ---------- 启动生产服务器 ----------
const pid = spawnSync("powershell", ["-NoProfile", "-Command", "(Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue).OwningProcess"], { encoding: "utf8" }).stdout.trim();
if (pid) spawnSync("powershell", ["-NoProfile", "-Command", `Stop-Process -Id ${pid} -Force`], { encoding: "utf8" });
await sleep(2000);
const srv = spawn("C:\\Users\\郭庆杰\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\node\\bin\\node.exe",
  [`${PROJECT}/node_modules/next/dist/bin/next`, "start", "-p", "3000"],
  { cwd: PROJECT, stdio: "ignore" });
for (let i = 0; i < 60; i++) { await sleep(500); try { if ((await fetch(`${BASE}/login`)).status === 200) break; } catch {} }

const db = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
await db.auth.signInWithPassword({ email: adminEmail, password: PASSWORD });

try {
  // ================= 1. tools 表登记 =================
  console.log("\n=== 1. tools 表登记 ===");
  {
    const { data, error } = await db.from("tools")
      .select("name, route, min_plan, active, sort_order").eq("route", "/tools/paper-analysis").maybeSingle();
    rec("tools 表已登记试卷分析", !error && !!data, error ? `${error.code} ${error.message}` : JSON.stringify(data));
    if (data) {
      rec("名称正确", data.name === "试卷分析工作台", data.name);
      rec("min_plan = free", data.min_plan === "free", data.min_plan);
      rec("active = true", data.active === true, String(data.active));
      rec("sort_order = 6", data.sort_order === 6, String(data.sort_order));
    }
    // 确认没有破坏其他工具
    const { data: all } = await db.from("tools").select("route, active").order("sort_order");
    rec("其他工具未被影响（共 8 条）", (all ?? []).length === 8, `${(all ?? []).length} 条`);
  }

  // ================= 2. 未登录访问 =================
  console.log("\n=== 2. 未登录鉴权 ===");
  {
    for (const [label, url, method] of [
      ["mode", "/api/paper-analysis/mode", "GET"],
      ["parse-file", "/api/paper-analysis/parse-file", "POST"],
      ["ai-advice", "/api/paper-analysis/ai-advice", "POST"],
      ["vision-scores", "/api/paper-analysis/vision-scores", "POST"],
    ]) {
      const r = await fetch(BASE + url, { method, headers: { "Content-Type": "application/json" }, body: method === "POST" ? "{}" : undefined });
      rec(`未登录 ${label} 被拒（401）`, r.status === 401, `HTTP ${r.status}`);
    }
    const p = await fetch(`${BASE}/tools/paper-analysis`, { redirect: "manual" });
    rec("未登录访问工具页被重定向", p.status === 307 || p.status === 302, `HTTP ${p.status}`);
  }

  // 用管理员会话登录（拿 cookie 调接口）
  const { data: signIn } = await db.auth.signInWithPassword({ email: adminEmail, password: PASSWORD });
  const cookie = `sb-${new URL(SUPABASE_URL).hostname.split(".")[0]}-auth-token=${encodeURIComponent(JSON.stringify(signIn.session))}`;
  const api = (path, init = {}) => fetch(BASE + path, { ...init, headers: { "Content-Type": "application/json", cookie, ...(init.headers ?? {}) } });

  // ================= 3. mode =================
  console.log("\n=== 3. /mode ===");
  {
    const r = await api("/api/paper-analysis/mode");
    const j = await r.json();
    rec("mode 返回 200", r.status === 200, `HTTP ${r.status}`);
    rec("ok = true", j.ok === true, "");
    rec("mode = next", j.mode === "next", String(j.mode));
    rec("isAdmin = true", j.isAdmin === true, String(j.isAdmin));
    rec("hasKey 是布尔值", typeof j.config?.hasKey === "boolean", String(j.config?.hasKey));
    rec("未配置视觉模型（visionModel 为空）", j.config?.visionModel === "", JSON.stringify(j.config?.visionModel));
    rec("响应体不含 AI Key", !JSON.stringify(j).includes("sk-"), "");
    console.log(`     hasKey=${j.config?.hasKey} model=${j.config?.model} apiBase=${j.config?.apiBase}`);
  }

  // ================= 4. parse-file =================
  console.log("\n=== 4. /parse-file ===");
  {
    // 4.1 真实 docx（工具自带模板）
    if (existsSync(TEMPLATE_DOCX)) {
      const buf = readFileSync(TEMPLATE_DOCX);
      const dataUrl = "data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64," + buf.toString("base64");
      const r = await api("/api/paper-analysis/parse-file", {
        method: "POST",
        body: JSON.stringify({ name: "模板-占位符.docx", data: dataUrl }),
      });
      const j = await r.json();
      rec("docx 解析返回 200", r.status === 200, `HTTP ${r.status}`);
      rec("kind = docx", j.kind === "docx", String(j.kind));
      rec("抽到了文本", typeof j.text === "string" && j.text.length > 20, `${j.text?.length ?? 0} 字`);
      rec("表格被包成 <TABLE>", j.text.includes("<TABLE>"), j.text.includes("<TABLE>") ? "有" : "无");
      const sample = (j.text || "").split("\n").filter(Boolean).slice(0, 3);
      console.log(`     抽到 ${j.text.length} 字，样例: ${JSON.stringify(sample)}`);
      rec("抽到的文本可读（含中文）", /[\u4e00-\u9fa5]/.test(j.text), "");
    } else {
      rec("模板 docx 存在", false, TEMPLATE_DOCX);
    }

    // 4.2 假 PDF（走 extractPdfText，应返回空文本 + 提示，不抛错）
    {
      const fake = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF");
      const r = await api("/api/paper-analysis/parse-file", {
        method: "POST",
        body: JSON.stringify({ name: "x.pdf", data: "data:application/pdf;base64," + fake.toString("base64") }),
      });
      const j = await r.json();
      rec("假 PDF 返回 200 且 kind=pdf", r.status === 200 && j.kind === "pdf", `HTTP ${r.status} kind=${j.kind}`);
      rec("假 PDF 给出可操作提示", typeof j.note === "string" && j.note.length > 0, (j.note || "").slice(0, 40));
    }

    // 4.3 .doc（走 extractLegacyDocText，二进制噪声不应崩）
    {
      const fake = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, ...Array(2000).fill(0x41)]);
      const r = await api("/api/paper-analysis/parse-file", {
        method: "POST",
        body: JSON.stringify({ name: "x.doc", data: "data:application/msword;base64," + fake.toString("base64") }),
      });
      const j = await r.json();
      rec("假 .doc 返回 200 且 kind=doc", r.status === 200 && j.kind === "doc", `HTTP ${r.status} kind=${j.kind}`);
    }

    // 4.4 图片 → 降级提示
    {
      const png = Buffer.from("89504e470d0a1a0a", "hex");
      const r = await api("/api/paper-analysis/parse-file", {
        method: "POST",
        body: JSON.stringify({ name: "x.png", data: "data:image/png;base64," + png.toString("base64") }),
      });
      const j = await r.json();
      rec("图片返回 200 且 kind=image", r.status === 200 && j.kind === "image", `HTTP ${r.status} kind=${j.kind}`);
      rec("图片给出降级提示（未启用视觉）", /未启用|粘贴|docx/.test(j.note || ""), (j.note || "").slice(0, 50));
    }

    // 4.5 未知格式
    {
      const r = await api("/api/paper-analysis/parse-file", {
        method: "POST",
        body: JSON.stringify({ name: "x.txt", data: "data:text/plain;base64,aGVsbG8=" }),
      });
      const j = await r.json();
      rec("未知格式返回 kind=unknown", r.status === 200 && j.kind === "unknown", `kind=${j.kind}`);
    }

    // 4.6 非法 dataURL
    {
      const r = await api("/api/paper-analysis/parse-file", {
        method: "POST",
        body: JSON.stringify({ name: "x.docx", data: "not-a-dataurl" }),
      });
      rec("非法 dataURL 返回 400", r.status === 400, `HTTP ${r.status}`);
    }

    // 4.7 超大文件（Content-Length 拦）
    {
      const big = Buffer.alloc(5 * 1024 * 1024, 0x41);
      const r = await api("/api/paper-analysis/parse-file", {
        method: "POST",
        body: JSON.stringify({ name: "big.pdf", data: "data:application/pdf;base64," + big.toString("base64") }),
      });
      rec("超大文件返回 413", r.status === 413, `HTTP ${r.status}`);
    }
  }

  // ================= 5. ai-advice 鉴权 =================
  console.log("\n=== 5. /ai-advice 鉴权 ===");
  {
    // 5.1 管理员当前不是 VIP → 403
    const { data: list } = await db.rpc("admin_list_users");
    const adminId = list.find((u) => u.email === adminEmail)?.user_id;
    const orig = (await db.from("user_roles").select("plan, expires_at, status").eq("user_id", adminId).maybeSingle()).data;
    await db.from("user_roles").update({ plan: "free", expires_at: null, status: "active" }).eq("user_id", adminId);
    await sleep(600);

    const r1 = await api("/api/paper-analysis/ai-advice", {
      method: "POST",
      body: JSON.stringify({ task: "advice", name: "测试", score: 100, full: 150 }),
    });
    const j1 = await r1.json();
    rec("非会员调用 AI 建议被拒 403", r1.status === 403, `HTTP ${r1.status} ${j1.error ?? ""}`);

    // 5.2 非法 JSON → 400（先升 VIP 以越过鉴权）
    await db.from("user_roles").update({ plan: "vip", expires_at: new Date(Date.now() + 86400000).toISOString(), status: "active" }).eq("user_id", adminId);
    await sleep(600);

    // 注意：路由的检查顺序是「鉴权 → AI_KEY → 入参」，所以本地没配 AI_KEY 时
    // 会在校验入参之前就返回 503。两种环境的期望值不同，分别断言。
    const localKey = Boolean(process.env.AI_KEY);
    const r2 = await api("/api/paper-analysis/ai-advice", { method: "POST", body: "not json{" });
    rec(
      localKey ? "非法 JSON 返回 400" : "无 AI_KEY 时先返回 503（校验顺序正确）",
      r2.status === (localKey ? 400 : 503),
      `HTTP ${r2.status}（本地 AI_KEY=${localKey ? "有" : "无"}）`,
    );

    // 5.3 空诊断数据
    const r3 = await api("/api/paper-analysis/ai-advice", { method: "POST", body: JSON.stringify({}) });
    rec(
      localKey ? "空诊断数据返回 400" : "无 AI_KEY 时先返回 503（校验顺序正确）",
      r3.status === (localKey ? 400 : 503),
      `HTTP ${r3.status}`,
    );

    // 5.4 有效 payload + VIP：本地无 AI_KEY 时应为 503，有 key 时应为 200/502
    const payload = {
      task: "advice", name: "测试学生", subject: "数学", examName: "单元测",
      score: 96, full: 150, scoreRate: "64%",
      band: "中等", bandStrategy: "稳基础", examTypeForSkeleton: "常规",
      attitude: "认真", typeSummary: [{ 题型: "单选题", 题量: 8, 满分: 40, 得分: 32, 得分率: "80%" }],
      modules: [{ 模块: "函数", 满分: 30, 得分: 12, 失分: 18, 题号: [18], 主要失分类型: ["概念不清"], 建议方向: "复习" }],
      blanks: [7], wrongItems: [{ 题号: 18, 题型: "解答题", 分值: 12, 得分: 3, 难度: "0.42", 知识点: ["导数"], 失分类型: ["计算"], 已有原因: "" }],
      teacherNote: "",
    };
    const r4 = await api("/api/paper-analysis/ai-advice", { method: "POST", body: JSON.stringify(payload) });
    const j4 = await r4.json().catch(() => ({}));
    const hasKey = Boolean(process.env.AI_KEY);
    rec(
      "会员调用走通鉴权（503=未配Key / 200=成功 / 502=上游错）",
      [200, 502, 503].includes(r4.status),
      `HTTP ${r4.status} ${j4.error ?? (j4.text ? `返回 ${j4.text.length} 字` : "")}`,
    );
    rec("失败响应不透传上游原文", !/sk-|api\.deepseek|Bearer/.test(JSON.stringify(j4)), JSON.stringify(j4).slice(0, 80));

    // ================= 6. vision-scores 降级（仍处于 VIP 会话内）=================
    console.log("\n=== 6. /vision-scores 降级 ===");
    {
      // 非会员先被 403 拦下 —— 这也是正确行为，单独确认一次
      const rVip = await api("/api/paper-analysis/vision-scores", {
        method: "POST",
        body: JSON.stringify({ image: "data:image/png;base64,AAAA", questions: [] }),
      });
      const jVip = await rVip.json().catch(() => ({}));
      rec(
        "会员访问时因未配视觉模型返回 503 并给出提示",
        rVip.status === 503 && /未启用|多模态/.test(jVip.error || ""),
        `HTTP ${rVip.status} ${jVip.error ?? ""}`,
      );
    }

    // 还原会员状态
    await db.from("user_roles").update(orig ?? { plan: "free", expires_at: null, status: "active" }).eq("user_id", adminId);
    await sleep(600);

    // 非会员再试一次：应在鉴权阶段就被拒（403）
    {
      const r = await api("/api/paper-analysis/vision-scores", {
        method: "POST",
        body: JSON.stringify({ image: "data:image/png;base64,AAAA", questions: [] }),
      });
      rec("非会员访问答题卡识别被拒 403", r.status === 403, `HTTP ${r.status}`);
    }
  }

  // ================= 7. 静态资源 =================
  console.log("\n=== 7. 静态资源 ===");
  {
    const r = await fetch(`${BASE}/tools/paper-analysis/index.html`, { headers: { cookie } });
    rec("index.html 可访问（已登录）", r.status === 200, `HTTP ${r.status}`);
    const html = await r.text();
    rec("index.html 含 app.js 引用", /js\/app\.js/.test(html), "");
    rec("index.html 含 css 引用", /css\/app\.css/.test(html), "");
    rec("index.html 已改为「AI 设置」", html.includes("AI 设置"), "");

    for (const [label, path] of [["app.js", "/tools/paper-analysis/js/app.js"], ["app.css", "/tools/paper-analysis/css/app.css"]]) {
      const rr = await fetch(BASE + path, { headers: { cookie } });
      rec(`${label} 可访问`, rr.status === 200, `HTTP ${rr.status}`);
    }
    // app.js 内容确认
    const app = await (await fetch(`${BASE}/tools/paper-analysis/js/app.js`, { headers: { cookie } })).text();
    rec("app.js 含 NEXT_HOST / API_BASE", app.includes("NEXT_HOST") && app.includes("API_BASE"), "");
    rec("app.js 无残留裸 api/ 调用", !/apiFetch\('api\//.test(app), "");
    rec("app.js 指向 /api/paper-analysis", app.includes("'/api/paper-analysis'"), "");
  }

  // ================= 8. 浏览器端到端 =================
  console.log("\n=== 8. 浏览器端到端 ===");
  {
    const edge = spawn(EDGE, ["--headless=new", `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${USER_DATA}`, "--no-first-run", "--no-default-browser-check", "about:blank"], { stdio: "ignore" });
    let cdp;
    for (let i = 0; i < 40; i++) { await sleep(500); try { cdp = await connect(); break; } catch {} }
    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    await cdp.send("Page.enable", {}, sessionId);
    await cdp.send("Runtime.enable", {}, sessionId);
    // 收集页面异常。
    //
    // 注意：用 Page.navigate 做硬跳转会打断页面上"在途"的 XHR，
    // 而 Next.js 客户端会用 reject 暴露它 —— 此时被拒绝的对象就是
    // XMLHttpRequest 本身（readyState=0，description 只有 "Object"）。
    // 那不是页面缺陷，属于测试手段的产物，必须排除，否则断言会长期误报。
    let testPhase = "(启动)";
    const pageErrors = [];
    cdp.ws.addEventListener("message", (e) => {
      const m = JSON.parse(e.data);
      if (m.method === "Runtime.exceptionThrown") {
        const d = m.params.exceptionDetails;
        const ex = d?.exception ?? {};
        const desc = typeof ex.description === "string" ? ex.description : "";
        // description 恰为 "Object" 且带 XHR 特征 → 被中断的请求，跳过
        const isAbortedXhr =
          desc === "Object" &&
          Array.isArray(ex.preview?.properties) &&
          ex.preview.properties.some((p) => p.name === "setRequestHeader" || p.name === "readyState");
        if (isAbortedXhr) return;
        pageErrors.push(`[${testPhase}] ${String(d?.text)} ${desc.slice(0, 240)}`);
      }
      if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
        const args = (m.params.args ?? []).map((a) => (a.description ?? a.value ?? a.type ?? "").toString()).join(" ").slice(0, 240);
        // 过滤掉被中断请求在控制台留下的噪声
        if (/readyState|overrideMimeType/.test(args) && args.length < 120) return;
        pageErrors.push(`[${testPhase}] console.error: ${args}`);
      }
      if (m.method === "Log.entryAdded" && m.params.entry.level === "error") {
        const t = typeof m.params.entry.text === "string" ? m.params.entry.text : JSON.stringify(m.params.entry.text);
        pageErrors.push(`[${testPhase}] log: ${t.slice(0, 240)}`);
      }
    });

    const ev = async (expr) => {
      const r = await cdp.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }, sessionId);
      if (r.exceptionDetails) return { __err: r.exceptionDetails.exception?.description };
      return r.result.value;
    };
    const goto = async (p, w = 5000) => { cdp.clear(); await cdp.send("Page.navigate", { url: BASE + p }, sessionId);
      await cdp.waitForEvent("Page.loadEventFired").catch(() => {}); await sleep(w); };
    const inTool = (body) => ev(`(() => { const f=document.querySelector('iframe'); if(!f) return {__err:'无 iframe'};
      const doc=f.contentDocument; const w=f.contentWindow; if(!doc) return {__err:'无 doc'};
      try { ${body} } catch(e){ return {__err:String(e && e.message || e)}; } })()`);

    // 登录
    testPhase = "清cookie";
    await cdp.send("Network.clearBrowserCookies", {}, sessionId);
    testPhase = "登录页";
    await goto("/login", 2000);
    for (let i = 0; i < 40; i++) { if (await ev(`!!document.querySelector('form input[name="email"]')`)) break; await sleep(250); }
    await ev(`(() => { const f=document.querySelector("form"); const d=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value");
      const em=f.querySelector('input[name="email"]'), pw=f.querySelector('input[name="password"]');
      d.set.call(em, ${JSON.stringify(adminEmail)}); em.dispatchEvent(new Event("input",{bubbles:true}));
      d.set.call(pw, ${JSON.stringify(PASSWORD)}); pw.dispatchEvent(new Event("input",{bubbles:true})); return true; })()`);
    testPhase = "提交登录";
    await sleep(400);
    await ev(`document.querySelector("form").requestSubmit(), true`);
    for (let i = 0; i < 60; i++) { await sleep(500); if ((await ev("location.pathname")) !== "/login") break; }
    await sleep(1500);

    testPhase = "工具页";
    await goto("/tools/paper-analysis", 9000);
    {
      const url = await ev("location.pathname + location.search");
      rec("工具页可访问（free，未被拦）", String(url).startsWith("/tools/paper-analysis"), String(url));
      const s = await inTool(`
        return {
          badge: doc.getElementById('modeBadge')?.textContent ?? '',
          title: doc.title,
          hasApp: typeof w.API !== 'undefined' || !!doc.querySelector('script[src*="app.js"]'),
          serverBtn: doc.getElementById('btnServer')?.textContent ?? '',
          students: !!doc.getElementById('stuName'),
        };
      `);
      rec("iframe 正常加载", !s.__err, s.__err ?? "");
      rec("工具页面元素就位", s.students === true, `title=${String(s.title).slice(0, 30)}`);
      rec("按钮已改为「AI 设置」", /AI 设置/.test(String(s.serverBtn)), String(s.serverBtn));
      // 等 detectServer 完成
      let badge = "";
      for (let i = 0; i < 20; i++) {
        await sleep(500);
        badge = await inTool(`return doc.getElementById('modeBadge')?.textContent ?? ''`);
        if (/云端/.test(String(badge))) break;
      }
      rec("模式徽章显示「云端」", /云端/.test(String(badge)), String(badge));
    }

    // 打开 AI 设置弹窗，确认服务器配置段已隐藏
    {
      testPhase = "点击AI设置";
      await inTool(`doc.getElementById('btnServer').click(); return 'ok';`);
      await sleep(800);
      const m = await inTool(`
        const body = doc.querySelector('#maskServer .mbody');
        return {
          open: doc.getElementById('maskServer')?.classList.contains('on'),
          bodyHidden: body ? body.style.display === 'none' : null,
          info: (doc.getElementById('serverModeInfo')?.innerText ?? '').slice(0, 80),
        };
      `);
      testPhase = "弹窗检查";
      rec("AI 设置弹窗可打开", m.open === true, "");
      rec("云端模式下服务器配置段已隐藏", m.bodyHidden === true, String(m.bodyHidden));
      rec("弹窗说明了云端模式行为", /云端版/.test(String(m.info)), String(m.info).slice(0, 50));
    }

    if (pageErrors.length) { console.log("     页面错误详情:"); for (const pe of pageErrors.slice(0, 6)) console.log("       " + pe); }
    rec("页面无真实 JS 异常（已排除被导航中断的 XHR）", pageErrors.length === 0, `${pageErrors.length} 条`);

    try { await cdp.send("Browser.close"); } catch { edge.kill(); }
  }
} catch (e) {
  console.error("测试异常:", e.message);
} finally {
  srv.kill();
}

const passed = results.filter((r) => r.pass).length;
console.log(`\n=== SUMMARY: ${passed}/${results.length} passed ===`);
process.exit(passed === results.length ? 0 : 1);
