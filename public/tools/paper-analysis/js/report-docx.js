/**
 * 把试卷分析数据渲染成与老师模板一致的《锐满分教育试卷分析表》DOCX
 * ------------------------------------------------------------------
 * 模板结构（来自老师的《-试卷分析 .docx》）：
 *   「锐满分教育试卷分析表」+「学员基本信息」
 *   表1  学员基本信息（3 行，8 列栅格）
 *   表2  试卷分析（考试时间／总分／辅导周期／考试范围／授课内容／学生进步点）
 *   表3  题型分布（题型|题目数量|难度|总分值|得分|得分率）
 *   表4  错题分析（题号|题型|分值|得分|难度|考察知识点|失分情况及原因分析）
 *   表5  教学辅导建议/安排（长文本）
 *   表6  签字栏（分析人|学管师|家长签字）
 *
 * ── 版面约束（踩过的坑，改动前务必先读）──────────────────────────────
 * 页面：A4 纵向 11906×16838 twips，四边页边距 720 → 可用宽度 10466 twips。
 * 实测现象：当某列放不下单元格里的文字时，LibreOffice/Word 会强行把该列撑宽，
 *           连累整张表超出页面，最右列被切掉。因此必须遵守：
 *             ① 每列宽度 ≥ 700 twips（约 4 个 9pt 汉字）；
 *             ② 单元格里不要塞过长的连续内容（不要把两个词挤在一格）；
 *             ③ 表宽合计控制在 9100 以内，给"被撑宽"留余量。
 * test_docx.js 里有对应的自动校验（表宽、列宽、gridSpan 是否对得上）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./docx-builder.js'));
  else root.ReportDocx = factory(root.DocxBuilder);
}(typeof self !== 'undefined' ? self : this, function (D) {
  'use strict';

  const SAFE_W = 9100;

  /* 表1「学员基本信息」与表2「试卷分析」共用同一套 8 列栅格（合计 9100） */
  const W8 = [760, 1000, 740, 740, 740, 740, 740, 3640];
  const W1 = W8;

  /* 表3 题型分布（合计 7200） */
  const W_TYPE = [1450, 1150, 1050, 1150, 1050, 1350];

  /* 表4 错题分析（合计 9100）—— 后两列承载长文本，给足宽度 */
  const W_Q = [520, 820, 500, 500, 620, 2980, 3160];

  /* 表5 教学辅导建议（合计 9100） */
  const W_ADV = [820, 8280];

  /* 表6 签字栏（合计 9100） */
  const W_SIGN = [1510, 1520, 1510, 1520, 1510, 1530];

  const ALL_CAP = ['知识储备', '学习规划', '学习动力', '学习习惯', '学习能力', '应试能力', '自控能力', '成绩趋势', '补习频次'];

  const num = x => { const v = parseFloat(x); return isNaN(v) ? 0 : v; };
  const r2 = x => Math.round(num(x) * 100) / 100;
  const sum = a => a.reduce((x, y) => x + y, 0);

  /**
   * @param {object} ctx
   *   name gender grade subject teacher manager score full
   *   examDate examName duration examScope taughtContent progress
   *   paper records questionRows typeSummary advice
   * @returns {Uint8Array} docx 二进制
   */
  function build(ctx) {
    const C = [];
    const name = ctx.name || '';
    const subject = ctx.subject || '数学';
    const teacher = ctx.teacher || '郭庆杰';
    const score = r2(ctx.score);
    const full = r2(ctx.full) || 150;
    const paper = ctx.paper || {};
    const diffWord = paper.overallDifficulty || '中等';
    const LBL = { bold: true, align: 'center', shade: 'F2F2F2' };

    /* ---------- 标题 ---------- */
    C.push(D.p('锐满分教育试卷分析表', { size: 16, bold: true, align: 'center', after: 60 }));
    C.push(D.p('学员基本信息', { size: 11, bold: true, before: 0, after: 40 }));

    /* ---------- 表1：学员基本信息 ---------- */
    {
      const rows = [];
      rows.push({ cells: [
        D.tc('学生姓名', Object.assign({ w: W1[0] }, LBL)),
        D.tc(name, { w: W1[1] + W1[2], span: 2, align: 'center' }),
        D.tc('性别', Object.assign({ w: W1[3] }, LBL)),
        D.tc(ctx.gender || '', { w: W1[4], align: 'center' }),
        D.tc('学校', Object.assign({ w: W1[5] }, LBL)),
        D.tc('', { w: W1[6], align: 'center' }),
        D.tc('年级', { w: W1[7], align: 'center' })
      ] });
      rows.push({ cells: [
        D.tc('学管师', Object.assign({ w: W1[0] }, LBL)),
        D.tc(ctx.manager || '', { w: W1[1], align: 'center' }),
        D.tc('教师', Object.assign({ w: W1[2] }, LBL)),
        D.tc(teacher, { w: W1[3], align: 'center' }),
        D.tc('辅导科目', Object.assign({ w: W1[4] }, LBL)),
        D.tc(subject, { w: W1[5], align: 'center' }),
        D.tc('测试得分', Object.assign({ w: W1[6] }, LBL)),
        D.tc(String(score), { w: W1[7], align: 'center' })
      ] });
      rows.push({ cells: [
        D.tc(ALL_CAP[0], Object.assign({ w: W1[0] }, LBL)),
        D.tc(ALL_CAP[1], Object.assign({ w: W1[1] }, LBL)),
        D.tc(ALL_CAP[2], Object.assign({ w: W1[2] }, LBL)),
        D.tc(ALL_CAP[3], Object.assign({ w: W1[3] }, LBL)),
        D.tc(ALL_CAP[4], Object.assign({ w: W1[4] }, LBL)),
        D.tc(ALL_CAP[5], Object.assign({ w: W1[5] }, LBL)),
        D.tc(ALL_CAP[6], Object.assign({ w: W1[6] }, LBL)),
        D.tc(ALL_CAP[7] + '、' + ALL_CAP[8], { w: W1[7], bold: true, align: 'center', shade: 'F2F2F2', size: 8 })
      ] });
      C.push(D.table(rows, W1));
      C.push(D.p('', { size: 6, before: 0, after: 0 }));
    }

    /* ---------- 表2：试卷分析 ---------- */
    {
      const rows = [];
      rows.push({ cells: [
        D.tc('试卷分析', { w: sum(W8), bold: true, align: 'center', span: 8, shade: 'DCE6F1', size: 11 })
      ] });
      rows.push({ cells: [
        D.tc('考试时间', Object.assign({ w: W8[0] }, LBL)),
        D.tc(ctx.examDate || '', { w: W8[1] + W8[2], span: 2, size: 9 }),
        D.tc('考试名称', Object.assign({ w: W8[3] }, LBL)),
        D.tc(ctx.examName || '', { w: W8[4], size: 9 }),
        D.tc('考试科目', Object.assign({ w: W8[5] }, LBL)),
        D.tc(subject, { w: W8[6], align: 'center' }),
        D.tc('考试时长：' + (ctx.duration || '120min'), { w: W8[7], align: 'center', size: 9 })
      ] });
      rows.push({ cells: [
        D.tc('试卷总分', Object.assign({ w: W8[0] }, LBL)),
        D.tc(String(full), { w: W8[1], align: 'center' }),
        D.tc('试卷得分', Object.assign({ w: W8[2] }, LBL)),
        D.tc(String(score), { w: W8[3], align: 'center' }),
        D.tc('试卷难度', Object.assign({ w: W8[4] }, LBL)),
        D.tc(diffWord, { w: W8[5], align: 'center' }),
        D.tc('试卷质量', Object.assign({ w: W8[6] }, LBL)),
        D.tc('试卷来源', { w: W8[7], align: 'center' })
      ] });
      rows.push({ cells: [
        D.tc('辅导周期', Object.assign({ w: W8[0] }, LBL)),
        D.tc('', { w: W8[1] + W8[2] + W8[3] + W8[4] + W8[5], span: 5, align: 'center' }),
        D.tc('已学课时', Object.assign({ w: W8[6] }, LBL)),
        D.tc('', { w: W8[7], align: 'center' })
      ] });
      const scope = ctx.examScope || ((paper.scope || []).join('，') || '');
      const wideW = W8.slice(1).reduce((a, b) => a + b, 0);
      rows.push({ cells: [
        D.tc('考试范围', Object.assign({ w: W8[0] }, LBL)),
        D.tc(scope, { w: wideW, span: 7, size: 9 })
      ] });
      rows.push({ cells: [
        D.tc('授课内容', Object.assign({ w: W8[0] }, LBL)),
        D.tc(ctx.taughtContent || '', { w: wideW, span: 7, size: 9 })
      ] });
      rows.push({ cells: [
        D.tc('学生进步点', Object.assign({ w: W8[0] }, LBL)),
        D.tc(ctx.progress || '', { w: wideW, span: 7, size: 9 })
      ] });
      C.push(D.table(rows, W8));
      C.push(D.p('', { size: 6, before: 0, after: 0 }));
    }

    /* ---------- 表3：题型分布 ---------- */
    {
      const W = W_TYPE;
      const rows = [];
      rows.push({ cells: [
        D.tc('题　型　分　布', { w: sum(W), bold: true, align: 'center', span: 6, shade: 'DCE6F1', size: 11 })
      ] });
      rows.push({ opts: { header: true }, cells: [
        D.tc('题型', Object.assign({ w: W[0] }, LBL)),
        D.tc('题目数量', Object.assign({ w: W[1] }, LBL)),
        D.tc('难度', Object.assign({ w: W[2] }, LBL)),
        D.tc('总分值', Object.assign({ w: W[3] }, LBL)),
        D.tc('得分', Object.assign({ w: W[4] }, LBL)),
        D.tc('得分率', Object.assign({ w: W[5] }, LBL))
      ] });
      const ts = ctx.typeSummary || [];
      ts.forEach(t => {
        rows.push({ cells: [
          D.tc(t.type, { w: W[0], align: 'center' }),
          D.tc(String(t.n), { w: W[1], align: 'center' }),
          D.tc(diffWord, { w: W[2], align: 'center' }),
          D.tc(String(r2(t.full)), { w: W[3], align: 'center' }),
          D.tc(String(r2(t.got)), { w: W[4], align: 'center' }),
          D.tc(t.full ? (t.got / t.full * 100).toFixed(1) + '%' : '—', { w: W[5], align: 'center' })
        ] });
      });
      rows.push({ cells: [
        D.tc('合计', Object.assign({ w: W[0] }, LBL)),
        D.tc(String(sum(ts.map(t => t.n))), Object.assign({ w: W[1] }, LBL)),
        D.tc('—', { w: W[2], align: 'center', shade: 'F2F2F2' }),
        D.tc(String(r2(sum(ts.map(t => t.full)))), Object.assign({ w: W[3] }, LBL)),
        D.tc(String(r2(sum(ts.map(t => t.got)))), Object.assign({ w: W[4] }, LBL)),
        D.tc(full ? (score / full * 100).toFixed(1) + '%' : '—', Object.assign({ w: W[5] }, LBL))
      ] });
      C.push(D.table(rows, W));
      C.push(D.p('', { size: 6, before: 0, after: 0 }));
    }

    /* ---------- 表4：错题分析（全卷逐题） ---------- */
    {
      const W = W_Q;
      const rows = [];
      rows.push({ cells: [
        D.tc('错　题　分　析', { w: sum(W), bold: true, align: 'center', span: 7, shade: 'DCE6F1', size: 11 })
      ] });
      rows.push({ opts: { header: true }, cells: [
        D.tc('题号', Object.assign({ w: W[0] }, LBL)),
        D.tc('题型', Object.assign({ w: W[1] }, LBL)),
        D.tc('分值', Object.assign({ w: W[2] }, LBL)),
        D.tc('得分', Object.assign({ w: W[3] }, LBL)),
        D.tc('难度', Object.assign({ w: W[4] }, LBL)),
        D.tc('考察知识点', Object.assign({ w: W[5] }, LBL)),
        D.tc('失分情况及原因分析', Object.assign({ w: W[6] }, LBL))
      ] });
      (ctx.questionRows || []).forEach(r => {
        rows.push({ cells: [
          D.tc(String(r.no), { w: W[0], align: 'center' }),
          D.tc(r.type, { w: W[1], align: 'center' }),
          D.tc(String(r2(r.full)), { w: W[2], align: 'center' }),
          D.tc(String(r2(r.got)), { w: W[3], align: 'center' }),
          D.tc(r.difficulty, { w: W[4], align: 'center' }),
          D.tc(r.knowledge, { w: W[5], size: 8 }),
          D.tc(r.reason, { w: W[6], size: 8 })
        ] });
      });
      C.push(D.table(rows, W));
      C.push(D.p('', { size: 6, before: 0, after: 0 }));
    }

    /* ---------- 表5：教学辅导建议 / 安排 ---------- */
    {
      const W = W_ADV;
      C.push(D.table([
        { cells: [
          D.tc('教学辅导建议/安排', { w: sum(W), bold: true, align: 'center', span: 2, shade: 'DCE6F1', size: 11 })
        ] },
        { cells: [
          D.tc('', { w: W[0], align: 'center', shade: 'F2F2F2' }),
          D.tc(ctx.advice || '', { w: W[1], size: 9 })
        ] }
      ], W));
      C.push(D.p('', { size: 6, before: 0, after: 0 }));
    }

    /* ---------- 表6：签字栏 ---------- */
    {
      const W = W_SIGN;
      C.push(D.table([{ cells: [
        D.tc('分析人：' + teacher, { w: W[0] + W[1], span: 2 }),
        D.tc('学管师：' + (ctx.manager || ''), { w: W[2] + W[3], span: 2 }),
        D.tc('家长签字：', { w: W[4] + W[5], span: 2 })
      ] }], W));
    }

    return D.build(C.join(''));
  }

  return { build, W8, W1, W_TYPE, W_Q, W_ADV, W_SIGN, SAFE_W, ALL_CAP };
}));
