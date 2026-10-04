/**
 * 模板化 DOCX 导出（读模板 → 替换占位符 → 重新打包）
 * ==================================================================
 * 设计原则
 *   ① 完全不碰格式：整份 document.xml 都来自 Word 模板，程序只把
 *      {{占位符}} 换成文字，绝不新增/修改任何 tcPr、tblPr、rPr、trHeight。
 *   ② 只改文字，不改结构：替换时保留原有 <w:p>/<w:r> 的 rPr（字体、字号、
 *      边框、底纹、对齐全部沿用模板），只在必要时新增 <w:r>（沿用同一 rPr）。
 *   ③ 动态行：错题分析按实际题数增删 <w:tr>；新增行是「复制模板里的行」，
 *      因此 trHeight 等属性与模板原值完全一致；行少就真矮下来，不做高度补偿。
 *
 * 占位符清单（共 263 个，见 template-data.js 的 PLACEHOLDERS）
 *   表1 学员基本信息：name sex school grade mgr teacher subject tscore
 *   表2 试卷信息：eyr emo edy exname exsubject exdur extotal exscore
 *                 exdiff exqual exsrc exam_scope teaching_content
 *                 progress_points
 *   表2 题型分布：t1..t6 × nm ct df tl gt          （6 行固定）
 *   表2 错题分析：q1..q30 × sn tp vl sc df kp rs   （按题数动态增删）
 *   表2 建议段：advice
 *
 * 注意：模板里「班级」是标签 + 空格子（无占位符），默认留白；
 *       勾选后由 fill 选项 class 传入才会写入。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./docx-builder.js'),
                             (function(){ try { return require('./template-data.js'); } catch(e){ return null; } })());
  } else {
    root.ReportTemplate = factory(root.DocxBuilder, root.TemplateData);
  }
}(typeof self !== 'undefined' ? self : this, function (D, TPL) {
  'use strict';

  const PH_RE = /\{\{\s*([^{}]+?)\s*\}\}/g;

  /* ============================ 小工具 ============================ */
  const esc = D.esc;
  const num = x => { const v = parseFloat(x); return isNaN(v) ? 0 : v; };
  const r2  = x => Math.round(num(x) * 100) / 100;

  /** 把值转成"给人看"的字符串：整数不带小数点 */
  function fmt(v) {
    if (v == null || v === '') return '';
    if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100);
    return String(v);
  }

  /**
   * 从 XML 片段里取纯文本（含实体反转义）
   * `<w:t>` 的文本 + `<w:br/>` 记为 \n
   */
  function textOf(xml) {
    let out = '';
    const re = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:br\s*\/>|<w:tab\s*\/>/g;
    let m;
    while ((m = re.exec(xml))) {
      if (m[1] !== undefined) {
        out += m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>')
                    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
                    .replace(/&amp;/g, '&');
      } else if (m[0].indexOf('<w:br') === 0) out += '\n';
      else out += '\t';
    }
    return out;
  }

  /** 该段落里出现的占位符键名 */
  function keysIn(paragraphXml) {
    const keys = [];
    let m;
    PH_RE.lastIndex = 0;
    const t = textOf(paragraphXml);
    while ((m = PH_RE.exec(t))) keys.push(m[1]);
    return keys;
  }

  /**
   * 替换一个段落里的所有占位符
   *  · 第一个占位符的值写进模板原有的第一个 <w:r>（沿用它的 rPr）
   *  · 其余占位符按需新建 <w:r>，克隆同一份 rPr
   *  · 占位符之间的固定文字原样保留
   *  · 段落里的换行（\n）→ 若模板有多个 <w:p> 就分段落，否则用 <w:br/>
   * @param {string} pXml  单个 <w:p> 的 XML
   * @param {object} data  键→值
   * @returns {string}
   */
  function replaceInParagraph(pXml, data) {
    const full = textOf(pXml);
    if (full.indexOf('{{') < 0) return pXml;      // 没有占位符，原样返回

    // 切段：把文本按 {{key}} 切成 [静态, 占位, 静态, …]
    const segs = [];
    let last = 0, m;
    PH_RE.lastIndex = 0;
    while ((m = PH_RE.exec(full))) {
      if (m.index > last) segs.push({ t: 'static', v: full.slice(last, m.index) });
      segs.push({ t: 'ph', k: m[1] });
      last = m.index + m[0].length;
    }
    if (last < full.length) segs.push({ t: 'static', v: full.slice(last) });

    // 取出模板段落里的所有 <w:r>，作为"样板 run"
    const runs = pXml.match(/<w:r(?:\s[^>]*)?>[\s\S]*?<\/w:r>|<w:r(?:\s[^>]*)?\/>/g) || [];
    if (!runs.length) return pXml;                 // 没有 run，不动
    // 选第一个含 <w:t> 的 run 作为样板（它的 rPr 就是模板的字体设置）
    let sampleRun = null;
    for (const r of runs) { if (/<w:t[\s>]/.test(r)) { sampleRun = r; break; } }
    if (!sampleRun) sampleRun = runs[0];
    const rPrMatch = sampleRun.match(/<w:rPr>[\s\S]*?<\/w:rPr>/);
    const rPr = rPrMatch ? rPrMatch[0] : '';
    const runOpenMatch = sampleRun.match(/^<w:r(?:\s[^>]*)?>/);
    const runOpen = runOpenMatch ? runOpenMatch[0] : '<w:r>';

    /** 造一个 run，text 里的 \n 变 <w:br/> */
    function mkRun(text) {
      const parts = String(text).split('\n');
      let inner = '';
      parts.forEach((ln, i) => {
        if (i > 0) inner += '<w:br/>';
        if (ln !== '') inner += `<w:t xml:space="preserve">${esc(ln)}</w:t>`;
      });
      return runOpen + rPr + inner + '</w:r>';
    }

    // 把段落的 <w:pPr> 保留，其余内容替换成新 run 序列
    const pPrMatch = pXml.match(/<w:pPr>[\s\S]*?<\/w:pPr>/);
    const pPr = pPrMatch ? pPrMatch[0] : '';
    const pOpenMatch = pXml.match(/^<w:p(?:\s[^>]*)?>/);
    const pOpen = pOpenMatch ? pOpenMatch[0] : '<w:p>';

    let inner = '';
    segs.forEach(s => {
      if (s.t === 'static') { if (s.v) inner += mkRun(s.v); }
      else { const v = data[s.k]; inner += mkRun(v == null ? '' : v); }
    });

    return pOpen + pPr + inner + '</w:p>';
  }

  /**
   * 替换一个单元格里的所有段落
   * 值里的 \n 按模板段落数分流：模板有 N 个段落就用前 N 个，多出的另加段落
   */
  function replaceInCell(tcXml, data) {
    if (tcXml.indexOf('{{') < 0) return tcXml;
    const paras = tcXml.match(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>|<w:p(?:\s[^>]*)?\/>/g);
    if (!paras || !paras.length) return tcXml;

    // 该单元格涉及的键（按出现顺序）
    const keys = [];
    paras.forEach(p => keysIn(p).forEach(k => { if (keys.indexOf(k) < 0) keys.push(k); }));
    if (!keys.length) return tcXml;

    // 只有一个键、且段落数 > 1 → 值用 \n 拆开后一个段落放一段
    if (keys.length === 1 && paras.length > 1) {
      const k = keys[0];
      const v = data[k] == null ? '' : String(data[k]);
      const lines = v.split('\n');
      let out;
      if (lines.length <= paras.length) {
        out = paras.map((p, i) => replaceInParagraph(p, { [k]: lines[i] == null ? '' : lines[i] })).join('');
      } else {
        // 行数超出模板段落数：前面的段落各放一段，最后一段承接剩余（内部用 <w:br/>）
        const head = paras.slice(0, -1);
        const tailLines = lines.slice(head.length);
        out = head.map((p, i) => replaceInParagraph(p, { [k]: lines[i] })).join('')
            + replaceInParagraph(paras[paras.length - 1], { [k]: tailLines.join('\n') });
      }
      // 需要时补足段落（保持与模板同样的 pPr）
      return tcXml.replace(paras.join(''), out);
    }

    // 常规：逐段落替换
    let out = tcXml;
    paras.forEach(p => { out = out.replace(p, replaceInParagraph(p, data)); });
    return out;
  }

  /**
   * 在整段 XML 里替换所有占位符（表1 / 表2 都能用）
   * 做法：逐表格 → 逐行 → 逐格，只替换单元格内段落，避免误伤 tblPr
   */
  function replaceAll(xml, data) {
    return xml.replace(/<w:tbl>[\s\S]*?<\/w:tbl>/g, tbl => {
      return tbl.replace(/<w:tr(?:\s[^>]*)?>[\s\S]*?<\/w:tr>/g, row => {
        return row.replace(/<w:tc>[\s\S]*?<\/w:tc>/g, tc => replaceInCell(tc, data));
      });
    });
  }

  /* ==================== 错题分析：动态增删行 ==================== */
  /**
   * 找到「错题分析」表头行与它的数据行（含 {{qN...}}）
   * @returns {{headIdx:number, rows:string[], rowStart:number, rowEnd:number}|null}
   */
  function locateQuestionRows(tableXml) {
    const rows = tableXml.match(/<w:tr(?:\s[^>]*)?>[\s\S]*?<\/w:tr>/g) || [];
    let start = -1;
    for (let i = 0; i < rows.length; i++) {
      const t = textOf(rows[i]);
      if (t.indexOf('失分情况及原因分析') >= 0 && t.indexOf('题号') >= 0) { start = i + 1; break; }
    }
    if (start < 0) {
      // 退而求其次：找第一行含 q1 的
      for (let i = 0; i < rows.length; i++) {
        if (/\{\{\s*q1[a-z]+\s*\}\}/.test(rows[i])) { start = i; break; }
      }
    }
    if (start < 0) return null;
    let end = start;
    while (end < rows.length && /\{\{\s*q\d+[a-z]+\s*\}\}/.test(rows[end])) end++;
    if (end === start) return null;
    return { rows, rowStart: start, rowEnd: end };
  }

  /**
   * 按实际题数增删错题行
   *  · 多了：复制最后一行（连 trHeight 一起复制，格式与模板一致）
   *  · 少了：删掉多余行
   *  · 然后把 qN 的编号重排成 1..N
   * @param {string} tableXml
   * @param {number} count 实际题目数
   */
  function fitQuestionRows(tableXml, count) {
    const loc = locateQuestionRows(tableXml);
    if (!loc) return { xml: tableXml, ok: false, reason: '没找到错题分析的数据行' };
    const { rows, rowStart, rowEnd } = loc;
    const have = rowEnd - rowStart;
    const orig = rows.slice();
    let dataRows = orig.slice(rowStart, rowEnd);

    if (count > have) {
      const last = dataRows[dataRows.length - 1];
      for (let i = have; i < count; i++) dataRows.push(last);
    } else if (count < have) {
      dataRows = dataRows.slice(0, count);
    }

    // 重新编号：把 {{qK...}} 改成 {{q(i+1)...}}
    dataRows = dataRows.map((r, i) =>
      r.replace(/\{\{\s*q\d+([a-z]+)\s*\}\}/g, (mm, suf) => `{{q${i + 1}${suf}}}`));

    const merged = orig.slice(0, rowStart).concat(dataRows, orig.slice(rowEnd));
    return { xml: tableXml.replace(orig.join(''), merged.join('')), ok: true, count: dataRows.length };
  }

  /* ============================ 数据装配 ============================ */
  /**
   * 把 ctx 转成 键→值 的表
   * @param {object} ctx 与旧版一致，外加 records / typeSummary / questionRows
   */
  function buildMap(ctx) {
    const d = {};
    const paper = ctx.paper || {};

    /* --- 表1 学员基本信息 --- */
    d.name    = ctx.name || '';
    d.sex     = ctx.gender || '';
    d.school  = ctx.school || '';
    d.grade   = ctx.grade || '';
    d.mgr     = ctx.manager || '';
    d.teacher = ctx.teacher || '郭庆杰';
    d.subject = ctx.subject || '数学';
    d.tscore  = fmt(r2(ctx.score));

    /* --- 表2 试卷信息 --- */
    const dt = parseExamDate(ctx.examDate);
    d.eyr = dt.y; d.emo = dt.m; d.edy = dt.d;
    d.exname    = ctx.examName || '';
    d.exsubject = ctx.exsubject || ctx.subject || '数学';
    d.exdur     = ctx.duration || '120min';
    d.extotal   = fmt(r2(ctx.full) || 150);
    d.exscore   = fmt(r2(ctx.score));
    d.exdiff    = paper.overallDifficulty || ctx.exdiff || '中等';
    d.exqual    = ctx.exqual || '';      // 老师手填 → 默认留白
    d.exsrc     = ctx.exsrc  || '';      // 老师手填 → 默认留白
    d.exam_scope        = ctx.examScope || ((paper.scope || []).join('，') || '');
    d.teaching_content  = ctx.taughtContent || '';
    d.progress_points   = ctx.progress || '';

    /* --- 表2 题型分布（固定 6 行，不足留白） --- */
    const ts = ctx.typeSummary || [];
    for (let i = 1; i <= 6; i++) {
      const t = ts[i - 1];
      d['t' + i + 'nm'] = t ? t.type : '';
      d['t' + i + 'ct'] = t ? fmt(t.n) : '';
      d['t' + i + 'df'] = t ? (paper.overallDifficulty || '中等') : '';
      d['t' + i + 'tl'] = t ? fmt(r2(t.full)) : '';
      d['t' + i + 'gt'] = t ? fmt(r2(t.got)) : '';
    }

    /* --- 表2 错题分析（先按 30 行给值，行数调整后再按实际编号取） --- */
    const qr = ctx.questionRows || [];
    for (let i = 1; i <= Math.max(30, qr.length); i++) {
      const r = qr[i - 1];
      d['q' + i + 'sn'] = r ? fmt(r.no) : '';
      d['q' + i + 'tp'] = r ? (r.type || '') : '';
      d['q' + i + 'vl'] = r ? fmt(r2(r.full)) : '';
      d['q' + i + 'sc'] = r ? fmt(r2(r.got)) : '';
      d['q' + i + 'df'] = r ? (r.difficulty || '') : '';
      d['q' + i + 'kp'] = r ? (r.knowledge || '') : '';
      d['q' + i + 'rs'] = r ? (r.reason || '') : '';
    }

    /* --- 表2 建议段 --- */
    d.advice = ctx.advice || '';

    /* --- 班级：默认留白，勾选后才填 --- */
    if (ctx.fillClass && ctx.className) d.__class = ctx.className;

    return d;
  }

  /** 从「2026 年 10 月 15 日」之类的文本里抠出年月日 */
  function parseExamDate(s) {
    const t = String(s || '');
    const ym = t.match(/(\d{4})\s*年/);
    const mm = t.match(/(\d{1,2})\s*月/);
    const dm = t.match(/(\d{1,2})\s*日/);
    return {
      y: ym ? ym[1] : '',
      m: mm ? mm[1] : '',
      d: dm ? dm[1] : ''
    };
  }

  /* ============================ 主流程 ============================ */
  /**
   * 生成 docx
   * @param {object} ctx
   * @param {object} [opts] { template: TemplateData 替代品 }
   * @returns {{blob:Uint8Array|Buffer, warnings:string[], questionRows:number}}
   */
  function build(ctx, opts) {
    opts = opts || {};
    const T = opts.template || TPL;
    if (!T) throw new Error('模板数据未加载（缺 js/template-data.js）');

    const warnings = [];
    const doc0 = T.getText('word/document.xml');
    const map = buildMap(ctx);

    // 1) 错题分析行数对齐
    let doc1 = doc0;
    const qcount = (ctx.questionRows || []).length;
    doc1 = doc1.replace(/<w:tbl>[\s\S]*?<\/w:tbl>/g, tbl => {
      if (tbl.indexOf('失分情况及原因分析') < 0) return tbl;
      const r = fitQuestionRows(tbl, qcount);
      if (!r.ok) warnings.push(r.reason);
      return r.xml;
    });

    // 2) 替换占位符
    let doc2 = replaceAll(doc1, map);

    // 3) 班级：把「班级」标签后面那个空格子填上
    if (map.__class) doc2 = fillClassCell(doc2, map.__class);

    // 4) 检查是否还有残留占位符
    const left = doc2.match(/\{\{\s*[^{}]+?\s*\}\}/g);
    if (left && left.length) {
      const uniq = Array.from(new Set(left)).slice(0, 8);
      warnings.push('仍有未替换的占位符：' + uniq.join('、') + (left.length > 8 ? ' 等' : ''));
    }

    // 5) 重新打包：除 document.xml 外全部原样（图片等二进制逐字节保留）
    //    用 collect(overrides) 覆盖，不写回模板状态 → 可反复导出且互不影响
    const files = T.collect({ 'word/document.xml': doc2 });
    const bytes = D.zip(files);

    return { blob: bytes, warnings, questionRows: qcount, placeholders: T.PLACEHOLDERS ? T.PLACEHOLDERS.length : 0 };
  }

  /**
   * 填「班级」那个空格子：定位含「班级」的单元格，取它后面那格的第一个段落写入
   * 只改 <w:t>，不动格式
   */
  function fillClassCell(xml, value) {
    return xml.replace(/<w:tr(?:\s[^>]*)?>[\s\S]*?<\/w:tr>/g, row => {
      if (row.indexOf('班级') < 0) return row;
      const cells = row.match(/<w:tc>[\s\S]*?<\/w:tc>/g);
      if (!cells || cells.length < 2) return row;
      for (let i = 0; i < cells.length; i++) {
        if (textOf(cells[i]).trim() === '班级' && cells[i + 1]) {
          const tgt = cells[i + 1];
          // 若这格已有占位符则交给 replaceAll 处理，这里只处理空格子
          if (tgt.indexOf('{{') >= 0) return row;
          const filled = tgt.replace(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/, p => {
            const pPrM = p.match(/<w:pPr>[\s\S]*?<\/w:pPr>/);
            const pPr = pPrM ? pPrM[0] : '';
            const pOpenM = p.match(/^<w:p(?:\s[^>]*)?>/);
            const pOpen = pOpenM ? pOpenM[0] : '<w:p>';
            // 借用同行其它格（含 run）的 rPr，保证字体一致
            let rPr = '';
            for (let k = 0; k < cells.length; k++) {
              const rm = cells[k].match(/<w:rPr>[\s\S]*?<\/w:rPr>/);
              if (rm) { rPr = rm[0]; break; }
            }
            return pOpen + pPr + `<w:r>${rPr}<w:t xml:space="preserve">${esc(value)}</w:t></w:r>` + '</w:p>';
          });
          const out = row.replace(cells[i + 1], filled);
          return out;
        }
      }
      return row;
    });
  }

  return {
    build, buildMap, replaceAll, replaceInCell, replaceInParagraph,
    fitQuestionRows, locateQuestionRows, parseExamDate, textOf, keysIn, fillClassCell
  };
}));
