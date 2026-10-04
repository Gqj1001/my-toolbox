// 问题2 修复验证：学段 × 科目的内容词来源
import { createClient } from "@supabase/supabase-js";
import {
  startServer, startBrowser, makePageApi, makeRecorder, readEnv, readUsers, sleepMs,
} from "./_helpers.mjs";

const CDP_PORT = "9401";
const USER_DATA = "D:/my-website/.edge-profile-fix2";
const { SUPABASE_URL, ANON_KEY } = readEnv();
const { adminEmail, password: PASSWORD } = readUsers();

const { record, summary } = makeRecorder();
/** 防御：iframe 读取失败时给出明确信息，而不是抛 undefined */
function checkContent(label, r) {
  if (!r || r.__err || !r.content) {
    record(label, false, `读取失败: ${JSON.stringify(r)}`);
    return null;
  }
  return r;
}

const srv = await startServer();
const { cdp, sessionId, edge } = await startBrowser(CDP_PORT, USER_DATA);
const { ev, goto, inTool, login } = makePageApi(cdp, sessionId);

/** 切学段/科目并等待载入 */
async function pick(stage, subject, waitMs = 4200) {
  await inTool(`
    const ss=doc.getElementById('stageSelect');
    const d=Object.getOwnPropertyDescriptor(w.HTMLSelectElement.prototype,'value');
    if(ss.value!==${JSON.stringify(stage)}){ d.set.call(ss,${JSON.stringify(stage)}); ss.dispatchEvent(new w.Event('change',{bubbles:true})); }
    return 'ok';
  `);
  await sleepMs(3000);
  await inTool(`
    const sel=doc.getElementById('subjectSelect');
    const d=Object.getOwnPropertyDescriptor(w.HTMLSelectElement.prototype,'value');
    if(sel.value!==${JSON.stringify(subject)}){ d.set.call(sel,${JSON.stringify(subject)}); sel.dispatchEvent(new w.Event('change',{bubbles:true})); }
    return 'ok';
  `);
  await sleepMs(waitMs);
}
/** 读取两个内容分类的构成 */
const readContent = () => inTool(`
  const out={};
  doc.querySelectorAll('#generateCategories details.cat').forEach(det=>{
    const name=det.querySelector('summary').textContent.replace(/[▼▶0-9]/g,'').trim();
    if(name!=='课堂内容' && name!=='下节课内容') return;
    const grid=det.querySelector('.grid[id^="bookGrid_"]');
    const normal=[...det.querySelectorAll('.grid')].filter(g=>!/^bookGrid_/.test(g.id||''));
    out[name]={
      hasBookPanel: !!grid,
      bookCount: grid ? grid.querySelectorAll('input[type=checkbox]').length : 0,
      normalCount: normal.reduce((n,g)=>n+g.querySelectorAll('input[type=checkbox]').length,0),
      sample: [...det.querySelectorAll('input[type=checkbox]')].map(b=>b.dataset.keyword).filter(Boolean).slice(0,3),
    };
  });
  return { content: out, total: doc.querySelectorAll('#generateCategories input[type=checkbox]').length,
    syncHint: doc.getElementById('syncHint')?.textContent ?? '' };
`);

// 登录（带会话确认）+ 清掉工具页记忆的学段/科目，保证起始状态一致
if (!(await login(adminEmail, PASSWORD))) {
  console.log("❌ 登录失败，测试无法继续");
  try { await cdp.send("Browser.close"); } catch { edge.kill(); }
  srv.kill();
  process.exit(3);
}
await goto("/tools/feedback", 1500);
await ev(`localStorage.removeItem('fb_stage_v1'); localStorage.removeItem('fb_subject_v1'); localStorage.removeItem('fb_textbook_v1'); localStorage.removeItem('fb_chapter_v1'); true`);
await goto("/tools/feedback", 7000);

console.log("=== 1. 初中 + 数学（修复重点：应为空）===");
await pick("junior", "math");
{
  const r = checkContent("初中数学 读取页面", await readContent());
  if (r) {
    record("初中数学 课堂内容 无课本面板", r.content["课堂内容"]?.hasBookPanel === false, JSON.stringify(r.content["课堂内容"]));
    record("初中数学 课堂内容 为 0 条", r.content["课堂内容"]?.normalCount === 0 && r.content["课堂内容"]?.bookCount === 0, JSON.stringify(r.content["课堂内容"]));
    record("初中数学 下节课内容 为 0 条", (r.content["下节课内容"]?.normalCount ?? 0) === 0 && (r.content["下节课内容"]?.bookCount ?? 0) === 0, JSON.stringify(r.content["下节课内容"]));
    record("初中数学 总计 0 个复选框", r.total === 0, `${r.total}`);
  }
}

console.log("\n=== 2. 初中 + 语文 / 英语 / 生物（其他科目也不串味）===");
for (const s of ["chinese", "english", "biology"]) {
  await pick("junior", s);
  const r = await readContent();
  record(`初中·${s} 无课本面板且为 0 条`, r.total === 0, `total=${r.total} hint=${r.syncHint.slice(0, 40)}`);
}

console.log("\n=== 3. 高中 + 数学 + 未选教材（应为通用内容词，无课本网格）===");
await pick("senior", "math");
{
  const r = await readContent();
  const c = r.content["课堂内容"];
  record("高中数学未选教材：无课本面板", c?.hasBookPanel === false, JSON.stringify(c));
  record("高中数学未选教材：课堂内容 = 通用内容词 31 条", c?.normalCount === 31, `${c?.normalCount} 条`);
  record("高中数学未选教材：下节课内容 = 14 条", r.content["下节课内容"]?.normalCount === 14, `${r.content["下节课内容"]?.normalCount} 条`);
  record("样例是通用词（平面向量/解三角形…）", (c?.sample ?? []).some((k) => /向量|解三角形|复数|集合|函数/.test(k)), JSON.stringify(c?.sample));
}

console.log("\n=== 4. 高中 + 数学 + 选教材「人教A版 · 必修第一册」（应为课本网格 21 条）===");
{
  // 两级下拉：先选版本，再选册次
  const r = await inTool(`
    const ver=doc.getElementById('textbookVersionSelect');
    if(!ver) return {err:'未找到版本下拉'};
    const d=Object.getOwnPropertyDescriptor(w.HTMLSelectElement.prototype,'value');
    d.set.call(ver,'人教A版'); ver.dispatchEvent(new w.Event('change',{bubbles:true}));
    return {ok:true, version:'人教A版'};
  `);
  await sleepMs(4500);
  const r2 = await inTool(`
    const ts=doc.getElementById('textbookSelect');
    if((ts?.style.display ?? 'none') === 'none') return {err:'册次下拉未出现'};
    const opt=[...ts.options].find(o=>o.text==='必修第一册');
    if(!opt) return {err:'未找到必修第一册', options:[...ts.options].map(o=>o.text)};
    const d=Object.getOwnPropertyDescriptor(w.HTMLSelectElement.prototype,'value');
    d.set.call(ts, opt.value); ts.dispatchEvent(new w.Event('change',{bubbles:true}));
    return {ok:true, picked: opt.text};
  `);
  await sleepMs(4500);
  const c = await readContent();
  console.log("   选中:", JSON.stringify(r), JSON.stringify(r2));
  record("选教材后出现课本面板", c.content["课堂内容"]?.hasBookPanel === true, JSON.stringify(c.content["课堂内容"]));
  record("课本网格 = 21 条", c.content["课堂内容"]?.bookCount === 21, `${c.content["课堂内容"]?.bookCount}`);
  record("课本网格内容为该册章节（含集合的概念与关系）", (c.content["课堂内容"]?.sample ?? []).some((k) => /集合/.test(k)), JSON.stringify(c.content["课堂内容"]?.sample));
  record("状态行显示已限定教材", /已限定教材/.test(c.syncHint), c.syncHint.slice(0, 60));
}

console.log("\n=== 5. 高中 + 语文（有教材，但语文不是数学 → 无课本网格）===");
await pick("senior", "chinese");
{
  const r = await readContent();
  record("高中语文 无课本面板", r.content["课堂内容"]?.hasBookPanel === false, JSON.stringify(r.content["课堂内容"]));
  record("高中语文 课堂内容 10 条（云端词）", r.content["课堂内容"]?.normalCount === 10, `${r.content["课堂内容"]?.normalCount}`);
}

console.log("\n=== 6. API 缺少 stage 时应默认高中，不再跨学段 ===");
{
  const r = await ev(`
    fetch('/api/feedback/data?subject=math',{credentials:'same-origin',cache:'no-store'})
      .then(r=>r.json()).then(j=>({stage:j.stage, content:(j.categoryKeywords?.['课堂内容']||[]).length}))
  `);
  record("?subject=math 的 stage 默认为 senior", r.stage === "senior", `stage=${r.stage} 课堂内容=${r.content}`);
}

console.log("\n=== 7. 离线模式仍保留课本下拉（回归）===");
{
  const r = await ev(`
    fetch('/tools/feedback.html').then(r=>r.text()).then(t=>({
      hasBookSelect: t.indexOf('bookSelect_') >= 0 && t.indexOf('data-cat-index') >= 0,
      hasGradeMark: (t.match(/grade:'senior', topics:/g)||[]).length,
      hasNewHelpers: t.includes('function selectedBookTopics()') && t.includes('function bookTopicsBlock('),
      bookSelectCount: (t.match(/bookSelect_/g)||[]).length,
    }))
  `);
  record("源码保留离线课本下拉", r.hasBookSelect === true, "");
  record("6 册均标注 grade:'senior'", r.hasGradeMark === 6, `${r.hasGradeMark} 处`);
  record("新增的辅助函数在位", r.hasNewHelpers === true, "");
}

try { await cdp.send("Browser.close"); } catch { edge.kill(); }
srv.kill();
process.exit(summary() ? 0 : 1);
