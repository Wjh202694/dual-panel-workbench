/**
 * 右上角「切换模型」按键
 *
 * 只做一件事：把提炼用的模型换掉。
 * 免费模型优先（用户成本敏感），所以预设里全是 opencode 的免费模型。
 */

const ENGINE_LABEL = {
  opencode: 'opencode',
  claude: 'Claude Code CLI',
  custom: '自定义命令',
};

/** 不在预设里的模型 id，取最后一段当短名 */
function shortLabel(id) {
  if (!id) return '未设置';
  const tail = String(id).split('/').pop();
  return tail.length > 24 ? tail.slice(0, 23) + '…' : tail;
}

export function createModelMenu({ api, toaster, els }) {
  const { btn, name, menu, list, more } = els;

  let presets = [];
  let cfg = null;

  function currentLabel() {
    if (!cfg) return '…';
    if (cfg.engine !== 'opencode') {
      return ENGINE_LABEL[cfg.engine] || cfg.engine;
    }
    const hit = presets.find((p) => p.id === cfg.model);
    return hit ? hit.label : shortLabel(cfg.model);
  }

  function paintLabel() {
    name.textContent = currentLabel();
    btn.title =
      '当前提炼模型：' +
      (cfg && cfg.model ? cfg.model : '未设置') +
      '（点一下切换）';
  }

  function paintList() {
    list.textContent = '';
    for (const p of presets) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'modelmenu__item';
      item.setAttribute('role', 'menuitemradio');
      const on = cfg && cfg.engine === 'opencode' && cfg.model === p.id;
      item.setAttribute('aria-checked', on ? 'true' : 'false');

      const t = document.createElement('span');
      t.textContent = p.label;
      const n = document.createElement('span');
      n.className = 'modelmenu__item-note';
      n.textContent = p.note || '';
      item.appendChild(t);
      item.appendChild(n);

      item.addEventListener('click', async () => {
        close();
        const next = await api.setEngineSettings({ engine: 'opencode', model: p.id });
        cfg = next;
        paintLabel();
        paintList();
        toaster.show('提炼模型已切换为 ' + p.label);
      });
      list.appendChild(item);
    }
  }

  function open() {
    menu.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
  }

  function close() {
    menu.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
  }

  btn.addEventListener('click', () => {
    if (menu.hidden) open();
    else close();
  });

  more.addEventListener('click', () => {
    close();
    api.openEngineDialog();
  });

  document.addEventListener('click', (e) => {
    if (menu.hidden) return;
    if (menu.contains(e.target) || btn.contains(e.target)) return;
    close();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !menu.hidden) close();
  });

  // 菜单里改了设置、或引擎窗口改了设置，都要把按钮上的名字刷过来
  api.onEngineChanged((next) => {
    cfg = next;
    paintLabel();
    paintList();
  });

  async function init() {
    try {
      presets = (await api.listModels()) || [];
    } catch (_) {
      presets = [];
    }
    try {
      cfg = await api.getEngineSettings();
    } catch (_) {
      cfg = null;
    }
    paintLabel();
    paintList();
  }

  init();

  return { refresh: init };
}
