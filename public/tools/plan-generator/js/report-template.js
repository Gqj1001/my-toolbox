/**
 * 《辅导计划》模板化 Word 导出（读模板替换占位符）
 * ==========================================================================
 * ⚠️ 这个文件的三段核心逻辑是**从 `public/tools/math-plan/js/report-template.js`
 *    逐字搬过来的**（用脚本搬，不是手抄 —— 手抄错一个字符，表现是"导出件里少一个值"，
 *    极难发现）。只改了这些地方：
 *      · 全局名 / 模块名：`MathPlanReportTemplate` → `PlanGenReportTemplate`
 *      · 措辞：逐次课表 → 模块进度表（本工具**一行 = 一个模块**）
 *      · 定位数据行时去掉了数学版的「教学内容」判据（本模板那列叫「内容（包括阶段检测）」）
 *      · **去掉了三轮节奏文案 `roundsSentence()`** —— 那个是数学版按"一轮/二轮/三轮"写死的，
 *        物理的复习阶段是科目包里的 `stages`（一轮·力学 / 一轮·电磁 / 二轮 / 收口），
 *        叙述句由本工具的调用方按科目包的 stages 拼，不能照抄。
 *
 * 三条硬性原则（与数学版一致，别改）：
 *   ① 完全不动格式：整份 document.xml 都来自 Word 模板，程序只做**文本替换**与
 *      **整行增删**（增行 = 深拷贝样板行的 XML），绝不自己拼 tcW / tblGrid / 边框。
 *   ② 只写占位符所在的格子：其余单元格（含老师手填的空白格、左侧竖排标签、表头
 *      文字、表外段落）一个字节都不碰。
 *   ③ 值由调用方传入，且调用方从「屏幕上最新内容」取值 —— 这样 AI 改了以后立刻导出，
 *      导出的就是改后的文本。
 *
 * 纯函数、无 DOM 依赖，浏览器与 Node 均可运行（Node 下便于写单元测试）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./docx-builder.js'));
  } else {
    root.PlanGenReportTemplate = factory(root.DocxBuilder);
  }
}(typeof self !== 'undefined' ? self : this, function (DocxBuilder) {
  'use strict';

  /** 进度表每个样板行支持的字段（顺序即表格列顺序）：
   *  st = 阶段（章节/单元/模块）· ct = 内容 · hr = 课时数 · ob = 教学目标 */
  const ROW_FIELDS = ['st', 'ct', 'hr', 'ob'];
  /** 安全上限：模板只留 1 行样板，超出靠深拷贝扩（模块数远小于此，纯粹防呆） */
  const MAX_ROWS = 200;

  /**
   * 程序填入内容的统一字体规格：**五号宋体**
   *   · 中文 → 宋体（eastAsia）
   *   · 英文/数字 → Times New Roman（ascii / hAnsi）
   *   · 字号 → 五号 = 10.5pt = w:sz 21（half-points）
   *
   * 为什么"强制覆盖"而不是沿用模板：模板里的占位符原始 rPr 可能大小不一，
   * 填进去以后字号忽大忽小。这里统一成一种，**只作用于被替换的那一格**。
   * ⚠️ 模板自带的固定标签（学生年级/教材版本/表头/签字行等）不走这里，保持模板原样。
   */
  const UNIFORM_RPR =
    '<w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="宋体"/>'
    + '<w:sz w:val="21"/><w:szCs w:val="21"/></w:rPr>';

  /* ============================ 基础工具 ============================ */
  /** XML 文本转义（去掉控制字符，否则 Word 会报文档损坏） */
  function xmlEsc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
  }

  /** 取一段 XML 里的可见文本 */
  function textOf(xml) {
    return String(xml || '')
      .replace(/<w:tab\b[^>]*\/?>/g, '\t')
      .replace(/<w:br\b[^>]*\/?>/g, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&');
  }

  function matchRows(tableXml) {
    return tableXml.match(/<w:tr(?:\s[^>]*)?>[\s\S]*?<\/w:tr>/g) || [];
  }
  function matchTables(xml) {
    return xml.match(/<w:tbl(?:\s[^>]*)?>[\s\S]*?<\/w:tbl>/g) || [];
  }

  /* ============================ ① 替换占位符 ============================ */
  /**
   * 在**单个 run** 内把 {{key}} 换成 value。
   * 只改写这个 run 的 <w:t> 文本 + 把它的 <w:rPr> 换成统一规格（五号宋体），
   * 不动同一段落里**其他 run**（例如「辅导时间：」这个固定标签的 run）。
   */
  function replaceKeyInRun(run, key, value) {
    const v = xmlEsc(value == null ? '' : value);
    // 把该 run 里第一个 <w:t> 的内容换掉（自闭合 <w:t/> 也认）
    return run
      .replace(/<w:t(?:\s[^>]*)?>[\s\S]*?<\/w:t>|<w:t(?:\s[^>]*)?\/>/,
        '<w:t xml:space="preserve">' + v + '</w:t>')
      // 统一字体规格：把该 run 自己的 rPr 整个换掉（没有 rPr 就补一个）
      .replace(/<w:rPr>[\s\S]*?<\/w:rPr>/, UNIFORM_RPR)
      .replace(/^<w:r>(\s*)(?!<w:rPr)/, '<w:r>' + UNIFORM_RPR);
  }

  /**
   * 把某个单元格里的占位符替换成 value。
   *
   * 做法（**外科式**，2 遍）：
   *   ① 成对替换：占位符完整落在某一个 run 里（278 个里绝大多数是这种），
   *      只改那个 run 的文本与 rPr；
   *   ② 兜底：占位符被 Word 拆到多个 run 时，退化为整段重写（并统一规格）。
   * 这样「辅导时间：」这种**与占位符同段的固定标签**不会被合并/改动，
   * 段落里其他 run 的格式也原样保留。
   */
  function replaceInCell(tc, value) {
    const v = xmlEsc(value == null ? '' : value);
    let out = tc.replace(/<w:r>[\s\S]*?<\/w:r>/g, (run) => {
      const m = run.match(/\{\{\s*([^{}]+?)\s*\}\}/);
      if (!m) return run;
      return replaceKeyInRun(run, m[1].trim(), value);
    });
    if (!/\{\{/.test(out)) return out;

    // ---- 兜底：占位符被拆散，只能在段落层面处理 ----
    return out.replace(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g, (p) => {
      if (!/\{\{/.test(p)) return p;
      const pPrM = p.match(/<w:pPr>[\s\S]*?<\/w:pPr>/);
      const pPr = pPrM ? pPrM[0] : '';
      const pOpenM = p.match(/^<w:p(?:\s[^>]*)?>/);
      const pOpen = pOpenM ? pOpenM[0] : '<w:p>';
      return pOpen + pPr + '<w:r>' + UNIFORM_RPR
        + '<w:t xml:space="preserve">' + v + '</w:t></w:r></w:p>';
    });
  }

  /** 在整个 document.xml 里替换所有占位符（逐表格 → 逐行 → 逐格，不碰 tblPr/trPr） */
  function replaceAll(xml, data) {
    const out = xml.replace(/<w:tbl(?:\s[^>]*)?>[\s\S]*?<\/w:tbl>/g, (tbl) =>
      tbl.replace(/<w:tr(?:\s[^>]*)?>[\s\S]*?<\/w:tr>/g, (row) =>
        row.replace(/<w:tc(?:\s[^>]*)?>[\s\S]*?<\/w:tc>/g, (tc) => {
          const m = textOf(tc).match(/\{\{\s*([^{}]+?)\s*\}\}/);
          if (!m) return tc;
          const key = m[1].trim();
          if (!(key in data)) return tc;          // 没给值就保持原样（便于发现漏填）
          return replaceInCell(tc, data[key]);
        })));
    return replaceInParagraphs(out, data);
  }

  /**
   * 表格**外面**的占位符（本工具的模板有：正文标题那一句 `{{title}}`）。
   *
   * ⚠️ 为什么必须单独一遍：`replaceAll` 的第一遍只遍历 `<w:tbl>`，
   *    表格外的段落根本走不到 —— 第一版就是这样漏掉了标题（导出件里留着 `{{title}}`）。
   * 为什么不能用 `replaceInCell`：那个函数按"格"处理，对段落语义不对；
   *    这里按"段"处理，且**只动第一个带占位符的段内的 run**，其余段一字不碰。
   */
  function replaceInParagraphs(xml, data) {
    let done = {};
    return xml.replace(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g, (p) => {
      if (/\{\{/.test(p) === false) return p;
      const m = textOf(p).match(/\{\{\s*([^{}]+?)\s*\}\}/);
      if (!m) return p;
      const key = m[1].trim();
      if (!(key in data)) return p;
      if (done[key]) return p;                    // 一个键只替换第一处，避免重复写
      done[key] = true;
      // 段落里的 run 逐个看：命中占位符的那个换成值，**其余 run 清空**
      // （否则「辅导时间：{{period}}」这种会被写成 "值值"）
      let hit = false;
      return p.replace(/<w:r>[\s\S]*?<\/w:r>/g, (run) => {
        if (!/\{\{/.test(run)) return hit ? blankRun(run) : run;
        if (hit) return blankRun(run);
        hit = true;
        return replaceKeyInRun(run, key, data[key]);
      });
    });
  }

  /** 把 run 的可见文字清空（保留它的 rPr 与结构） */
  function blankRun(run) {
    return run.replace(/<w:t(?:\s[^>]*)?>[\s\S]*?<\/w:t>|<w:t(?:\s[^>]*)?\/>/,
      '<w:t xml:space="preserve"></w:t>');
  }

  /* ==================== ② 模块进度表：动态增删行 ==================== */
  /**
   * 定位模块进度表的数据行（含 {{sN_xx}} 的连续行）
   * @returns {{rows:string[], rowStart:number, rowEnd:number, firstXml:string}|null}
   */
  function locateLessonRows(xml) {
    const tables = matchTables(xml);
    for (const tbl of tables) {
      const rows = matchRows(tbl);
      let start = -1;
      for (let i = 0; i < rows.length; i++) {
        const t = textOf(rows[i]);
        if (t.indexOf('阶段') >= 0 && (t.indexOf('课时数') >= 0 || t.indexOf('教学目标') >= 0)) { start = i + 1; break; }
      }
      if (start < 0) {
        for (let i = 0; i < rows.length; i++) {
          if (/\{\{\s*s1_st\s*\}\}/.test(rows[i])) { start = i; break; }
        }
      }
      if (start < 0) continue;
      let end = start;
      while (end < rows.length && /\{\{\s*s\d+_[a-z]{2}\s*\}\}/.test(rows[end])) end++;
      if (end === start) return null;
      return { table: tbl, rows, rowStart: start, rowEnd: end,
               firstXml: rows[start], lastXml: rows[end - 1] };
    }
    return null;
  }

  /**
   * 按实际行数增删样板行
   *  · 多了：深拷贝最后一行样板追加（列宽/边距随 XML 一起复制 → 格式与模板一致）
   *  · 少了：截掉多余行
   *  · 再把 sN 编号重排成 1..count
   */
  function fitLessonRows(xml, count) {
    const loc = locateLessonRows(xml);
    if (!loc) return { xml: xml, ok: false, reason: '没找到模块进度表的样板行', count: 0 };
    const { table, rows, rowStart, rowEnd, lastXml } = loc;
    const have = rowEnd - rowStart;
    let dataRows = rows.slice(rowStart, rowEnd);

    if (count > have) {
      for (let i = have; i < count; i++) dataRows.push(lastXml);   // 深拷贝式追加（字符串复制即为深拷贝）
    } else if (count < have) {
      dataRows = dataRows.slice(0, count);
    }
    // 重排编号：{{sK_xx}} → {{s(i+1)_xx}}
    dataRows = dataRows.map((r, i) =>
      r.replace(/\{\{\s*s\d+_([a-z]{2})\s*\}\}/g, (mm, suf) => '{{s' + (i + 1) + '_' + suf + '}}'));

    const oldBlock = rows.slice(rowStart, rowEnd).join('');
    const newBlock = dataRows.join('');
    const newTable = table.replace(oldBlock, newBlock);
    const out = xml.replace(table, newTable);
    return { xml: out, ok: true, count: dataRows.length, have: have };
  }


  /* ============================ ④ 装配数据 ============================ */
  /**
   * 把 payload 转成 键→值 表。
   * @param {object} p {
   *   title, grade, subject, book, teacher, campus,   // 抬头
   *   hoursLine,                                      // 「课时分配（需要课时…；辅导时间…；…）」整句
   *   method,                                         // 教学方法那一大段
   *   rows: [{ stage, content, hours, goal }]         // 模块进度表（一行一个模块）
   * }
   */
  function buildMap(p) {
    const d = {};
    d.title = p.title || '';
    d.grade = p.grade || '';
    d.subj = p.subject || '';
    d.book = p.book || '';
    d.teacher = p.teacher || '';
    if (p.campus) d.campus = p.campus;
    d.hoursLine = p.hoursLine || '';
    d.method = p.method || '';

    const rows = p.rows || [];
    rows.forEach((r, i) => {
      const n = i + 1;
      d['s' + n + '_st'] = r.stage == null ? '' : String(r.stage);
      d['s' + n + '_ct'] = r.content == null ? '' : String(r.content);
      d['s' + n + '_hr'] = r.hours == null ? '' : String(r.hours);
      d['s' + n + '_ob'] = r.goal == null ? '' : String(r.goal);
    });
    return d;
  }

  /* ============================ ⑤ 主入口 ============================ */
  /**
   * 生成 docx
   * @param {object} payload 见 buildMap
   * @param {object} opts { template: PlanGenTemplateData }
   * @returns {{blob:Uint8Array, warnings:string[], rows:number, placeholderCount:number}}
   */
  function build(payload, opts) {
    opts = opts || {};
    const T = opts.template;
    if (!T) throw new Error('缺少模板数据（template）');
    if (!DocxBuilder) throw new Error('缺少 DocxBuilder（docx-builder.js 未加载）');

    const warnings = [];
    const p = payload || {};
    let rows = (p.rows || []).slice();
    if (rows.length > MAX_ROWS) {
      warnings.push('进度表行数 ' + rows.length + ' 超过上限 ' + MAX_ROWS + '，已截断');
      rows = rows.slice(0, MAX_ROWS);
    }
    if (!rows.length) warnings.push('模块进度表为空，将没有内容行');

    T.reset();
    const doc0 = T.getText('word/document.xml');

    // 1) 先按行数增删样板行（此时 document.xml 里还是 {{sN_xx}}）
    const fit = fitLessonRows(doc0, rows.length);
    if (!fit.ok) warnings.push('未能定位模块进度表的样板行：' + (fit.reason || '未知原因'));
    let doc = fit.xml;

    // 2) 替换所有占位符
    const map = buildMap(Object.assign({}, p, { rows: rows }));
    doc = replaceAll(doc, map);

    // 3) 残留占位符检查（除了没给值的，其余都应替换掉）
    const left = (doc.match(/\{\{\s*([^{}]+?)\s*\}\}/g) || []);
    if (left.length) warnings.push('仍有 ' + left.length + ' 个占位符未替换：' + left.slice(0, 5).join('、'));

    // 4) 重新打包：除 document.xml 外全部原样（图片等二进制逐字节保留）
    const files = T.collect({ 'word/document.xml': doc });
    const blob = DocxBuilder.zip(files);
    T.reset();

    return { blob: blob, warnings: warnings, rows: rows.length,
             placeholderCount: T.PLACEHOLDERS ? T.PLACEHOLDERS.length : 0 };
  }

  return {
    build: build,
    buildMap: buildMap,
    replaceAll: replaceAll,
    replaceInCell: replaceInCell,
    locateLessonRows: locateLessonRows,
    fitLessonRows: fitLessonRows,
    textOf: textOf,
    xmlEsc: xmlEsc,
    ROW_FIELDS: ROW_FIELDS,
    MAX_ROWS: MAX_ROWS,
  };
}));
