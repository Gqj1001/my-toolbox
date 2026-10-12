/**
 * 公司模板导出引擎（零依赖，浏览器 / Node 通用）
 * ==========================================================================
 * 干什么：**以公司模板为底、只替换文字**，产出可直接交公司的 .docx。
 *
 * ⚠️ 三条红线（改动前先读）：
 *  1. **不许新建文档拼表格** —— 那样字体/行距/表格线/合并格一定会走形。
 *     这里只改 `word/document.xml` 里的**文字**，其余零件（styles/theme/fontTable/sectPr…）
 *     原样带回 ⇒ 格式与公司模板逐字节一致。
 *  2. **不许让样例文字漏出去**：模板里的语文样例（三段归因、8 行错题、17 行进度…）
 *     在导出时**必须被替换或清空**。任何"没数据就保持原样"的分支都是 bug。
 *  3. **不许按写死的行号填**：模板是公司发下来的，将来可能微调行序。
 *     这里一律**按标签文字定位**（`学生姓名`、`题号/考点/错因`、`教师签字`…），
 *     定位不到就**抛错**（宁可导出失败，也不要把数据填到错的格子里）。
 *
 * 用法：
 *   const bytes = CompanyDocx.build('附件2', data);   // → Uint8Array（合法 .docx）
 *
 * data（缺的键 = 该格留空，交给老师在 Word 里写）：
 *   {
 *     student, school, grade, teacher, subject, examType,
 *     learnedHours, totalHours,                       // 「已学课时/单科总课时」
 *     entryScore, entryRank, currentScore, currentRank,  // 「入学成绩/排名」「本次成绩/排名」
 *     wrongRows: [{ no, topic, point, reason }],       // 附件2 错题分析（动态行数）
 *     longTexts: { '学生角度': '…', … }                 // 附件1 六段长文（一期传空 = 留空）
 *   }
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./template-data.js'),
                             require('../paper-analysis/js/docx-builder.js'));
  } else {
    root.CompanyDocx = factory(root.CompanyTemplateData, root.DocxBuilder);
  }
}(typeof self !== 'undefined' ? self : this, function (T, D) {
  'use strict';

  const esc = D.esc;
  const DOC = 'word/document.xml';
  const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

  /* ======================================================================
     一、XML 层：字符串切片（不用 DOMParser —— 它会把 XML 规范化，其余字节就不保真了）
     ====================================================================== */

  /** 找到第 idx 张表的 XML 片段（含起止标签） */
  function tableAt(xml, idx) {
    let pos = 0, found = 0;
    while (true) {
      const s = xml.indexOf('<w:tbl>', pos);
      const s2 = xml.indexOf('<w:tbl ', pos);
      const start = (s < 0) ? s2 : (s2 < 0 ? s : Math.min(s, s2));
      if (start < 0) break;
      const end = xml.indexOf('</w:tbl>', start);
      if (end < 0) break;
      if (found === idx) return { start: start, end: end + '</w:tbl>'.length };
      found++;
      pos = end + 1;
    }
    throw new Error('模板里找不到第 ' + idx + ' 张表');
  }

  /** 把一张表拆成行（只取顶层 <w:tr>） */
  function splitRows(tblXml) {
    const rows = [];
    let pos = 0;
    while (true) {
      const start = tblXml.indexOf('<w:tr>', pos) >= 0 && (tblXml.indexOf('<w:tr ', pos) < 0 ||
                    tblXml.indexOf('<w:tr>', pos) < tblXml.indexOf('<w:tr ', pos))
        ? tblXml.indexOf('<w:tr>', pos) : tblXml.indexOf('<w:tr ', pos);
      if (start < 0) break;
      const end = tblXml.indexOf('</w:tr>', start);
      if (end < 0) break;
      rows.push(tblXml.slice(start, end + '</w:tr>'.length));
      pos = end + 1;
    }
    return rows;
  }

  /** 把一行拆成格（<w:tc>…</w:tc>），并给出每格的 gridSpan */
  function splitCells(rowXml) {
    const cells = [];
    let pos = 0;
    while (true) {
      const a = rowXml.indexOf('<w:tc>', pos);
      const b = rowXml.indexOf('<w:tc ', pos);
      const start = (a < 0) ? b : (b < 0 ? a : Math.min(a, b));
      if (start < 0) break;
      const end = rowXml.indexOf('</w:tc>', start);
      if (end < 0) break;
      const xml = rowXml.slice(start, end + '</w:tc>'.length);
      const spanMatch = xml.match(/<w:gridSpan w:val="(\d+)"\s*\/>/);
      cells.push({ xml: xml, span: spanMatch ? parseInt(spanMatch[1], 10) : 1 });
      pos = end + 1;
    }
    return cells;
  }

  /** 取一格里的纯文字（所有 <w:t> 拼起来） */
  function cellText(cellXml) {
    const out = [];
    const re = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g;
    let m;
    while ((m = re.exec(cellXml)) !== null) out.push(m[1]);
    return out.join('')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ').trim();
  }

  /** 行的文字（用于按标签定位） */
  function rowText(rowXml) {
    return splitCells(rowXml).map(function (c) { return cellText(c.xml); }).join(' | ');
  }

  /**
   * 把一格的文字换掉，**保留该格第一段的 pPr 与第一个 run 的 rPr**（字号/字体/加粗/对齐都还在）。
   * 多行文字用 <w:br/> 连接。传空串 = 清空该格（用于"留空给老师写"）。
   */
  function setCellText(cellXml, text) {
    const openTag = cellXml.match(/^<w:tc(?:\s[^>]*)?>/)[0];
    const inner = cellXml.slice(openTag.length, -'</w:tc>'.length);
    const tcPrMatch = inner.match(/<w:tcPr>[\s\S]*?<\/w:tcPr>/);
    const tcPr = tcPrMatch ? tcPrMatch[0] : '';
    const body = tcPr ? inner.replace(tcPr, '') : inner;

    const pMatch = body.match(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/);
    const pOpen = pMatch ? pMatch[0].match(/^<w:p(?:\s[^>]*)?>/)[0] : '<w:p>';
    const pPr = pMatch ? ((pMatch[0].match(/<w:pPr>[\s\S]*?<\/w:pPr>/) || [''])[0]) : '';
    const rPr = pMatch ? ((pMatch[0].match(/<w:rPr>[\s\S]*?<\/w:rPr>/) || [''])[0]) : '';

    const lines = String(text == null ? '' : text).split('\n');
    const runs = lines.map(function (ln, i) {
      return (i ? '<w:r><w:br/></w:r>' : '') +
        '<w:r>' + rPr + '<w:t xml:space="preserve">' + esc(ln) + '</w:t></w:r>';
    }).join('');
    // ⚠️ 只保留第一段（多出来的段落多是样例文字，留着会把样例带出去）
    return openTag + tcPr + pOpen + pPr + runs + '</w:p>' + '</w:tc>';
  }

  /* ======================================================================
     二、定位工具（一律按标签找，找不到就抛错）
     ====================================================================== */

  function findRow(rows, needle) {
    for (let i = 0; i < rows.length; i++) {
      if (rowText(rows[i]).indexOf(needle) >= 0) return i;
    }
    return -1;
  }

  function requireRow(rows, needle, att) {
    const i = findRow(rows, needle);
    if (i < 0) {
      throw new Error(att + ' 模板结构变了：找不到含「' + needle + '」的行。'
        + '（公司改了模板就要同步更新 company-docx.js 的定位标签，别改成写死行号）');
    }
    return i;
  }

  /**
   * 用新的一组格替换掉一行的格。
   * ⚠️ 只删 `<w:tc>`，行里**其余东西一律原样保留** —— 最容易漏的是 `<w:tblPrEx>`
   *    （行级表格属性，Word 把边框写在这里）：实测踩过，丢掉它表格线就没了。
   */
  function replaceCells(rowXml, newCells) {
    const openTag = rowXml.match(/^<w:tr(?:\s[^>]*)?>/)[0];
    const close = '</w:tr>';
    const inner = rowXml.slice(openTag.length, -close.length)
      .replace(/<w:tc(?:\s[^>]*)?>[\s\S]*?<\/w:tc>/g, '');
    return openTag + inner + newCells.join('') + close;
  }

  /**
   * 固定标签白名单：**这些格的文字一个字都不许改**（公司模板的骨架）。
   * 清空"值格"时必须靠它来区分 —— 表里有合并格，凭"第几格之后全是值"会误伤标签
   * （实测踩过：附件3 签字行的 `学管签字` 被当成值格清掉了）。
   */
  const FIXED_LABELS = [
    '行未来教育集团个性化试卷分析模板', '行未来教育集团个性化辅导方案模板',
    '学生姓名', '学校年级', '教师姓名', '任教学科', '辅导课时',
    '已学课时/单科总课时', '考试类型', '入学成绩/排名', '本次成绩/排名',
    '成绩变化原因分析', '学生角度', '教师角度', '其它原因',
    '方案调整及应对措施', '教师教学', '学生配合', '家长配合',
    '错题分析', '题号', '题目', '考点', '错因',
    '项目', '具体内容', '三次课后', '阶段总结',
    '学情分析', '学科知识掌握情况', '学习方法与能力', '学习态度与习惯', '其它方面',
    '拟采取的措施', '理论学习', '方法习得', '能力提升', '习惯培养',
    '预期达成的效果', '知识层面', '能力层面', '非学科层面',
    '成绩结果统计', '入学成绩', '补习后',
    '知识模块', '具体知识点（含检测）及预期目标', '课时数', '效果评估（比对目标）及方案调整',
    '教师签字', '学管师签字', '教管主任签字', '家长签字', '学科教师签字', '学管签字',
  ];
  function isLabel(text) {
    const t = String(text == null ? '' : text).trim();
    if (FIXED_LABELS.indexOf(t) >= 0) return true;
    return t.indexOf('辅导进度及结果验收') === 0 || t.indexOf('附件') === 0;
  }

  /** 清空一行里**所有值格**（标签格原样保留） */
  function clearValues(rowXml) {
    const cells = splitCells(rowXml).map(function (c) { return c.xml; });
    for (let i = 0; i < cells.length; i++) {
      if (!isLabel(cellText(cells[i]))) cells[i] = setCellText(cells[i], '');
    }
    return replaceCells(rowXml, cells);
  }

  /** 把某一行里"最后一个格"当长文格（模板里长文永远在最右） */
  function fillLastCell(rowXml, value) {
    const n = splitCells(rowXml).length;
    return fillCell(rowXml, n - 1, value);
  }

  /** 按「非合并重复格」的下标改一格；下标越界 = 模板结构变了 → 抛错 */
  function fillCell(rowXml, cellIndex, value, att) {
    const cells = splitCells(rowXml).map(function (c) { return c.xml; });
    if (cellIndex >= cells.length) {
      throw new Error(att + ' 定位到「' + cellText(cells[0] || '') + '」这一行，但它只有 '
        + cells.length + ' 格，取不到第 ' + (cellIndex + 1) + ' 格');
    }
    cells[cellIndex] = setCellText(cells[cellIndex], value);
    return replaceCells(rowXml, cells);
  }

  /* ======================================================================
     三、取值合成（一处实现，测试里逐条钉住）
     ====================================================================== */

  /** 「90分/500名」；只有分数就写「90分」；都没有 = 空 */
  function scoreRank(score, rank) {
    const s = (score === 0 || score) ? String(score).trim() : '';
    const r = (rank === 0 || rank) ? String(rank).trim() : '';
    if (!s && !r) return '';
    if (!r) return s;
    return (s || '') + '/' + r;
  }

  /** 「10小时/40小时」；只有总课时就写「/40小时」（已学留空等老师补） */
  function hoursPair(learned, total) {
    const a = (learned === 0 || learned) ? String(learned).trim() : '';
    const b = (total === 0 || total) ? String(total).trim() : '';
    if (!a && !b) return '';
    return a + '/' + b;
  }

  /** 「学校年级」＝ 学校 + 年级（样例是「天津高三」这种） */
  function schoolGrade(school, grade) {
    const a = String(school == null ? '' : school).trim();
    const b = String(grade == null ? '' : grade).trim();
    return (a + b).trim();
  }

  /* ======================================================================
     四、三个附件的填充规格
     ====================================================================== */

  /** 抬头行：[标签, 第一格值, 第二格标签, 第二格值]（每行 4 个"非合并格"） */
  const HEAD_ROWS = {
    '附件1': [
      ['学生姓名', 'student', '学校年级', 'schoolGrade'],
      ['教师姓名', 'teacher', '任教学科', 'subject'],
      ['已学课时/单科总课时', 'hours', '考试类型', 'examType'],
      ['入学成绩/排名', 'entryScoreRank', '本次成绩/排名', 'currentScoreRank'],
    ],
    '附件2': [
      ['学生姓名', 'student', '学校年级', 'schoolGrade'],
      ['教师姓名', 'teacher', '任教学科', 'subject'],
      ['已学课时/单科总课时', 'hours', '考试类型', 'examType'],
      ['入学成绩/排名', 'entryScoreRank', '本次成绩/排名', 'currentScoreRank'],
    ],
    '附件3': [
      ['学生姓名', 'student', '学校年级', 'schoolGrade'],
      ['教师姓名', 'teacher', '辅导课时', 'totalHoursText'],
    ],
  };

  /** 附件1 的六段长文：[定位标签, longTexts 的键] */
  const LONG_ROWS_1 = [
    ['学生角度', '学生角度'], ['教师角度', '教师角度'], ['其它原因', '其它原因'],
    ['教师教学', '教师教学'], ['学生配合', '学生配合'], ['家长配合', '家长配合'],
  ];

  /** 附件3 的样例内容由"整表只留标签"清理，不需要逐个标签列清单 */

  /* ======================================================================
     五、对外入口
     ====================================================================== */

  /**
   * 生成某个附件的 docx
   * @param {string} att '附件1' | '附件2' | '附件3'
   * @param {object} data 见文件头
   * @returns {Uint8Array}
   */
  function build(att, data) {
    data = data || {};
    let xml = T.getText(att, DOC);
    const tbl = tableAt(xml, 0);
    let tblXml = xml.slice(tbl.start, tbl.end);
    let rows = splitRows(tblXml);

    const v = {
      student: data.student || '',
      schoolGrade: schoolGrade(data.school, data.grade),
      teacher: data.teacher || '',
      subject: data.subject || '数学',
      hours: hoursPair(data.learnedHours, data.totalHours),
      totalHoursText: (data.totalHours === 0 || data.totalHours) ? String(data.totalHours) : '',
      examType: data.examType || '',
      entryScoreRank: scoreRank(data.entryScore, data.entryRank),
      currentScoreRank: scoreRank(data.currentScore, data.currentRank),
    };

    /* ---------- 附件3：整表"只留标签"，样例一律清掉（一期：过程内容留空给老师写） ----------
       ⚠️ 不能"按标签清那一行"：学情分析/措施/预期效果这三块的**子行首格是纵向合并的延续格**
       （第二行起首格是空的），按标签只会命中每块第一行，其余行的语文样例会直接漏进导出件
       （实测踩过）。所以这里做**整表**清理：值格全清、标签格原样留。 */
    if (att === '附件3') {
      rows = rows.map(function (r) { return clearValues(r); });
    }

    /* ---------- 抬头：逐行按标签填 ---------- */
    (HEAD_ROWS[att] || []).forEach(function (spec) {
      const ri = requireRow(rows, spec[0], att);
      rows[ri] = fillCell(rows[ri], 1, v[spec[1]], att);
      rows[ri] = fillCell(rows[ri], 3, v[spec[3]], att);
    });

    /* ---------- 附件1：六段长文（一期留空 = 清掉语文样例） ---------- */
    if (att === '附件1') {
      LONG_ROWS_1.forEach(function (pair) {
        const ri = requireRow(rows, pair[0], att);
        const txt = (data.longTexts && data.longTexts[pair[1]]) || '';
        rows[ri] = fillLastCell(rows[ri], txt);        // 长文永远在最右一格
      });
    }

    /* ---------- 附件2：错题分析（行数随实际错题数变化） ---------- */
    if (att === '附件2') {
      const headIdx = requireRow(rows, '错因', att);
      const endIdx = requireRow(rows, '方案调整及应对措施', att);
      const sampleIdx = [];
      for (let i = headIdx + 1; i < endIdx; i++) sampleIdx.push(i);
      if (!sampleIdx.length) throw new Error('附件2 模板里没有错题样例行（结构变了？）');

      // ⚠️ 列位从**表头行**现算，不写死：表头第一格是纵向合并的标签列（`错题分析`），
      //    数据行首格是它的**合并延续格**（实测踩过坑：写死 0/1/2/3 会把题号写进延续格、
      //    错因留在原位 ⇒ 语文样例直接漏进导出件）。
      const headCells = splitCells(rows[headIdx]).map(function (c) { return cellText(c.xml); });
      const colOf = function (name) {
        const i = headCells.findIndex(function (t) { return t.indexOf(name) >= 0; });
        if (i < 0) throw new Error('附件2 表头里找不到「' + name + '」列（公司改模板了？）');
        return i;
      };
      const COL = { no: colOf('题号'), topic: colOf('题目'), point: colOf('考点'), reason: colOf('错因') };

      const list = Array.isArray(data.wrongRows) ? data.wrongRows : [];
      const templateRow = rows[sampleIdx[0]];
      const built = [];
      list.forEach(function (r) {
        let row = templateRow;
        row = fillCell(row, COL.no, r.no == null ? '' : r.no, att);
        // 「题目」列：用户 2026-10 定的口径 = **用知识点顶替**（工具里没有题干）
        row = fillCell(row, COL.topic, r.topic || r.point || '', att);
        row = fillCell(row, COL.point, r.point || '', att);
        row = fillCell(row, COL.reason, r.reason || '', att);
        built.push(row);
      });
      // 用实际行替换掉**全部**样例行（没有错题 = 一行都不留，防样例漏出）
      rows = rows.slice(0, sampleIdx[0]).concat(built, rows.slice(endIdx));

      // 三段措施：一期留空
      ['教师教学', '学生配合', '家长配合'].forEach(function (label) {
        const ri = requireRow(rows, label, att);
        rows[ri] = fillLastCell(rows[ri], (data.longTexts && data.longTexts[label]) || '');
      });
    }

    /* ---------- 签字栏：一律留空（打印后手写） ---------- */
    ['教师签字', '学科教师签字', '教管主任签字'].forEach(function (label) {
      const ri = findRow(rows, label);
      if (ri >= 0) rows[ri] = clearValues(rows[ri]);     // ⚠️ 只清值格（附件3 签字行里还夹着标签）
    });

    /* ---------- 拼回文档 ---------- */
    tblXml = rows.join('');
    const head = xml.slice(0, tbl.start);
    const tail = xml.slice(tbl.end);
    // 表被替换成"只有行"的串，这里补回 <w:tbl> 外壳与 tblPr/tblGrid
    const origTbl = xml.slice(tbl.start, tbl.end);
    const innerStart = origTbl.indexOf('>') + 1;
    const gridEnd = origTbl.indexOf('</w:tblGrid>');
    const header = origTbl.slice(innerStart, gridEnd + '</w:tblGrid>'.length);
    xml = head + '<w:tbl>' + header + rows.join('') + '</w:tbl>' + tail;

    return D.zip(T.collect(att, { 'word/document.xml': xml }));
  }

  return { build: build, _internal: {
    tableAt: tableAt, splitRows: splitRows, splitCells: splitCells,
    cellText: cellText, setCellText: setCellText, rowText: rowText,
    scoreRank: scoreRank, hoursPair: hoursPair, schoolGrade: schoolGrade,
  } };
}));
