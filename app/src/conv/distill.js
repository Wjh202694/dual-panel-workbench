'use strict';
/**
 * 提炼引擎：把一轮对话的素材交给外部 agent，压成几条 recap
 *
 * 约定：提示词一律走 **stdin**，命令行走 argv。
 * 这样提示词里的引号、换行、反引号都不会被 cmd.exe 的引号规则吃掉。
 */

const { spawn } = require('child_process');

/** 可选引擎 */
const ENGINES = [
  { id: 'opencode', label: 'opencode（推荐 · 免费模型）', defaultModel: 'magpie/auto/beam-free' },
  { id: 'claude', label: 'Claude Code CLI', defaultModel: '' },
  { id: 'custom', label: '自定义命令（从 stdin 读提示词）', defaultModel: '' },
];

const DEFAULT_SETTINGS = {
  engine: 'opencode',
  model: 'magpie/auto/beam-free',
  customCommand: '',
  timeoutMs: 180000,
};

/** 根据引擎拼出命令行（提示词不进来，只走 stdin） */
function buildCommand(cfg) {
  switch (cfg.engine) {
    case 'claude':
      return 'claude -p';
    case 'custom':
      return (cfg.customCommand || '').trim() || 'cat';
    case 'opencode':
    default:
      return `opencode run -m ${cfg.model || DEFAULT_SETTINGS.model} --format json`;
  }
}

/**
 * 跑一次引擎，返回原始输出文本
 * @returns {Promise<string>}
 */
function runEngine(cfg, prompt, opts = {}) {
  const command = buildCommand(cfg);
  const timeoutMs = cfg.timeoutMs || DEFAULT_SETTINGS.timeoutMs;
  const cwd = opts.cwd || process.cwd();

  return new Promise((resolve, reject) => {
    let child;
    try {
      // shell:true 让 Windows 上 opencode.cmd / claude.cmd 这类 npm 垫片能被找到
      child = spawn(command, {
        shell: true,
        cwd,
        windowsHide: true,
        env: process.env,
      });
    } catch (err) {
      reject(new Error(`无法启动引擎：${err.message}`));
      return;
    }

    let stdout = '';
    let stderr = '';
    let done = false;

    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { child.kill(); } catch (_) {}
      reject(new Error(`提炼超时（${Math.round(timeoutMs / 1000)} 秒），引擎：${cfg.engine}`));
    }, timeoutMs);

    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });

    child.on('error', (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(new Error(`引擎启动失败：${err.message}`));
    });

    child.on('close', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (code !== 0) {
        const tail = (stderr || stdout).trim().split('\n').slice(-4).join('\n');
        reject(new Error(`引擎退出码 ${code}${tail ? '：\n' + tail : ''}`));
        return;
      }
      resolve(stdout);
    });

    // 提示词从 stdin 送进去
    try {
      child.stdin.on('error', () => {});
      child.stdin.end(prompt);
    } catch (_) {
      /* 有些命令不读 stdin，忽略 */
    }
  });
}

/** opencode --format json 输出的是一行一个 JSON，取出其中的 text 事件 */
function parseOpencodeOutput(stdout) {
  const texts = [];
  for (const line of stdout.split('\n')) {
    const s = line.trim();
    if (!s || s[0] !== '{') continue;
    let j;
    try {
      j = JSON.parse(s);
    } catch (_) {
      continue;
    }
    if (j.type === 'text' && j.part && typeof j.part.text === 'string') {
      texts.push(j.part.text);
    }
  }
  if (texts.length) return texts.join('\n');
  // 不是 JSON 输出就按原文返回
  return stdout.trim();
}

/** 把引擎输出统一成纯文本 */
function extractText(engine, stdout) {
  if (engine === 'opencode') return parseOpencodeOutput(stdout);
  return stdout.trim();
}

/**
 * 把引擎输出整成要点数组
 * 优先用 `- ` / `* ` / `1. ` 开头的行；没有要点时按空行分段
 */
function toBullets(text) {
  const raw = String(text || '');
  const lines = raw
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);

  const bullets = [];
  for (const l of lines) {
    const m = l.match(/^([-*•·]|\d+[.、)])\s+(.*)$/);
    if (m) {
      const body = m[2].trim();
      if (body) bullets.push(body);
    }
  }
  if (bullets.length) return bullets;

  const paras = raw
    .split(/\n{2,}/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (paras.length) return paras;

  return raw.trim() ? [raw.trim()] : [];
}

/** 提炼用的提示词：只要 recap，不要复述决策 */
function buildPrompt(round, material) {
  const parts = [];
  parts.push('你正在整理一段人机对话的日志。');
  parts.push('请用中文总结「这一轮 agent 实际做了什么」。');
  parts.push('');
  parts.push('严格要求：');
  parts.push('1. 只输出 2~5 条要点，每条一行，每行以「- 」开头。');
  parts.push('2. 不要复述用户的提示词，不要写「用户要求……」这类句子，只写 agent 的动作与产出。');
  parts.push('3. 涉及文件、命令、结论时写具体名字。');
  parts.push('4. 不要输出标题、不要输出解释、不要输出代码块。');
  parts.push('');
  parts.push('===== 用户这一轮的提示词（仅供你理解上下文，不要复述） =====');
  parts.push(material.prompt);
  parts.push('');
  parts.push('===== agent 这一轮执行的动作序列 =====');
  if (material.actions.length) {
    for (const a of material.actions) parts.push('- ' + a);
    if (material.omitted) parts.push(`（另有 ${material.omitted} 个动作已省略）`);
  } else {
    parts.push('（无工具调用）');
  }
  parts.push('');
  parts.push('===== agent 这一轮的回复 =====');
  parts.push(material.reply || '（无）');
  parts.push('');
  parts.push('现在只输出要点：');
  return parts.join('\n');
}

module.exports = {
  ENGINES,
  DEFAULT_SETTINGS,
  buildCommand,
  runEngine,
  extractText,
  toBullets,
  buildPrompt,
};
