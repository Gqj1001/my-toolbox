/**
 * 真·DOCX 生成器（零依赖，浏览器/Node 通用）
 * ------------------------------------------------------------------
 * 直接拼 OOXML + 自造 ZIP（STORE 方式不压缩，Word 完全接受），
 * 从而在浏览器里就能生成带真实表格的 .docx，不需要任何第三方库、不需要服务器。
 *
 * 输出的表结构对齐老师的《-试卷分析 .docx》模板：
 *   标题「锐满分教育试卷分析表」+「学员基本信息」
 *   表1  学员基本信息（3 行）
 *   表2  试卷分析（含内嵌「题型分布」6 列子表 + 「错题分析」7 列子表）
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DocxBuilder = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ============================ ZIP（STORE） ============================ */
  const CRC_TABLE = (function(){
    const t = new Uint32Array(256);
    for(let n = 0; n < 256; n++){
      let c = n;
      for(let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes){
    let c = 0xFFFFFFFF;
    for(let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  function utf8(str){
    if(typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str);
    return new Uint8Array(Buffer.from(str, 'utf8'));
  }
  /** 生成 ZIP（不压缩）。files: [{name, data:Uint8Array}] */
  function zip(files){
    const chunks = [], central = [];
    let offset = 0;
    const u16 = n => [n & 0xFF, (n >>> 8) & 0xFF];
    const u32 = n => [n & 0xFF, (n >>> 8) & 0xFF, (n >>> 16) & 0xFF, (n >>> 24) & 0xFF];

    files.forEach(f => {
      const nameBytes = utf8(f.name);
      const crc = crc32(f.data);
      const size = f.data.length;
      const local = [].concat(
        u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(0), u16(0),
        u32(crc), u32(size), u32(size), u16(nameBytes.length), u16(0)
      );
      chunks.push(new Uint8Array(local), nameBytes, f.data);
      central.push({ nameBytes, crc, size, offset });
      offset += local.length + nameBytes.length + size;
    });

    const cdStart = offset;
    central.forEach(e => {
      const hdr = [].concat(
        u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0), u16(0), u16(0),
        u32(e.crc), u32(e.size), u32(e.size),
        u16(e.nameBytes.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(e.offset)
      );
      chunks.push(new Uint8Array(hdr), e.nameBytes);
      offset += hdr.length + e.nameBytes.length;
    });
    const eocd = [].concat(
      u32(0x06054b50), u16(0), u16(0),
      u16(central.length), u16(central.length),
      u32(offset - cdStart), u32(cdStart), u16(0)
    );
    chunks.push(new Uint8Array(eocd));

    let total = 0; chunks.forEach(c => total += c.length);
    const out = new Uint8Array(total);
    let p = 0; chunks.forEach(c => { out.set(c, p); p += c.length; });
    return out;
  }

  /* ============================ OOXML 片段 ============================ */
  const esc = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
    // 去掉 XML 非法字符（控制字符），否则 Word 会报文档损坏
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

  const PAGE_W = 11906, PAGE_H = 16838;      // A4 纵向（twips）
  const MARGIN = 720;                         // 上下左右 1.27cm（Word 常见默认值）
  /* 可用宽度 = 11906 - 720*2 = 10466 twips */

  /** 单元格左右边框 */
  function borders(align){
    const b = c => `<w:${c} w:val="single" w:sz="4" w:space="0" w:color="808080"/>`;
    return `<w:tcBorders>${b('top')}${b('left')}${b('bottom')}${b('right')}</w:tcBorders>`;
  }

  /**
   * 造一个单元格
   * @param {string} text 文本（\n 会变成换行）
   * @param {object} o {w 宽度twips, span 横向合并数, bold 加粗, size 字号(pt), align 对齐, shade 底纹, valign}
   */
  function tc(text, o){
    o = o || {};
    const sz = o.size || 10;                 // pt
    const half = Math.round(sz * 2);         // half-points
    const al = o.align || 'left';
    const lines = String(text == null ? '' : text).split('\n');
    const runs = lines.map((ln, i) =>
      (i > 0 ? '<w:r><w:br/></w:r>' : '') +
      `<w:r><w:rPr>${o.bold ? '<w:b/>' : ''}<w:sz w:val="${half}"/><w:szCs w:val="${half}"/></w:rPr>` +
      `<w:t xml:space="preserve">${esc(ln)}</w:t></w:r>`
    ).join('');
    const w = o.w ? `<w:tcW w:w="${o.w}" w:type="dxa"/>` : '';
    const span = o.span && o.span > 1 ? `<w:gridSpan w:val="${o.span}"/>` : '';
    const shd = o.shade ? `<w:shd w:val="clear" w:color="auto" w:fill="${o.shade}"/>` : '';
    const va = `<w:vAlign w:val="${o.valign || 'center'}"/>`;
    return `<w:tc><w:tcPr>${w}${span}${shd}${borders()}${va}</w:tcPr>`
      + `<w:p><w:pPr><w:jc w:val="${al}"/>`
      + `<w:spacing w:before="10" w:after="10" w:line="240" w:lineRule="auto"/>`
      + `<w:rPr><w:sz w:val="${half}"/></w:rPr></w:pPr>${runs}</w:p></w:tc>`;
  }

  function tr(cells, o){
    o = o || {};
    const h = o.h ? `<w:trHeight w:val="${o.h}" w:hRule="atLeast"/>` : '';
    const hdr = o.header ? '<w:tblHeader/>' : '';
    return `<w:tr><w:trPr>${h}${hdr}</w:trPr>${cells.join('')}</w:tr>`;
  }

  /** 表格：widths 为各列宽度（twips），rows 为二维数组 */
  function table(rows, widths, o){
    o = o || {};
    const grid = `<w:tblGrid>${widths.map(w => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>`;
    const total = widths.reduce((a, b) => a + b, 0);
    const bd = c => `<w:${c} w:val="single" w:sz="4" w:space="0" w:color="808080"/>`;
    const bordersXml = `<w:tblBorders>${bd('top')}${bd('left')}${bd('bottom')}${bd('right')}${bd('insideH')}${bd('insideV')}</w:tblBorders>`;
    return `<w:tbl><w:tblPr>`
      + `<w:tblW w:w="${total}" w:type="dxa"/>`
      + `<w:jc w:val="${o.align || 'center'}"/>`
      + bordersXml
      + `<w:tblLayout w:type="fixed"/>`
      + `<w:tblCellMar><w:top w:w="20" w:type="dxa"/><w:left w:w="60" w:type="dxa"/>`
      + `<w:bottom w:w="20" w:type="dxa"/><w:right w:w="60" w:type="dxa"/></w:tblCellMar>`
      + `</w:tblPr>${grid}`
      + rows.map(r => tr(r.cells, r.opts)).join('')
      + `</w:tbl>`;
  }

  function p(text, o){
    o = o || {};
    const sz = Math.round((o.size || 10.5) * 2);
    const lines = String(text == null ? '' : text).split('\n');
    const runs = lines.map((ln, i) =>
      (i > 0 ? '<w:r><w:br/></w:r>' : '') +
      `<w:r><w:rPr>${o.bold ? '<w:b/>' : ''}<w:sz w:val="${sz}"/><w:szCs w:val="${sz}"/>` +
      `${o.color ? `<w:color w:val="${o.color}"/>` : ''}</w:rPr>` +
      `<w:t xml:space="preserve">${esc(ln)}</w:t></w:r>`
    ).join('');
    return `<w:p><w:pPr><w:jc w:val="${o.align || 'left'}"/>`
      + `<w:spacing w:before="${o.before == null ? 40 : o.before}" w:after="${o.after == null ? 40 : o.after}" `
      + `w:line="${o.line || 300}" w:lineRule="auto"/></w:pPr>${runs}</w:p>`;
  }

  /* ============================ 文档生成 ============================ */
  const CONTENT_TYPES =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    + '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
    + '</Types>';

  const RELS =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
    + '</Relationships>';

  const DOC_RELS =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
    + '</Relationships>';

  const STYLES =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
    + '<w:docDefaults><w:rPrDefault><w:rPr>'
    + '<w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="宋体"/>'
    + '<w:sz w:val="21"/><w:szCs w:val="21"/>'
    + '</w:rPr></w:rPrDefault><w:pPrDefault><w:pPr>'
    + '<w:spacing w:line="300" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>'
    + '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>'
    + '<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/></w:style>'
    + '</w:styles>';

  /**
   * 生成 docx 二进制
   * @param {string} bodyXml 文档正文（段落 + 表格的 XML 序列）
   * @returns {Uint8Array}
   */
  function build(bodyXml){
    const sectPr = `<w:sectPr>`
      + `<w:pgSz w:w="${PAGE_W}" w:h="${PAGE_H}"/>`
      + `<w:pgMar w:top="${MARGIN}" w:right="${MARGIN}" w:bottom="${MARGIN}" w:left="${MARGIN}" `
      + `w:header="720" w:footer="720" w:gutter="0"/>`
      + `</w:sectPr>`;
    const doc = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" '
      + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
      + `<w:body>${bodyXml}${sectPr}</w:body></w:document>`;
    return zip([
      { name: '[Content_Types].xml',   data: utf8(CONTENT_TYPES) },
      { name: '_rels/.rels',           data: utf8(RELS) },
      { name: 'word/document.xml',     data: utf8(doc) },
      { name: 'word/_rels/document.xml.rels', data: utf8(DOC_RELS) },
      { name: 'word/styles.xml',       data: utf8(STYLES) }
    ]);
  }

  return { build, zip, crc32, utf8, esc,
           tc, tr, table, p,
           PAGE_W, PAGE_H, MARGIN };
}));
