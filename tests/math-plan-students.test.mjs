/**
 * 阶段4：math-plan 接入统一学生 API（`/api/students`）
 *
 * math-plan 以前**什么都不存**（刷新即丢），所以这一轮是**纯新增**：
 * 没有历史数据要迁、没有新旧冲突。四条要覆盖的红线，每条都对应一种「静默出错」：
 *
 *   1. **选学生能带出信息**：点一下学生圆片，左侧表单（年级/校区/教师/学段/教材/考区）
 *      真的被填上。填不上就是"看着有这个功能，实际没用"。
 *   2. **只存身份字段**（用户明确要求）：POST 出去的 body 里**不许**出现
 *      分数 / 目标分 / 课时 / 薄弱模块 / 已完成模块 / 备注 —— 那些属于「这一次方案」，
 *      存进档案就会「换个学生做方案，把上一位的分数写成他的」。
 *   3. **刷新不丢**：保存 → 重新打开页面 → 学生圆片还在（数据真在服务器上）。
 *   4. **★extra 跨工具互不踩**：math-plan 存一次必须**保住 paper 的 extra.cls**，反过来也一样。
 *      ⚠️ **2026-10 第二批之后这条的性质变了**：以前 `extra` 在接口层是**整块替换**
 *      （合并语义只保护顶层列），所以"保住别人"完全靠**每个工具自己先读旧值**；
 *      现在服务端做了**按键合并**（`mergeExtra()`），调用方一句旧值都不读也不会踩到别人。
 *      本文件的三条断言因此变成**服务端兜底**的证据（尤其③，它以前记录的正是"会被盖掉"）。
 *
 * 外加一条接口防护（顺手修掉的真实 bug）：
 *   5. `op:"import"` 的 `tool` 原来是「缺省按 paper」—— 会把别的工具的数据**静默标成 paper**。
 *      现在不合法一律拒绝，这条钉住它。
 *
 * 跑法：& "<bundled node>" tests\math-plan-students.test.mjs
 * ⚠️ 自己起 next start（端口 3000），别和其它真服务套件同时跑。
 */
import { spawnSync } from "node:child_process";
import { readEnv, readUsers, makeRecorder, startServer, startBrowser, makePageApi, sleepMs } from "./_helpers.mjs";
import { loginCookie } from "./_students-baseline.mjs";

const BASE = "http://127.0.0.1:3000";
const { record, summary } = makeRecorder();

/** 探针学生名（前缀 __ 以便一眼看出是测试数据，且不会和真学生重名） */
const STU = "__mp阶段4探针";
const PAPER_CLS = "9班（paper 写的）";

let srv = null, edge = null;
try {
  const { adminEmail, password } = readUsers();
  const { SUPABASE_URL, ANON_KEY } = readEnv();

  srv = await startServer();
  record("next start 起来了", true);

  // ---------------------------------------------------------------- 准备：直连库清干净
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
  const cookie = await loginCookie(adminEmail, password);
  record("用真会话登录成功", !!cookie);

  const api = async (path, init = {}) => {
    const r = await fetch(BASE + path, {
      ...init,
      headers: { "Content-Type": "application/json", cookie, ...(init.headers ?? {}) },
    });
    let body = null;
    try { body = await r.json(); } catch { /* 可能没有响应体 */ }
    return { status: r.status, body };
  };

  // ================================================================
  // 0. 预置：paper 先在这个学生名下留一个自己的 extra 键（cls）
  //    ——「跨工具互不踩」那条测试就是拿它当证据。
  // ================================================================
  const seed = await api("/api/students", {
    method: "POST",
    body: JSON.stringify({ name: STU, grade: "高三", class_name: PAPER_CLS, extra: { cls: PAPER_CLS } }),
  });
  record("（准备）paper 风格先写一份档案（extra.cls）",
    seed.status === 200 && seed.body?.student?.extra?.cls === PAPER_CLS,
    `status=${seed.status} extra=${JSON.stringify(seed.body?.student?.extra)}`);

  // ================================================================
  // 1. 浏览器：选学生带出信息 + 只存身份字段 + 刷新不丢
  // ================================================================
  const b = await startBrowser(9481, "D:/my-website/.edge-profile-mp-students");
  edge = b.edge;
  const { cdp, sessionId } = b;
  const { ev, goto, login } = makePageApi(cdp, sessionId);

  const pageErrors = [];
  cdp.ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.method === "Runtime.exceptionThrown") {
      const d = m.params.exceptionDetails;
      pageErrors.push(`${String(d?.text)} ${String(d?.exception?.description ?? "").slice(0, 200)}`);
    }
  });

  record("管理员在浏览器里登录成功", await login(adminEmail, password));

  /** 页面里的求值（math-plan 是单文件页面，直接在主文档上跑） */
  const inDoc = (body) => ev(`(() => { try { ${body} } catch(e){ return {__err:String(e && e.message || e)}; } })()`);

  /** 打开 math-plan 页面并等它真的初始化完 */
  const openPlan = async () => {
    await goto("/tools/math-plan.html", 6000);
    for (let i = 0; i < 24; i++) {
      const ready = await inDoc(`return { has: !!document.getElementById('f-name'),
        chips: !!document.getElementById('stuChips') };`);
      if (ready && ready.has && ready.chips) break;
      await sleepMs(500);
    }
    // 等 bootCloud() 把档案拉回来（页面里能查到探针就说明拉到了）
    // ⚠️ 必须用**裸标识符** CLOUD_STORE / CLOUD_STUDENTS，不能写 window.xxx ——
    //    脚本里是 `const` / `let` 顶层声明，它们进的是全局**词法**环境，
    //    **不是** window 的属性（`window.CLOUD_STORE` 会是 undefined）。
    for (let i = 0; i < 20; i++) {
      const st = await inDoc(`return { on: !!(typeof CLOUD_STORE !== 'undefined' && CLOUD_STORE.enabled),
        has: Object.prototype.hasOwnProperty.call((typeof CLOUD_STUDENTS !== 'undefined' ? CLOUD_STUDENTS : {}), ${JSON.stringify(STU)}) };`);
      if (st && st.on && st.has) return { ok: true, ...st };
      if (i === 19) return { ok: false, ...(st || {}) };
      await sleepMs(500);
    }
    return { ok: false };
  };

  const opened = await openPlan();
  // 打印「服务器上这一行到底是什么」：下面几条断言都基于它。
  // 本轮就是靠这一行才发现"探针档案的 grade 其实是空的"，从而避免了把断言写成错的（不是产品坏）。
  const probeRow = await api(`/api/students?name=${encodeURIComponent(STU)}`);
  console.log("     探针档案（服务器原样）:", JSON.stringify(probeRow.body?.student));
  record("页面初始化完成，且已从账号里拉到学生档案（含探针）",
    opened.ok === true, JSON.stringify(opened));
  // ⚠️ HTML 里档案行**默认是 display:none**（不写死成可见），由 JS 在「确认是本站部署」后打开。
  //    如果哪天有人把那段 style 删掉，本机模式（file://）就会冒出一排点了没反应的圆片 —— 这条钉住它。
  const rowNow = await inDoc(`
    const row = document.getElementById('stuRow');
    return { exists: !!row, visible: !!(row && row.offsetParent !== null) };
  `);
  record("云端模式下档案行**可见**（渲染逻辑真的把它打开了，不是只写在 HTML 里）",
    rowNow && rowNow.exists === true && rowNow.visible === true, JSON.stringify(rowNow));
  if (!opened.ok) throw new Error("math-plan 页面没能拉到账号档案，后续无法继续");

  // ---- 1a. 选学生 → 带出信息 ----
  // 先把表单清成"另一位学生"的样子，再点圆片 —— 否则「本来就有值」会伪装成"带出来了"
  const picked = await inDoc(`
    const d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    const set = (id, v) => { const el = document.getElementById(id); if(el) d.set.call(el, v); };
    set('f-name', '');
    set('f-campus', '（点之前留下的校区）');
    set('f-teach', '（点之前留下的教师）');
    document.getElementById('f-grade').value = '高二';
    document.getElementById('f-phase').value = '春';
    document.getElementById('f-book').value = '湘教版';
    document.getElementById('f-exam').value = 'bj';
    const chip = document.querySelector('#stuChips [data-stu=' + JSON.stringify(${JSON.stringify(STU)}) + ']');
    if(!chip) return { err: '找不到学生圆片' };
    chip.click();
    return {
      name: document.getElementById('f-name').value,
      grade: document.getElementById('f-grade').value,
      phase: document.getElementById('f-phase').value,
      book: document.getElementById('f-book').value,
      exam: document.getElementById('f-exam').value,
      campus: document.getElementById('f-campus').value,
      teacher: document.getElementById('f-teach').value,
    };
  `);
  record("★选学生：姓名被填上", picked && picked.name === STU, JSON.stringify(picked));
  record("★选学生：年级从档案带出来（高三），且为空的校区/教师被**清掉**（不留上一位的）",
    picked && picked.grade === "高三" && picked.campus === "" && picked.teacher === "",
    JSON.stringify({ grade: picked?.grade, campus: picked?.campus, teacher: picked?.teacher }));
  // ⚠️ 「档案里为空」的字段不该把表单弄坏：pickStudent() 只写**下拉里真实存在**的值，
  //    所以别家工具填的「初二」这种值不会让年级下拉变成空。见 math-plan.html 的 pickStudent()。
  // 学生圆片复用了 .pill 的样式，而页面里 `.pill` 有一条**全局**的切换高亮逻辑
  // （薄弱模块/已完成模块用）。没有排除的话，点一下就变"已选中"、点保存按钮也会亮起来。
  const chipCls = await inDoc(`
    const chip = document.querySelector('#stuChips [data-stu]');
    const btn = document.getElementById('btnSaveStu');
    return { chip: chip ? chip.className : null, btn: btn ? btn.className : null,
             weakOn: document.querySelectorAll('#f-weak .pill.on').length };
  `);
  record("★学生圆片与「保存档案」按钮**不会**被加上 `.pill.on` 高亮（它俩不是选择项）",
    chipCls && !/(^|\s)on(\s|$)/.test(chipCls.chip || "") && !/(^|\s)on(\s|$)/.test(chipCls.btn || ""),
    JSON.stringify(chipCls));

  // ---- 1b. 只存身份字段（★用户明确要求的红线）----
  // 在表单里塞满「这一次方案」的参数，然后点保存 —— 这些**一个都不许上传**
  const saved = await inDoc(`
    const d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    const set = (id, v) => { const el = document.getElementById(id); if(el) d.set.call(el, v); };
    set('f-name', ${JSON.stringify(STU + "·全字段")});
    set('f-campus', '燕郊中学校区');
    set('f-teach', '郭庆杰');
    set('f-paper', '近五年北京卷（不该上传）');
    document.getElementById('f-grade').value = '高三';
    document.getElementById('f-phase').value = '秋寒';
    document.getElementById('f-book').value = '人教A版';
    document.getElementById('f-exam').value = 'nh1';
    document.getElementById('f-score').value = '62';
    document.getElementById('f-target').value = '100';
    document.getElementById('f-hours').value = '120';
    document.getElementById('f-freq').value = '3';
    document.getElementById('f-wk').value = '20';
    document.getElementById('f-note').value = '计算能力弱（不该上传）';
    document.querySelectorAll('#f-weak .pill').forEach((p,i)=>{ if(i<2) p.classList.add('on'); });
    document.querySelectorAll('#f-done .pill').forEach((p,i)=>{ if(i<2) p.classList.add('on'); });
    // 点「保存档案」
    const btn = document.getElementById('btnSaveStu');
    if(!btn) return { err: '没有保存档案按钮' };
    btn.click();
    return { weak: document.querySelectorAll('#f-weak .pill.on').length,
             done: document.querySelectorAll('#f-done .pill.on').length };
  `);
  record("（准备）表单里确实塞了方案参数（薄弱 2 个 / 已完成 2 个）",
    saved && saved.weak === 2 && saved.done === 2, JSON.stringify(saved));

  // 等保存落盘（连到 Supabase 的一个来回）
  let full = null;
  for (let i = 0; i < 20; i++) {
    await sleepMs(500);
    const got = await api(`/api/students?name=${encodeURIComponent(STU + "·全字段")}`);
    if (got.body?.student) { full = got.body.student; break; }
  }
  record("★保存档案：服务器上真的有了这位学生", !!full, JSON.stringify(full)?.slice(0, 200));

  record("★只存身份字段：姓名/年级/校区/教师 都进去了",
    full?.grade === "高三" && full?.campus === "燕郊中学校区" && full?.teacher === "郭庆杰",
    JSON.stringify({ grade: full?.grade, campus: full?.campus, teacher: full?.teacher }));
  record("★只存身份字段：extra 里只有本工具的 phase/book/exam",
    full?.extra?.phase === "秋寒" && full?.extra?.book === "人教A版" && full?.extra?.exam === "nh1",
    `extra=${JSON.stringify(full?.extra)}`);

  // ★核心红线：方案参数一个都不许出现在档案里（顶层列 + extra 都查）
  const extraKeys = Object.keys(full?.extra || {});
  const FORBIDDEN_EXTRA = ["score", "target", "totalHours", "len", "freq", "freqH", "weeks",
    "holidayWeeks", "national", "holiday", "weakTopics", "done", "note", "focus", "flow", "check", "paper"];
  const leakedExtra = FORBIDDEN_EXTRA.filter((k) => extraKeys.includes(k));
  record("★红线：extra 里**没有**任何「这一次方案」的参数（分数/目标分/课时/薄弱模块…）",
    leakedExtra.length === 0,
    leakedExtra.length ? `泄漏=[${leakedExtra.join(",")}] extra=${JSON.stringify(full?.extra)}`
      : `extra 键=[${extraKeys.join(",")}]`);
  // 更狠一层：身份字段**全是字符串**，而方案参数（分数/课时/周数）都是**数字**。
  // 所以「extra 里出现数字」本身就是泄漏的信号，不用逐个列名字（列名字迟早漏一个）。
  const numericExtra = extraKeys.filter((k) => typeof full?.extra[k] === "number");
  record("★红线：extra 里没有数字型值（身份字段都是字符串；出现数字基本就是把分数/课时塞进去了）",
    numericExtra.length === 0,
    numericExtra.length ? `数字键=[${numericExtra.map((k) => k + "=" + full.extra[k]).join(",")}]`
      : `值类型=${extraKeys.map((k) => k + ":" + typeof full.extra[k]).join(", ")}`);

  // 顶层列也不许被塞方案参数（notes 是 feedback 的备注列，math-plan 不该碰；
  // 「备注」是「这一次方案」的学习特点，属于方案不属于学生）
  const raw = await (await fetch(
    `${SUPABASE_URL}/rest/v1/feedback_students?name=eq.${encodeURIComponent(STU + "·全字段")}&select=*`,
    { headers: H })).json();
  const row = raw?.[0] || {};
  const forbiddenCols = ["subject", "salutation", "type", "notes", "attitude", "gender", "manager", "class_name"];
  const leakedCols = forbiddenCols.filter((c) => row[c] !== null && row[c] !== undefined && row[c] !== "");
  record("★红线：接口没替 math-plan 写任何别家工具的列（notes/attitude/class_name… 仍是空）",
    leakedCols.length === 0,
    leakedCols.length ? `被写了=[${leakedCols.map((c) => c + "=" + JSON.stringify(row[c])).join(",")}]`
      : `这些列都是空：${forbiddenCols.join("/")}`);

  // ---- 1c. ★extra 跨工具互不踩 ----
  // ① math-plan 存一次之后，paper 的 extra.cls 必须还在（就在探针 STU 那行上）
  const afterMp = await api(`/api/students?name=${encodeURIComponent(STU)}`);
  record("★extra 互不踩①：math-plan 存档案后，paper 的 extra.cls **还在**",
    afterMp.body?.student?.extra?.cls === PAPER_CLS,
    `extra=${JSON.stringify(afterMp.body?.student?.extra)}`);

  // ② math-plan 用自己的 store 再存一次（会在探针 STU 上写 phase/book/exam）
  const cross = await inDoc(`
    const d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    const set = (id, v) => { const el = document.getElementById(id); if(el) d.set.call(el, v); };
    set('f-name', ${JSON.stringify(STU)});
    set('f-campus', '燕郊中学校区');
    set('f-teach', '郭庆杰');
    document.getElementById('f-grade').value = '高三';
    document.getElementById('f-phase').value = '秋';
    document.getElementById('f-book').value = '人教B版';
    document.getElementById('f-exam').value = 'nh2';
    const btn = document.getElementById('btnSaveStu'); if(!btn) return { err:'无按钮' };
    btn.click();
    return 'clicked';
  `);
  let crossOk = false;
  for (let i = 0; i < 20; i++) {
    await sleepMs(500);
    const got = await api(`/api/students?name=${encodeURIComponent(STU)}`);
    const ex = got.body?.student?.extra || {};
    if (ex.phase === "秋" && ex.book === "人教B版" && ex.exam === "nh2") {
      // ★同一次响应里两家的键必须同时在
      crossOk = ex.cls === PAPER_CLS;
      record("★extra 互不踩②：写本工具三个键**不会**把 paper 的 cls 一起替换掉",
        crossOk, `extra=${JSON.stringify(ex)}`);
      break;
    }
    if (i === 19) record("★extra 互不踩②：写本工具三个键**不会**把 paper 的 cls 一起替换掉",
      false, `写入后 extra=${JSON.stringify(ex)}（cross=${JSON.stringify(cross)}）`);
  }

  // ③ 反过来：模拟 paper **只发自己的 extra.cls**（它**没有**先读旧值 ——
  //    `public/tools/paper-analysis/js/app.js` 的 `CLOUD_STORE.saveStudent()` 就是只发 `{cls}`）。
  //
  //    ★ 2026-10 第二批：这一步**以前会把 math-plan 的 phase/book/exam 盖掉** ——
  //      那时 `extra` 在接口层是整块替换，paper 前端又不读旧值，所以这条断言
  //      如实记录着"会被盖掉"。现在服务端做了**按键合并**（`mergeExtra()`），
  //      即使调用方一句旧值都不读，也不会踩到别人 —— 这条断言因此**翻转**成"不再被盖掉"。
  //      ⚠️ 它正是「服务端按键合并生效」的直接证据：合并被摘掉，这条立刻红。
  const paperWrite = await api("/api/students", {
    method: "POST",
    body: JSON.stringify({ name: STU, class_name: PAPER_CLS, extra: { cls: PAPER_CLS } }),
  });
  const paperExtra = paperWrite.body?.student?.extra ?? {};
  record("★extra 互不踩③：paper 只发 {cls}（服务端按键合并兜底）→ math-plan 的三个键**仍在**",
    paperExtra.cls === PAPER_CLS && paperExtra.phase === "秋" &&
      paperExtra.book === "人教B版" && paperExtra.exam === "nh2",
    `extra=${JSON.stringify(paperExtra)}（phase/book/exam 消失 = 服务端合并没生效）`);

  // ---- 1d. 刷新不丢 ----
  const reopened = await openPlan();
  record("★刷新不丢：重新打开页面后，学生圆片还在（数据真在服务器上，不是内存里的）",
    reopened.ok === true, JSON.stringify(reopened));

  // ================================================================
  // 1e. ★阶段4 之三：「📥 存入档案」把**这一次方案**写进历史（tool='math-plan'）
  // ================================================================
  // 用户明确要「手动点才存」（生成十几次不该存十几条垃圾），所以要钉住：
  //   ① 没生成方案前按钮是禁用的；生成后变可用
  //   ② 点了之后 history 里真的多出一条 tool='math-plan' 的记录，且正文是这份方案
  //   ③ 再点一次**不会**产生第二条（接口按 (学生,工具,考试名,日期) 判重）
  {
    // 先确认按钮在「还没生成方案」时是禁用的
    const btnIdle = await inDoc(`
      const b = document.getElementById('btnSavePlan');
      return { exists: !!b, disabled: b ? b.disabled : null, text: b ? b.textContent.trim() : null };
    `);
    record("★存入档案：按钮存在，且**没生成方案前是禁用的**（不会存出空记录）",
      btnIdle?.exists === true && btnIdle.disabled === true, JSON.stringify(btnIdle));

    // 清掉可能的旧记录（用同一个标题+日期做幂等键，重复跑不会累积）
    await purge(STU);

    // 填姓名 + 点一个预设（预设会立刻生成方案）
    const gen = await inDoc(`
      const d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
      const n = document.getElementById('f-name');
      if(!n) return { err: '没有姓名输入框' };
      d.set.call(n, ${JSON.stringify(STU)});
      const preset = document.querySelector('.preset button[data-preset="gap"]');
      if(!preset) return { err: '没有预设按钮' };
      preset.click();
      return 'clicked';
    `);
    if (gen && gen.err) record("（准备）填姓名并生成方案", false, gen.err);
    await sleepMs(2500);
    const btnReady = await inDoc(`
      const b = document.getElementById('btnSavePlan');
      return { disabled: b ? b.disabled : null, rows: (window.MathPlanHooks && window.MathPlanHooks.counts()) ? window.MathPlanHooks.counts().docRows : null };
    `);
    record("★存入档案：生成方案后按钮变为**可用**",
      btnReady?.disabled === false, JSON.stringify(btnReady));

    // 点它
    await inDoc(`document.getElementById('btnSavePlan').click(); return 'ok';`);
    let savedRow = null;
    for (let i = 0; i < 20; i++) {
      await sleepMs(500);
      const h = await api(`/api/students?name=${encodeURIComponent(STU)}&withHistory=1`);
      const rows = h.body?.history?.[STU] || [];
      savedRow = rows.find((x) => x.tool === "math-plan") || null;
      if (savedRow) break;
    }
    record("★存入档案：点一下之后，档案里真的多了一条 tool='math-plan' 的记录",
      !!savedRow, savedRow ? JSON.stringify({ title: savedRow.title, score: savedRow.score, date: savedRow.date }) : "没找到");
    record("★存入档案：正文是这份方案（含学情诊断 / 提分目标 / 逐次课表）",
      !!savedRow && /【学情诊断】/.test(String(savedRow.text)) &&
        /【提分目标】/.test(String(savedRow.text)) && /【逐次课表】/.test(String(savedRow.text)),
      savedRow ? String(savedRow.text).slice(0, 120) : "—");
    record("★存入档案：分数与考试名带上了（供以后看趋势）",
      savedRow?.score === 65 && /辅导方案$/.test(String(savedRow?.title)),
      JSON.stringify({ score: savedRow?.score, title: savedRow?.title }));

    // 再点一次 → 幂等，不该出现第二条
    await inDoc(`document.getElementById('btnSavePlan').click(); return 'ok';`);
    await sleepMs(2500);
    const h2 = await api(`/api/students?name=${encodeURIComponent(STU)}&withHistory=1`);
    const planRows = (h2.body?.history?.[STU] || []).filter((x) => x.tool === "math-plan");
    record("★存入档案：再点一次**不会**存出第二条（按 学生+工具+考试名+日期 判重）",
      planRows.length === 1, `math-plan 记录条数=${planRows.length}`);
  }

  // ================================================================
  // 2. 接口防护：op:"import" 的 tool 不许静默兜底
  // ================================================================
  const impBad = await api("/api/students", {
    method: "POST",
    body: JSON.stringify({ op: "import", items: [
      { student_name: STU, text: "缺 tool 的记录", date: "10月7日", title: "无归属" },
    ] }),
  });
  record("★防护：import 缺 tool → 明确 400（不再静默标成 paper）",
    impBad.status === 400 && impBad.body?.ok === false,
    `status=${impBad.status} body=${JSON.stringify(impBad.body)}`);

  const impBadTool = await api("/api/students", {
    method: "POST",
    body: JSON.stringify({ op: "import", items: [
      { student_name: STU, text: "未登记归属", date: "10月7日", tool: "history", title: "坏" },
    ] }),
  });
  record("★防护：import 给了**未登记**的 tool（history）→ 明确 400（不是静默记成 paper）",
    impBadTool.status === 400 && impBadTool.body?.ok === false,
    `status=${impBadTool.status} body=${JSON.stringify(impBadTool.body)}`);

  // ★tool='math-plan' 现在是**合法**的（2026-10 起：迁移 0016 + 接口白名单都放开了）。
  //  ⚠️ 这条以前是反过来的（断言它被拒）—— 那时约束还没放开、用来防止「静默记成 paper」。
  //     现在放开之后，要钉住的是「它真的能以 math-plan 的身份写进去、读出来还是 math-plan」。
  const impPlan = await api("/api/students", {
    method: "POST",
    body: JSON.stringify({ op: "import", items: [
      { student_name: STU, text: "math-plan 归属正文", date: "10月11日", tool: "math-plan",
        title: "秋季辅导方案", score: 62, full_score: 150 },
    ] }),
  });
  record("★tool='math-plan' 已被接受并写入（迁移 0016 + 接口白名单两处都放开了）",
    impPlan.status === 200 && impPlan.body?.inserted === 1,
    `status=${impPlan.status} body=${JSON.stringify(impPlan.body)}`);
  // 读回来归属必须**仍是 math-plan**（不是被兜底成 paper）——这才是这条断言真正要防的事
  {
    const h = await api(`/api/students?name=${encodeURIComponent(STU)}&withHistory=1`);
    const rows = h.body?.history?.[STU] || [];
    const plan = rows.find((x) => String(x.text).includes("math-plan 归属正文"));
    record("★读回来归属仍是 math-plan（没被兜底成 paper），分数/考试名也带上了",
      plan?.tool === "math-plan" && plan?.title === "秋季辅导方案" && plan?.score === 62,
      JSON.stringify({ tool: plan?.tool, title: plan?.title, score: plan?.score }));
  }

  const impOk = await api("/api/students", {
    method: "POST",
    body: JSON.stringify({ op: "import", items: [
      { student_name: STU, text: "合法 paper 记录", date: "10月7日", tool: "paper", title: "合法" },
    ] }),
  });
  record("合法 tool='paper' 仍然正常导入（没把正常路径一起挡掉）",
    impOk.status === 200 && impOk.body?.ok === true && impOk.body?.inserted === 1,
    JSON.stringify(impOk.body));

  const impMixed = await api("/api/students", {
    method: "POST",
    body: JSON.stringify({ op: "import", items: [
      { student_name: STU, text: "混入的坏记录", date: "10月8日", tool: "history", title: "坏" },
      { student_name: STU, text: "混入的好记录", date: "10月9日", tool: "paper", title: "好" },
    ] }),
  });
  record("★防护：一条坏一条好 → 好的照样进，坏的条数**如实报出来**（rejectedTool）",
    impMixed.status === 200 && impMixed.body?.inserted === 1 && impMixed.body?.rejectedTool === 1,
    JSON.stringify(impMixed.body));

  // ================================================================
  // 3. 本机模式（file://）行为必须**一行没变**：不显示档案行、不调任何接口
  // ================================================================
  // 老师有可能直接把 HTML 下载下来双击打开。那时没有 /api/students，
  // 一旦 bootCloud 误判成云端就会弹一句「读不到档案」的错，等于把本机模式弄坏了。
  {
    pageErrors.length = 0;                       // 只统计本机模式这一段
    await cdp.send("Page.navigate", { url: "file:///D:/my-website/my-toolbox/public/tools/math-plan.html" }, sessionId);
    await cdp.waitForEvent("Page.loadEventFired").catch(() => {});
    await sleepMs(2500);
  }
  const local = await inDoc(`
    const row = document.getElementById('stuRow');
    return {
      hasRow: !!row,
      rowVisible: !!(row && row.offsetParent !== null),
      hasIdentity: !!document.getElementById('f-name'),
      enabled: (typeof CLOUD_STORE !== 'undefined') ? CLOUD_STORE.enabled : 'undefined',
    };
  `);
  record("★本机模式（file://）：页面照常初始化（学生/年级等输入框都在）",
    local && local.hasIdentity === true, JSON.stringify(local));
  record("★本机模式（file://）：**不显示**档案行、云模式保持关闭（行为与接入前一致）",
    local && local.hasRow === true && local.rowVisible === false && local.enabled === false,
    JSON.stringify(local));
  // ⚠️ 这里**不**断言「file:// 下页面零异常」：本机模式下 AI 那段本来就打不到服务端，
  //    老代码也会记异常，把这条写死会变成假红。只钉住**本次新增代码**没把本机模式弄坏。
  const stuErrors = pageErrors.filter((p) => /students|bootCloud|CLOUD_STORE|读不到账号/i.test(p));
  record("★本机模式（file://）：新增的档案代码没有抛异常（没去调不存在的 /api/students）",
    stuErrors.length === 0, stuErrors.slice(0, 3).join(" | ") || "0 条");

  if (pageErrors.length) {
    console.log("     页面错误详情:");
    pageErrors.slice(0, 6).forEach((p) => console.log("       " + p));
  }
  record("页面无真实 JS 异常", pageErrors.length === 0, `${pageErrors.length} 条`);

  // ---------------------------------------------------------------- 清理
  await purge(STU);
  await purge(STU + "·全字段");
  const left = await (await fetch(
    `${SUPABASE_URL}/rest/v1/feedback_students?name=in.(${encodeURIComponent(STU)},${encodeURIComponent(STU + "·全字段")})&select=name`,
    { headers: H })).json();
  record("探针数据已清理（线上不留垃圾）", Array.isArray(left) && left.length === 0,
    `剩余=${JSON.stringify(left)}`);

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
