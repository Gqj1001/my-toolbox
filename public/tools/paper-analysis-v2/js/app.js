/**
 * 全学科试卷分析工作台（v2）
 * ==========================================================================
 * 设计口径（用户 2026-10 拍板）：
 *   · **绝对不动老数学版** `/tools/paper-analysis`；本工具是新界面壳；
 *   · 解析 / 算分 / 归类 / 导出数据组装全部走 `paper-analysis/js/core/` 公用引擎；
 *   · 学科 = 一份配置（`subjects/*.js`），加学科不改这里；
 *   · 一次录入，三档导出（附件1 / 附件2 / 两份一起）；
 *   · AI 只做「题干摘要」「附件1 三段归因初稿」，必须老师确认后再导出。
 */
(function () {
  'use strict';

  const E = window.PaperSubjectEngine;
  const PACKS = window.PaperV2SubjectPacks || {};
  const MANIFEST = window.PaperV2Manifest || { subjects: [] };
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));

  const state = {
    pack: null,
    parsed: null,
    scored: null,
    paper: null,
    presetName: '',
  };

  const DEMO = `2026年秋季高三第一次月考
整体难度：适中
考试范围：函数与导数,解析几何
试卷题型
题型|数量
单选题|8
多选题|3
填空题|3
解答题|5
细目表分析
题号|难度系数|详细知识点
一、单选题
1|0.85|集合的交集运算
2|0.75|复数的基本概念
3|0.65|函数的单调性
4|0.55|平面向量的数量积
5|0.45|等差数列的前n项和
6|0.65|直线与圆的位置关系
7|0.55|三角函数的图象与性质
8|0.40|导数的几何意义
二、多选题
9|0.65|基本不等式
10|0.55|空间向量的应用
11|0.40|圆锥曲线的性质
三、填空题
12|0.75|二项式定理
13|0.55|排列与组合
14|0.35|函数与导数综合
四、解答题
15|0.70|解三角形
16|0.55|立体几何
17|0.50|概率与统计
18|0.40|平面解析几何
19|0.30|导数与函数单调性`;

  function disabledByFlag() {
    try {
      if (new URLSearchParams(location.search).get('nopaperv2') === '1') return true;
      if (parent && parent !== window) {
        return new URLSearchParams(parent.location.search).get('nopaperv2') === '1';
      }
    } catch { /* 跨域/无父页 */ }
    return false;
  }

  function subjectOf(key) {
    return MANIFEST.subjects.find((s) => s.key === key) || MANIFEST.subjects[0];
  }

  function fillSelect(el, items, valueKey, labelKey, selected) {
    el.innerHTML = items.map((it) => {
      const v = typeof valueKey === 'function' ? valueKey(it) : it[valueKey];
      const label = typeof labelKey === 'function' ? labelKey(it) : it[labelKey];
      return `<option value="${esc(v)}"${String(v) === String(selected) ? ' selected' : ''}>${esc(label)}</option>`;
    }).join('');
  }

  function setPack() {
    const key = $('#v2Subject').value;
    const stage = $('#v2Stage').value;
    state.pack = PACKS[`${key}-${stage}`] || null;
    if (!state.pack) {
      $('#v2Status').textContent = '该学科/学段还没有配置。';
      state.paper = null;
      renderAll();
      return;
    }
    $('#v2FullScore').value = state.pack.fullScore;
    fillSelect($('#v2Grade'), state.pack.grades.map((g) => ({ g })), 'g', 'g', state.pack.defaultGrade);
    const presets = [{ name: '', label: '自动匹配' }].concat((state.pack.presets || []).map((p) => ({
      name: p.name, label: `${p.name}（${p.total}分）`,
    })));
    fillSelect($('#v2Preset'), presets, 'name', 'label', state.presetName);
    state.parsed = null;
    state.scored = null;
    state.paper = null;
    $('#v2Status').textContent = '';
    $('#v2Warnings').innerHTML = '';
    renderAll();
  }

  function currentPreset() {
    return $('#v2Preset') ? $('#v2Preset').value : '';
  }

  function parseCurrent() {
    if (!state.pack) return;
    const text = String($('#v2Text').value || '').trim();
    if (!text) {
      setStatus('请先粘贴或上传学科网试卷分析报告。', true);
      return null;
    }
    try {
      const parsed = E.parseReport(text, state.pack);
      const total = Number($('#v2FullScore').value) || state.pack.fullScore;
      const scored = E.scorePaper(state.pack, parsed.typeDist, total, currentPreset());
      const paper = E.buildPaper(state.pack, parsed, scored);
      state.parsed = parsed;
      state.scored = scored;
      state.paper = paper;
      renderAll();
      const missing = parsed.questions.length;
      setStatus(missing ? `已解析 ${missing} 道题。` : '没有解析到题目，请检查粘贴内容。', !missing);
      return paper;
    } catch (e) {
      console.error(e);
      setStatus('解析失败：' + (e && e.message ? e.message : e), true);
      return null;
    }
  }

  function setStatus(text, bad) {
    const el = $('#v2Status');
    if (!el) return;
    el.textContent = text || '';
    el.style.color = bad ? 'var(--danger)' : 'var(--muted)';
  }

  function setAiStatus(text, bad) {
    const el = $('#v2AiStatus');
    if (!el) return;
    el.textContent = text || '';
    el.style.color = bad ? 'var(--danger)' : 'var(--muted)';
  }

  function renderAll() {
    renderWarnings();
    renderBlocks();
    renderQuestions();
    renderStems();
    renderScoreLine();
  }

  function renderStems() {
    const el = $('#v2StemList');
    if (!el) return;
    const stems = (state.paper && state.paper.stems) || [];
    el.textContent = stems.length ? `共享材料：${stems.map((s) => `${s.name}（${s.questionNos.join('、')}）`).join('；')}` : '';
  }

  function addStem() {
    if (!state.paper) { setAiStatus('请先解析试卷。', true); return; }
    const name = $('#v2StemName').value.trim();
    const nos = String($('#v2StemNos').value || '').split(/[,，、\s]+/).map((s) => s.trim()).filter(Boolean);
    if (!name || !nos.length) { setAiStatus('共享材料要填名称和题号（逗号分隔）。', true); return; }
    const stem = { id: `s${state.paper.stems.length + 1}`, name, questionNos: nos };
    state.paper.stems.push(stem);
    state.paper.questions.forEach((q) => { if (nos.includes(String(q.no))) q.stemRef = stem.id; });
    $('#v2StemName').value = '';
    $('#v2StemNos').value = '';
    renderStems();
    renderQuestions();
    setAiStatus(`已加共享材料「${name}」，关联 ${nos.length} 道题。`);
  }

  function renderWarnings() {
    const box = $('#v2Warnings');
    const warnings = (state.paper && state.paper.warnings) || [];
    box.innerHTML = warnings.map((w) => `<div class="warn">${esc(w)}</div>`).join('');
  }

  function renderBlocks() {
    const tb = $('#v2Blocks tbody');
    if (!tb) return;
    if (!state.paper) { tb.innerHTML = '<tr><td colspan="4" class="hint">解析后显示</td></tr>'; return; }
    const blocks = state.paper.blocks || [];
    tb.innerHTML = blocks.map((b) => {
      const info = state.scored && state.scored.perType ? state.scored.perType[b.type] : null;
      return `<tr><td>${esc(b.type)}</td><td>${info ? info.count : ''}</td><td>${info ? info.per : ''}</td><td>${info ? info.total : ''}</td></tr>`;
    }).join('') || '<tr><td colspan="4" class="hint">没有识别到题型</td></tr>';
  }

  function knowledgeText(q) {
    return (q.knowledge || []).map((k) => k.name).filter(Boolean).join('；');
  }

  function sourceOf(q) {
    const sources = Array.from(new Set((q.knowledge || []).map((k) => k.source || 'imported')));
    if (!sources.length) return '';
    if (sources.length > 1) return '混合';
    return sources[0];
  }

  function badgeOf(q) {
    const s = sourceOf(q);
    if (!s) return '';
    const label = s === 'ai' ? 'AI' : s === 'manual' ? '老师' : '导入';
    const cls = s === 'ai' ? 'ai' : s === 'manual' ? 'manual' : '';
    return `<span class="badge ${cls}">${label}</span>`;
  }

  function renderQuestions() {
    const tb = $('#v2Questions tbody');
    if (!tb) return;
    if (!state.paper) { tb.innerHTML = '<tr><td colspan="7" class="hint">解析后显示</td></tr>'; return; }
    tb.innerHTML = state.paper.questions.map((q, i) => {
      const parts = q.partDefs
        ? `<div class="sub">${q.partDefs.map((p) => `<label>${esc(p)}<input type="number" step="0.5" data-idx="${i}" data-part="${esc(p)}" value="${q.scoreParts && q.scoreParts[p] != null ? q.scoreParts[p] : ''}"></label>`).join('')}</div>`
        : '';
      return `<tr data-idx="${i}">
        <td><b>${esc(q.no)}</b></td>
        <td>${esc(q.type)}${q.stemRef ? '<span class="badge">材料</span>' : ''}</td>
        <td><input type="number" step="0.5" data-idx="${i}" data-field="score" value="${q.score == null ? '' : q.score}"></td>
        <td><input type="number" step="0.5" data-idx="${i}" data-field="got" value="${q.got == null ? '' : q.got}">${parts}</td>
        <td><input class="kp" data-idx="${i}" data-field="knowledge" value="${esc(knowledgeText(q))}">${badgeOf(q)}</td>
        <td><input class="stem" data-idx="${i}" data-field="stemSummary" value="${esc(q.stemSummary || '')}" placeholder="8–15 字"></td>
        <td><input class="reason" data-idx="${i}" data-field="reason" value="${esc(q.reason || '')}"></td>
      </tr>`;
    }).join('') || '<tr><td colspan="7" class="hint">没有题目</td></tr>';
  }

  function renderScoreLine() {
    const el = $('#v2ScoreLine');
    if (!el) return;
    if (!state.paper) { el.textContent = ''; return; }
    const qs = state.paper.questions || [];
    const full = E.round2(qs.reduce((a, q) => a + (Number(q.score) || 0), 0));
    const got = E.round2(qs.reduce((a, q) => a + (Number(q.got) || 0), 0));
    const answered = qs.filter((q) => q.got != null).length;
    const wrong = qs.filter((q) => q.got != null && Number(q.got) < Number(q.score)).length;
    el.textContent = `满分 ${full} ｜ 已录 ${answered}/${qs.length} 题 ｜ 得分 ${got} ｜ 得分率 ${full ? (got / full * 100).toFixed(1) : '—'}% ｜ 错题 ${wrong} 道`;
  }

  function questionAt(target) {
    const idx = Number(target.dataset.idx);
    return state.paper && state.paper.questions ? state.paper.questions[idx] : null;
  }

  function onQuestionInput(e) {
    const q = questionAt(e.target);
    if (!q) return;
    const field = e.target.dataset.field;
    if (field === 'score') q.score = e.target.value === '' ? null : Number(e.target.value);
    else if (field === 'got') q.got = e.target.value === '' ? null : Number(e.target.value);
    else if (field === 'knowledge') {
      const names = String(e.target.value || '').split(/[;；,，、]/).map((s) => s.trim()).filter(Boolean);
      q.knowledge = names.map((name) => ({ name, source: 'manual', confidence: 'high' }));
    } else if (field === 'stemSummary') q.stemSummary = String(e.target.value || '').trim();
    else if (field === 'reason') q.reason = String(e.target.value || '').trim();
    if (e.target.dataset.part) {
      q.scoreParts = q.scoreParts || {};
      q.scoreParts[e.target.dataset.part] = e.target.value === '' ? null : Number(e.target.value);
      const vals = Object.values(q.scoreParts).filter((v) => v != null && !isNaN(v));
      q.got = vals.length ? E.round2(vals.reduce((a, v) => a + Number(v), 0)) : null;
      const gotInput = e.target.closest('tr')?.querySelector('input[data-field="got"]');
      if (gotInput) gotInput.value = q.got == null ? '' : q.got;
    }
    renderScoreLine();
  }

  function collectForm() {
    return {
      student: $('#v2Student').value.trim(),
      school: $('#v2School').value.trim(),
      grade: $('#v2Grade').value,
      teacher: $('#v2Teacher').value.trim(),
      examType: $('#v2ExamType').value,
      entryScore: $('#v2EntryScore').value.trim(),
      entryRank: $('#v2EntryRank').value.trim(),
      currentRank: $('#v2CurrentRank').value.trim(),
      learnedHours: $('#v2LearnedHours').value.trim(),
      totalHours: $('#v2TotalHours').value.trim(),
    };
  }

  function collectAttribution() {
    const attribution = {};
    $$('[data-attr]').forEach((el) => { attribution[el.dataset.attr] = el.value.trim(); });
    const measures = {};
    $$('[data-measure]').forEach((el) => { measures[el.dataset.measure] = el.value.trim(); });
    return { attribution, measures };
  }

  function companyData() {
    return E.buildCompanyData(state.paper, collectForm(), collectAttribution());
  }

  function download(bytes, filename) {
    const blob = new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1200);
  }

  function exportAttachment(att) {
    if (disabledByFlag()) return { ok: false, error: '功能已关闭' };
    if (!state.paper) { $('#v2ExportHint').textContent = '请先解析试卷。'; return { ok: false, error: '请先解析试卷' }; }
    if (!window.CompanyDocx || !window.CompanyTemplateData) {
      $('#v2ExportHint').textContent = '导出模块没加载，请刷新页面。';
      return { ok: false, error: '导出模块没加载' };
    }
    try {
      const data = companyData();
      const bytes = window.CompanyDocx.build(att, data);
      const form = collectForm();
      const name = `${form.student || '学生'}-${state.pack ? state.pack.name : ''}-${att}.docx`;
      download(bytes, name);
      $('#v2ExportHint').textContent = `已导出 ${att}（${bytes.length} 字节）`;
      return { ok: true, bytes: Array.from(bytes), att, data };
    } catch (e) {
      console.error(e);
      $('#v2ExportHint').textContent = '导出失败：' + (e && e.message ? e.message : e);
      return { ok: false, error: String(e && e.message ? e.message : e) };
    }
  }

  async function aiCall(payload) {
    const res = await fetch('/api/paper-analysis-v2/ai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || data.ok === false) {
      throw new Error((data && data.error) || `AI 接口返回 ${res.status}`);
    }
    return data;
  }

  async function aiStems() {
    if (!state.paper) return;
    const wrong = state.paper.questions.filter((q) => q.got != null && Number(q.got) < Number(q.score) && !q.stemSummary);
    if (!wrong.length) { setAiStatus('没有需要补题干摘要的错题。'); return; }
    setAiStatus('生成中…');
    try {
      const data = await aiCall({
        section: 'stem',
        subject: state.pack.name,
        stage: state.pack.stage,
        questions: wrong.map((q) => ({ no: q.no, type: q.type, knowledge: q.knowledge.map((k) => k.name) })),
      });
      const stems = Array.isArray(data.stems) ? data.stems : [];
      let n = 0;
      for (const s of stems) {
        const q = state.paper.questions.find((x) => x.no === s.no);
        if (q && s.text) { q.stemSummary = String(s.text).trim(); n++; }
      }
      renderQuestions();
      setAiStatus(`已补 ${n} 条题干摘要（请核对）。`);
    } catch (e) {
      setAiStatus('AI 暂时不可用：' + (e && e.message ? e.message : e), true);
    }
  }

  async function aiAttribution() {
    if (!state.paper) return;
    setAiStatus('生成归因中…');
    try {
      const summary = E.summarizePaper(state.paper, state.pack);
      let history = [];
      const name = $('#v2Student').value.trim();
      if (name) {
        try {
          const r = await fetch(`/api/students?withHistory=1&name=${encodeURIComponent(name)}`, { credentials: 'same-origin' });
          const j = await r.json();
          const list = j && j.history && j.history[name] ? j.history[name] : [];
          history = list.slice(-5).map((h) => ({
            title: h.title || '', date: h.date || '', tool: h.tool || '',
            text: String(h.text || '').slice(0, 300),
          }));
        } catch { /* 档案读不到就不带历史 */ }
      }
      const data = await aiCall({ section: 'attribution', subject: state.pack.name, stage: state.pack.stage, summary, history });
      const a = data.attribution || {};
      for (const key of ['学生角度', '教师角度', '其它原因']) {
        const el = document.querySelector(`[data-attr="${key}"]`);
        if (el && a[key]) el.value = a[key];
      }
      setAiStatus('归因初稿已填入，请务必逐段核对/修改后再导出。');
    } catch (e) {
      setAiStatus('AI 暂时不可用：' + (e && e.message ? e.message : e), true);
    }
  }

  function reasonForAll() {
    if (!state.paper) return;
    const records = {};
    state.paper.questions.forEach((q) => {
      records[q.no] = { full: q.score == null ? 0 : q.score, got: q.got == null ? 0 : q.got, note: q.reason || '' };
    });
    const normalized = state.paper.questions.map((q) => Object.assign({}, q, {
      section: q.type,
      knowledge: (q.knowledge || []).map((k) => k.name),
    }));
    const diags = window.ErrorEngine.diagnoseAll({ questions: normalized }, records, {});
    let n = 0;
    for (const d of diags) {
      const q = state.paper.questions.find((x) => x.no === d.no);
      if (q && d.text && d.text !== '无') { q.reason = d.text; n++; }
    }
    renderQuestions();
    setAiStatus(`已生成 ${n} 条错因（可手改）。`);
  }

  function bind() {
    $('#v2Subject').addEventListener('change', () => {
      const s = subjectOf($('#v2Subject').value);
      fillSelect($('#v2Stage'), s.stages, 'key', 'name', $('#v2Stage').value);
      setPack();
    });
    $('#v2Stage').addEventListener('change', setPack);
    $('#v2Preset').addEventListener('change', () => { state.presetName = currentPreset(); parseCurrent(); });
    $('#v2Parse').addEventListener('click', parseCurrent);
    $('#v2Demo').addEventListener('click', () => { $('#v2Text').value = DEMO; parseCurrent(); });
    $('#v2Questions').addEventListener('input', onQuestionInput);
    $('#v2ReasonBtn').addEventListener('click', reasonForAll);
    $('#v2StemBtn').addEventListener('click', aiStems);
    $('#v2AttrBtn').addEventListener('click', aiAttribution);
    $('#v2AddStem').addEventListener('click', addStem);
    $('#v2Export1').addEventListener('click', () => exportAttachment('附件1'));
    $('#v2Export2').addEventListener('click', () => exportAttachment('附件2'));
    $('#v2ExportBoth').addEventListener('click', () => {
      exportAttachment('附件1');
      setTimeout(() => exportAttachment('附件2'), 350);
    });
    $('#v2File').addEventListener('change', async (ev) => {
      const files = Array.from(ev.target.files || []);
      if (!files.length) return;
      setStatus('读取文件中…');
      let text = '';
      for (const f of files) {
        if (/\.(txt|md)$/i.test(f.name) || f.type.startsWith('text/')) {
          text += (text ? '\n' : '') + await f.text();
        } else {
          // 图片 → 走老工具同一条视觉识别管线（拍照兜底）；docx/pdf → 走 parse-file。
          const dataUrl = await new Promise((resolve) => {
            const fr = new FileReader();
            fr.onload = () => resolve(String(fr.result || ''));
            fr.readAsDataURL(f);
          });
          const isImage = f.type.startsWith('image/') || /\.(png|jpe?g|webp|gif|bmp)$/i.test(f.name);
          try {
            const res = isImage
              ? await fetch('/api/paper-analysis/vision-paper', {
                method: 'POST', credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ image: dataUrl }),
              })
              : await fetch('/api/paper-analysis/parse-file', {
                method: 'POST', credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: f.name, data: dataUrl }),
              });
            const j = await res.json();
            if (j && j.text) {
              text += (text ? '\n' : '') + j.text;
              if (j.uncertain) setStatus('图片里有看不清的地方（已标 [看不清]），请核对后再解析。', true);
            } else if (j && j.note) setStatus(j.note, true);
            else if (j && j.error) setStatus(j.error, true);
          } catch (e) {
            setStatus('文件解析失败：' + (e && e.message ? e.message : e), true);
          }
        }
      }
      if (text) { $('#v2Text').value = text; parseCurrent(); }
      else setStatus('没有读到文字。扫描版/图片请用老工具的拍照识别，或直接粘贴报告文字。', true);
    });
  }

  function init() {
    if (disabledByFlag()) {
      $('#v2Disabled').classList.remove('hidden');
      document.querySelector('.topbar').classList.add('hidden');
      document.querySelector('.wrap').classList.add('hidden');
      return;
    }
    if (!E) { document.body.innerHTML = '<p style="padding:20px">公用引擎没加载，请刷新页面。</p>'; return; }
    fillSelect($('#v2Subject'), MANIFEST.subjects, 'key', 'name', 'math');
    const s = subjectOf('math');
    fillSelect($('#v2Stage'), s.stages, 'key', 'name', 'senior');
    setPack();
    bind();
    renderAll();
  }

  window.PaperV2 = {
    getState: () => state,
    parse: parseCurrent,
    render: renderAll,
    exportAttachment,
    companyData: () => (state.paper ? companyData() : null),
    summarize: () => (state.paper ? E.summarizePaper(state.paper, state.pack) : null),
    packs: PACKS,
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
}());
