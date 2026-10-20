/**
 * 全学科试卷分析 · 科目清单
 * 加学科：在 SUBJECTS 里加一行，并新建 subjects/<key>.js（两份学段包）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PaperV2Manifest = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  return {
    subjects: [
      { key: 'math', name: '数学', stages: [{ key: 'senior', name: '高中' }, { key: 'junior', name: '初中' }] },
      { key: 'physics', name: '物理', stages: [{ key: 'senior', name: '高中' }, { key: 'junior', name: '初中' }] },
      { key: 'english', name: '英语', stages: [{ key: 'senior', name: '高中' }, { key: 'junior', name: '初中' }] },
      { key: 'chinese', name: '语文', stages: [{ key: 'senior', name: '高中' }, { key: 'junior', name: '初中' }] },
    ],
  };
}));
