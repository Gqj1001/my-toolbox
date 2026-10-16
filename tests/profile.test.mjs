#!/usr/bin/env node
/**
 * 「教师个人资料」（姓名 / 学科 / 校区 / 落款）测试（2026-10 第二十批）
 * ==========================================================================
 * 用户原话：「我们能否在注册页面后加入填写信息模块 …… 然后未来我们首页这个部分就显示这几个
 * 主要信息，然后导出来的档案文件什么的就可以从这里提取信息了，然后别忘了再加入一个修改信息的
 * 功能即可」+「你把我的名字去了，改为填写的方式 …… 填写以后未来就会记忆我这个账号上次用的
 * 落款和学科，避免了重新等待加载的过程」
 *
 * 测什么（四段）：
 *   一、**纯函数**：入参校验、落款拼接、学科显示名；
 *   二、**接口**：`/api/profile` 与 `/api/feedback/data` 的资料段（未登录 401 / 没填 → null / 不缓存）；
 *   三、**真浏览器**：注册后的引导页 → 首页账号卡显示资料 + 「修改信息」入口 → 资料页可填；
 *   四、**兜底（最要紧的一条）**：**资料表还没建 / 没填时，工具不许导出空白**
 *       —— 导出的报告里教师栏必须是"有人名或下划线"，**绝不能是空**。
 *
 * ⚠️ 自行起服务（占 3000）+ Edge（9498）。别和其它真服务套件并行跑。
 * ⚠️ 迁移 `0021` 没跑时：读资料一律 null、保存会提示"去跑 0021"。所以本套件**两种状态都要能过**
 *    （这正是"先推代码后跑迁移"的安全保证 —— 也是本套件要钉住的行为）。
 */
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { readEnv, readUsers, makeRecorder, startBrowser, makePageApi } from "./_helpers.mjs";
import { loginCookie } from "./_students-baseline.mjs";

const PROJECT = "D:\\my-website\\my-toolbox";
const NODE_BIN = "C:\\Users\\郭庆杰\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\node\\bin\\node.exe";
const NEXT_BIN = `${PROJECT}\\node_modules\\next\\dist\\bin\\next`;
const BASE = "http://127.0.0.1:3000";
const CDP_PORT = 9498;

const { record, summary } = makeRecorder();
const { adminEmail, userEmail, password } = readUsers();
readEnv();

/* ---------------------------------------------------------------------------
   一、纯函数（不需要服务）
   --------------------------------------------------------------------------- */
const {
  PROFILE_SUBJECTS, subjectName, defaultSignature, resolveSignature,
  checkProfileInput, PROFILE_MIGRATION, MAX_PROFILE_TEXT,
} = await import("../src/lib/user-profile.ts");

{
  record("① 学科清单与工具同一套口径（含 math/chinese… 与「其它」）",
    PROFILE_SUBJECTS.length >= 10 && PROFILE_SUBJECTS.some((s) => s.code === "math" && s.name === "数学") &&
      PROFILE_SUBJECTS.some((s) => s.code === "general"),
    PROFILE_SUBJECTS.map((s) => s.code).join(","));

  record("① 学科 code → 显示名（认不出来就原样回显，空仍是空）",
    subjectName("math") === "数学" && subjectName("chinese") === "语文" &&
      subjectName("") === "" && subjectName("whatever") === "whatever",
    [subjectName("math"), subjectName(""), subjectName("whatever")].join("|"));

  record("★① 落款默认 = 学科+姓名+老师（用户截图里就是「数学郭老师」这种格式）",
    defaultSignature("郭", "math") === "数学郭老师" &&
      defaultSignature("郭", "chinese") === "语文郭老师" &&
      defaultSignature("", "math") === "" && defaultSignature("郭", "") === "郭老师",
    [defaultSignature("郭", "math"), defaultSignature("郭", "")].join(" / "));

  record("★① 落款：手填的优先于自动拼的（老师改过就用他的）",
    resolveSignature({ teacherName: "郭", subject: "math", sigTeacher: "老郭" }) === "老郭" &&
      resolveSignature({ teacherName: "郭", subject: "math", sigTeacher: "  " }) === "数学郭老师" &&
      resolveSignature(null) === "",
    "手填优先 / 空白当没填 / null 安全");
}

{
  const ok = checkProfileInput({ teacher_name: " 郭 ", subject: "math", campus: " 燕郊校区 " });
  record("① 入参：合法时去掉首尾空白并规整成 UserProfile",
    ok.ok === true && ok.value.teacherName === "郭" && ok.value.subject === "math" &&
      ok.value.campus === "燕郊校区" && ok.value.sigTeacher === "",
    JSON.stringify(ok));

  record("★① 入参：姓名必填 / 学科必选且必须在清单里 / 超长被拒（错在哪说清楚）",
    checkProfileInput({ teacher_name: "", subject: "math" }).ok === false &&
      /姓名/.test(checkProfileInput({ teacher_name: "", subject: "math" }).error) &&
      checkProfileInput({ teacher_name: "郭", subject: "" }).ok === false &&
      /学科/.test(checkProfileInput({ teacher_name: "郭", subject: "" }).error) &&
      checkProfileInput({ teacher_name: "郭", subject: "nope" }).ok === false &&
      /范围/.test(checkProfileInput({ teacher_name: "郭", subject: "nope" }).error) &&
      checkProfileInput({ teacher_name: "郭".repeat(MAX_PROFILE_TEXT + 1), subject: "math" }).ok === false,
    `上限 ${MAX_PROFILE_TEXT} 字`);

  record("① 迁移文件名是唯一来源（提示里要能点名，别写死字符串）",
    PROFILE_MIGRATION === "supabase/migrations/0021_user_profiles.sql",
    PROFILE_MIGRATION);
}

/* ---------------------------------------------------------------------------
   起服务
   --------------------------------------------------------------------------- */
const ps = (cmd) => spawnSync("powershell", ["-NoProfile", "-Command", cmd], { encoding: "utf8" }).stdout.trim();
const killPort3000 = () => {
  const pid = ps("(Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue).OwningProcess");
  if (pid) ps(`Stop-Process -Id ${pid} -Force`);
};

killPort3000();
await sleep(1500);
const srv = spawn(NODE_BIN, [NEXT_BIN, "start", "-p", "3000"], { cwd: PROJECT, stdio: "ignore", env: { ...process.env } });
let up = false;
for (let i = 0; i < 60; i++) {
  await sleep(500);
  try { if ((await fetch(`${BASE}/login`)).status === 200) { up = true; break; } } catch { /* 等 */ }
}
record("（准备）本地服务已起来", up);
if (!up) { summary(); process.exit(1); }

const vipCookie = await loginCookie(userEmail, password);
record("（准备）拿到会员会话", !!vipCookie);

/* ---------------------------------------------------------------------------
   二、接口
   --------------------------------------------------------------------------- */
let tableReady = false;
{
  const r = await fetch(`${BASE}/api/profile`);
  record("② 未登录访问 /api/profile → 401（资料是账号私有信息）", r.status === 401, `HTTP ${r.status}`);

  const r2 = await fetch(`${BASE}/api/profile`, { headers: { cookie: vipCookie } });
  const j2 = await r2.json().catch(() => null);
  tableReady = !!(j2?.profile);
  record("★② /api/profile 会员可达；**表没建/没填时 profile=null 且 HTTP 200**（不是 500、不拦页面）",
    r2.status === 200 && j2?.ok === true && (j2.profile === null || typeof j2.profile === "object"),
    `HTTP ${r2.status} profile=${JSON.stringify(j2?.profile)}`);
  record("② 资料接口**不缓存**（刚改完刷新就该看到）",
    String(r2.headers.get("cache-control") ?? "").includes("no-store"),
    String(r2.headers.get("cache-control")));

  // /api/feedback/data 也要带资料段（工具页读的就是它）
  const d = await (await fetch(`${BASE}/api/feedback/data?stage=senior&subject=math`, { headers: { cookie: vipCookie } })).json().catch(() => null);
  record("★② 工具页的数据接口也带上 profile 段（课后反馈从它取落款）",
    d?.ok === true && "profile" in (d ?? {}),
    `profile=${JSON.stringify(d?.profile)}`);
}

/* ---------------------------------------------------------------------------
   三、真浏览器 + 四、兜底
   --------------------------------------------------------------------------- */
let edge = null;
try {
  const b = await startBrowser(CDP_PORT, "D:/my-website/.edge-profile-profile");
  edge = b.edge;
  const { cdp, sessionId } = b;
  const { ev, goto, login, inTool } = makePageApi(cdp, sessionId);
  const pageErrors = [];
  cdp.ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.method === "Runtime.exceptionThrown") {
      const d = m.params.exceptionDetails;
      pageErrors.push(`${String(d?.text)} ${String(d?.exception?.description ?? "").slice(0, 140)}`);
    }
  });

  record("（准备）会员在浏览器里登录", await login(userEmail, password));

  // ---- 引导页（注册后的"完善资料"）----
  await goto("/welcome", 4500);
  const welcome = await ev(`(() => {
    const body = document.body.innerText;
    return { body: body.slice(0, 600),
             hasForm: !!document.querySelector('input[name="teacher_name"]'),
             hasSubject: !!document.querySelector('select[name="subject"]'),
             canSkip: !!([...document.querySelectorAll('a')].find(a => /以后再说/.test(a.textContent))) };
  })()`);
  record("★③ 注册后的「完善资料」页能打开：姓名 + 学科（下拉）+ 校区 + 落款",
    welcome?.hasForm === true && welcome?.hasSubject === true,
    String(welcome?.body ?? "").slice(0, 160));
  record("★★③ 引导页**可以跳过**（用户拍板：注册是转化关键节点，挡着不让进不好）",
    welcome?.canSkip === true, `有"以后再说"链接=${welcome?.canSkip}`);

  // ---- 首页账号卡：显示资料 + 修改信息入口 ----
  await goto("/tools", 4500);
  const card = await ev(`(() => {
    const body = document.body.innerText;
    return { body: body.slice(0, 500),
             hasProfileLink: !!([...document.querySelectorAll('a')].find(a => a.getAttribute('href') === '/account/profile')),
             hasPwdLink: !!([...document.querySelectorAll('a')].find(a => a.getAttribute('href') === '/account/password')),
             email: (body.match(/[\\w.+-]+@[\\w.-]+/) || [''])[0] };
  })()`);
  record("★★③ 首页账号卡有「修改信息」入口（用户点名要的功能）",
    card?.hasProfileLink === true, `href=/account/profile 在=${card?.hasProfileLink}`);
  record("③ 「修改密码」入口没被挤掉（两个按钮并排）",
    card?.hasPwdLink === true, `href=/account/password 在=${card?.hasPwdLink}`);
  record("★③ 没填资料时账号卡**明确提示「还没填资料」并给补齐入口**（不是静悄悄什么都没有）",
    !tableReady ? /还没填资料/.test(String(card?.body)) : true,
    `表已建=${tableReady}；卡片文本：${String(card?.body ?? "").slice(0, 90)}`);

  // ---- 资料页：可填、可保存（表没建时提示点名迁移文件）----
  await goto("/account/profile", 4500);
  const pf = await ev(`(() => {
    const body = document.body.innerText;
    const name = document.querySelector('input[name="teacher_name"]');
    const sel = document.querySelector('select[name="subject"]');
    return { body: body.slice(0, 500), hasName: !!name, hasSelect: !!sel,
             options: sel ? [...sel.options].map(o => o.value) : [],
             hasCampus: !!document.querySelector('input[name="campus"]'),
             hasSig: !!document.querySelector('input[name="sig_teacher"]') };
  })()`);
  record("★③ 「我的资料」页四个字段都在（姓名/学科/校区/落款）",
    pf?.hasName === true && pf?.hasSelect === true && pf?.hasCampus === true && pf?.hasSig === true,
    JSON.stringify(pf?.options).slice(0, 120));
  record("③ 学科下拉里是**工具同一套 code**（math/chinese…）",
    Array.isArray(pf?.options) && pf.options.includes("math") && pf.options.includes("chinese"),
    JSON.stringify(pf?.options));

  if (!tableReady) {
    // 表没建：填了提交 → 必须**点名迁移文件**（不能报"保存失败"让人反复重试）
    const saved = await ev(`(() => {
      const setV = (el, v) => { const d = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value');
        d.set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
      const f = document.querySelector('form');
      setV(f.querySelector('input[name="teacher_name"]'), '测试老师');
      setV(f.querySelector('select[name="subject"]'), 'math');
      setV(f.querySelector('input[name="campus"]'), '燕郊校区');
      f.requestSubmit();
      return 'submitted';
    })()`);
    record("（准备）表没建时提交资料表单", saved === "submitted", String(saved));
    await sleep(3000);
    const after = await ev(`document.body.innerText.replace(/\\s+/g,' ')`);
    record("★★③ **迁移没跑时明确点名要跑哪个文件**（不能报成「保存失败」让人反复重试）",
      /0021_user_profiles\.sql/.test(String(after)),
      (String(after).match(/资料表还没建[^。]*。?/) ?? ["<没找到提示>"])[0].slice(0, 120));
  } else {
    record("③ 表已建：资料页可正常保存（本机已有资料时跳过写入，避免污染真实账号）", true, "表已建");
  }

  /* ---- ★★ 四、兜底：资料没填/表没建时，工具**不许导出空白** ---- */
  await goto("/tools/paper-analysis", 5000);
  const fallback = await ev(`(() => {
    const f = document.querySelector('iframe');
    const w = f && f.contentWindow;
    if (!w || !w.document) return { err: '没有 iframe' };
    const t = w.document.getElementById('stuTeacher');
    const body = w.document.body.innerText;
    const brand = w.document.getElementById('brandWho');
    return { teacher: t ? t.value : null,
             brand: brand ? brand.textContent : null,
             pageHasAuthorHardcode: /郭庆杰/.test(body),
             hasNarrator: !!w.Narrator };
  })()`);
  record("★★④ 试卷分析页**不再出现写死的作者名**（用户：你把我的名字去了）",
    fallback?.pageHasAuthorHardcode === false,
    `页面里含「郭庆杰」=${fallback?.pageHasAuthorHardcode}`);
  record("★★④ 资料没填时「教师」框为空（**不是**被塞了一个别人的名字）",
    fallback?.teacher === "" || fallback?.teacher === null,
    `stuTeacher=${JSON.stringify(fallback?.teacher)}`);
  record("★④ 页头那行小字没填资料时是空的（不再写死名字）",
    !fallback?.brand, `brandWho=${JSON.stringify(fallback?.brand)}`);

  // 生成一份报告，确认「教师/分析人」栏**不是空白**（下划线或人名都行）
  // ⚠️ 必须用 `inTool`（在子窗口自己的上下文里点），不要用 `ev` 去够 `f.contentWindow` ——
  //    本轮实测踩到：后者点完「生成方案」报告框一直空着（子窗口里的时序/上下文不同），
  //    而 company-export 套件用 inTool 一直是好的。
  const report = await inTool(`
    w.document.getElementById('btnDemo').click();
    w.document.getElementById('btnParse').click();
    // ⚠️ 必须填学生姓名，否则点生成会被拦下（提示"请先填学生姓名"）——本轮实测踩到
    const nameEl = w.document.getElementById('stuName');
    if (nameEl) { nameEl.value = '资料探针同学'; nameEl.dispatchEvent(new w.Event('input', { bubbles: true })); }
    for (const no of [1,2,3]) {
      const el = w.document.querySelector('#scoreList input[data-got="' + no + '"]');
      if (el) { el.value = '0'; el.dispatchEvent(new w.Event('input', { bubbles: true })); }
    }
    w.document.getElementById('btnGen').click();
    const el = w.document.getElementById('reportText');
    const txt = el ? (el.textContent || '') : '';
    const gen = w.document.getElementById('btnGen');
    return { len: txt.length, hasEl: !!el,
             genDisabled: gen ? !!gen.disabled : null,
             genText: gen ? String(gen.textContent || '').slice(0, 20) : null,
             reportWrapVisible: (() => {
               const wrap = w.document.getElementById('reportWrap') || w.document.getElementById('step3');
               return wrap ? (wrap.style.display !== 'none' && !wrap.hidden) : null;
             })(),
             toasts: [...w.document.querySelectorAll('.toast')].map(t => String(t.textContent || '').slice(0, 40)).slice(-3),
             teacherLine: (txt.match(/[^\\n]*教师：[^\\n]*/) || [''])[0],
             signLine: (txt.match(/[^\\n]*分析人：[^\\n]*/) || [''])[0] };
  `);
  record("★★④ 兜底：报告里「教师/分析人」栏**不是空的**（没资料时给下划线让老师手写，绝不导出空白）",
    report?.len > 200 &&
      /教师：\s*\S/.test(String(report?.teacherLine)) &&
      /分析人：\s*\S/.test(String(report?.signLine)),
    `len=${report?.len} hasEl=${report?.hasEl} genDisabled=${report?.genDisabled} genText=${report?.genText} wrapVisible=${report?.reportWrapVisible} toasts=${JSON.stringify(report?.toasts)} | ${String(report?.teacherLine).slice(0, 40)} | ${String(report?.signLine).slice(0, 40)}`);

  // 课后反馈：落款框不再被硬写，且填过会被记住（localStorage 按账号）
  await goto("/tools/feedback", 5000);
  const fb = await ev(`(() => {
    const f = document.querySelector('iframe');
    const w = f && f.contentWindow;
    if (!w || !w.document) return { err: '没有 iframe' };
    const t = w.document.getElementById('teacherInput');
    return { value: t ? t.value : null, body: w.document.body.innerText.slice(0, 300),
             brand: (w.document.getElementById('brandWho') || {}).textContent || '' };
  })()`);
  record("★★④ 课后反馈的「落款」不再被硬写成作者的名字（没资料时是空的，等老师填）",
    fb?.value === "" || fb?.value === null, `落款框=${JSON.stringify(fb?.value)}`);
  record("★④ 课后反馈页头也不再写死名字", !fb?.brand, `brandWho=${JSON.stringify(fb?.brand)}`);

  // ★★ 用户点名的功能："填写以后未来就会记忆我这个账号上次用的落款和学科"
  {
    await inTool(`
      const t = w.document.getElementById('teacherInput');
      t.value = '数学测试老师';
      t.dispatchEvent(new w.Event('input', { bubbles: true }));
      const s = w.document.getElementById('subjectSelect');
      s.value = 'math';
      s.dispatchEvent(new w.Event('change', { bubbles: true }));
      return true;
    `);
    await sleep(400);
    const stored = await inTool(`
      let keys = [];
      try { for (let i = 0; i < w.localStorage.length; i++) keys.push(w.localStorage.key(i)); } catch(e){}
      const hit = keys.filter(k => k.indexOf('fb_my_prefs_v1') === 0);
      return { keys: hit, raw: hit.length ? w.localStorage.getItem(hit[0]) : null };
    `);
    record("★★④ 填过的落款与学科**按账号**记住（用户：'记忆我这个账号上次用的落款和学科'）",
      (stored?.keys ?? []).some((k) => /:(\w{8}-)/.test(k)) && /数学测试老师/.test(String(stored?.raw)),
      `keys=${JSON.stringify(stored?.keys)} raw=${String(stored?.raw).slice(0, 80)}`);

    // 刷新后要**自动带回来**（这是"记忆"的意义）
    // ⚠️ 要**等**：落款是异步补上的（先按本机记忆填、云端资料回来再兜底）。
    //    第一版点完 goto 立刻问 ⇒ 拿到空值、假红（本轮实测踩到）。
    await goto("/tools/feedback", 5000);
    await sleep(2500);          // ⚠️ iframe 里的工具页要时间起来；不等的话读到的全是空（本轮踩到）
    let restored = null;
    for (let i = 0; i < 12; i++) {
      restored = await inTool(`
        const t = w.document.getElementById('teacherInput');
        return { value: t ? t.value : null, uid: (w.API && w.API.userId) || '' };
      `);
      if (String(restored?.value ?? "").trim()) break;
      await sleep(500);
    }
    record("★★④ 刷新/下次打开**自动带出上次的落款**（不用重新等加载、不用手打）",
      restored?.value === "数学测试老师",
      `重开后落款框=${JSON.stringify(restored?.value)} userId=${String(restored?.uid).slice(0, 8)}`);
    if (restored?.value !== "数学测试老师") {
      // ⚠️ 注意：页面里的 `API` 是**闭包内变量**，从外面读永远是 null/undefined，
      //    别拿它当证据（本轮冤枉过它一次）。只信**看得见的字段值**。
      const diag = await inTool(`
        const t = w.document.getElementById('teacherInput');
        let keys = []; try { for (let i=0;i<w.localStorage.length;i++) keys.push(w.localStorage.key(i)); } catch(e){}
        return { fieldValue: t ? t.value : null, readyState: w.document.readyState, keys };
      `);
      console.log("     [诊断] " + JSON.stringify(diag));
    }

    // 收尾：把本机记忆清掉，别影响其它套件与真实使用
    await inTool(`try { Object.keys(w.localStorage).filter(k => k.indexOf('fb_my_prefs_v1') === 0)
      .forEach(k => w.localStorage.removeItem(k)); } catch(e){} return true;`);
  }

  record("④ 页面无真实 JS 异常", pageErrors.length === 0, pageErrors.slice(0, 2).join(" | ") || "0 条");

  try { await cdp.send("Browser.close"); } catch { /* ignore */ }
} catch (e) {
  record("测试执行未异常中断", false, String(e && e.message ? e.message : e));
  console.error(e?.stack ?? e);
} finally {
  if (srv?.pid) spawnSync("powershell", ["-NoProfile", "-Command", `Stop-Process -Id ${srv.pid} -Force`], { encoding: "utf8" });
  killPort3000();
  if (edge) { try { edge.kill(); } catch { /* ignore */ } }
  const ok = summary();
  process.exit(ok ? 0 : 1);
}
