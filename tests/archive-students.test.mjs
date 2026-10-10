/**
 * 学员档案（`/dashboard`）—— 2026-10 起它从「和 /tools 重复的百宝箱」改成**学员档案**：
 * 把每个学生的辅导方案 / 试卷分析 / 课后反馈收集到一处，**能看又能改**。
 *
 * 覆盖五件（每条都对应一种「静默出错」）：
 *   1. **新建**：填表提交 → 服务器上真的有这位学生（年级/校区/教师都进去了）
 *   2. **名单 + 搜索**：新学生出现在名单里；搜索能过滤
 *   3. **详情**：能打开某个学生，看到他的**全部记录**（且按工具分组、不丢别家工具的记录）
 *   4. **修改**：勾「改年级」才能改（不勾就不动）；⚠️ 这是本轮最容易做错的地方 ——
 *      「留空＝不改」会让「清空校区」永远做不到，所以改成了勾选框
 *   5. **删除**：删掉之后名单里没有他，而且**记录一起没了**（服务端就是连历史一起删）
 *
 * 跑法：& "<bundled node>" tests\archive-students.test.mjs
 * ⚠️ 自己起 next start（端口 3000），别和其它真服务套件并行跑。
 */
import { spawnSync } from "node:child_process";
import { readEnv, readUsers, makeRecorder, startServer, startBrowser, makePageApi, sleepMs } from "./_helpers.mjs";
import { loginCookie } from "./_students-baseline.mjs";

const BASE = "http://127.0.0.1:3000";
const { record, summary } = makeRecorder();

const STU = "__档案探针·阶段5";

let srv = null, edge = null;
try {
  const { adminEmail, password } = readUsers();
  const { SUPABASE_URL, ANON_KEY } = readEnv();

  srv = await startServer();
  record("next start 起来了", true);

  const cookie = await loginCookie(adminEmail, password);
  record("用真会话登录成功", !!cookie);

  const api = async (path, init = {}) => {
    const r = await fetch(BASE + path, {
      ...init,
      headers: { "Content-Type": "application/json", cookie, ...(init.headers ?? {}) },
    });
    // ⚠️ 响应体**只能读一次**（流读第二遍会得到空串）。
    //    本轮就踩到了：先 `json()` 再 `text()`，于是 body 永远是 null、text 永远是 ""，
    //    症状看起来像「接口没返回数据 / 数据没写进去」，实际是**测试自己把它读没了**。
    const raw = await r.text().catch(() => "");
    let body = null;
    try { body = JSON.parse(raw); } catch { /* 可能是 HTML 或空体 */ }
    return { status: r.status, body, text: raw };
  };
  // 直连库清探针（可重复跑）
  const tok = await (await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST", headers: { apikey: ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email: adminEmail, password }),
  })).json();
  const H = { apikey: ANON_KEY, Authorization: `Bearer ${tok.access_token}`, "Content-Type": "application/json" };
  const purge = async (name) => {
    await fetch(`${SUPABASE_URL}/rest/v1/feedback_history?student_name=eq.${encodeURIComponent(name)}`, { method: "DELETE", headers: H });
    await fetch(`${SUPABASE_URL}/rest/v1/feedback_students?name=eq.${encodeURIComponent(name)}`, { method: "DELETE", headers: H });
  };
  await purge(STU);

  // ================================================================
  // 浏览器：新建 → 名单 → 详情 → 修改 → 删除
  // ================================================================
  const b = await startBrowser(9482, "D:/my-website/.edge-profile-archive");
  edge = b.edge;
  const { cdp, sessionId } = b;
  const { ev, goto, login } = makePageApi(cdp, sessionId);

  const pageErrors = [];
  cdp.ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.method === "Runtime.exceptionThrown") {
      const d = m.params.exceptionDetails;
      pageErrors.push(`${String(d?.text)} ${String(d?.exception?.description ?? "").slice(0, 160)}`);
    }
  });

  record("管理员在浏览器里登录成功", await login(adminEmail, password));

  const inDoc = (body) => ev(`(() => { try { ${body} } catch(e){ return {__err:String(e && e.message || e)}; } })()`);

  // ---- 1. 名单页能打开，且是「学员档案」（不再是工具卡片列表）----
  await goto("/dashboard", 5000);
  const list0 = await inDoc(`
    return { title: document.title, body: document.body.innerText.replace(/\\s+/g,' ').slice(0, 300),
             hasNewForm: !!document.querySelector('input[name="name"]'),
             hasArchiveNav: [...document.querySelectorAll('a')].some(a => a.getAttribute('href') === '/dashboard') };
  `);
  record("★/dashboard 已是「学员档案」页（标题 + 新建学生表单都在）",
    /学员档案/.test(String(list0?.body)) && list0?.hasNewForm === true, String(list0?.body).slice(0, 120));
  record("★顶栏有「学员档案」入口（改造前故意没放，现在加回来了）",
    list0?.hasArchiveNav === true, JSON.stringify(list0?.hasArchiveNav));

  // ---- 2. 新建学生（真的提交表单）----
  const created = await inDoc(`
    const setVal = (el, v) => {
      const d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
      d.set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    const form = document.querySelector('form');
    if(!form) return { err: '没有表单' };
    const n = form.querySelector('input[name="name"]');
    if(!n) return { err: '没有姓名框' };
    setVal(n, ${JSON.stringify(STU)});
    setVal(form.querySelector('input[name="grade"]'), '高二');
    setVal(form.querySelector('input[name="campus"]'), '燕郊中学校区');
    setVal(form.querySelector('input[name="teacher"]'), '郭庆杰');
    form.requestSubmit();
    return 'submitted';
  `);
  if (created && created.err) record("（准备）提交新建表单", false, created.err);
  // 提交后会被重定向到这位学生的详情页
  for (let i = 0; i < 30; i++) {
    await sleepMs(500);
    const p = await ev(`location.pathname + location.search`);
    if (String(p).includes("name=")) break;
  }
  const afterCreate = await api(`/api/students?name=${encodeURIComponent(STU)}`);
  record("★新建学生：服务器上真的有了这位学生",
    afterCreate.body?.student?.grade === "高二" && afterCreate.body?.student?.campus === "燕郊中学校区",
    JSON.stringify(afterCreate.body?.student ?? {}).slice(0, 160));
  record("★新建学生：提交后被带到这位学生的详情页（不用自己再点进去）",
    String(await ev(`location.search`)).includes(encodeURIComponent(STU)),
    String(await ev(`location.pathname + location.search`)).slice(0, 80));

  // ---- 3. 造一条记录，详情页要能看到，并按工具分组 ----
  await api("/api/students", {
    method: "POST",
    body: JSON.stringify({ op: "import", items: [
      { student_name: STU, text: "档案探针：试卷分析正文", date: "10月7日", tool: "paper",
        title: "档案探针月考", score: 88, full_score: 150 },
    ] }),
  });
  // 服务端档案读有 25 秒缓存 → 写入走接口后需要一次新请求才会看到（goto 本身是新请求，够了）
  await goto(`/dashboard?name=${encodeURIComponent(STU)}`, 5000);
  const detail = await inDoc(`
    const body = document.body.innerText.replace(/\\s+/g,' ');
    return { body, hasEditor: !!document.querySelector('input[name="change_grade"]'),
             hasDelete: /删除这位学生/.test(body) };
  `);
  record("★详情页：看得到这个学生的记录（标题/分数/日期都在）",
    /档案探针月考/.test(String(detail?.body)) && /88/.test(String(detail?.body)),
    String(detail?.body).slice(0, 200));
  record("★详情页：记录按工具分组（显示「试卷分析」标签）",
    /试卷分析/.test(String(detail?.body)), "");
  record("★详情页：有「修改档案」勾选框与「删除这位学生」按钮",
    detail?.hasEditor === true && detail?.hasDelete === true, JSON.stringify(detail));

  // ---- 3b. ★第三批：详情页的「学情分析」区块（当前登录的是**免费**账号 rolea）----
  //    这里钉住四件事：
  //      ① 统计部分**免费可见**（三个小节都在）——用户口径是「统计免费、AI 会员专属」；
  //      ② 数字算得对（88/150 → 58.7%），别把别的记录算进来；
  //      ③ **抽不到就如实说**（这条 paper 正文里没有那句话）——这是本功能最容易做坏的地方：
  //         编一条"薄弱模块"出来老师会拿去跟家长说；
  //      ④ 免费用户**看不到**生成按钮（AI 是会员专属）。
  const analysis = await inDoc(`
    const body = document.body.innerText.replace(/\\s+/g,' ');
    const btnTexts = [...document.querySelectorAll('button')].map(b => b.innerText.trim());
    return { body, btnTexts };
  `);
  const aBody = String(analysis?.body ?? "");
  record("★学情分析：详情页有该区块，且统计三个小节都在（成绩趋势 / 课时安排 / 薄弱与失分）",
    /学情分析/.test(aBody) && /成绩趋势/.test(aBody) && /课时安排/.test(aBody) && /薄弱与失分/.test(aBody),
    aBody.slice(0, 160));
  record("★学情分析：把这条试卷分析算进了成绩统计（88 / 150 → 得分率 58.7%）",
    /88/.test(aBody) && /150/.test(aBody) && /58\.7%/.test(aBody),
    (aBody.match(/58\.7%/) ? "找到 58.7%" : "**没找到得分率**") + " | " + aBody.slice(0, 200));
  record("★学情分析：正文没有那句话就**如实说没抽到**（不硬凑一条薄弱模块）",
    /没有抽到薄弱/.test(aBody) && /没有出现「核心薄弱板块/.test(aBody),
    (aBody.match(/[^ ]*没有出现「核心薄弱板块[^ ]*/) ?? ["<未找到如实说明>"])[0]);
  record("★学情分析：免费用户看得到统计，但**没有**「生成学情报告」按钮（AI 会员专属）",
    /会员专属/.test(aBody) && !(analysis?.btnTexts ?? []).some((t) => /生成学情报告/.test(String(t))),
    `按钮=[${(analysis?.btnTexts ?? []).join(" / ")}]`);

  // ---- 4. 修改：**不勾任何框**直接提交 → 什么都不该变 ----
  const noChange = await inDoc(`
    const form = [...document.querySelectorAll('form')].find(f => f.querySelector('input[name="change_grade"]'));
    if(!form) return { err: '没有修改表单' };
    form.querySelector('input[name="grade"]').value = '高一';   // 改了值但不勾
    form.requestSubmit();
    return 'submitted';
  `);
  if (noChange && noChange.err) record("（准备）不勾框提交", false, noChange.err);
  await sleepMs(2500);
  const afterNoChange = await api(`/api/students?name=${encodeURIComponent(STU)}`);
  record("★修改：不勾「改」的项**不会被提交**（改成高一但没勾 → 服务器上仍是高二）",
    afterNoChange.body?.student?.grade === "高二",
    `grade=${JSON.stringify(afterNoChange.body?.student?.grade)}（勾选框语义：不勾＝不动）`);

  // ---- 5. 修改：勾上「改年级」→ 这次要真的变 ----
  await goto(`/dashboard?name=${encodeURIComponent(STU)}`, 4000);
  const doChange = await inDoc(`
    const form = [...document.querySelectorAll('form')].find(f => f.querySelector('input[name="change_grade"]'));
    if(!form) return { err: '没有修改表单' };
    const setVal = (el, v) => {
      const d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
      d.set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    setVal(form.querySelector('input[name="grade"]'), '高三');
    form.querySelector('input[name="change_grade"]').checked = true;
    form.requestSubmit();
    return 'submitted';
  `);
  if (doChange && doChange.err) record("（准备）勾框提交", false, doChange.err);
  await sleepMs(2500);
  const afterChange = await api(`/api/students?name=${encodeURIComponent(STU)}`);
  record("★修改：勾上「改年级」并提交 → 服务器上真的变成高三",
    afterChange.body?.student?.grade === "高三",
    `grade=${JSON.stringify(afterChange.body?.student?.grade)}`);
  record("★修改：没勾的项（校区/教师）保持原值，没有被清掉",
    afterChange.body?.student?.campus === "燕郊中学校区" &&
      afterChange.body?.student?.teacher === "郭庆杰",
    JSON.stringify({ campus: afterChange.body?.student?.campus, teacher: afterChange.body?.student?.teacher }));

  // ---- 6. 名单页搜索 ----
  await goto("/dashboard?q=" + encodeURIComponent("档案探针"), 4000);
  const searched = await inDoc(`return document.body.innerText.replace(/\\s+/g,' ')`);
  record("★名单页：搜索能过滤出这位学生", /档案探针/.test(String(searched)), String(searched).slice(0, 120));

  // ---- 7. 删除（页面上的删除按钮走服务端 action；这里用接口删，行为同一份实现）----
  // ⚠️ 不点页面按钮：它带 window.confirm，无头浏览器默认会取消（等于测不到）。见文件末尾说明。
  const del = await api(`/api/students?name=${encodeURIComponent(STU)}`, { method: "DELETE" });
  record("删除学生返回 ok", del.status === 200 && del.body?.ok === true, `status=${del.status}`);
  const gone = await api(`/api/students?name=${encodeURIComponent(STU)}&withHistory=1`);
  record("★删除：名单里没有他了，**记录也一起删了**",
    gone.body?.student === null && !(gone.body?.history?.[STU]?.length),
    JSON.stringify({ student: gone.body?.student, history: gone.body?.history?.[STU]?.length ?? 0 }));

  if (pageErrors.length) {
    console.log("     页面错误详情:");
    pageErrors.slice(0, 6).forEach((p) => console.log("       " + p));
  }
  record("页面无真实 JS 异常", pageErrors.length === 0, `${pageErrors.length} 条`);

  try { await cdp.send("Browser.close"); } catch { /* ignore */ }
} catch (e) {
  record("测试执行未异常中断", false, String(e && e.message ? e.message : e));
  console.error("测试异常:", e && e.stack ? e.stack : e);
} finally {
  if (srv?.pid) spawnSync("powershell", ["-NoProfile", "-Command", `Stop-Process -Id ${srv.pid} -Force`], { encoding: "utf8" });
  spawnSync("powershell", ["-NoProfile", "-Command",
    "(Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue).OwningProcess | ForEach-Object { Stop-Process -Id $_ -Force }"],
    { encoding: "utf8" });
  if (edge) { try { edge.kill(); } catch { /* ignore */ } }
  const ok = summary();
  process.exit(ok ? 0 : 1);
}
