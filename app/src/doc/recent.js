'use strict';
/**
 * 文档侧的"找得到"：
 *   1. 最近导入过的文档
 *   2. 项目文件夹里的 .md / .txt / 源代码
 *
 * 跟对话那边同一个思路：不给一个要靠肉眼认的文件框，给一份有名字、有来路的清单。
 *
 * 这一层只懂「文档」：项目目录从哪儿来是别人决定的，
 * 由 main.js 把会话日志里推出来的目录递进来（doc 不反过来依赖 conv）。
 */

const fs = require('fs');
const path = require('path');
const { readSettings, writeSettings } = require('../settings');

/**
 * 能导入的文件类型。
 * 除了文档（.txt / .md / .markdown），也收源代码 —— 5 种主流的：
 * Python 和 JS/TS 家族。要加别的类型就往这个集合里加。
 */
const DOC_EXT = new Set([
  '.txt', '.md', '.markdown',
  '.py', '.js', '.ts', '.tsx', '.jsx',
]);
const MAX_RECENT = 12;
const MAX_PER_DIR = 40;
const MAX_DIRS = 8;

/** 最近导入过的文档 */
function recentDocs() {
  const s = readSettings();
  return Array.isArray(s.recentDocs) ? s.recentDocs : [];
}

/** 记一笔：导入过就记住，下次能直接找到 */
function rememberDoc(doc) {
  if (!doc || !doc.path) return recentDocs();
  const list = recentDocs().filter((d) => d.path !== doc.path);
  list.unshift({
    path: doc.path,
    name: doc.name || path.basename(doc.path),
    at: Date.now(),
  });
  const next = list.slice(0, MAX_RECENT);
  writeSettings({ recentDocs: next });
  return next;
}

/**
 * 项目文件夹里的文档
 * @param {Array<{cwd:string, mtime:number}>} dirs 项目目录（从哪来的由调用方决定）
 */
function docsInProjects(dirs) {
  const groups = [];
  for (const d of (dirs || []).slice(0, MAX_DIRS)) {
    let entries;
    try {
      entries = fs.readdirSync(d.cwd, { withFileTypes: true });
    } catch (_) {
      continue;
    }
    const items = [];
    for (const e of entries) {
      if (!e.isFile()) continue;
      const ext = path.extname(e.name).toLowerCase();
      if (!DOC_EXT.has(ext)) continue;
      const full = path.join(d.cwd, e.name);
      let st;
      try {
        st = fs.statSync(full);
      } catch (_) {
        continue;
      }
      items.push({ path: full, name: e.name, mtime: st.mtimeMs, size: st.size });
    }
    if (!items.length) continue;
    items.sort((a, b) => b.mtime - a.mtime);
    groups.push({ dir: d.cwd, at: d.mtime, items: items.slice(0, MAX_PER_DIR) });
  }
  return groups;
}

/**
 * 给选择器用的完整清单
 * @param {Array<{cwd:string, mtime:number}>} dirs 项目目录
 */
function listDocCandidates(dirs) {
  return {
    recent: recentDocs(),
    projects: docsInProjects(dirs),
  };
}

module.exports = { recentDocs, rememberDoc, docsInProjects, listDocCandidates, DOC_EXT };
