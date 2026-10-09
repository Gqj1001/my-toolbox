// 第二批「解答题分值逐题可编辑」· 浏览器端到端验证
//
// 跑在 next start（生产构建）+ 无头 Edge 上，真实点击、真实事件：
//   1. DEMO 试卷 → 分值分配表主行结构（题型/题量/平均/总分）
//   2. 默认全部收起
//   3. 展开解答题 → 逐题输入框、题号、批量栏
//   4. 改一道题 → 该行总分/平均、整卷合计、提示行「与预设不一致」
//   5. 批量设置区间 → 只影响该题型内该区间
//   6. 收起子行
//   7. 页面无真实 JS 异常（尤其没有 ReferenceError / 监听器叠加报错）
import { startServer, startBrowser, makePageApi, makeRecorder, readUsers, sleepMs } from "./_helpers.mjs";

const { adminEmail, password } = readUsers();
const { record, summary } = makeRecorder();
let srv = null, edge = null;

// 面板里的单元格查询：主行按题型名定位
const ROW_INFO = `
  const rows = Array.from(doc.querySelectorAll('#scoreTable tr.trow'));
  return rows.map(tr => {
    const tds = tr.querySelectorAll('td');
    return {
      type: tds[0].innerText.trim(),
      count: tds[1].innerText.trim(),
      per: tds[2].innerText.trim(),
      total: tds[3].innerText.trim(),
    };
  });
`;

try {
  srv = await startServer();
  const b = await startBrowser(9430, "D:/my-website/.edge-profile-paper-batch2");
  edge = b.edge;
  const { cdp, sessionId } = b;
  const { ev, goto, inTool, login } = makePageApi(cdp, sessionId);

  // 收集页面真实异常（排除被导航打断的 XHR，沿用既有测试的判据）
  const pageErrors = [];
  cdp.ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.method === "Runtime.exceptionThrown") {
      const d = m.params.exceptionDetails;
      const ex = d?.exception ?? {};
      const desc = typeof ex.description === "string" ? ex.description : "";
      const isAbortedXhr = desc === "Object" && Array.isArray(ex.preview?.properties)
        && ex.preview.properties.some((p) => p.name === "setRequestHeader" || p.name === "readyState");
      if (isAbortedXhr) return;
      pageErrors.push(`${String(d?.text)} ${desc.slice(0, 240)}`);
    }
    if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
      const args = (m.params.args ?? []).map((a) => (a.description ?? a.value ?? a.type ?? "").toString()).join(" ").slice(0, 240);
      if (/readyState|overrideMimeType/.test(args) && args.length < 120) return;
      pageErrors.push("console.error: " + args);
    }
  });

  const loggedIn = await login(adminEmail, password);
  record("管理员登录成功", loggedIn);
  if (!loggedIn) throw new Error("登录失败，无法继续");

  await goto("/tools/paper-analysis", 9000);
  // 等 iframe 与 detectServer 就位
  for (let i = 0; i < 20; i++) {
    const r = await inTool(`return !!doc.getElementById('btnDemo')`);
    if (r === true) break;
    await sleepMs(500);
  }

  // ---------- 载入 DEMO 并解析 ----------
  await inTool(`doc.getElementById('btnDemo').click(); return 'ok';`);
  await sleepMs(400);
  const pasted = await inTool(`return (doc.getElementById('paperPaste').value || '').length`);
  record("DEMO 文本已载入粘贴框", Number(pasted) > 200, `${pasted} 字`);

  await inTool(`doc.getElementById('btnParse').click(); return 'ok';`);
  // 等解析完成：分值表出现主行
  let rows = [];
  for (let i = 0; i < 30; i++) {
    await sleepMs(500);
    const r = await inTool(ROW_INFO);
    if (Array.isArray(r) && r.length) { rows = r; break; }
  }
  record("分值分配表已渲染主行", rows.length > 0, `${rows.length} 个题型`);
  if (!rows.length) throw new Error("分值表未渲染，后续断言无意义");

  // ---------- 先确保停在「① 导入试卷」这一页（2026-10 起解析后不再自动跳走）----------
  // ⚠️ 这一段**必须有**：分值分配表（#scoreTable）在 #cPaper 里，而 #cPaper 是
  //    `.col{display:none}`；如果面板是隐藏的，`getBoundingClientRect()` 一律返回 0，
  //    下面「收起后不占高度」「收起后没有输入框可见」这些断言就会**必然通过、什么都没验证**。
  //    （本套件以前就是这样空过的：解析后会自动跳到 cScore，而 cScore 里没有这张表。）
  await inTool(`
    const btn = doc.querySelector('.steps button[data-col="cPaper"]');
    if (btn) btn.click();
    return 'ok';
  `);
  await sleepMs(500);
  const visible = await inTool(`
    const col = doc.getElementById('cPaper');
    const tbl = doc.getElementById('scoreTable');
    const r = tbl ? tbl.getBoundingClientRect() : null;
    return {
      activeStep: (doc.querySelector('.steps button.on')||{}).dataset?.col ?? '(none)',
      colDisplay: col ? getComputedStyle(col).display : null,
      tableW: r ? Math.round(r.width) : 0,
      tableH: r ? Math.round(r.height) : 0,
    };
  `);
  record("★分值分配表所在的试卷页是**可见**的（否则下面的尺寸断言全是空过）",
    visible.colDisplay !== "none" && visible.tableW > 0 && visible.tableH > 0,
    `步骤=${visible.activeStep} display=${visible.colDisplay} 表尺寸=${visible.tableW}×${visible.tableH}`);

  console.log("      " + rows.map((r) => `${r.type} ${r.count}题 ${r.per} ${r.total}分`).join(" | "));

  const jdRow = rows.find((r) => r.type.includes("解答题"));
  record("解答题主行存在", !!jdRow, jdRow ? `${jdRow.count}题 / ${jdRow.total}分` : "");
  record("「每题分值」列显示「平均 X」（收起态不写单题分值）", /^平均\s/.test(jdRow.per), jdRow.per);

  // ---------- 默认全部收起 ----------
  // 注意：收起只是给 tr.sub 加 hidden，子行内容仍在 DOM 里（重建时要用），
  // 所以「不占用界面」要靠实际渲染高度判断，不能数 .qcell 的个数。
  const collapsed = await inTool(`
    const subs = Array.from(doc.querySelectorAll('#scoreTable tr.sub'));
    const boxes = subs.map(s => { const r = s.getBoundingClientRect(); return { h: r.height, w: r.width }; });
    const cells = Array.from(doc.querySelectorAll('#scoreTable .qcell'));
    const visibleCells = cells.filter(c => c.getBoundingClientRect().height > 0);
    return {
      n: subs.length,
      hidden: subs.filter(s => s.hidden).length,
      cells: cells.length,
      visibleCells: visibleCells.length,
      maxH: Math.max(0, ...boxes.map(b => b.h)),
    };
  `);
  record("子行数量 = 题型数量", collapsed.n === rows.length, `${collapsed.n} vs ${rows.length}`);
  record("默认全部收起", collapsed.hidden === collapsed.n, `hidden=${collapsed.hidden}/${collapsed.n}`);
  record("收起后子行不占渲染高度", collapsed.maxH === 0, `子行最高 ${collapsed.maxH}px`);
  record("收起后没有一个逐题输入框可见",
    collapsed.visibleCells === 0, `可见 ${collapsed.visibleCells} / DOM 内 ${collapsed.cells} 个`);

  // ---------- 展开解答题 ----------
  await inTool(`
    const b = Array.from(doc.querySelectorAll('#scoreTable button.tgl')).find(x => x.dataset.tgl.includes('解答题'));
    b.click(); return 'ok';
  `);
  await sleepMs(600);

  const opened = await inTool(`
    const b = Array.from(doc.querySelectorAll('#scoreTable button.tgl')).find(x => x.dataset.tgl.includes('解答题'));
    const sub = b.closest('tr').nextElementSibling;
    const cells = Array.from(sub.querySelectorAll('.qcell'));
    return {
      open: b.dataset.open,
      arrow: b.textContent.trim(),
      hidden: sub.hidden,
      n: cells.length,
      labels: cells.map(c => c.querySelector('.qno').textContent.trim()),
      values: cells.map(c => c.querySelector('input').value),
      batchFrom: sub.querySelector('input[data-bfrom]')?.value,
      batchTo: sub.querySelector('input[data-bto]')?.value,
      hasApply: !!sub.querySelector('button[data-bapply]'),
      colspan: sub.querySelector('td')?.getAttribute('colspan'),
      subShown: !sub.hidden && sub.querySelector('.qcell') !== null,
    };
  `);
  record("展开后 data-open = 1", opened.open === "1", String(opened.open));
  record("展开后箭头变 ▼", opened.arrow === "▼", opened.arrow);
  record("展开后子行可见", opened.subShown === true && opened.hidden === false);
  record("逐题输入框数量 = 解答题题量", opened.n === Number(jdRow.count), `${opened.n} vs ${jdRow.count}`);
  record("每个输入框带「第N题」标签", opened.labels.every((l) => /^第\d+题$/.test(l)), opened.labels.join(","));
  record("逐题分值都填了初值", opened.values.every((v) => Number(v) > 0), opened.values.join(","));
  record("批量栏题号区间 = 该题型首末题号",
    Number(opened.batchFrom) > 0 && Number(opened.batchTo) >= Number(opened.batchFrom),
    `${opened.batchFrom}–${opened.batchTo}`);
  record("批量栏有「应用」按钮", opened.hasApply === true);
  record("子行 colspan = 4", opened.colspan === "4", String(opened.colspan));

  // ---------- 改一道题的分值 ----------
  const beforeSum = await inTool(`return doc.getElementById('sumCell').textContent.trim()`);
  const beforeTotal = jdRow.total;

  // 把解答题第 3 道改成 25（原值 +25-原值 的差额会体现在合计上）
  const editOne = await inTool(`
    const sub = doc.querySelector('#scoreTable tr.sub:not([hidden])');
    const inputs = Array.from(sub.querySelectorAll('.qcell input'));
    const inp = inputs[2];
    const old = Number(inp.value);
    inp.value = '25';
    inp.dispatchEvent(new Event('change', { bubbles: true }));
    return { old, n: inputs.length };
  `);
  await sleepMs(800);

  const afterEdit = await inTool(`
    const b = Array.from(doc.querySelectorAll('#scoreTable button.tgl')).find(x => x.dataset.tgl.includes('解答题'));
    const tr = b.closest('tr');
    const tds = tr.querySelectorAll('td');
    const sub = tr.nextElementSibling;
    const inputs = Array.from(sub.querySelectorAll('.qcell input'));
    return {
      per: tds[2].innerText.trim(),
      total: tds[3].innerText.trim(),
      sum: doc.getElementById('sumCell').textContent.trim(),
      hint: doc.getElementById('scoreSumHint').innerText,
      values: inputs.map(i => Number(i.value)),
      expandStillOpen: b.dataset.open,
    };
  `);
  const expTotal = Number(beforeTotal) - editOne.old + 25;
  record("改一道题后该行总分已重算",
    Math.abs(Number(afterEdit.total) - expTotal) < 0.01, `${afterEdit.total} (期望 ${expTotal})`);
  record("该行「平均」已重算", /^平均\s/.test(afterEdit.per), afterEdit.per);
  record("整卷合计已重算",
    Math.abs(Number(afterEdit.sum) - (Number(beforeSum) + 25 - editOne.old)) < 0.01,
    `${afterEdit.sum} (原 ${beforeSum}, 改动 +${25 - editOne.old})`);
  record("其他题的分值没被改动",
    afterEdit.values.filter((v, i) => i !== 2).length === afterEdit.values.length - 1,
    afterEdit.values.join(","));
  record("改一道题后展开态保持", afterEdit.expandStillOpen === "1", String(afterEdit.expandStillOpen));
  record("提示行给出「与卷面预设不一致」的温和提示",
    /不一致/.test(afterEdit.hint) && /解答题/.test(afterEdit.hint),
    afterEdit.hint.replace(/\s+/g, " ").slice(0, 90));

  // ---------- 批量设置区间 ----------
  const jdNos = opened.labels.map((l) => Number(l.replace(/[^\d]/g, "")));
  const from = jdNos[0], to = jdNos[1];
  const batch = await inTool(`
    const sub = doc.querySelector('#scoreTable tr.sub:not([hidden])');
    sub.querySelector('input[data-bfrom]').value = '${from}';
    sub.querySelector('input[data-bto]').value = '${to}';
    sub.querySelector('input[data-bval]').value = '11';
    sub.querySelector('button[data-bapply]').click();
    return 'ok';
  `);
  await sleepMs(800);

  const afterBatch = await inTool(`
    const sub = doc.querySelector('#scoreTable tr.sub:not([hidden])');
    const inputs = Array.from(sub.querySelectorAll('.qcell input'));
    const b = Array.from(doc.querySelectorAll('#scoreTable button.tgl')).find(x => x.dataset.tgl.includes('解答题'));
    const tds = b.closest('tr').querySelectorAll('td');
    return { values: inputs.map(i => Number(i.value)), total: tds[3].innerText.trim(),
             sum: doc.getElementById('sumCell').textContent.trim() };
  `);
  record("批量设置只改了区间内的两道题",
    afterBatch.values[0] === 11 && afterBatch.values[1] === 11, afterBatch.values.join(","));
  record("批量设置没动区间外的题", afterBatch.values[2] === 25, afterBatch.values.join(","));
  record("批量后题型总分 = 逐题之和",
    Math.abs(Number(afterBatch.total) - afterBatch.values.reduce((a, x) => a + x, 0)) < 0.01,
    `${afterBatch.total} vs ${afterBatch.values.reduce((a, x) => a + x, 0)}`);

  // ---------- 让解答题总分回到预设值 → 提示应消失 ----------
  // 必须逐题走「真实交互路径」（改输入框 + change）。原因：spread 才是权威数据源，
  // 只改 DOM 的 value 不会被读取；而且每次 change 都会重建该题型子行、换掉输入框节点，
  // 所以每改一道题都要重新查询一次输入框。
  const initVals = opened.values.map(Number);
  for (let i = 0; i < initVals.length; i++) {
    const r = await inTool(`
      const sub = doc.querySelector('#scoreTable tr.sub:not([hidden])');
      const inp = sub.querySelector('.qcell input[data-i="${i}"]');
      if(!inp) return { __err: '找不到第 ${i} 个输入框' };
      inp.value = String(${initVals[i]});
      inp.dispatchEvent(new Event('change', { bubbles: true }));
      return inp.dataset.i;
    `);
    if (r && r.__err) record(`逐题恢复第 ${i + 1} 个输入框`, false, r.__err);
    await sleepMs(220);
  }
  await sleepMs(600);
  const restored = await inTool(`
    return { hint: doc.getElementById('scoreSumHint').innerText,
             sum: doc.getElementById('sumCell').textContent.trim(),
             total: (() => { const b = Array.from(doc.querySelectorAll('#scoreTable button.tgl')).find(x => x.dataset.tgl.includes('解答题'));
                             return b.closest('tr').querySelectorAll('td')[3].innerText.trim(); })() };
  `);
  record("逐题改回初值后题型总分回到预设值",
    Math.abs(Number(restored.total) - Number(beforeTotal)) < 0.01, `${restored.total} vs ${beforeTotal}`);
  record("整卷合计回到改动前", Math.abs(Number(restored.sum) - Number(beforeSum)) < 0.01,
    `${restored.sum} vs ${beforeSum}`);
  record("分值恢复一致后「不一致」提示消失", !/不一致/.test(restored.hint),
    restored.hint.replace(/\s+/g, " ").slice(0, 80));

  // ---------- 收起 ----------
  await inTool(`
    const b = Array.from(doc.querySelectorAll('#scoreTable button.tgl')).find(x => x.dataset.tgl.includes('解答题'));
    b.click(); return 'ok';
  `);
  await sleepMs(500);
  const reclosed = await inTool(`
    const b = Array.from(doc.querySelectorAll('#scoreTable button.tgl')).find(x => x.dataset.tgl.includes('解答题'));
    const sub = b.closest('tr').nextElementSibling;
    return { open: b.dataset.open, arrow: b.textContent.trim(), hidden: sub.hidden };
  `);
  record("再次点击可收起", reclosed.open === "0" && reclosed.hidden === true,
    `open=${reclosed.open} hidden=${reclosed.hidden} arrow=${reclosed.arrow}`);
  record("收起后箭头变回 ▶", reclosed.arrow === "▶", reclosed.arrow);

  // ---------- 逐题列表的「满分」标签是否跟着变 ----------
  // 最终解答题总分应等于初始预设值（上面已改回），逐题满分标签应与 spread 一致
  const listFull = await inTool(`
    const items = Array.from(doc.querySelectorAll('#scoreList .qitem'));
    const jd = items.filter(it => {
      const tags = Array.from(it.querySelectorAll('.tag')).map(t => t.textContent.trim());
      return tags.includes('解答题');
    });
    return { n: items.length, jdN: jd.length, sample: jd.slice(0, 3).map(it => {
      const tags = Array.from(it.querySelectorAll('.tag')).map(t => t.textContent.trim());
      return tags.find(t => t.startsWith('满分')) || '';
    }) };
  `);
  record("逐题得分列表已渲染", listFull.n > 0, `${listFull.n} 题`);
  record("解答题在逐题列表里带「满分」标签",
    listFull.jdN > 0 && listFull.sample.every((s) => /满分/.test(s)),
    `${listFull.jdN} 道解答题, ${listFull.sample.join(",")}`);

  if (pageErrors.length) {
    console.log("     页面错误详情:");
    for (const pe of pageErrors.slice(0, 6)) console.log("       " + pe);
  }
  record("页面无真实 JS 异常", pageErrors.length === 0, `${pageErrors.length} 条`);

  try { await cdp.send("Browser.close"); } catch { /* ignore */ }
} catch (e) {
  record("测试执行未异常中断", false, e.message);
  console.error("测试异常:", e.message);
} finally {
  if (edge) { try { edge.kill(); } catch { /* ignore */ } }
  if (srv) { try { srv.kill(); } catch { /* ignore */ } }
}

const ok = summary();
process.exit(ok ? 0 : 1);
