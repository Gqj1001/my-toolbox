# -*- coding: utf-8 -*-
"""把三个公司模板的零件内嵌成 JS 数据文件（与现有 js/template-data.js 同一形状）。

为什么要这一步：浏览器里"以模板为底只替换文字"需要拿到 document.xml 的明文，
又要能把改动后的零件重新打包。现有两个工具的做法是**构建期**把零件 base64 内嵌
（`js/template-data.js`，见它的文件头），运行期只做字符串替换 + `DocxBuilder.zip`。
这里沿用同一套，**不引任何第三方库、离线也能用**。

用法：
  python scripts/build-company-template.py [模板目录] [输出文件]
"""
import base64
import io
import json
import os
import sys
import zipfile

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TPL_DIR = sys.argv[1] if len(sys.argv) > 1 else os.path.join(REPO, "docs", "company-template")
OUT_JS = sys.argv[2] if len(sys.argv) > 2 else os.path.join(
    REPO, "public", "tools", "company-template", "template-data.js")

ATTACHMENTS = ["附件1", "附件2", "附件3"]


def read_parts(path):
    """按 zip 内顺序读出所有零件（目录条目跳过）"""
    parts = []
    with zipfile.ZipFile(path) as z:
        for info in z.infolist():
            if info.is_dir():
                continue
            parts.append((info.filename, z.read(info.filename)))
    return parts


def js_string(s):
    return json.dumps(s, ensure_ascii=False)


def main():
    blocks = []
    for name in ATTACHMENTS:
        p = os.path.join(TPL_DIR, name + ".docx")
        if not os.path.exists(p):
            raise SystemExit("找不到模板：%s（先跑 scripts/split-company-template.py）" % p)
        parts = read_parts(p)
        order = [n for n, _ in parts]
        b64 = {n: base64.b64encode(d).decode("ascii") for n, d in parts}
        lines = []
        lines.append('    %s: {' % js_string(name))
        lines.append('      ORDER: %s,' % json.dumps(order, ensure_ascii=False))
        lines.append('      B64: {')
        for i, n in enumerate(order):
            lines.append('        %s: %s%s' % (js_string(n), js_string(b64[n]),
                                              "" if i == len(order) - 1 else ","))
        lines.append('      }')
        lines.append('    }' + ("" if name == ATTACHMENTS[-1] else ","))
        blocks.append("\n".join(lines))

    js = '''/**
 * 自动生成，请勿手改！
 * 来源：docs/company-template/{附件1,附件2,附件3}.docx
 *      （由 scripts/split-company-template.py 从公司原件「辅导计划及试卷分析模板.docx」切分，
 *        styles/theme/sectPr 原样保留 ⇒ 字体、表格线、合并格、行高与公司模板一致）
 * 重新生成：python scripts/build-company-template.py
 *
 * 把模板的所有零件以 base64 内嵌，浏览器无需解压即可直接用；
 * 文本类零件（.xml/.rels）另给明文缓存，便于按格替换后重新打包。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CompanyTemplateData = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var T = {
%s
  };

  var TEXT = {};                 // 明文缓存 { 附件: { 零件名: 字符串 } }
  function isText(n) { return /\\.(xml|rels)$/i.test(n); }

  function b64ToBytes(b64) {
    if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(b64, 'base64'));
    var bin = atob(b64), out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function utf8Decode(u8) {
    if (typeof TextDecoder !== 'undefined') return new TextDecoder('utf-8').decode(u8);
    return Buffer.from(u8).toString('utf8');
  }
  function utf8Encode(s) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s);
    return new Uint8Array(Buffer.from(s, 'utf8'));
  }
  function pack(att) {
    if (!T[att]) throw new Error('没有这个附件模板：' + att);
    return T[att];
  }

  /** 取某附件某零件的明文（仅文本类零件） */
  function getText(att, name) {
    var t = pack(att);
    TEXT[att] = TEXT[att] || {};
    if (TEXT[att][name] != null) return TEXT[att][name];
    if (!t.B64[name]) throw new Error(att + ' 模板里没有零件：' + name);
    TEXT[att][name] = utf8Decode(b64ToBytes(t.B64[name]));
    return TEXT[att][name];
  }
  function getBytes(att, name) {
    var t = pack(att);
    if (t.B64[name] == null) throw new Error(att + ' 模板里没有零件：' + name);
    return b64ToBytes(t.B64[name]);
  }
  /** 覆盖某零件明文（不改模块状态，交给 collect 传 overrides） */
  function setText(att, name, s) {
    TEXT[att] = TEXT[att] || {};
    TEXT[att][name] = s;
  }
  function reset(att) { if (att) delete TEXT[att]; else TEXT = {}; }

  /**
   * 组装出最终零件表 [{name, data:Uint8Array}]
   * @param att 附件名
   * @param overrides 本次要覆盖的零件 {零件名: 明文}
   */
  function collect(att, overrides) {
    var t = pack(att);
    overrides = overrides || {};
    var files = [];
    t.ORDER.forEach(function (n) {
      var data;
      if (overrides[n] != null) data = utf8Encode(overrides[n]);
      else if (TEXT[att] && TEXT[att][n] != null) data = utf8Encode(TEXT[att][n]);
      else data = b64ToBytes(t.B64[n]);
      files.push({ name: n, data: data });
    });
    return files;
  }

  return { ATTACHMENTS: %s, ORDER: function (att) { return pack(att).ORDER.slice(); },
           getText: getText, setText: setText, getBytes: getBytes, reset: reset,
           collect: collect, isText: isText };
}));
''' % ("\n".join(blocks), json.dumps(ATTACHMENTS, ensure_ascii=False))

    os.makedirs(os.path.dirname(OUT_JS), exist_ok=True)
    with io.open(OUT_JS, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(js)
    print("已生成 %s（%.1f KB）" % (OUT_JS, os.path.getsize(OUT_JS) / 1024.0))
    for name in ATTACHMENTS:
        parts = read_parts(os.path.join(TPL_DIR, name + ".docx"))
        print("  %s: %d 个零件（document.xml %.1f KB）"
              % (name, len(parts),
                 len(dict(parts)["word/document.xml"]) / 1024.0))


if __name__ == "__main__":
    main()
