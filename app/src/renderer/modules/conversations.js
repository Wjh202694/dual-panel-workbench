/**
 * 上方对话区：把对话日志变成一张张「轮次卡片」
 *
 * 每张卡片：
 *   左上角 = 轮次
 *   决策   = 我当时说的原话（一个字都不改）+ agent 给我的选项
 *   recap  = 这一轮 agent 干了什么（由外部引擎提炼，结果缓存在日志旁边的 .recap.md）
 */

/** 同时最多提炼几轮（免得把免费模型的额度打爆） */
const CONCURRENCY = 3;

/** 连续失败多少次就暂停（多半是额度用尽） */
const MAX_CONSECUTIVE_FAILS = 3;

/** 一次刷新最多带出几轮新的（跟提炼并发数一致，剩下的下次再带） */
const MAX_NEW_ROUNDS = 3;

/**
 * 剥掉 Electron IPC 套在错误外面的那层壳：
 * "Error invoking remote method 'conv:distill': Error: 引擎退出码 1"
 * → "引擎退出码 1"
 * 卡片上要给人看的是原因，不是这串框架噪音。
 */
function reasonText(err) {
  const raw = (err && err.message ? err.message : String(err || ''))
    .replace(/^Error invoking remote method '[^']*':\s*/i, '')
    .replace(/^(Uncaught )?Error:\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  return raw || '未知错误';
}

export function createConversations({ api, toaster, onLayout }) {
  const container = document.getElementById('ct-top');
  const placeholders = Array.from(container.querySelectorAll('.card'));

  /** @type {Array<{path:string,name:string,root:HTMLElement,cards:Map<number,object>}>} */
  const groups = [];
  const queue = [];
  const notified = new Set();
  let active = 0;
  let paused = false;
  let consecutiveFails = 0;

  /* ---------------- 卡片 ---------------- */
  function buildCard(round) {
    const card = document.createElement('div');
    card.className = 'card conv-card';

    const badge = document.createElement('div');
    badge.className = 'conv-card__round';
    badge.textContent = String(round.index);
    card.appendChild(badge);

    const body = document.createElement('div');
    body.className = 'conv-card__body';

    /* ---- 决策 ---- */
    const dec = document.createElement('section');
    dec.className = 'conv-sec';

    const decTitle = document.createElement('h4');
    decTitle.className = 'conv-sec__title';
    decTitle.textContent = '决策';
    dec.appendChild(decTitle);

    const prompt = document.createElement('div');
    prompt.className = 'conv-prompt';
    prompt.textContent = round.raw; // 原话，一字不动
    dec.appendChild(prompt);

    if (round.choices && round.choices.length) {
      const list = document.createElement('ul');
      list.className = 'conv-choices';
      for (const c of round.choices) {
        const li = document.createElement('li');
        li.className = 'conv-choice';
        const label = document.createElement('span');
        label.className = 'conv-choice__label';
        label.textContent = c.label;
        li.appendChild(label);
        if (c.description) {
          const desc = document.createElement('span');
          desc.className = 'conv-choice__desc';
          desc.textContent = c.description;
          li.appendChild(desc);
        }
        list.appendChild(li);
      }
      dec.appendChild(list);
    }
    body.appendChild(dec);

    /* ---- recap ---- */
    const rec = document.createElement('section');
    rec.className = 'conv-sec';

    const recTitle = document.createElement('h4');
    recTitle.className = 'conv-sec__title';
    recTitle.textContent = 'recap';
    rec.appendChild(recTitle);

    const box = document.createElement('div');
    box.className = 'conv-recapbox';
    rec.appendChild(box);

    body.appendChild(rec);
    card.appendChild(body);

    return { card, box };
  }

  function renderBullets(box, bullets, againBtn) {
    box.textContent = '';
    const ul = document.createElement('ul');
    ul.className = 'conv-recap';
    for (const b of bullets) {
      const li = document.createElement('li');
      li.textContent = b;
      ul.appendChild(li);
    }
    box.appendChild(ul);
    if (againBtn) box.appendChild(againBtn);
  }

  function renderState(box, text, kind, onRetry, btnText) {
    box.textContent = '';
    const span = document.createElement('span');
    span.className = 'conv-recap__state' + (kind ? ' conv-recap__state--' + kind : '');
    span.textContent = text;
    box.appendChild(span);
    if (onRetry) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'conv-recap__retry';
      btn.textContent = btnText || '重试';
      btn.addEventListener('click', onRetry);
      box.appendChild(btn);
    }
  }

  /* ---------------- 提炼队列 ---------------- */
  /* key = `${path}#${index}` → 正在排队的作业。
     同一轮可能被多次排队（同一份日志导入两次、或者点了重试），
     这时要把所有等着结果的卡片都挂到同一个作业上，
     不然后来的那组卡片会永远停在「提炼中…」。 */
  const jobs = new Map();

  function enqueue(job) {
    const key = `${job.path}#${job.index}`;
    const boxes = job.boxes ? job.boxes.slice() : [job.box];
    const exist = jobs.get(key);
    if (exist) {
      exist.boxes.push(...boxes);
      return;
    }
    const task = { path: job.path, name: job.name, index: job.index, boxes };
    jobs.set(key, task);
    queue.push(task);
    pump();
  }

  function pump() {
    if (paused) return;
    while (active < CONCURRENCY && queue.length) {
      const job = queue.shift();
      active++;
      runJob(job).finally(() => {
        jobs.delete(`${job.path}#${job.index}`);
        active--;
        pump();
      });
    }
  }

  /** 「重新提炼」按钮：已经保存过的轮次也能再跑一次（会覆盖已存的 recap） */
  function makeAgainButton(logPath, logName, index, box) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'conv-recap__again';
    btn.textContent = '重新提炼';
    btn.title = '已保存到日志旁边的 .recap.md。用当前模型重跑会覆盖它。';
    btn.addEventListener('click', () => {
      enqueue({ path: logPath, name: logName, index, box });
    });
    return btn;
  }

  async function runJob(job) {
    const { path: logPath, name: logName, index } = job;
    for (const box of job.boxes) renderState(box, '提炼中…', 'pending');
    try {
      const res = await api.distillRound(logPath, index);
      for (const box of job.boxes) {
        renderBullets(box, res.bullets, makeAgainButton(logPath, logName, index, box));
      }
      consecutiveFails = 0;
      if (!notified.has(logPath)) {
        notified.add(logPath);
        const nm = (logName || '').split('\\').pop().split('/').pop();
        toaster.show(`recap 已写入 ${nm}.recap.md`);
      }
    } catch (err) {
      const msg = reasonText(err).slice(0, 160);
      for (const box of job.boxes) {
        renderState(box, '提炼失败：' + msg, 'err', () => {
          // 手动点重试 = 用户明确要再试一次：必须解除熔断。
          // 不解除的话作业只是进了队列、pump() 直接 return，
          // 点了「重试」看着像没反应 —— 这就是"只响应一次"。
          paused = false;
          consecutiveFails = 0;
          enqueue({ path: logPath, name: logName, index, boxes: job.boxes });
        });
      }
      consecutiveFails++;
      if (consecutiveFails >= MAX_CONSECUTIVE_FAILS) {
        paused = true;
        toaster.show(
          `连续 ${consecutiveFails} 次提炼失败（多半是额度用尽或引擎不可用），已暂停。` +
          '修好后从菜单「工具 → 提炼缺失的 recap」继续。',
          'error',
          9000
        );
      }
    }
  }

  /* ---------------- 导入 ---------------- */

  /**
   * 把一轮做成卡片挂到某个分组上。
   * 导入时用、刷新时也用（刷新带出来的新轮次走同一条路）。
   */
  function addRoundToGroup(g, round) {
    const { card, box } = buildCard(round);
    g.root.appendChild(card);
    const entry = { card, box, round };
    g.cards.set(round.index, entry);

    if (round.bullets && round.bullets.length) {
      // 有缓存：直接显示已保存的要点，并给一个「重新提炼」入口
      renderBullets(box, round.bullets, makeAgainButton(g.path, g.name, round.index, box));
    } else {
      // 没提炼过的轮次给个手动按钮：额度紧的时候可以只提炼想看的几轮
      renderState(box, '尚未提炼', 'idle', () => {
        enqueue({ path: g.path, name: g.name, index: round.index, box });
      }, '提炼这一轮');
    }
    if (round.index > g.lastIndex) g.lastIndex = round.index;
    return entry;
  }

  function addGroup(log) {
    const root = document.createElement('div');
    root.className = 'conv-group';

    const label = document.createElement('div');
    label.className = 'conv-group__label';
    label.textContent = log.name;
    root.appendChild(label);

    const cards = new Map();
    const group = { path: log.path, name: log.name, root, cards, lastIndex: 0 };
    for (const round of log.rounds) {
      addRoundToGroup(group, round);
    }

    container.appendChild(root);
    groups.push(group);
    return group;
  }

  function updateGroupLabels() {
    const show = groups.length > 1;
    for (const g of groups) {
      const label = g.root.querySelector('.conv-group__label');
      if (label) label.hidden = !show;
    }
  }

  function clearPlaceholders() {
    for (const p of placeholders) {
      if (p.parentNode) p.parentNode.removeChild(p);
    }
  }

  function scrollToBottom() {
    if (onLayout) onLayout();
    requestAnimationFrame(() => {
      const vp = document.getElementById('vp-top');
      if (vp) vp.scrollTop = vp.scrollHeight;
    });
  }

  /** 把一个已解析好的对话日志渲染成卡片；返回这一组 */
  function addLog(log) {
    if (!groups.length) clearPlaceholders();
    const g = addGroup(log);
    // 有缓存的直接显示，没有缓存的排队提炼
    for (const round of log.rounds) {
      if (round.bullets && round.bullets.length) continue;
      const entry = g.cards.get(round.index);
      enqueue({ path: log.path, name: log.name, index: round.index, box: entry.box });
    }
    updateGroupLabels();
    scrollToBottom();
    return g;
  }

  /** 直接按路径载入一个日志（自检与「最近文件」用） */
  async function openLogByPath(filePath) {
    const log = await api.loadConversation(filePath);
    if (!log.rounds.length) throw new Error('这个文件里没解析出对话轮次');
    return addLog(log);
  }

  /**
   * 刷新：把日志里新长出来的轮次带出来，不用重新导入文件。
   *
   * 日志文件（Claude Code 的 .jsonl）在导入之后还在往下追加，
   * 所以「再导入一次」会多出一整组重复卡片 —— 刷新只补新轮次。
   * 一次最多带 3 轮，剩下的下一次刷新再带。
   */
  async function refresh() {
    if (!groups.length) {
      toaster.show('还没导入对话，先点左上角「导入对话」', 'warn');
      return { added: 0 };
    }
    let added = 0;
    const seen = new Set(); // 同一轮导入过多次时，只算一轮
    for (const g of groups.slice()) {
      // 已经被从界面上摘掉的分组（比如换了文档、重新导入过）不用再管
      if (!g.root.isConnected) continue;
      let res;
      try {
        res = await api.reloadConversation(g.path, g.lastIndex, MAX_NEW_ROUNDS);
      } catch (err) {
        toaster.show('刷新失败：' + reasonText(err), 'error');
        continue;
      }
      const fresh = (res && res.rounds) || [];
      for (const round of fresh) {
        // 已经在界面上的轮次不再重复加
        if (g.cards.has(round.index)) continue;
        const entry = addRoundToGroup(g, round);
        // 新轮次跟刚导入时一样，直接排队提炼
        enqueue({ path: g.path, name: g.name, index: round.index, box: entry.box });
        const key = `${g.path}#${round.index}`;
        if (!seen.has(key)) {
          seen.add(key);
          added++;
        }
      }
    }
    if (added) {
      updateGroupLabels();
      scrollToBottom();
      toaster.show(`带出 ${added} 轮新对话，正在提炼`);
    } else {
      toaster.show('没有新的对话（日志还没长出新轮次）');
    }
    return { added };
  }

  async function importConversations() {
    let res;
    try {
      res = await api.pickConversations();
    } catch (err) {
      toaster.show('打开文件框失败：' + reasonText(err), 'error');
      return;
    }
    if (!res || !res.logs || !res.logs.length) {
      if (res && res.errors && res.errors.length) {
        for (const e of res.errors) toaster.show(`${e.name}：${e.message}`, 'error');
      }
      return;
    }
    for (const log of res.logs) addLog(log);
  }

  /** 提炼所有还没提炼的轮次（也会解除熔断，恢复排队） */
  function distillAll() {
    paused = false;
    consecutiveFails = 0;
    let n = 0;
    for (const g of groups) {
      for (const [index, entry] of g.cards) {
        const bullets = entry.box.querySelector('.conv-recap');
        if (bullets) continue;
        enqueue({ path: g.path, name: g.name, index, box: entry.box });
        n++;
      }
    }
    if (!n) toaster.show('所有轮次都已经提炼过了');
    else toaster.show(`排队提炼 ${n} 轮`);
    return n;
  }

  return { importConversations, openLogByPath, refresh, distillAll, groups };
}
