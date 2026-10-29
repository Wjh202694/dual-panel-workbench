/**
 * 列表选择器：给"导入对话"和"导入文档"用
 * 目的：别让人在文件框里认 UUID / 认目录，改成挑一份有名字的清单。
 */
(function () {
  const $ = (id) => document.getElementById(id);
  let selected = null;
  let kind = '';

  if (!window.api || !window.api.picker) {
    console.log('[picker] 缺少 api.picker');
    return;
  }

  function pick(item) {
    selected = item;
    document.querySelectorAll('.item').forEach((el) => {
      el.classList.toggle('sel', el.dataset.path === item.path);
    });
    $('ok').disabled = false;
    $('ok').textContent = item.action || '导入';
  }

  function addGroup(label, items, render) {
    if (!items.length) return;
    const h = document.createElement('div');
    h.className = 'group__label';
    h.textContent = label;
    $('list').appendChild(h);
    for (const it of items) {
      const el = document.createElement('div');
      el.className = 'item';
      el.dataset.path = it.path;

      const main = document.createElement('div');
      main.className = 'item__main';

      const t = document.createElement('div');
      t.className = 'item__title';
      t.textContent = it.title || it.name || it.path;
      main.appendChild(t);

      if (it.subtitle) {
        const s = document.createElement('div');
        s.className = 'item__sub';
        s.textContent = it.subtitle;
        s.title = it.subtitle;
        main.appendChild(s);
      }

      el.appendChild(main);

      if (it.meta) {
        const m = document.createElement('div');
        m.className = 'item__meta';
        m.textContent = it.meta;
        el.appendChild(m);
      }

      el.addEventListener('click', () => pick(it));
      el.addEventListener('dblclick', () => {
        pick(it);
        confirm();
      });
      $('list').appendChild(el);
    }
  }

  function confirm() {
    if (!selected) return;
    window.api.picker.choose({ kind, path: selected.path });
  }

  window.api.picker.getData().then((data) => {
    if (!data) return;
    kind = data.kind || '';
    $('title').textContent = data.title || '选择';
    $('subtitle').textContent = data.subtitle || '';
    $('browse').textContent = data.browseLabel || '浏览其他文件…';
    $('list').textContent = '';

    for (const g of data.groups || []) {
      addGroup(g.label, g.items || []);
    }
    if (!($('list').children.length)) {
      const e = document.createElement('div');
      e.className = 'empty';
      e.textContent = data.emptyText || '这里还没有可选项';
      $('list').appendChild(e);
    }
  });

  $('ok').addEventListener('click', confirm);
  $('cancel').addEventListener('click', () => window.api.picker.cancel());
  $('browse').addEventListener('click', () => window.api.picker.browse(kind));

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') window.api.picker.cancel();
    else if (e.key === 'Enter') confirm();
  });
})();
