#!/usr/bin/env node
/**
 * 全学科试卷分析 v2 · 真浏览器冒烟测试
 * ==========================================================================
 * 只验「新界面壳」这条链：
 *   · 页面能打开（登录后），iframe 里 4 学科 × 2 学段可选；
 *   · 点「填入示例」→ 19 题出现，题型表 4 行；
 *   · 录一个错题 → 生成错因；
 *   · 导出附件1 能返回合法 docx 字节（不靠下载目录，直接拿返回值）。
 * 老数学版的回归由 paper-analysis / paper-regression / vision-paper 等套件负责。
 */
import { spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { makePageApi, makeRecorder, readUsers, startBrowser, startServer } from "./_helpers.mjs";

const { record, summary } = makeRecorder();
const { userEmail, password } = readUsers();
const PORT = 9499;
const PROFILE = "D:\\my-website\\.edge-profile-paper-v2";

let srv = null;
let edge = null;
try {
  srv = await startServer();
  record("next start 起来了", true);

  const b = await startBrowser(PORT, PROFILE);
  edge = b.edge;
  const { cdp, sessionId } = b;
  const { ev, goto, login, inTool } = makePageApi(cdp, sessionId);
  const pageErrors = [];
  cdp.ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.method === "Runtime.exceptionThrown") {
      const d = m.params.exceptionDetails;
      const desc = String(d?.exception?.description || "");
      if (/chrome-extension:\/\//.test(desc)) return;
      pageErrors.push(`${String(d?.text)} ${desc.slice(0, 160)}`);
    }
  });

  record("（准备）VIP 登录成功", await login(userEmail, password));
  await goto("/tools/paper-analysis-v2", 5000);
  const iframe = await ev(`(() => { const f=document.querySelector('iframe'); return f?f.getAttribute('src'):null; })()`);
  record("v2 工具页有 iframe，src 指向 /tools/paper-analysis-v2", /paper-analysis-v2/.test(String(iframe)), String(iframe));

  await sleep(2500);
  const ui = await inTool(`
    return {
      subjectCount: w.document.querySelectorAll('#v2Subject option').length,
      stageCount: w.document.querySelectorAll('#v2Stage option').length,
      subject: w.document.querySelector('#v2Subject').value,
      fullScore: w.document.querySelector('#v2FullScore').value,
      hasDemo: !!w.document.querySelector('#v2Demo'),
      hasExport: !!w.document.querySelector('#v2Export1') && !!w.document.querySelector('#v2Export2'),
    };
  `);
  record("① 学科 4 个 / 学段 2 个 / 默认数学 150 分",
    ui?.subjectCount === 4 && ui?.stageCount === 2 && ui?.subject === "math" && Number(ui?.fullScore) === 150,
    JSON.stringify(ui));
  record("② 页面有「填入示例」和三档导出按钮", ui?.hasDemo === true && ui?.hasExport === true, JSON.stringify(ui));

  await inTool(`w.document.querySelector('#v2Demo').click(); true;`);
  await sleep(1200);
  const parsed = await inTool(`
    const s = w.PaperV2.getState();
    return {
      n: s.paper ? s.paper.questions.length : 0,
      blocks: w.document.querySelectorAll('#v2Blocks tbody tr').length,
      rows: w.document.querySelectorAll('#v2Questions tbody tr').length,
      firstNo: s.paper ? s.paper.questions[0].no : null,
      firstType: s.paper ? s.paper.questions[0].type : null,
    };
  `);
  record("★③ 示例解析出 19 题 / 4 个题型 / 题号字符串",
    parsed?.n === 19 && parsed?.blocks === 4 && parsed?.rows === 19 && parsed?.firstNo === "1",
    JSON.stringify(parsed));

  await inTool(`
    const q = w.PaperV2.getState().paper.questions[0];
    q.got = q.score - 1;
    w.PaperV2.render();
    w.document.querySelector('#v2ReasonBtn').click();
    return true;
  `);
  await sleep(400);
  const reason = await inTool(`
    const q = w.PaperV2.getState().paper.questions[0];
    return { got: q.got, reason: q.reason || '' };
  `);
  record("★④ 录分 + 生成错因（错题原因不为空）", reason?.got != null && String(reason?.reason).length > 5, JSON.stringify(reason));

  const exp = await inTool(`
    return w.PaperV2.exportAttachment('附件1');
  `);
  record("★⑤ 导出附件1：返回合法 docx 字节（PK 头 + 大于 1KB）",
    exp?.ok === true && exp.bytes?.length > 1000 && exp.bytes[0] === 80 && exp.bytes[1] === 75,
    exp?.ok ? `${exp.bytes.length} 字节` : JSON.stringify(exp));

  const exp2 = await inTool(`
    return w.PaperV2.exportAttachment('附件2');
  `);
  record("★⑤b 导出附件2：同样返回合法 docx 字节（三档导出里的第二档）",
    exp2?.ok === true && exp2.bytes?.length > 1000 && exp2.bytes[0] === 80 && exp2.bytes[1] === 75,
    exp2?.ok ? `${exp2.bytes.length} 字节` : JSON.stringify(exp2));

  await inTool(`
    const sub = w.document.querySelector('#v2Subject');
    sub.value = 'physics'; sub.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  `);
  await sleep(500);
  const phy = await inTool(`
    return {
      subject: w.document.querySelector('#v2Subject').value,
      fullScore: w.document.querySelector('#v2FullScore').value,
      grade: w.document.querySelector('#v2Grade').value,
    };
  `);
  record("★⑥ 切到物理：满分 100、年级默认高三（科目包切换生效）",
    phy?.subject === "physics" && Number(phy?.fullScore) === 100 && phy?.grade === "高三",
    JSON.stringify(phy));

  record("页面无真实 JS 异常", pageErrors.length === 0, pageErrors.slice(0, 2).join(" | ") || "0 条");

  await goto("/tools/paper-analysis-v2/index.html?nopaperv2=1", 2500);
  const off = await ev(`(() => {
    const d = document.querySelector('#v2Disabled');
    const w = document.querySelector('.wrap');
    return { shown: !!d && !d.classList.contains('hidden'), wrapHidden: !!w && w.classList.contains('hidden') };
  })()`);
  record("★⑦ 后台关掉开关（?nopaperv2=1）：显示「暂时关闭」而不是空白页",
    off?.shown === true && off?.wrapHidden === true, JSON.stringify(off));

  try { await cdp.send("Browser.close"); } catch { /* ignore */ }
} catch (e) {
  record("测试执行未异常中断", false, String(e && e.message ? e.message : e));
  console.error(e?.stack ?? e);
} finally {
  if (srv?.pid) spawnSync("powershell", ["-NoProfile", "-Command", `Stop-Process -Id ${srv.pid} -Force`], { encoding: "utf8" });
  if (edge) { try { edge.kill(); } catch { /* ignore */ } }
  const ok = summary();
  process.exit(ok ? 0 : 1);
}

