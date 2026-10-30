'use strict';
/**
 * 扫描 ~/.claude/projects 下的会话日志，提取"这是哪一次对话"的可读信息
 *
 * 日志文件名是 UUID，光看文件名认不出谁是谁。但日志里有：
 *   type:"ai-title"    → Claude 自动生成的标题（如「双面板滚动UI-Demo 文档导入」）
 *   cwd                 → 项目目录
 *   第一条人写的消息     → 首句提示词
 * 再加上文件修改时间，足够认人。
 *
 * 只读文件开头一段（256KB），不做全量扫描 —— 有 59MB 的日志，全扫会卡。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { isRealPrompt, isSystemArtifact } = require('./parse-log');

/** 只读开头这么多字节 */
const HEAD_BYTES = 256 * 1024;

/** 列表最多给多少条 */
const MAX_ITEMS = 60;

function projectsRoot() {
  return path.join(os.homedir(), '.claude', 'projects');
}

/** 读文件开头，抽出元信息 */
function readMeta(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch (_) {
    return null;
  }
  try {
    const buf = Buffer.alloc(HEAD_BYTES);
    const read = fs.readSync(fd, buf, 0, HEAD_BYTES, 0);
    let head = buf.slice(0, read).toString('utf8');
    const lines = head.split('\n');
    if (read === HEAD_BYTES) lines.pop(); // 最后一行可能被截断，丢掉

    let title = '';
    let cwd = '';
    let firstPrompt = '';

    for (const line of lines) {
      if (!line.trim()) continue;
      let j;
      try {
        j = JSON.parse(line);
      } catch (_) {
        continue;
      }
      if (!title && j.type === 'ai-title' && j.aiTitle) title = String(j.aiTitle).trim();
      if (!cwd && j.cwd) cwd = String(j.cwd);
      if (!firstPrompt && j.type === 'user' && j.message && typeof j.message.content === 'string') {
        const c = j.message.content;
        if (j.sourceToolAssistantUUID) continue;
        if (isSystemArtifact(j, c)) continue;
        if (!isRealPrompt(c)) continue;
        const t = c.trim();
        if (t) firstPrompt = t;
      }
    }

    const st = fs.fstatSync(fd);
    return {
      title,
      cwd,
      firstPrompt,
      mtime: st.mtimeMs,
      size: st.size,
    };
  } catch (_) {
    return null;
  } finally {
    try {
      fs.closeSync(fd);
    } catch (_) {}
  }
}

/**
 * 列出最近的会话（新的在前）
 * @returns {Array<{path,title,cwd,firstPrompt,mtime,size,project}>}
 */
function listSessions(limit = MAX_ITEMS) {
  const cached = cache.sessions;
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.list.slice(0, limit);
  const list = scanSessions(limit);
  cache.sessions = { at: Date.now(), list };
  return list.slice(0, limit);
}

/** 扫描结果缓存一下，短时间内重复开选择器不用重扫 */
const CACHE_TTL_MS = 8000;
const cache = { sessions: null };

function scanSessions(limit) {
  const root = projectsRoot();
  let dirs;
  try {
    dirs = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch (_) {
    return [];
  }

  const found = [];
  for (const dir of dirs) {
    const dirPath = path.join(root, dir);
    let files;
    try {
      files = fs.readdirSync(dirPath).filter((f) => f.endsWith('.jsonl'));
    } catch (_) {
      continue;
    }
    for (const f of files) {
      const full = path.join(dirPath, f);
      let st;
      try {
        st = fs.statSync(full);
      } catch (_) {
        continue;
      }
      found.push({ path: full, project: dir, file: f, mtime: st.mtimeMs, size: st.size });
    }
  }

  found.sort((a, b) => b.mtime - a.mtime);

  return found.slice(0, limit).map((s) => {
    const meta = readMeta(s.path) || {};
    return {
      path: s.path,
      project: s.project,
      file: s.file,
      title: meta.title || '',
      cwd: meta.cwd || '',
      firstPrompt: meta.firstPrompt || '',
      mtime: meta.mtime || s.mtime,
      size: meta.size || s.size,
    };
  });
}

/**
 * 已知会话里出现过的项目目录（用来找项目文档）
 *
 * 注意：这个能力属于「对话这边」。文档那边要用它，
 * 由 main.js 把结果递过去（doc/recent.js 不反过来依赖这里）。
 */
function projectDirs() {
  const out = new Map(); // cwd -> {cwd, mtime}
  for (const s of listSessions(MAX_ITEMS)) {
    if (!s.cwd) continue;
    const prev = out.get(s.cwd);
    if (!prev || s.mtime > prev.mtime) out.set(s.cwd, { cwd: s.cwd, mtime: s.mtime });
  }
  return Array.from(out.values()).sort((a, b) => b.mtime - a.mtime);
}

module.exports = { listSessions, projectDirs, projectsRoot };
