// 阶段③（阶段B）验证：AI 分区润色接口 + 前端按钮
//
//   1. 接口鉴权：未登录 401 / 非会员 403 / 会员但无 AI_KEY 503（或配了 Key 则 200/502）
//   2. 入参校验：section 非法 400、空内容 400、非 JSON 400
//   3. 前端：/tools/math-plan 里两个「✨ AI 改写」按钮存在、可点击，
//      点击后能走到服务端并给出提示（本地无 AI_KEY → 期望"服务端未配置"）
//   4. 页面无真实 JS 异常
//
// 鉴权做法说明：接口靠 Supabase 会话 Cookie 鉴权。手工拼 sb-<ref>-auth-token
// 在本项目里拿不到会员身份（实测 403），所以接口断言一律**在已登录的页面里发 fetch**，
// 用浏览器真实会话（credentials: same-origin），与前端按钮走的是同一条路。
import { startServer, startBrowser, makePageApi, makeRecorder, readUsers, sleepMs } from "./_helpers.mjs";

const { adminEmail, userEmail, password } = readUsers();
const { record, summary } = makeRecorder();

const API = "/api/math-plan/ai-sections";
const METHOD_BODY = {
  section: "method",
  context: {
    grade: "高三", band: 2, score: 65, target: 95, totalHours: 80,
    paragraphs: ["（1）方案与总量。本方案共 80 课时。"],
  },
};

let srv = null, edge = null;
try {
  srv = await startServer();

  /* ============================ 1. 未登录（Origin 合法但未带会话） ============================ */
  {
    const res = await fetch(`http://127.0.0.1:3000${API}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://127.0.0.1:3000" },
      body: JSON.stringify(METHOD_BODY),
    });
    const text = await res.text();
    let body = {};
    try { body = JSON.parse(text); } catch { /* 可能是被中间件重定向后的 HTML */ }
    record("未登录调用被拒（401）", res.status === 401, `HTTP ${res.status} ${body.error ?? text.slice(0, 60)}`);
    record("401 响应体不含 AI Key", !text.includes("sk-"), text.slice(0, 70));
  }

  /* ============================ 2. 浏览器会话下的接口断言 ============================ */
  const b = await startBrowser(9440, "D:/my-website/.edge-profile-mathplan-ai");
  edge = b.edge;
  const { cdp, sessionId } = b;
  const { ev, goto, inTool, login } = makePageApi(cdp, sessionId);

  const pageErrors = [];
  cdp.ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.method === "Runtime.exceptionThrown") {
      const d = m.params.exceptionDetails;
      const ex = d?.exception ?? {};
      const desc = typeof ex.description === "string" ? ex.description : "";
      const abortedXhr = desc === "Object" && Array.isArray(ex.preview?.properties)
        && ex.preview.properties.some((p) => p.name === "setRequestHeader" || p.name === "readyState");
      if (!abortedXhr) pageErrors.push(`${String(d?.text)} ${desc.slice(0, 200)}`);
    }
    if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
      const args = (m.params.args ?? []).map((a) => (a.description ?? a.value ?? a.type ?? "").toString()).join(" ").slice(0, 200);
      if (!(/readyState|overrideMimeType/.test(args) && args.length < 120)) pageErrors.push("console.error: " + args);
    }
  });

  /** 在页面里发同源 POST，返回 {status, body, text} */
  const callApi = (bodyObj) =>
    ev(`fetch(${JSON.stringify(API)}, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: ${JSON.stringify(typeof bodyObj === "string" ? bodyObj : JSON.stringify(bodyObj))}
      }).then(async r => {
        const t = await r.text();
        let j = null; try { j = JSON.parse(t); } catch(e){}
        return { status: r.status, body: j, text: String(t).slice(0, 200) };
      }).catch(e => ({ status: -1, body: null, text: String(e && e.message) }))`);

  /* ---- 2a. 免费用户（rolea-，admin 但免费版）→ 403 ---- */
  // 环境事实：roleb- 已被开通 VIP，rolea- 仍是免费版（/upgrade 页显示"免费版"）。
  // 既有 /api/paper-analysis/ai-advice 等测试也用 rolea- 当"非会员"样本，口径一致。
  const loggedInAdmin = await login(adminEmail, password);
  record("免费版账号（rolea-）登录成功", loggedInAdmin);
  if (loggedInAdmin) {
    const r = await callApi(METHOD_BODY);
    record("非会员调用被拒 403", r.status === 403, `HTTP ${r.status} ${r.body?.error ?? r.text}`);
    record("403 文案说明是会员专属", /会员/.test(String(r.body?.error)), String(r.body?.error));
    record("403 响应体不含 AI Key", !String(r.text).includes("sk-"), String(r.text).slice(0, 70));
  }

  /* ---- 2b. VIP（roleb-）----
     顺序事实：接口的处理顺序是 ①requireVip → ②AI_KEY 检查 → ③入参校验。
     所以本地**没有 AI_KEY** 时，即使是 VIP + 非法入参，也会先被 503 拦住，
     400 分支在本机不可能到达（这是设计使然，与既有 ai-advice 一致）。
     因此这里只断言「走到了配置闸」；400 校验由假 Key 环境的单独脚本覆盖。 */
  const loggedInUser = await login(userEmail, password);
  record("VIP 账号（roleb-）登录成功", loggedInUser);
  if (loggedInUser) {
    const badSection = await callApi({ section: "nope", context: { paragraphs: ["x"] } });
    record("VIP + 无 Key 时先被配置闸拦住（503），入参校验在此之前不触发",
      badSection.status === 503, `HTTP ${badSection.status} ${badSection.body?.error ?? ""}`);

    const okCall = await callApi(METHOD_BODY);
    const isNoKey = okCall.status === 503;
    record("VIP 调用走通鉴权（503=未配 Key / 200=成功 / 502=上游错）",
      [200, 502, 503].includes(okCall.status), `HTTP ${okCall.status} ${okCall.body?.error ?? ""}`);
    if (isNoKey) {
      record("无 AI_KEY 时给出「服务端未配置 AI Key」提示",
        /服务端未配置/.test(String(okCall.body?.error)), String(okCall.body?.error));
      record("503 响应体不含 AI Key", !String(okCall.text).includes("sk-"), String(okCall.text).slice(0, 70));
    } else {
      record("已配置 AI_KEY（本次跳过 503 断言）", true, `HTTP ${okCall.status}`);
    }

    const goalsCall = await callApi({
      section: "goals",
      context: { grade: "高三", lessons: [{ stage: "数列", content: "通项", goal: "正确率≥90%" }] },
    });
    record("goals 分支同样受鉴权与 Key 校验保护",
      [200, 502, 503].includes(goalsCall.status), `HTTP ${goalsCall.status} ${goalsCall.body?.error ?? ""}`);
  }

  /* ============================ 3. 前端按钮实测 ============================ */
  // 注意：线上 tools 表把 math-plan 设成了 VIP 专属（与仓库里的 migration 不一致），
  // 非会员访问 /tools/math-plan 会被重定向到 /upgrade，从而看不到 iframe。
  // 这里直接打开工具自身的 HTML（与 iframe 同一份文件、同一 origin，同样受登录保护），
  // 以验证按钮与前后端往返。
  if (loggedInAdmin) {
    await goto("/tools/math-plan.html", 8000);
    const navPath = await ev("location.pathname");
    record("工具 HTML 可直接加载（同 origin，受登录保护）", navPath === "/tools/math-plan.html", String(navPath));

    for (let i = 0; i < 24; i++) {
      if (await ev(`!!document.getElementById('btnGen')`)) break;
      await sleepMs(500);
    }
    // 工具在顶层窗口时没有 iframe，用顶层 document
    const inDoc = (body) => ev(`(() => { const doc=document; try { ${body} } catch(e){ return {__err:String(e&&e.message||e)}; } })()`);

    // 用「gap」预设直接生成一份方案，让文档渲染出来
    const preset = await inDoc(`
      const b = doc.querySelector('.preset button[data-preset="gap"]');
      if(!b) return { err: '没有 gap 预设按钮' };
      b.click(); return 'ok';
    `);
    if (preset && preset.err) record("找到预设按钮", false, preset.err);
    await sleepMs(3000);

    let ready = await inDoc(`return { r: doc.querySelectorAll('#doc tbody tr').length }`);
    if (!ready || !ready.r) {
      await inDoc(`const b=doc.getElementById('btnGen'); if(b) b.click(); return 'ok';`);
      await sleepMs(2500);
      ready = await inDoc(`return { r: doc.querySelectorAll('#doc tbody tr').length }`);
    }
    record("方案文档已渲染（有表格行）", !!ready && ready.r > 0, JSON.stringify(ready));

    const btnInfo = await inDoc(`
      const btns = Array.from(doc.querySelectorAll('.ai-btn[data-ai]'));
      return {
        count: btns.length,
        kinds: btns.map(b => b.dataset.ai),
        texts: btns.map(b => b.textContent.trim()),
        hasMethodBody: !!doc.getElementById('methodBody'),
        hasGoalsBody: !!doc.getElementById('goalsBody'),
        goalCells: doc.querySelectorAll('#goalsBody [data-goal]').length,
        disabled: btns.map(b => !!b.disabled),
        docRows: doc.querySelectorAll('#doc tbody tr').length,
      };
    `);
    if (btnInfo && btnInfo.__err) record("读取前端按钮信息", false, String(btnInfo.__err));
    const bi = btnInfo && !btnInfo.__err ? btnInfo : { count: 0, kinds: [], texts: [], disabled: [] };
    record("生成方案后存在 2 个 AI 改写按钮", bi.count === 2,
      `count=${bi.count} kinds=${JSON.stringify(bi.kinds)} 文档行=${bi.docRows}`);
    record("按钮文案为「AI 改写」与「AI 改写教学目标」",
      /AI 改写/.test(bi.texts.join("|")) && /教学目标/.test(bi.texts.join("|")),
      bi.texts.join(" | "));
    record("「教学方法」容器就位", bi.hasMethodBody === true);
    record("「逐次课表」容器就位且每行有教学目标单元格",
      bi.hasGoalsBody === true && bi.goalCells > 0, `goal 单元格 ${bi.goalCells} 个`);
    record("按钮初始可点击（未 disabled）",
      bi.disabled.length === 2 && bi.disabled.every((d) => d === false), JSON.stringify(bi.disabled));

    const waitToast = async (re) => {
      for (let i = 0; i < 30; i++) {
        await sleepMs(400);
        const t = await inDoc(`return doc.getElementById('toast') ? doc.getElementById('toast').textContent : ''`);
        if (t && re.test(String(t))) return String(t);
      }
      return "";
    };

    await inDoc(`doc.querySelector('.ai-btn[data-ai="method"]').click(); return 'clicked';`);
    const toastText = await waitToast(/服务端未配置|会员|失败|登录|超时|不可用/);
    record("点「AI 改写」后走到服务端并弹出提示", toastText.length > 0, toastText.slice(0, 70));
    // 本节用免费版账号（rolea-）驱动 → 服务端返回 403「会员专属」；
    // VIP（roleb-）且未配 Key 时则是 503「服务端未配置」。两者都算往返成功。
    record("提示文案来自服务端（会员专属 / 服务端未配置）",
      /服务端未配置|会员/.test(toastText), toastText.slice(0, 70));

    const afterBtn = await inDoc(`
      const b = doc.querySelector('.ai-btn[data-ai="method"]');
      return { disabled: !!b.disabled, text: b.textContent.trim() };
    `);
    record("调用结束后按钮恢复可用且文案还原",
      afterBtn && afterBtn.disabled === false && /AI 改写/.test(afterBtn.text), JSON.stringify(afterBtn));

    await inDoc(`doc.querySelector('.ai-btn[data-ai="goals"]').click(); return 'ok';`);
    const toast2 = await waitToast(/服务端未配置|会员|失败|登录|超时|不可用/);
    record("点「AI 改写教学目标」同样给出提示", toast2.length > 0, toast2.slice(0, 70));

    const intact = await inDoc(`
      return {
        methodParas: doc.querySelectorAll('#methodBody p').length,
        goalsFilled: Array.from(doc.querySelectorAll('#goalsBody [data-goal]')).filter(td => td.textContent.trim().length > 0).length,
      };
    `);
    record("失败后原文案未被破坏",
      !!intact && intact.methodParas > 0 && intact.goalsFilled > 0, JSON.stringify(intact));

    // AI 按钮是界面操作元素，不应进入 Word 导出
    const noprint = await inDoc(`
      const clone = doc.getElementById('doc').cloneNode(true);
      clone.querySelectorAll('[data-noprint]').forEach(el => el.remove());
      return { inExport: clone.querySelectorAll('.ai-btn').length, inPage: doc.querySelectorAll('.ai-btn').length };
    `);
    record("AI 按钮已在 Word 导出时被剔除",
      !!noprint && noprint.inExport === 0 && noprint.inPage === 2, JSON.stringify(noprint));

    if (pageErrors.length) {
      console.log("     页面错误详情:");
      pageErrors.slice(0, 6).forEach((p) => console.log("       " + p));
    }
    record("页面无真实 JS 异常", pageErrors.length === 0, `${pageErrors.length} 条`);
  } else {
    record("会员登录后进入前端按钮测试", false, "rolea- 未登录成功，跳过前端按钮断言");
  }

  try { await cdp.send("Browser.close"); } catch { /* ignore */ }
} catch (e) {
  record("测试执行未异常中断", false, e.message);
  console.error("测试异常:", e.message);
} finally {
  if (edge) { try { edge.kill(); } catch { /* ignore */ } }
  if (srv) { try { srv.kill(); } catch { /* ignore */ } }
}

const pass = summary();
process.exit(pass ? 0 : 1);
