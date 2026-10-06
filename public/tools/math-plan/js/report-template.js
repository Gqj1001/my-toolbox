/**
 * 《辅导方案》模板化 Word 导出（读模板替换占位符）
 * ------------------------------------------------------------------
 * 与试卷分析同一套思路，但占位符形态不同：
 *   · 本模板的逐次课表占位符是 {{sN_st}} / {{sN_ct}} / {{sN_hr}} / {{sN_ob}}，
 *     N = 1..67，模板里预置了 67 个样板行（表格第 6..72 行）。
 *
 * 三条硬性原则：
 *   ① 完全不动格式：整份 document.xml 都来自 Word 模板，程序只做**文本替换**与
 *      **整行增删**（增行 = 深拷贝样板行的 XML），绝不自己拼 tcW / tblGrid / 边框。
 *   ② 只写占位符所在的格子：其余单元格（含老师手填的空白格、左侧竖排标签、表头
 *      文字、表外段落）一个字节都不碰。
 *   ③ 值由调用方传入，且调用方从「屏幕上最新内容」取值 —— 这样 AI 改写后立刻
 *      导出，导出的就是改后的文本。
 *
 * 纯函数、无 DOM 依赖，浏览器与 Node 均可运行（Node 下便于写单元测试）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./docx-builder.js'));
  } else {
    root.MathPlanReportTemplate = factory(root.DocxBuilder);
  }
}(typeof self !== 'undefined' ? self : this, function (DocxBuilder) {
  'use strict';

  /** 逐次课表每个样板行支持的字段（顺序即表格列顺序） */
  const ROW_FIELDS = ['st', 'ct', 'hr', 'ob'];
  /** 安全上限：极端的行数保护（模板 67 行，超出靠深拷贝扩） */
  const MAX_ROWS = 200;

  /**
   * 程序填入内容的统一字体规格：**五号宋体**
   *   · 中文 → 宋体（eastAsia）
   *   · 英文/数字 → Times New Roman（ascii / hAnsi）
   *   · 字号 → 五号 = 10.5pt = w:sz 21（half-points）
   *
   * 为什么要"强制覆盖"而不是沿用模板：
   *   模板里 278 个占位符的原始 rPr 有 3 种（微软雅黑 9pt / 10.5pt / 11pt），
   *   填进去以后字号忽大忽小。这里统一成一种，只作用于**被替换的那一格**。
   * ⚠ 模板自带的固定标签（学员/学管师/教材版本/表头/辅导时间：等）不走这里，
   *   它们保持模板原样（宋体，原始 rPr 不动）。
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
    return xml.replace(/<w:tbl(?:\s[^>]*)?>[\s\S]*?<\/w:tbl>/g, (tbl) =>
      tbl.replace(/<w:tr(?:\s[^>]*)?>[\s\S]*?<\/w:tr>/g, (row) =>
        row.replace(/<w:tc(?:\s[^>]*)?>[\s\S]*?<\/w:tc>/g, (tc) => {
          const m = textOf(tc).match(/\{\{\s*([^{}]+?)\s*\}\}/);
          if (!m) return tc;
          const key = m[1].trim();
          if (!(key in data)) return tc;          // 没给值就保持原样（便于发现漏填）
          return replaceInCell(tc, data[key]);
        })));
  }

  /* ==================== ② 逐次课表：动态增删行 ==================== */
  /**
   * 定位逐次课表的数据行（含 {{sN_xx}} 的连续行）
   * @returns {{rows:string[], rowStart:number, rowEnd:number, firstXml:string}|null}
   */
  function locateLessonRows(xml) {
    const tables = matchTables(xml);
    for (const tbl of tables) {
      const rows = matchRows(tbl);
      let start = -1;
      for (let i = 0; i < rows.length; i++) {
        const t = textOf(rows[i]);
        if (t.indexOf('阶段') >= 0 && t.indexOf('教学内容') < 0
            && (t.indexOf('课时数') >= 0 || t.indexOf('教学目标') >= 0)) { start = i + 1; break; }
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
    if (!loc) return { xml: xml, ok: false, reason: '没找到逐次课表的样板行', count: 0 };
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

  /* ============================ ③ 三轮节奏文案 ============================ */
  /**
   * 把三轮课时安排写成**连续叙述**（拼接在「教学方法」末尾，不建表格、不建段落）
   * 数字全部取自 rounds，跟着实际课时变。
   * 参考真实方案的口气：「…先用 A 课时…，再用 B 课时…，最后用 C 课时…。」
   *
   * ⚠️ 措辞范围（2026-10 润色后的约定，别越界）：
   *   本函数**只负责串联词与框架句**；轮次名（基础过关/专项突破/真题模拟、
   *   一轮补基础/二轮抓题型/三轮练真题）与下面 ACT 里的动作短语是**工具内部权威口径**
   *   （来源 math-plan.html 的 threeRounds），改了会让屏幕课表的分轮与叙述对不上。
   *
   *   ✅ 已核实：这句话**只在导出/payload 时拼上去**，**从不写进 #methodBody**；
   *      而 AI 润色只处理 #methodBody 里的 6 个带小标题段落 —— 所以 AI 根本不会写三轮节奏，
   *      **不存在「与 samples.ts 的 few-shot 打架」的问题**（旧文档那句因果不成立）。
   *
   * 口径：句首用「分 N 步走」，不用「三轮」——
   *   因为 <100h 的轮次名是「基础过关/专项突破/真题模拟」，本来就没有「一轮/二轮」字样，
   *   说「三轮」会和新高三那套「一轮补基础/二轮抓题型/三轮练真题」的口径混在一起。
   *   N 取实际轮次数（`rs.length`，已过滤掉 0 课时的轮次），所以两轮时是「分 2 步走」。
   */
  function roundsSentence(rounds) {
    const rs = (rounds || []).filter((r) => r && r.hours > 0);
    if (!rs.length) return '';
    // 每一轮的动作用词组表达，避免箭头清单
    const ACT = {
      '一轮补基础': '逐模块补齐基础、训练计算准确率',
      '基础过关': '逐模块补齐基础、把公式与题型模板固化下来',
      '二轮抓题型': '按卷面题型做专项突破、强化选填技巧与解答题规范',
      '专项突破': '按题型做专项训练、强化中档题的得分能力',
      '三轮练真题': '做限时套卷与真题模拟、查漏补缺',
      '真题模拟': '用真题与模拟卷做限时训练、模拟考场节奏与取舍',
    };
    const act = (r) => ACT[r.name] || r.focus || '';

    if (rs.length === 1) {
      return '复习节奏上，用 ' + rs[0].hours + ' 课时' + act(rs[0]) + '。';
    }
    const head = rs[0], mid = rs.slice(1, -1), tail = rs[rs.length - 1];
    // ⚠️ 别在这里再补一句「把基础过一遍」之类的开场话术：六个 ACT 动作短语**自己就带动作**
    //    （`基础过关` 那条是「逐模块补齐基础、…」），自己再写一句就会撞成
    //    「把基础逐模块过一遍，逐模块补齐基础…」——正是「一个意思写两遍」的老毛病。
    //    推进感靠**连接词**表达就够：先用…；再用…；最后…。
    let s = '复习节奏上分 ' + rs.length + ' 步走：先用 ' + head.hours + ' 课时' + act(head);
    mid.forEach((r) => { s += '；再用 ' + r.hours + ' 课时' + act(r); });
    s += '；最后 ' + tail.hours + ' 课时' + act(tail) + '。';
    return s;
  }

  /* ============================ ④ 装配数据 ============================ */
  /**
   * 把 payload 转成 键→值 表
   * @param {object} p { name, grade, subject, book, mgr, cons, camp, tchr,
   *                     period, method, rows:[{stage,content,hours,goal}] }
   */
  function buildMap(p) {
    const d = {};
    d.name = p.name || '';
    d.grade = p.grade || '';
    d.subj = p.subject || '数学';
    d.book = p.book || '';
    d.mgr = p.mgr || '';            // 空值 = 替换为空（留白给老师手填）
    d.cons = p.cons || '';
    d.camp = p.camp || '';
    d.tchr = p.tchr || '';
    // 「辅导时间：」这个标签**由模板自己带**（模板 R4 那一格是「辅导时间：{{period}}」），
    // 所以这里只填时间值本身。⚠ 早期版本在这里又拼了一次 '辅导时间：'，
    // 导致导出成「辅导时间：辅导时间：春季（3–6 月）」—— 别再拼。
    d.period = p.period || '';
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
   * @param {object} opts { template: MathPlanTemplateData }
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
      warnings.push('课表行数 ' + rows.length + ' 超过上限 ' + MAX_ROWS + '，已截断');
      rows = rows.slice(0, MAX_ROWS);
    }
    if (!rows.length) warnings.push('课表为空，逐次课表将没有内容行');

    T.reset();
    const doc0 = T.getText('word/document.xml');

    // 1) 先按行数增删样板行（此时 document.xml 里还是 {{sN_xx}}）
    const fit = fitLessonRows(doc0, rows.length);
    if (!fit.ok) warnings.push('未能定位逐次课表样板行：' + (fit.reason || '未知原因'));
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
    roundsSentence: roundsSentence,
    textOf: textOf,
    xmlEsc: xmlEsc,
    ROW_FIELDS: ROW_FIELDS,
    MAX_ROWS: MAX_ROWS,
  };
}));
