'use strict';
/**
 * 提炼引擎：把一轮对话的素材交给外部 agent，压成几条 recap
 *
 * 约定：提示词一律走 **stdin**，命令行走 argv。
 * 这样提示词里的引号、换行、反引号都不会被 cmd.exe 的引号规则吃掉。
 */

const { spawn } = require('child_process');
const { ENGINES, DEFAULT_SETTINGS } = require('../engines');

/**
 * 校验 API 配置。格式不对就抛人话错误，让卡片上能直接看到原因。
 * @returns {{base:string, key:string, model:string, anthropic:boolean}}
 */
function validateApiConfig(cfg) {
  const base = String(cfg.apiBaseUrl || '').trim();
  if (!base) throw new Error('API 地址没填（去「工具 → 自定义模型与命令…」里填）');
  let u;
  try {
    u = new URL(base);
  } catch (_) {
    throw new Error(`API 地址格式不对：「${base}」不是合法网址，要以 http:// 或 https:// 开头`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`API 地址格式不对：只支持 http:// 或 https://，现在写的是 ${u.protocol}//`);
  }
  const key = String(cfg.apiKey || '').trim();
  if (!key) throw new Error('API Key 没填');
  const model = String(cfg.model || '').trim();
  if (!model) throw new Error('模型名没填');
  return { base: base.replace(/\/+$/, ''), key, model, anthropic: cfg.apiFormat === 'anthropic' };
}

/** 拼最终请求地址：容忍用户少写 /v1 或写全了路径 */
function apiUrl(base, anthropic) {
  const suffix = anthropic ? '/messages' : '/chat/completions';
  const full = anthropic ? '/v1/messages' : '/v1/chat/completions';
  if (base.endsWith(suffix)) return base;
  if (base.endsWith('/v1')) return base + suffix;
  return base + full;
}

/**
 * 直接调 HTTP API 提炼。
 * @returns {Promise<string>} 模型的纯文本回复
 */
async function runApi(cfg, prompt, opts = {}) {
  const { base, key, model, anthropic } = validateApiConfig(cfg);
  const url = apiUrl(base, anthropic);
  const timeoutMs = cfg.timeoutMs || DEFAULT_SETTINGS.timeoutMs;

  const headers = { 'content-type': 'application/json' };
  let body;
  if (anthropic) {
    headers['x-api-key'] = key;
    headers['anthropic-version'] = '2023-06-01';
    body = {
      model,
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    };
  } else {
    headers['authorization'] = 'Bearer ' + key;
    body = {
      model,
      messages: [{ role: 'user', content: prompt }],
      stream: false,
    };
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err && err.name === 'AbortError') {
      throw new Error(`请求超时（${Math.round(timeoutMs / 1000)} 秒）：${url}`);
    }
    throw new Error(`连不上 ${url}：${(err && err.message) || err}`);
  }
  clearTimeout(timer);

  const raw = await res.text();
  if (!res.ok) {
    const detail = raw.replace(/\s+/g, ' ').slice(0, 240);
    throw new Error(`HTTP ${res.status}${res.statusText ? ' ' + res.statusText : ''}：${detail}`);
  }

  let j;
  try {
    j = JSON.parse(raw);
  } catch (_) {
    throw new Error('返回的不是 JSON（检查一下 API 地址填对了吗）：' + raw.replace(/\s+/g, ' ').slice(0, 200));
  }
  if (j && j.error) {
    const e = j.error;
    throw new Error('接口报错：' + (typeof e === 'string' ? e : e.message || JSON.stringify(e)));
  }

  const text = extractApiText(j, anthropic);
  if (!text) {
    throw new Error('返回里没找到文本内容：' + raw.replace(/\s+/g, ' ').slice(0, 200));
  }
  return text;
}

/** 从接口返回里挖出文本 */
function extractApiText(j, anthropic) {
  if (!j || typeof j !== 'object') return '';
  if (anthropic) {
    if (Array.isArray(j.content)) {
      return j.content.map((c) => (c && typeof c.text === 'string' ? c.text : '')).filter(Boolean).join('\n');
    }
    if (typeof j.completion === 'string') return j.completion;
    return '';
  }
  const ch = Array.isArray(j.choices) ? j.choices[0] : null;
  if (!ch) return '';
  if (ch.message && typeof ch.message.content === 'string') return ch.message.content;
  if (typeof ch.text === 'string') return ch.text;
  return '';
}


/** 根据引擎拼出命令行（提示词不进来，只走 stdin） */
function buildCommand(cfg) {
  switch (cfg.engine) {
    case 'claude':
      return 'claude -p';
    case 'custom':
      return (cfg.customCommand || '').trim() || 'cat';
    case 'api':
      return ''; // API 引擎不走命令行
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
  // API 引擎直接发 HTTP，不起子进程
  if (cfg.engine === 'api') return runApi(cfg, prompt, opts);

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
  buildCommand,
  runEngine,
  runApi,
  validateApiConfig,
  extractText,
  toBullets,
  buildPrompt,
};
