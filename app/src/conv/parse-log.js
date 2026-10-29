'use strict';
/**
 * 解析 Claude Code 对话日志（JSONL）→ 一轮轮「决策素材」
 *
 * 日志里 user 记录混着三类东西：
 *   1. 人写的原话（string 型 message.content，且不是工具结果）
 *   2. 工具结果（带 sourceToolAssistantUUID）
 *   3. 系统包裹标签（<command-name>、<task-notification> 等）
 * 只有第 1 类才是"我的提示词"，必须原样保留、一字不动。
 */

/** 系统包裹标签：这些不是人写的，要排除 */
const WRAPPER_TAGS = new Set([
  'command-name',
  'command-message',
  'command-args',
  'command-contents',
  'local-command',
  'local-command-stdout',
  'local-command-stderr',
  'local-command-caveat',
  'task-notification',
  'system-reminder',
  'bash-input',
  'user-input',
]);

/** 判断一条 user 记录是不是"人写的原话" */
function isRealPrompt(text) {
  const t = (text || '').trimStart();
  if (!t.startsWith('<')) return true;
  const m = t.match(/^<([a-zA-Z-]+)/);
  if (!m) return true;
  return !WRAPPER_TAGS.has(m[1].toLowerCase());
}

/**
 * 判断这条记录是不是系统塞给 agent 的产物（不是人写的）
 *
 * 依据日志自带的标记，不靠猜内容：
 *   isCompactSummary / isVisibleInTranscriptOnly → 压缩摘要
 *   origin.kind 不是 human（peer / task-notification）→ 别的会话或任务转来的
 *   isMeta === true → 系统通知（上下文用量、跨会话转发、命令回执……）
 * 例外：图片占位符虽然是 isMeta，但它确实代表"我发了一张图"，保留。
 */
function isSystemArtifact(rec, content) {
  if (rec.isCompactSummary || rec.isVisibleInTranscriptOnly) return true;
  const origin = rec.origin && rec.origin.kind;
  if (origin && origin !== 'human') return true;
  if (rec.isMeta === true && !/^\[Image:/.test(String(content).trimStart())) return true;
  return false;
}

/** 把一次工具调用压成一句人能读的动作 */
function describeTool(name, input) {
  const i = input || {};
  const cut = (s, n) => {
    const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    return t.length > n ? t.slice(0, n) + '…' : t;
  };
  switch (name) {
    case 'Bash':
      return `Bash: ${cut(i.command, 120)}`;
    case 'Read':
      return `Read: ${cut(i.file_path, 100)}`;
    case 'Write':
      return `Write: ${cut(i.file_path, 100)}`;
    case 'Edit':
    case 'MultiEdit':
      return `${name}: ${cut(i.file_path, 100)}`;
    case 'NotebookEdit':
      return `NotebookEdit: ${cut(i.notebook_path, 100)}`;
    case 'Grep':
      return `Grep: ${cut(i.pattern, 60)}`;
    case 'Glob':
      return `Glob: ${cut(i.pattern, 60)}`;
    case 'WebSearch':
      return `WebSearch: ${cut(i.query, 80)}`;
    case 'WebFetch':
      return `WebFetch: ${cut(i.url, 100)}`;
    case 'Agent':
      return `Agent: ${cut(i.description || i.prompt, 80)}`;
    case 'Task':
      return `Task: ${cut(i.description || i.prompt, 80)}`;
    case 'AskUserQuestion':
      return 'AskUserQuestion: 向用户提问';
    case 'Skill':
      return `Skill: ${cut(i.skill, 40)}`;
    case 'TodoWrite':
      return 'TodoWrite: 更新待办';
    default: {
      const keys = Object.keys(i);
      const hint = keys.length ? ' ' + cut(i[keys[0]], 60) : '';
      return `${name}${hint}`;
    }
  }
}

/**
 * 从一次工具调用里抽出「文件改动」—— 只管写文件的那几个工具
 *
 * 产出的每一项：{ file, kind:'write'|'edit'|'notebook', oldText, newText }
 * 没有文件路径的、新旧文本都空的，都跳过（不是真的改动）。
 */
function collectEdits(name, input, out) {
  const i = input || {};
  const push = (file, kind, oldText, newText) => {
    if (!file) return;
    const o = String(oldText == null ? '' : oldText);
    const n = String(newText == null ? '' : newText);
    if (!o && !n) return; // 两边都空 = 没改东西
    out.push({ file: String(file), kind, oldText: o, newText: n });
  };

  switch (name) {
    case 'Write':
      push(i.file_path, 'write', '', i.content || '');
      break;
    case 'Edit':
      push(i.file_path, 'edit', i.old_string || '', i.new_string || '');
      break;
    case 'MultiEdit': {
      const list = Array.isArray(i.edits) ? i.edits : [];
      for (const e of list) {
        push(i.file_path, 'edit', (e && e.old_string) || '', (e && e.new_string) || '');
      }
      break;
    }
    case 'NotebookEdit':
      push(i.notebook_path, 'notebook', '', i.new_source || '');
      break;
    default:
      break; // 其它工具不改文件
  }
}

/** 抽出 agent 给用户的选择（AskUserQuestion 的选项） */
function collectChoices(input, out) {
  const qs = (input && input.questions) || [];
  for (const q of qs) {
    const opts = q.options || [];
    for (const o of opts) {
      out.push({
        label: String(o.label || '').trim(),
        description: String(o.description || '').trim(),
      });
    }
  }
}

/**
 * 解析日志文本
 * @returns {{rounds: Array<{index:number,prompt:string,choices:Array,actions:Array<string>,edits:Array,reply:string}>, cwd:string}}
 */
function parseTranscript(text) {
  const records = [];
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch (_) {
      /* 不是 JSON 的行（极少数）跳过 */
    }
  }

  const rounds = [];
  let cur = null;
  let cwd = ''; // 日志里记的项目目录（第一条带 cwd 的记录说了算）

  for (const r of records) {
    if (!cwd && typeof r.cwd === 'string' && r.cwd) cwd = r.cwd;

    if (r.isSidechain) continue; // 子代理的会话不算人机轮次

    /* 中途插话：用户在 agent 干活时又发了一条。
       这种消息在日志里不是 user 记录，而是 attachment / queued_command。 */
    if (r.type === 'attachment') {
      const a = r.attachment || {};
      if (a.type === 'queued_command' && a.origin && a.origin.kind === 'human' && typeof a.prompt === 'string') {
        const raw = a.prompt;
        const prompt = raw.trim();
        if (prompt && isRealPrompt(prompt)) {
          cur = {
            index: rounds.length + 1,
            prompt,
            raw,
            choices: [],
            actions: [],
            edits: [],
            reply: '',
            _texts: [],
          };
          rounds.push(cur);
        }
      }
      continue;
    }

    if (r.type === 'user' && r.message) {
      // 压缩摘要、只在转录里可见的记录：都是系统产物，不是人写的
      if (r.isCompactSummary || r.isVisibleInTranscriptOnly) continue;
      const content = r.message.content;
      if (typeof content !== 'string') continue; // 数组型 = 工具结果
      if (r.sourceToolAssistantUUID) continue; // 字符串型工具结果
      if (isSystemArtifact(r, content)) continue;
      if (!isRealPrompt(content)) continue;
      const raw = String(content);
      const prompt = raw.trim();
      if (!prompt) continue;
      cur = {
        index: rounds.length + 1,
        prompt,        // 供提炼用（已去首尾空白）
        raw,           // 展示用：用户的原话，一个字都不改
        choices: [],
        actions: [],
        edits: [],
        reply: '',
        _texts: [],
      };
      rounds.push(cur);
      continue;
    }

    if (r.type === 'assistant' && cur && r.message) {
      const content = r.message.content;
      if (!Array.isArray(content)) continue;
      for (const b of content) {
        if (!b) continue;
        if (b.type === 'tool_use') {
          cur.actions.push(describeTool(b.name, b.input));
          collectEdits(b.name, b.input, cur.edits);
          if (b.name === 'AskUserQuestion') collectChoices(b.input, cur.choices);
        } else if (b.type === 'text' && b.text) {
          cur._texts.push(b.text);
        }
      }
    }
  }

  for (const r of rounds) {
    // 最后一段文字通常是本轮的正式回复，最有信息量
    r.reply = r._texts.length ? r._texts[r._texts.length - 1].trim() : '';
    delete r._texts;
  }

  return { rounds, cwd };
}

/** 供提炼用的素材（控制长度，避免提示词过长） */
function buildMaterial(round) {
  const MAX_ACTIONS = 40;
  const MAX_REPLY = 2500;
  const MAX_PROMPT = 6000;

  let actions = round.actions;
  let omitted = 0;
  if (actions.length > MAX_ACTIONS) {
    omitted = actions.length - MAX_ACTIONS;
    actions = actions.slice(0, MAX_ACTIONS);
  }

  let prompt = round.raw || round.prompt;
  if (prompt.length > MAX_PROMPT) {
    prompt = prompt.slice(0, MAX_PROMPT) + '\n…（原提示词过长，已截断）';
  }

  let reply = round.reply;
  if (reply.length > MAX_REPLY) {
    reply = reply.slice(0, MAX_REPLY) + '…（已截断）';
  }

  return { prompt, actions, omitted, reply };
}

module.exports = { parseTranscript, buildMaterial, isRealPrompt, isSystemArtifact, describeTool };
