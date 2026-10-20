/**
 * 全学科试卷分析 · 公用科目引擎（core）
 * ==========================================================================
 * 给「全学科试卷分析工具（paper-analysis-v2）」用；**老数学工具不依赖它**，
 * 所以这里的任何改动都不会影响 `/tools/paper-analysis`。
 *
 * 为什么单独一个文件：
 *   · 学科差异全部收敛到 `subjects/*.js` 的配置里；
 *   · 解析、算分、归类、组装数据这些"逻辑"只写一份，四学科共用；
 *   · 以后加化学/生物，只加一个科目包，不改这里。
 *
 * 纯函数、无网络、无 DOM，Node 可直接 require（测试用）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PaperSubjectEngine = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

  /** 去掉「一、」「二.」这类前缀，并归一化空白 */
  function cleanLabel(s) {
    return String(s == null ? '' : s)
      .replace(/^[一二三四五六七八九十]+\s*[、.．,，:：]\s*/, '')
      .replace(/\s+/g, '')
      .trim();
  }

  /** 科目包里的题型词表 → 查表；认不出就原样保留（不丢题） */
  function normalizeType(pack, label) {
    const raw = String(label == null ? '' : label).trim();
    const key = cleanLabel(raw);
    const types = (pack && pack.types) || [];
    for (const t of types) {
      if (cleanLabel(t.label) === key || cleanLabel(t.id) === key) return t.label;
      if (Array.isArray(t.aliases) && t.aliases.some((a) => cleanLabel(a) === key)) return t.label;
    }
    return raw || '未分类';
  }

  function typeSpec(pack, label) {
    return ((pack && pack.types) || []).find((t) => t.label === label) || null;
  }

  /** 把一行拆成单元格（兼容 | ｜ 制表符；连续重复单元格折叠） */
  function splitRow(line) {
    let cells = String(line || '').split(/[|｜\t]/).map((s) => s.trim());
    cells = cells.filter((s) => s !== '');
    const out = [];
    for (const c of cells) if (out[out.length - 1] !== c) out.push(c);
    return out;
  }

  /** 题号：数字 / 14(3) / 14（3）/ 1. 都认；返回字符串或 null */
  function parseQuestionNo(cell) {
    const s = String(cell == null ? '' : cell).trim().replace(/[.．]$/, '');
    if (!s) return null;
    if (/^\d+$/.test(s)) return s;
    if (/^\d+\s*[（(]\s*\d+\s*[)）]$/.test(s)) return s.replace(/\s+/g, '');
    return null;
  }

  /** 难度系数 → 标签/档位（沿用 core/paper-parser 的口径；拿不到就留空） */
  function coeffMeta(coeff) {
    if (coeff == null || isNaN(coeff)) return { label: '', grade: '' };
    let label = '';
    if (coeff >= 0.8) label = '较易';
    else if (coeff >= 0.6) label = '中等';
    else if (coeff >= 0.4) label = '较难';
    else label = '难';
    let grade = '';
    if (coeff >= 0.85) grade = 'easy';
    else if (coeff >= 0.7) grade = 'mid';
    else if (coeff >= 0.4) grade = 'hard';
    else grade = 'vhard';
    return { label, grade };
  }

  /**
   * 解析「学科网试卷分析报告」。
   * 与老数学版的区别：题号是**字符串**（14(3) 也认）；题型走科目包词表；
   * 认不出的题型原样保留，不丢题。
   */
  function parseReport(text, pack) {
    const lines = String(text || '').split(/\r?\n/).map((l) => l.trim());
    const warnings = [];
    const res = {
      title: '',
      overallDifficulty: '',
      scope: [],
      typeDist: [],
      diffDist: [],
      questions: [],
      knowledgeGroups: [],
      warnings,
    };

    let i = 0;
    for (; i < lines.length; i++) {
      const l = lines[i];
      if (!l) continue;
      if (/^={3,}\s*FILE/.test(l)) continue;
      if (/^<\/?TABLE>$/i.test(l)) continue;
      res.title = l;
      i++;
      break;
    }
    for (let guard = 0; i < lines.length && guard < 200; i++, guard++) {
      const l = lines[i];
      if (!l) continue;
      if (/^<\/?TABLE>$/i.test(l)) continue;
      let m = l.match(/^整体难度\s*[:：]\s*(.*)$/);
      if (m) { res.overallDifficulty = (m[1] || '').trim(); continue; }
      m = l.match(/^考试范围\s*[:：]\s*(.*)$/);
      if (m) { res.scope = m[1].split(/[,，、]/).map((s) => s.trim()).filter(Boolean); continue; }
      if (/^试卷题型$/.test(l.replace(/\s/g, ''))) break;
      if (/^试卷难度$/.test(l.replace(/\s/g, ''))) break;
      if (res.title === l) continue;
      break;
    }

    const idxOf = (kw) => lines.findIndex((l, k) => k >= i && l.replace(/\s/g, '') === kw);
    const iType = idxOf('试卷题型');
    const iDiff = idxOf('试卷难度');
    const iDetail = idxOf('细目表分析');
    const iKnow = idxOf('知识点分析');

    if (iType >= 0) {
      const end = [iDiff, iDetail, iKnow].filter((x) => x > iType).sort((a, b) => a - b)[0] || lines.length;
      for (let k = iType + 1; k < end; k++) {
        const c = splitRow(lines[k]);
        if (!c || c.length < 2) continue;
        if (/^(题型|试卷题型)$/.test(c[0])) continue;
        const n = parseInt(c[c.length - 1], 10);
        if (!isNaN(n)) res.typeDist.push({ type: normalizeType(pack, c[0]), count: n });
      }
    }

    if (iDiff >= 0) {
      const end = [iDetail, iKnow].filter((x) => x > iDiff).sort((a, b) => a - b)[0] || lines.length;
      for (let k = iDiff + 1; k < end; k++) {
        const c = splitRow(lines[k]);
        if (!c || c.length < 2) continue;
        if (/^难度$/.test(c[0])) continue;
        const n = parseInt(c[c.length - 1], 10);
        if (!isNaN(n)) res.diffDist.push({ level: c[0], count: n });
      }
    }

    if (iDetail >= 0) {
      const end = iKnow > iDetail ? iKnow : lines.length;
      let section = '';
      for (let k = iDetail + 1; k < end; k++) {
        const raw = lines[k];
        if (!raw || /^<\/?TABLE>$/i.test(raw)) continue;
        const rawCells = raw.split(/[|｜\t]/).map((s) => s.trim()).filter((s) => s !== '');
        const allSame = rawCells.length > 1 && rawCells.every((x) => x === rawCells[0]);
        if ((allSame && /^[一二三四五六七八九十]+\s*[、.．]/.test(rawCells[0])) ||
            (rawCells.length === 1 && /^[一二三四五六七八九十]+\s*[、.．]/.test(rawCells[0]))) {
          section = normalizeType(pack, rawCells[0]);
          continue;
        }
        const c = splitRow(raw);
        if (c && /^题号$/.test(c[0])) continue;
        if (!c || !c.length) continue;
        let no = parseQuestionNo(c[0]);
        if (!no) {
          // 语文/英语的写作常常没有题号（就写“作文/写作”）；允许用标签代替题号，不丢题。
          const label = String(c[0] || '').trim();
          if (!section || !/作文|写作|书面表达|大作文/.test(label + section)) continue;
          no = label || section;
        }
        let coeff = null;
        let kpStr = '';
        if (c.length >= 2 && /^[0-9.]+%?$/.test(String(c[1]))) {
          coeff = parseFloat(String(c[1]).replace('%', ''));
          if (/%$/.test(String(c[1]))) coeff = coeff / 100;
          kpStr = c.slice(2).join('；');
        } else {
          kpStr = c.slice(1).join('；');
        }
        const names = String(kpStr).split(/[;；]/).map((s) => s.trim()).filter(Boolean);
        const meta = coeffMeta(coeff);
        res.questions.push({
          no,
          section,
          coeff: coeff == null || isNaN(coeff) ? null : coeff,
          difficulty: meta.label,
          grade: meta.grade,
          knowledge: names.map((name) => ({ name, source: 'imported', confidence: 'high' })),
        });
      }

      if (res.questions.length && !res.questions.some((q) => q.section)) {
        let cursor = 0;
        const ranges = [];
        res.typeDist.forEach((t) => {
          ranges.push({ type: t.type, from: cursor + 1, to: cursor + t.count });
          cursor += t.count;
        });
        res.questions.forEach((q, idx) => {
          const n = parseInt(q.no, 10);
          const r = ranges.find((x) => n >= x.from && n <= x.to);
          q.section = r ? r.type : (res.typeDist[idx] ? res.typeDist[idx].type : '');
        });
      }
    }

    if (iKnow >= 0) {
      for (let k = iKnow + 1; k < lines.length; k++) {
        const c = splitRow(lines[k]);
        if (!c || c.length < 3) continue;
        if (/^序号$/.test(c[0])) continue;
        const nos = (c[2] || '').split(/[,，、]/).map((s) => s.trim()).filter(Boolean);
        if (nos.length) res.knowledgeGroups.push({ name: c[1], questions: nos });
      }
    }

    const typeSum = res.typeDist.reduce((a, x) => a + x.count, 0);
    if (typeSum && res.questions.length && typeSum !== res.questions.length) {
      warnings.push(`试卷题型表的题数合计 ${typeSum} 与细目表的题目数 ${res.questions.length} 不一致`);
    }
    if (!res.questions.length) warnings.push('没有解析到细目表，请确认粘贴的是学科网「试卷分析报告」的完整内容');
    if (!res.title) warnings.push('没有解析到试卷标题');
    return res;
  }

  /** 把「某题型的预设」展开成逐题分值（保留一位小数、合计精确） */
  function spreadBlock(count, per, blockTotal) {
    const n = Math.max(0, Math.round(Number(count) || 0));
    if (!n) return { spread: [], total: 0 };
    const total = blockTotal != null ? round2(blockTotal) : round2((Number(per) || 0) * n);
    const base = Math.floor((total / n) * 10) / 10;
    const arr = Array.from({ length: n }, () => base);
    let left = round2(total - base * n);
    for (let i = 0; i < n && left > 0.0001; i++) {
      const add = Math.min(0.1, left);
      arr[i] = round2(arr[i] + add);
      left = round2(left - add);
    }
    return { spread: arr, total };
  }

  /**
   * 按科目包算分：
   *   · 预设优先（题量能对上就用预设的逐题/块总分）；
   *   · 否则用科目包的每题默认分；
   *   · 最后把差额并进 absorb 题型（作文/计算题），保证合计 = 老师填的总分。
   */
  function scorePaper(pack, typeDist, totalScore, presetName) {
    const warnings = [];
    const total = Number(totalScore) || (pack && pack.fullScore) || 150;
    const list = (typeDist || []).map((t) => ({ type: normalizeType(pack, t.type), count: Number(t.count) || 0 }))
      .filter((t) => t.count > 0);
    if (!list.length) return { perType: {}, fullScore: total, preset: '无题型', warnings: ['没有识别到题型'] };

    let preset = null;
    if (presetName) preset = (pack.presets || []).find((p) => p.name === presetName) || null;
    if (!preset) {
      preset = (pack.presets || []).find((p) => {
        const keys = Object.keys(p.dist || {});
        if (keys.length !== list.length) return false;
        return keys.every((k) => list.some((t) => t.type === k));
      }) || null;
    }

    const perType = {};
    let sum = 0;
    for (const t of list) {
      const spec = typeSpec(pack, t.type);
      const d = preset && preset.dist ? preset.dist[t.type] : null;
      let per = spec ? Number(spec.per) || 5 : 5;
      let blockTotal = null;
      if (Array.isArray(d)) {
        if (d[1] != null) per = Number(d[1]) || per;
        if (d[2] != null && Number(d[0]) === t.count) blockTotal = Number(d[2]);
      }
      const block = spreadBlock(t.count, per, blockTotal);
      perType[t.type] = { per, count: t.count, total: block.total, spread: block.spread };
      sum = round2(sum + block.total);
    }

    // 差额并进 absorb 题型（没有就最后一个）
    const diff = round2(total - sum);
    if (Math.abs(diff) > 0.0001) {
      const absorbLabel = (pack.types || []).find((t) => t.absorb && perType[t.label])?.label ||
        Object.keys(perType)[Object.keys(perType).length - 1];
      const target = perType[absorbLabel];
      if (target) {
        target.total = round2(target.total + diff);
        if (target.spread.length) {
          target.spread[target.spread.length - 1] = round2(target.spread[target.spread.length - 1] + diff);
          if (target.spread[target.spread.length - 1] <= 0) {
            target.spread = target.spread.map((x) => Math.max(0.1, x));
            const s = round2(target.spread.reduce((a, x) => a + x, 0));
            const fix = round2(target.total - s);
            target.spread[target.spread.length - 1] = round2(target.spread[target.spread.length - 1] + fix);
          }
        }
        warnings.push(`题型总分之和与总分的差额 ${diff} 已并入「${absorbLabel}」`);
      }
    }

    return { perType, fullScore: total, preset: preset ? preset.name : '按科目包默认分值', warnings };
  }

  /** 组装成「三层模型」的 Paper（题号字符串 / 共享材料 / 考点带来源） */
  function buildPaper(pack, parsed, scored) {
    const blocks = [];
    const seen = new Set();
    const counters = {};
    const questions = (parsed.questions || []).map((q, idx) => {
      const type = q.section || (parsed.typeDist[0] && parsed.typeDist[0].type) || '未分类';
      const block = scored.perType[type];
      let score = null;
      if (block) {
        const n = counters[type] || 0;
        score = block.spread[n] != null ? block.spread[n] : block.per;
        counters[type] = n + 1;
      }
      if (!seen.has(type)) {
        seen.add(type);
        blocks.push({
          id: `b${blocks.length + 1}`,
          type,
          label: type,
          perScore: block ? block.per : null,
          order: blocks.length,
        });
      }
      const spec = typeSpec(pack, type);
      const noDifficulty = !!(spec && spec.noDifficulty);
      return {
        qid: `q-${idx + 1}-${q.no}`,
        no: String(q.no),
        blockId: blocks.find((b) => b.type === type)?.id || null,
        type,
        stemRef: null,
        coeff: noDifficulty ? null : q.coeff,
        difficulty: noDifficulty ? '' : (q.difficulty || ''),
        grade: noDifficulty ? '' : (q.grade || ''),
        knowledge: Array.isArray(q.knowledge) ? q.knowledge : [],
        score,
        got: null,
        scoreParts: spec && Array.isArray(spec.parts) ? {} : null,
        partDefs: spec && Array.isArray(spec.parts) ? spec.parts.slice() : null,
        uncertain: false,
        stemSummary: '',
        reason: '',
      };
    });

    return {
      meta: {
        subject: pack.key,
        stage: pack.stage,
        subjectName: pack.name,
        fullScore: scored.fullScore,
        title: parsed.title || '',
        overallDifficulty: parsed.overallDifficulty || '',
        scope: parsed.scope || [],
        source: 'xkw',
        preset: scored.preset,
      },
      blocks,
      stems: [],
      questions,
      warnings: [...(parsed.warnings || []), ...(scored.warnings || [])],
    };
  }

  /** 科目包知识点 → 模块 id（词典优先，正则兜底，认不出归 other） */
  function classifyWithPack(text, pack) {
    const t = String(text || '');
    if (!t) return 'other';
    const dict = pack && pack.kpDict;
    if (dict) {
      let id = null;
      try {
        if (typeof dict.lookup === 'function') id = dict.lookup(t);
        else if (dict.map && dict.map[t]) id = dict.map[t];
        else if (dict[t]) id = dict[t];
      } catch { /* ignore */ }
      if (id && (!pack.modules || pack.modules.some((m) => m.id === id))) return id;
    }
    for (const m of (pack && pack.modules) || []) {
      if (m.re && m.re.test(t)) return m.id;
    }
    return 'other';
  }

  function moduleNameOf(pack, id) {
    const m = ((pack && pack.modules) || []).find((x) => x.id === id);
    return m ? m.name : '其他';
  }

  function adviceOf(pack, id) {
    const m = ((pack && pack.modules) || []).find((x) => x.id === id);
    return (m && m.advice) || (pack && pack.otherAdvice) || '先定位具体卡点，再做同类题巩固。';
  }

  function buildClassifier(pack) {
    return {
      classify: (text) => classifyWithPack(text, pack),
      classifyName: (text) => moduleNameOf(pack, classifyWithPack(text, pack)),
      moduleName: (id) => moduleNameOf(pack, id),
      adviceOf: (name) => {
        const m = ((pack && pack.modules) || []).find((x) => x.name === name || x.id === name);
        return m ? adviceOf(pack, m.id) : (pack && pack.otherAdvice) || '';
      },
    };
  }

  /** 给 AI 的摘要（不喂整张卷子；只喂算好的统计） */
  function summarizePaper(paper, pack) {
    const qs = (paper && paper.questions) || [];
    const answered = qs.filter((q) => q.got != null);
    const fullSum = round2(qs.reduce((a, q) => a + (Number(q.score) || 0), 0));
    const gotSum = round2(answered.reduce((a, q) => a + (Number(q.got) || 0), 0));
    const byModule = {};
    qs.forEach((q) => {
      const names = (q.knowledge || []).map((k) => k.name).filter(Boolean);
      const id = names.length ? classifyWithPack(names[0], pack) : 'other';
      const m = (byModule[id] = byModule[id] || { id, name: moduleNameOf(pack, id), lost: 0, full: 0, n: 0 });
      m.n++;
      m.full = round2(m.full + (Number(q.score) || 0));
      m.lost = round2(m.lost + Math.max(0, (Number(q.score) || 0) - (Number(q.got) || 0)));
    });
    return {
      title: paper?.meta?.title || '',
      subject: paper?.meta?.subjectName || '',
      fullScore: fullSum,
      gotScore: gotSum,
      scoreRate: fullSum ? round2((gotSum / fullSum) * 100) : null,
      total: qs.length,
      answered: answered.length,
      wrong: answered.filter((q) => Number(q.got) < Number(q.score)).length,
      modules: Object.values(byModule).sort((a, b) => b.lost - a.lost),
    };
  }

  /**
   * 组装公司附件1/2 共用数据。
   * `longTexts` 的键：学生角度 / 教师角度 / 其它原因 / 教师教学 / 学生配合 / 家长配合。
   */
  function buildCompanyData(paper, form, extras) {
    const qs = (paper && paper.questions) || [];
    const wrongRows = qs
      .filter((q) => q.got != null && Number(q.got) < Number(q.score))
      .map((q) => {
        const names = (q.knowledge || []).map((k) => k.name).filter(Boolean);
        const parts = q.scoreParts && Object.keys(q.scoreParts).length
          ? `（${Object.entries(q.scoreParts).map(([k, v]) => `${k}${v}`).join('/')}）`
          : '';
        return {
          no: String(q.no),
          topic: (q.stemSummary || names[0] || q.type || '') + parts,
          point: names.join('；') || q.type || '',
          reason: q.reason || '',
        };
      });
    const gotSum = round2(qs.reduce((a, q) => a + (Number(q.got) || 0), 0));
    const longTexts = {};
    const attr = (extras && extras.attribution) || {};
    const measure = (extras && extras.measures) || {};
    ['学生角度', '教师角度', '其它原因'].forEach((k) => { longTexts[k] = String(attr[k] || '').trim(); });
    ['教师教学', '学生配合', '家长配合'].forEach((k) => { longTexts[k] = String(measure[k] || '').trim(); });

    return {
      student: form.student || '',
      school: form.school || '',
      grade: form.grade || '',
      teacher: form.teacher || '',
      subject: paper?.meta?.subjectName || form.subject || '',
      learnedHours: form.learnedHours || '',
      totalHours: form.totalHours || '',
      examType: form.examType || '',
      entryScore: form.entryScore || '',
      entryRank: form.entryRank || '',
      currentScore: form.currentScore || String(gotSum || ''),
      currentRank: form.currentRank || '',
      wrongRows,
      longTexts,
    };
  }

  return {
    normalizeType,
    cleanLabel,
    parseReport,
    scorePaper,
    buildPaper,
    spreadBlock,
    classifyWithPack,
    moduleNameOf,
    adviceOf,
    buildClassifier,
    summarizePaper,
    buildCompanyData,
    coeffMeta,
    round2,
  };
}));
