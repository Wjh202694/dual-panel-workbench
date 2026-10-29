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

  function renderBullets(box, bullets) {
    box.textContent = '';
    const ul = document.createElement('ul');
    ul.className = 'conv-recap';
    for (const b of bullets) {
      const li = document.createElement('li');
      li.textContent = b;
      ul.appendChild(li);
    }
    box.appendChild(ul);
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
  const queued = new Set(); // `${path}#${index}`，防止同一轮被排两次

  function enqueue(job) {
    const key = `${job.path}#${job.index}`;
    if (queued.has(key)) return;
    queued.add(key);
    queue.push(job);
    pump();
  }

  function pump() {
    if (paused) return;
    while (active < CONCURRENCY && queue.length) {
      const job = queue.shift();
      active++;
      runJob(job).finally(() => {
        queued.delete(`${job.path}#${job.index}`);
        active--;
        pump();
      });
    }
  }

  async function runJob(job) {
    const { box } = job;
    job.done = true;
    renderState(box, '提炼中…', 'pending');
    try {
      const res = await api.distillRound(job.path, job.index);
      renderBullets(box, res.bullets);
      consecutiveFails = 0;
      if (!notified.has(job.path)) {
        notified.add(job.path);
        const name = (job.name || '').split('\\').pop().split('/').pop();
        toaster.show(`recap 已写入 ${name}.recap.md`);
      }
    } catch (err) {
      const msg = (err && err.message ? err.message : String(err)).replace(/\s+/g, ' ').slice(0, 160);
      renderState(box, '提炼失败：' + msg, 'err', () => {
        job.done = false;
        enqueue(job);
      });
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
  function addGroup(log) {
    const root = document.createElement('div');
    root.className = 'conv-group';

    const label = document.createElement('div');
    label.className = 'conv-group__label';
    label.textContent = log.name;
    root.appendChild(label);

    const cards = new Map();
    for (const round of log.rounds) {
      const { card, box } = buildCard(round);
      root.appendChild(card);
      cards.set(round.index, { card, box, round });

      if (round.bullets && round.bullets.length) {
        renderBullets(box, round.bullets);
      } else {
        // 没提炼过的轮次给个手动按钮：额度紧的时候可以只提炼想看的几轮
        renderState(box, '尚未提炼', 'idle', () => {
          enqueue({ path: log.path, name: log.name, index: round.index, box });
        }, '提炼这一轮');
      }
    }

    container.appendChild(root);
    const group = { path: log.path, name: log.name, root, cards };
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

  async function importConversations() {
    let res;
    try {
      res = await api.pickConversations();
    } catch (err) {
      toaster.show('打开文件框失败：' + (err.message || err), 'error');
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

  return { importConversations, openLogByPath, distillAll, groups };
}
