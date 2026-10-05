// AI 改写「落地」回归：桩上游 + 真浏览器，检查点「应用」这一步
//
// 为什么需要这个套件（补的测试缺口）：
//   现有两套 AI 测试都到不了「把 AI 返回写回 DOM」这一步 ——
//     · math-plan-ai-sections：本地无 AI_KEY → 503 → 替换逻辑不执行
//     · math-plan-ai-vip-path：假 Key 打真上游 → 502 → 替换逻辑同样不执行
//   于是「（1）方案与总量。（1）方案与总量。」这种**标题写两遍**的 bug
//   在 172 项全绿的情况下漏到了线上。
//
// 做法：起一个本地桩上游，把 AI_BASE_URL 指过去，并让桩**故意返回带前缀的文本**
//      （模拟真实模型按旧提示词回显小标题），从而真正压到落地逻辑。
//
//   1. method：点「AI 改写」→ 6 段每段的「（N）小标题。」只出现 1 次（6 段各断言）
//   2. goals ：点「AI 改写教学目标」→ 每格被替换成桩返回的那一行
//   3. 请求体：method 的 system 要求「只输出该段正文」；goals 的 system 含量化表
//   4. 请求体：goals 的 context 带 band，且每个 lesson 都带 lv
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { startBrowser, makePageApi, makeRecorder, readUsers, sleepMs } from "./_helpers.mjs";

const NODE_BIN = "C:\\Users\\郭庆杰\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\node\\bin\\node.exe";
const NEXT_BIN = "D:\\my-website\\my-toolbox\\node_modules\\next\\dist\\bin\\next";
const PROJECT = "D:\\my-website\\my-toolbox";
const STUB_PORT = 4567;

const { userEmail, password } = readUsers();   // roleb- = VIP
const { record, summary } = makeRecorder();

/* ---------------- 桩上游：故意回显前缀 ---------------- */
const captured = [];
const stub = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    let body = null;
    try { body = JSON.parse(raw); } catch { /* ignore */ }
    captured.push({ model: body?.model, messages: body?.messages });

    const msgs = body?.messages ?? [];
    const last = msgs[msgs.length - 1]?.content ?? "{}";
    let content = "桩上游内容";
    try {
      const ctx = JSON.parse(last);
      if (ctx.section === "goals" || ctx.lessons) {
        // goals：每行带一个量化指标
        content = (ctx.lessons ?? []).map((l, i) => `桩目标${i + 1}（lv${l.lv ?? "?"}）正确率≥85%`).join("\n");
      } else {
        // method：★故意把输入里的「（N）小标题。」原样回显★ —— 复现线上那个 bug 的触发条件
        content = (ctx.paragraphs ?? []).map((p, i) => {
          const m = String(p).match(/^（\d{1,2}）[^。！？]{0,12}[。！？]/);
          const prefix = m ? m[0] : "";
          return `${prefix}桩改写正文（第${i + 1}段）。`;
        }).join("\n");
      }
    } catch { /* ignore */ }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
});
await new Promise((r) => stub.listen(STUB_PORT, "127.0.0.1", r));

function killPort3000() {
  const pid = spawnSync("powershell", ["-NoProfile", "-Command",
    "(Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue).OwningProcess"],
    { encoding: "utf8" }).stdout.trim();
  if (pid) spawnSync("powershell", ["-NoProfile", "-Command", `Stop-Process -Id ${pid} -Force`], { encoding: "utf8" });
}

let srv = null, edge = null;
const pageErrors = [];
try {
  killPort3000();
  await sleep(2000);
  srv = spawn(NODE_BIN, [NEXT_BIN, "start", "-p", "3000"], {
    cwd: PROJECT, stdio: "ignore",
    env: { ...process.env, AI_KEY: "sk-local-stub-not-real", AI_BASE_URL: `http://127.0.0.1:${STUB_PORT}/v1` },
  });
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    try { if ((await fetch("http://127.0.0.1:3000/login")).status === 200) break; } catch { /* wait */ }
  }

  const b = await startBrowser(9490, "D:/my-website/.edge-profile-mp-apply");
  edge = b.edge;
  const { cdp, sessionId } = b;
  const { ev, goto, login } = makePageApi(cdp, sessionId);

  // 收集页面真实 JS 异常（删掉 btnDocLegacy 的绑定后，这一项要保证仍然是 0 条）
  // 两类**已知噪声**必须过滤，否则这条断言会随机变红（本仓库其它真浏览器套件也是这么做的）：
  //   ① Edge 扩展（chrome-extension://…）自己发 fetch 失败时抛的异常；
  //   ② 导航或关闭页面时被中断的 XMLHttpRequest —— 特征是 className=Object，
  //      且 preview 里带 setRequestHeader/readyState（登录检查、AI 请求被打断都会命中）。
  cdp.ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.method !== "Runtime.exceptionThrown") return;
    const d = m.params.exceptionDetails;
    const ex = d?.exception ?? {};
    const desc = typeof ex.description === "string" ? ex.description : "";

    const fromExtension = /chrome-extension:\/\/|extension:\/\//.test(desc)
      || /extension:\/\//.test(String(d?.url))
      || (d?.stackTrace?.callFrames ?? []).some((f) => /extension:\/\//.test(String(f?.url)));
    if (fromExtension) return;

    const abortedXhr = String(ex.className) === "Object" && Array.isArray(ex.preview?.properties)
      && ex.preview.properties.some((p) => p.name === "setRequestHeader" || p.name === "readyState");
    if (abortedXhr) return;

    pageErrors.push(`${String(d?.text)} ${desc.slice(0, 160)} url=${String(d?.url)}`);
  });

  const loggedIn = await login(userEmail, password);
  record("VIP 账号(roleb) 登录成功", loggedIn);
  if (!loggedIn) throw new Error("登录失败");

  // 静态页直接用（与 export-ui 一致；这一步只关心前端落地逻辑）
  await goto("/tools/math-plan.html", 9000);
  const inDoc = (body) => ev(`(() => { const doc=document; try { ${body} } catch(e){ return {__err:String(e&&e.message||e)}; } })()`);

  for (let i = 0; i < 24; i++) {
    if (await inDoc(`return !!doc.getElementById('btnGen')`)) break;
    await sleepMs(500);
  }

  /* ---- 生成方案 ---- */
  await inDoc(`const b=doc.querySelector('.preset button[data-preset="gap"]'); if(!b) return {err:'无 gap 预设'}; b.click(); return 'ok';`);
  await sleepMs(3000);
  let ready = await inDoc(`return { paras: doc.querySelectorAll('#methodBody p').length, goals: doc.querySelectorAll('#goalsBody [data-goal]').length }`);
  if (!ready || !ready.goals) {
    await inDoc(`const b=doc.getElementById('btnGen'); if(b) b.click(); return 'ok';`);
    await sleepMs(2500);
    ready = await inDoc(`return { paras: doc.querySelectorAll('#methodBody p').length, goals: doc.querySelectorAll('#goalsBody [data-goal]').length }`);
  }
  record("方案已生成（6 段教学方法 + 逐次课表）",
    ready?.paras === 6 && ready?.goals > 0, JSON.stringify(ready));

  /* ---- 1) method：点 AI 改写，检查小标题是否重复 ---- */
  await inDoc(`const b=doc.querySelector('.ai-btn[data-ai="method"]'); if(b) b.click(); return 'ok';`);
  await sleepMs(3500);

  const methodState = await inDoc(`
    const ps = Array.from(doc.querySelectorAll('#methodBody p'));
    return ps.map((p, i) => {
      const strong = p.querySelector('b');
      const label = strong ? strong.textContent.trim() : '';
      const text = p.innerText.replace(/\\s+/g, ' ');
      let count = 0, idx = 0;
      while (label && (idx = text.indexOf(label, idx)) !== -1) { count++; idx += label.length; }
      return { no: i + 1, label, count, head: text.slice(0, 46) };
    });
  `);

  if (!Array.isArray(methodState)) {
    record("读取 methodBody 各段成功", false, JSON.stringify(methodState));
  } else {
    record("AI 改写后仍是 6 段（结构未被破坏）", methodState.length === 6, `${methodState.length} 段`);
    // 6 段各断言一次：小标题只出现 1 次
    methodState.forEach((s) => {
      record(`第 ${s.no} 段小标题「${s.label}」只出现 1 次`, s.count === 1, `出现 ${s.count} 次 | ${s.head}`);
    });
  }

  /* ---- 2) goals：点 AI 改写教学目标，检查是否落到表格 ---- */
  await inDoc(`const b=doc.querySelector('.ai-btn[data-ai="goals"]'); if(b) b.click(); return 'ok';`);
  await sleepMs(3500);

  const goalState = await inDoc(`
    const cells = Array.from(doc.querySelectorAll('#goalsBody [data-goal]'));
    return { n: cells.length, first: cells[0] ? cells[0].textContent.trim() : null,
             allStub: cells.every(c => /^桩目标\\d+/.test(c.textContent.trim())) };
  `);
  record("goals 改写已落地（每格都被替换成桩返回内容）",
    goalState?.allStub === true, `${goalState?.n} 格，首格「${String(goalState?.first).slice(0, 30)}」`);

  /* ---- 3)+4) 检查桩收到的请求体 ---- */
  const mMethod = captured.find((c) => c.messages?.length === 2 && /教学方法/.test(c.messages?.[0]?.content ?? ""));
  const mGoals = captured.find((c) => (c.messages?.length ?? 0) > 2);

  record("桩共收到 2 次请求（method + goals）", captured.length === 2, `captured=${captured.length}`);

  if (mMethod) {
    const sys = mMethod.messages[0].content;
    record("method system 要求「只输出该段正文」（不再要求保留小标题）",
      /只输出该段正文/.test(sys) && /不要输出「（1）」这类编号/.test(sys));
    record("method system 已不含旧的「保留该分条名」指令",
      !/保留该分条名/.test(sys));
    record("method system 仍含 4 份真实范例", /范例1/.test(sys) && /范例4/.test(sys));
  } else {
    record("捕获到 method 请求", false, "未捕获");
  }

  if (mGoals) {
    const sys = mGoals.messages[0].content;
    record("goals system 含量化表（band×lv 四行阈值）",
      /≥70%/.test(sys) && /≥80%/.test(sys) && /≥85%/.test(sys) && /≥60%/.test(sys) && /≥75%/.test(sys) && /≥50%/.test(sys));
    record("goals system 含反例「能理解函数的概念」", /能理解函数的概念/.test(sys));

    const ctx = JSON.parse(mGoals.messages[mGoals.messages.length - 1].content);
    // 便于人工核对：把桩收到的量化表与一行样例打印出来
    sys.split("\n").filter((l) => /(lv1|lv2|lv3)/.test(l))
      .forEach((l) => console.log("     量化表 → " + l.trim()));
    console.log("     样例课次 → " + JSON.stringify((ctx.lessons ?? [])[0]));
    record("goals 上下文带 band", typeof ctx.band === "number", `band=${ctx.band}`);
    const lvs = (ctx.lessons ?? []).map((l) => l.lv);
    record("goals 每行都带 lv（1/2/3）",
      lvs.length > 0 && lvs.every((v) => v === 1 || v === 2 || v === 3),
      `共 ${lvs.length} 行，lv 取值 ${[...new Set(lvs)].sort().join(",")}`);
    record("goals 每行仍带 stage/content/goal",
      (ctx.lessons ?? []).every((l) => l.stage && l.content && l.goal));
  } else {
    record("捕获到 goals 请求", false, "未捕获");
  }

  /* ---- 页面无 JS 异常（重点：删掉 btnDocLegacy 绑定后不能报错） ---- */
  if (pageErrors.length) pageErrors.slice(0, 5).forEach((p) => console.log("     页面异常: " + p));
  record("页面无真实 JS 异常", pageErrors.length === 0, `${pageErrors.length} 条`);

  try { await cdp.send("Browser.close"); } catch { /* ignore */ }
} catch (e) {
  record("测试执行未异常中断", false, e.message);
  console.error("测试异常:", e.message);
} finally {
  if (edge) { try { edge.kill(); } catch { /* ignore */ } }
  if (srv) { try { srv.kill(); } catch { /* ignore */ } }
  stub.close();
}
const ok = summary();
process.exit(ok ? 0 : 1);
