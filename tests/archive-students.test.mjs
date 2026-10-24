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
    setVal(form.querySelector('input[name="campus"]'), '三河一中');
    setVal(form.querySelector('input[name="manager"]'), '李学管');
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
  record("★新建学生：服务器上真的有了这位学生（年级/学校/学管师都进去了）",
    afterCreate.body?.student?.grade === "高二" && afterCreate.body?.student?.campus === "三河一中" &&
      afterCreate.body?.student?.manager === "李学管",
    JSON.stringify(afterCreate.body?.student ?? {}).slice(0, 200));
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

  // ---- 3c. ★第十七批：**学情报告的删除**（用户原话："我生成了好几份学情分析，
  //          现在不知道在哪里删除。"）
  //      这里钉三件事：① 分析记录在详情页有删除按钮；② 二次确认点"确定"后
  //      那一行消失；③ **学生档案还在**（只删记录，不误删档案）。
  {
    // 先用接口造一条 analysis 记录（与 AI 生成时落库的形状一致：tool='analysis'）
    const mk = await api("/api/students", {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({
        op: "import",
        items: [
          { student_name: STU, tool: "analysis", title: "学情报告 · 测试用",
            date: "2026-10-16", text: "【整体学情】这是测试用的一份学情报告。" },
          { student_name: STU, tool: "paper", title: "不该被删的卷子",
            date: "2026-10-16", text: "【备考建议】这条是试卷分析，删除分析记录时不能碰它。" },
        ],
      }),
    });
    record("（准备）造一条学情报告 + 一条试卷分析记录",
      mk.status === 200 && (mk.body?.inserted ?? 0) >= 1, JSON.stringify(mk.body).slice(0, 140));

    await goto(`/dashboard?name=${encodeURIComponent(STU)}`, 4500);
    const withAnalysis = await inDoc(`
      const rows = [...document.querySelectorAll('li')];
      const findRow = (t) => rows.find(li => li.innerText.includes(t)) || null;
      // ⚠️ 2026-10 修：**不能再拿"这一行有没有 button"当判据** ——
      //    用户验收后每条记录都多了一个「补日期 / 改日期」按钮（那是另一个功能）。
      //    改成**按文案找按钮**：删除按钮 = 文案含「删除」。
      const btns = (row) => row ? [...row.querySelectorAll('button')] : [];
      const hasDelete = (row) => btns(row).some(b => b.innerText.includes('删除'));
      const hasDate   = (row) => btns(row).some(b => /改日期|补日期/.test(b.innerText));
      const a = findRow('学情报告 · 测试用');
      const p = findRow('不该被删的卷子');
      return {
        analysisHasDelete: hasDelete(a),
        paperHasDelete: hasDelete(p),
        analysisHasDate: hasDate(a),
        paperHasDate: hasDate(p),
        analysisText: a ? a.innerText.replace(/\\s+/g,' ').slice(0, 120) : null,
      };
    `);
    record("★学情报告在详情页有「删除」按钮（老师终于能自己删掉多余的报告）",
      withAnalysis?.analysisHasDelete === true, JSON.stringify(withAnalysis));
    record("★别的归属（试卷分析）**没有被误开删除**按钮（仍由各自的工具管理）",
      withAnalysis?.paperHasDelete === false,
      `analysis=${withAnalysis?.analysisHasDelete} paper=${withAnalysis?.paperHasDelete}`);
    // ⭐ 2026-10 用户验收（问题 2）：**每条记录的日期都能改**（不分归属）
    record("★★每条记录都有「改日期 / 补日期」按钮（不分归属：学情报告与试卷分析都有）",
      withAnalysis?.analysisHasDate === true && withAnalysis?.paperHasDate === true,
      `analysis=${withAnalysis?.analysisHasDate} paper=${withAnalysis?.paperHasDate}`);

    // 点删除 —— ⚠️ 无头浏览器里 confirm 会**阻塞页面**，必须用 CDP 自动点"确定"
    let dialogMsg = "";
    const onClick = (e) => {
      const m = JSON.parse(e.data);
      if (m.method === "Page.javascriptDialogOpening") {
        dialogMsg = String(m.params?.message ?? "");
        cdp.send("Page.handleJavaScriptDialog", { accept: true }, sessionId).catch(() => {});
      }
    };
    cdp.ws.addEventListener("message", onClick);
    if (withAnalysis?.analysisHasDelete) {
      await inDoc(`
        const rows = [...document.querySelectorAll('li')];
        const a = rows.find(li => li.innerText.includes('学情报告 · 测试用'));
        // ⚠️ 按文案点「删除」那个按钮，别点"第一个按钮"（现在第一个是「改日期」）
        const del = a ? [...a.querySelectorAll('button')].find(b => b.innerText.includes('删除')) : null;
        if (del) del.click();
        return true;
      `);
      await sleepMs(3000);
    }
    cdp.ws.removeEventListener("message", onClick);

    record("★删除前有**二次确认**，且说清「只删这一条、不影响档案和其它记录」",
      /只删这一条/.test(dialogMsg) && /不影响/.test(dialogMsg), JSON.stringify(dialogMsg));

    const afterDel = await api(`/api/students?name=${encodeURIComponent(STU)}&withHistory=1`);
    const items = (afterDel.body?.history ?? {})[STU] ?? [];
    // ⚠️ 直连数据库问一次"档案行还在不在"（2026-10 第十七批加）：
    //    这是本功能最危险的失效方式（删一条记录却把档案带走），值得**独立来源**核实。
    //    ⚠️ 第一版这里还断言了 `student.name === STU` —— **那是错的**：
    //    `studentsByName()` 返回的对象**不含 name**（名字是 map 的 key），
    //    所以那条断言永远为假（假红）。改成看"行还在 + 关键字段在"。
    const rawRow = await fetch(
      `${SUPABASE_URL}/rest/v1/feedback_students?name=eq.${encodeURIComponent(STU)}&select=name,grade`,
      { headers: H },
    ).then((r) => r.json()).catch(() => null);
    record("★点确定后：那条学情报告**从记录里消失**了",
      !items.some((i) => String(i.tool) === "analysis" && String(i.title).includes("测试用")),
      `剩余 ${items.length} 条：${items.map((i) => i.tool + "/" + i.title).join("、")}`);
    record("★删的是**那一条**：试卷分析那条还在（没有连带误删）",
      items.some((i) => String(i.tool) === "paper" && String(i.title).includes("不该被删")),
      JSON.stringify(items.map((i) => [i.tool, i.title])));
    record("★**学生档案还在**（只删记录，不误删档案 —— 这是本功能最危险的失效方式）",
      Array.isArray(rawRow) && rawRow.length === 1 && rawRow[0].name === STU && rawRow[0].grade === "高二" &&
        !!afterDel.body?.student && afterDel.body?.student?.grade === "高二",
      `库里行=${JSON.stringify(rawRow)} 接口 student.grade=${JSON.stringify(afterDel.body?.student?.grade ?? null)}`);
  }

  // ---- 3d. ★第十九批：档案编辑区是**三格 = 年级 / 学校 / 学管师** ----
  //   用户原话："第二格我想把校区改为学校，第三格我想把教师改为学管师 …… 我希望学员档案的
  //   页面中能直观的看到老师的对接人是谁"。这一组就把这两件事钉住。
  {
    await goto(`/dashboard?name=${encodeURIComponent(STU)}`, 4000);
    const ed = await inDoc(`
      const form = [...document.querySelectorAll('form')].find(f => f.querySelector('input[name="change_grade"]'));
      if(!form) return { err: '没有修改表单' };
      const names = [...form.querySelectorAll('input[type="checkbox"]')]
        .map(c => c.getAttribute('name')).filter(Boolean).sort();
      const labels = [...form.querySelectorAll('label')].map(l => l.innerText.replace(/\\s+/g,'')).filter(Boolean);
      const inputs = [...form.querySelectorAll('input:not([type="checkbox"]):not([type="hidden"]):not([type="submit"])')]
        .map(i => i.getAttribute('name')).filter(n => n !== 'name');
      const ph = {};
      form.querySelectorAll('input[name]').forEach(i => { ph[i.getAttribute('name')] = i.getAttribute('placeholder') || ''; });
      return { names, labels, inputs, ph, hasTeacherInput: !!form.querySelector('input[name="teacher"]') };
    `);
    record("★★档案编辑区**五格**：年级 / 学校 / 学管师 / 目标分数 / 总课时数",
      JSON.stringify(ed?.names) === JSON.stringify(["change_campus", "change_grade", "change_manager", "change_targetScore", "change_totalHours"]) &&
      JSON.stringify(ed?.inputs) === JSON.stringify(["grade", "campus", "manager", "targetScore", "totalHours"]),
      JSON.stringify({ 勾选框: ed?.names, 输入框: ed?.inputs }));
    record("★★第二格显示名是「学校」（不再叫「校区」）、第三格是「学管师」（不再叫「教师」）",
      /改「年级」/.test(ed?.labels?.join("|") ?? "") && /改「学校」/.test(ed?.labels?.join("|") ?? "") &&
      /改「学管师」/.test(ed?.labels?.join("|") ?? "") && !/改「校区」/.test(ed?.labels?.join("|") ?? "") &&
      !/改「教师」/.test(ed?.labels?.join("|") ?? "") &&
      /改「目标分数」/.test(ed?.labels?.join("|") ?? "") && /改「总课时数」/.test(ed?.labels?.join("|") ?? ""),
      JSON.stringify(ed?.labels));
    record("★★「任课教师」不再占编辑区一格（但它没有被删除：库里、报告里都还在）",
      ed?.hasTeacherInput === false, `有 teacher 输入框=${ed?.hasTeacherInput}`);
    record("★占位提示也换了（学校给的是真学校的例子，不是「燕郊中学校区」）",
      /三河一中|学校/.test(String(ed?.ph?.campus ?? "")) && !/校区/.test(String(ed?.ph?.campus ?? "")),
      JSON.stringify(ed?.ph));

    // ★ 2026-10-23：目标分数 / 总课时数（存 extra，不新增列）真的能写进去
    const setExtra = await inDoc(`
      const form = [...document.querySelectorAll('form')].find(f => f.querySelector('input[name="change_grade"]'));
      if(!form) return { err: '没有修改表单' };
      const setVal = (el, v) => {
        const d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
        d.set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true }));
      };
      setVal(form.querySelector('input[name="targetScore"]'), '100');
      setVal(form.querySelector('input[name="totalHours"]'), '40');
      form.querySelector('input[name="change_targetScore"]').checked = true;
      form.querySelector('input[name="change_totalHours"]').checked = true;
      form.requestSubmit();
      return 'submitted';
    `);
    if (setExtra && setExtra.err) record("（准备）保存目标分数/总课时", false, setExtra.err);
    await sleepMs(2500);
    const afterExtra = await api(`/api/students?name=${encodeURIComponent(STU)}`);
    record("★★目标分数 / 总课时数能保存（写进 extra，不新增数据库列）",
      Number(afterExtra.body?.student?.extra?.targetScore) === 100 &&
        Number(afterExtra.body?.student?.extra?.totalHours) === 40,
      JSON.stringify(afterExtra.body?.student?.extra));

    // 造一份带逐次课表的方案，供「学习进度/课时消耗图」使用
    const mkPlan = await api("/api/students", {
      method: "POST",
      body: JSON.stringify({
        op: "import",
        items: [{
          student_name: STU, tool: "math-plan", title: "目标课时方案", date: "2026-10-18",
          text: "【提分目标】60 → 100 分\n【课时安排】共 40 课时\n【逐次课表】\n函数｜函数的单调性｜10 课时｜掌握\n解析几何｜直线与圆｜10 课时｜会求弦长",
        }],
      }),
    });
    record("（准备）造一份带逐次课表的辅导方案", mkPlan.body?.inserted === 1, JSON.stringify(mkPlan.body));

    // 详情页抬头与名单卡片都要能**一眼看到对接人**（只显示人名，前后不加"学管师"三个字）
    const head = await inDoc(`return document.body.innerText.replace(/\\s+/g,' ')`);
    record("★★详情页抬头显示学管师姓名（对接人一眼可见，**不带「学管师」三个字**）",
      /·\s*李学管\s*·/.test(String(head)) && !/学管师\s*李学管/.test(String(head)),
      (String(head).match(/^[^]{0,120}/) ?? [""])[0]);
    await goto("/dashboard?q=" + encodeURIComponent("档案探针"), 4000);
    const listTxt = await inDoc(`return document.body.innerText.replace(/\\s+/g,' ')`);
    record("★名单卡片也显示学管师姓名（不用点进去就能看到对接人）",
      /李学管/.test(String(listTxt)) && /三河一中/.test(String(listTxt)) &&
        !/学管师\s*李学管/.test(String(listTxt)),
      String(listTxt).slice(0, 160));
    await goto(`/dashboard?name=${encodeURIComponent(STU)}`, 4000);
  }

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
  record("★修改：没勾的项（学校/学管师）保持原值，没有被清掉",
    afterChange.body?.student?.campus === "三河一中" &&
      afterChange.body?.student?.manager === "李学管",
    JSON.stringify({ campus: afterChange.body?.student?.campus, manager: afterChange.body?.student?.manager }));

  // ---- 5b. ★第十九批：**学管师那一格真的能改动**（换个对接人）----
  //   ⚠️ 上一条只验了"格子存在"，没验"改了能存进去" —— 而"新增的格能不能写"正是这次改动的
  //      核心风险（漏把 manager 加进 patch 列表，页面看起来完全正常、就是存不上）。
  //      所以这里必须**真的勾框、真的改值、真的提交**，再回服务器核对。
  {
    const chgMgr = await inDoc(`
      const form = [...document.querySelectorAll('form')].find(f => f.querySelector('input[name="change_manager"]'));
      if(!form) return { err: '没有「改学管师」勾选框' };
      const el = form.querySelector('input[name="manager"]');
      const d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
      d.set.call(el, '王学管'); el.dispatchEvent(new Event('input', { bubbles: true }));
      form.querySelector('input[name="change_manager"]').checked = true;
      form.requestSubmit();
      return 'submitted';
    `);
    if (chgMgr && chgMgr.err) record("（准备）勾「改学管师」提交", false, chgMgr.err);
    await sleepMs(2500);
    const afterMgr = await api(`/api/students?name=${encodeURIComponent(STU)}`);
    record("★★修改学管师：勾框改值并提交 → 服务器上真的从「李学管」变成「王学管」",
      afterMgr.body?.student?.manager === "王学管",
      `manager=${JSON.stringify(afterMgr.body?.student?.manager)}`);
    record("★★改学管师**没有连带改别的**（年级仍是高三、学校仍是三河一中）",
      afterMgr.body?.student?.grade === "高三" && afterMgr.body?.student?.campus === "三河一中",
      JSON.stringify({ grade: afterMgr.body?.student?.grade, campus: afterMgr.body?.student?.campus }));
  }

  // ---- 5c. ★2026-10-23：课后反馈折叠 + 补录日期不显示 ----
  {
    const items = [1, 2, 3, 4].map((i) => ({
      student_name: STU,
      text: `【课堂内容】${i === 4 ? "函数的单调性" : `第 ${i} 次课`}\n【主要失分点】第 ${i} 个失分点`,
      date: `2026-10-${10 + i}`,
      tool: "feedback",
      title: `课后反馈（补录 · 10月${10 + i}日）`,
    }));
    const seed = await api("/api/students", {
      method: "POST",
      body: JSON.stringify({ op: "import", items }),
    });
    record("（准备）造 4 条带「补录·日期」标题的课后反馈", seed.body?.inserted === 4, JSON.stringify(seed.body));
    await goto(`/dashboard?name=${encodeURIComponent(STU)}`, 4500);
    await sleepMs(900);
    const folded = await inDoc(`
      const sec = [...document.querySelectorAll('section')].find(s => /课后反馈/.test(s.querySelector('h2')?.innerText || ''));
      if(!sec) return { err: '没有课后反馈分组' };
      const details = sec.querySelector(':scope > details');
      return {
        topLis: sec.querySelectorAll(':scope > ul > li').length,
        foldedLis: details ? details.querySelectorAll('li').length : 0,
        summary: details ? details.querySelector('summary')?.innerText || '' : '',
        open: details ? details.open : null,
        titles: [...sec.querySelectorAll('li')].map(li => (li.querySelector('span')?.textContent || '')).slice(0, 6),
        hasBackfillText: /补录/.test(sec.innerText),
        hasProgressSection: /学习进度/.test(document.body.innerText),
        hasTargetSection: /分数目标对比/.test(document.body.innerText),
        chartLabels: [...document.querySelectorAll('canvas')].map(c => c.getAttribute('aria-label')).filter(Boolean),
      };
    `);
    record("★课后反馈默认只展示最近 3 条（第 4 条在折叠里）",
      folded?.topLis === 3 && folded?.foldedLis === 1,
      JSON.stringify(folded));
    record("★折叠按钮文案 =「展开全部（共 4 条）」",
      /展开全部（共 4 条）/.test(String(folded?.summary)), String(folded?.summary));
    record("★补录日期不再显示在标题里（页面上没有「补录 ·」字样，标题是「课后反馈」）",
      folded?.hasBackfillText === false && folded?.titles?.every((t) => t === "课后反馈"),
      JSON.stringify(folded?.titles));
    record("★免费学情分析页也出现「学习进度」「分数目标对比」两节（与 AI 摘要同源）",
      folded?.hasProgressSection === true && folded?.hasTargetSection === true,
      JSON.stringify({ progress: folded?.hasProgressSection, target: folded?.hasTargetSection }));
    record("★学情分析图表真的渲染了（成绩趋势折线图 + 课时消耗环形图 + 模块薄弱条形图）",
      (folded?.chartLabels ?? []).includes("成绩趋势折线图") &&
        (folded?.chartLabels ?? []).includes("课时消耗环形图") &&
        (folded?.chartLabels ?? []).includes("模块薄弱分布条形图"),
      JSON.stringify(folded?.chartLabels));

    await inDoc(`
      const sec = [...document.querySelectorAll('section')].find(s => /课后反馈/.test(s.querySelector('h2')?.innerText || ''));
      sec?.querySelector(':scope > details > summary')?.click();
      return true;
    `);
    await sleepMs(500);
    const opened = await inDoc(`
      const sec = [...document.querySelectorAll('section')].find(s => /课后反馈/.test(s.querySelector('h2')?.innerText || ''));
      const d = sec?.querySelector(':scope > details');
      return { open: !!d?.open, visibleLis: d ? [...d.querySelectorAll('li')].filter(li => li.getBoundingClientRect().height > 0).length : 0 };
    `);
    record("★点「展开全部」后能展开（折叠里的第 4 条可见）",
      opened?.open === true && opened?.visibleLis === 1, JSON.stringify(opened));
  }

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
