/**
 * 提炼引擎设置窗口（独立小窗口，不动主界面）
 *
 * - 切换引擎时立刻切换显示哪些字段
 * - 保存前校验，错误红字显示在出错字段下方，焦点落到第一个出错字段
 * - 「测试连接」用当前输入框里的值真跑一次引擎，不保存
 */
(async function () {
  const $ = (id) => document.getElementById(id);

  /* 字段元信息：配置键 → 输入框 id / 错误区 id */
  const FIELDS = {
    model: { el: 'model', err: 'err-model' },
    customCommand: { el: 'cmd', err: 'err-cmd' },
    apiBaseUrl: { el: 'apiBaseUrl', err: 'err-apiBaseUrl' },
    apiKey: { el: 'apiKey', err: 'err-apiKey' },
    apiFormat: { el: 'apiFormat', err: 'err-apiFormat' },
  };

  /* 每个引擎要显示哪些字段 */
  const FIELDS_BY_ENGINE = {
    opencode: ['model'],
    claude: ['model'],
    custom: ['customCommand', 'model'],
    api: ['apiBaseUrl', 'apiKey', 'model', 'apiFormat'],
  };

  /* 字段容器（连 label 一起藏） */
  const fieldBox = (key) => document.querySelector('.field[data-field="' + key + '"]');

  /* ---------- 引擎下拉 ---------- */
  const engines = await window.api.listEngines();
  const sel = $('engine');
  for (const e of engines) {
    const o = document.createElement('option');
    o.value = e.id;
    o.textContent = e.label;
    sel.appendChild(o);
  }

  /* ---------- 回填当前设置 ---------- */
  const cfg = await window.api.getEngineSettings();
  const stored = {
    model: String(cfg.model || ''),
    customCommand: String(cfg.customCommand || ''),
    apiBaseUrl: String(cfg.apiBaseUrl || ''),
    apiKey: String(cfg.apiKey || ''),
    apiFormat: cfg.apiFormat === 'anthropic' ? 'anthropic' : 'openai',
  };
  /* 用户动过的字段：切到别的引擎把它藏起来之后，保存仍要带上他填的新值 */
  const dirty = new Set();

  sel.value = cfg.engine || 'opencode';
  $('model').value = stored.model;
  $('cmd').value = stored.customCommand;
  $('apiBaseUrl').value = stored.apiBaseUrl;
  $('apiKey').value = stored.apiKey;
  $('apiFormat').value = stored.apiFormat;

  /* ---------- 显示 / 隐藏 ---------- */

  function visibleKeys(engine) {
    const keys = FIELDS_BY_ENGINE[engine];
    return Array.isArray(keys) ? keys : ['model'];
  }

  function applyVisibility() {
    const vis = visibleKeys(sel.value);
    for (const key of Object.keys(FIELDS)) {
      const box = fieldBox(key);
      if (box) box.hidden = !vis.includes(key);
    }
  }

  /* ---------- 错误提示 ---------- */

  function clearErrors() {
    for (const key of Object.keys(FIELDS)) {
      const e = $(FIELDS[key].err);
      if (e) { e.textContent = ''; e.classList.remove('on'); }
    }
  }

  /* 显示一组错误：{字段配置键: 文案}，焦点挪到第一个出错的字段（按画面从上到下） */
  function showErrors(engine, errors) {
    clearErrors();
    /* 画面顺序：先按当前引擎的字段顺序，再补上其余字段 */
    const order = visibleKeys(engine).concat(
      Object.keys(FIELDS).filter((k) => !visibleKeys(engine).includes(k))
    );
    let firstEl = null;
    for (const key of order) {
      if (!errors[key]) continue;
      const f = FIELDS[key];
      const e = $(f.err);
      if (e) {
        e.textContent = errors[key];
        e.classList.add('on');
      }
      if (!firstEl) firstEl = $(f.el);
    }
    if (firstEl) {
      try { firstEl.focus(); } catch (_) {}
    }
  }

  /* 状态行（绿色成功 / 红色失败） */
  function setStatus(text, ok) {
    const s = $('status');
    s.textContent = text || '';
    s.classList.toggle('on', !!text);
    s.classList.toggle('ok', ok === true);
    s.classList.toggle('err', ok === false);
  }

  /* ---------- 校验 ---------- */

  function validate(engine, v) {
    const errors = {};

    if (engine === 'api') {
      const url = String(v.apiBaseUrl || '').trim();
      let parsed = null;
      try { parsed = new URL(url); } catch (_) { parsed = null; }
      if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
        errors.apiBaseUrl = 'API 地址格式不对，要以 http:// 或 https:// 开头';
      }
      if (!String(v.apiKey || '').trim()) errors.apiKey = 'API Key 不能为空';
      if (!String(v.model || '').trim()) errors.model = '模型名不能为空';
    } else if (engine === 'custom') {
      if (!String(v.customCommand || '').trim()) errors.customCommand = '自定义命令不能为空';
    } else if (engine === 'opencode') {
      if (!String(v.model || '').trim()) errors.model = '模型名不能为空';
    }
    /* claude：模型可以为空（claude -p 用它自己的默认），不报错 */

    return errors;
  }

  /* ---------- 取值 ---------- */

  /* 输入框里的当前值（测试连接用：完全按框里写的来，不看存没存过） */
  function rawValues() {
    return {
      engine: sel.value,
      model: $('model').value.trim(),
      customCommand: $('cmd').value.trim(),
      apiBaseUrl: $('apiBaseUrl').value.trim(),
      apiKey: $('apiKey').value.trim(),
      apiFormat: $('apiFormat').value === 'anthropic' ? 'anthropic' : 'openai',
    };
  }

  /* 保存要带的全部字段：可见的用框里的值；不可见的用已存的旧值（除非用户动过它） */
  function saveValues() {
    const vis = visibleKeys(sel.value);
    const read = (key, elId) => {
      if (vis.includes(key) || dirty.has(key)) return $(elId).value.trim();
      return String(stored[key] || '').trim();
    };
    return {
      engine: sel.value,
      model: read('model', 'model'),
      customCommand: read('customCommand', 'cmd'),
      apiBaseUrl: read('apiBaseUrl', 'apiBaseUrl'),
      apiKey: read('apiKey', 'apiKey'),
      apiFormat: read('apiFormat', 'apiFormat'),
    };
  }

  /* 把 IPC 抛回来的错变成人话（去掉 Electron 那层前缀） */
  function errText(e) {
    let m = (e && e.message) ? String(e.message) : String(e || '');
    m = m.replace(/^Error invoking remote method '[^']*':\s*/i, '');
    m = m.replace(/^(Uncaught )?Error:\s*/i, '');
    return m || '未知错误';
  }

  /* ---------- 保存 ---------- */

  async function doSave() {
    const v = saveValues();
    const errors = validate(v.engine, v);
    if (Object.keys(errors).length) {
      setStatus('', null);
      showErrors(v.engine, errors);
      return;
    }
    clearErrors();

    const save = window.api.saveEngineSettings || window.api.setEngineSettings;
    if (typeof save !== 'function') {
      setStatus('保存失败：主进程没有提供保存接口', false);
      return;
    }

    try {
      await save({
        engine: v.engine,
        model: v.model,
        customCommand: v.customCommand,
        apiBaseUrl: v.apiBaseUrl,
        apiKey: v.apiKey,
        apiFormat: v.apiFormat,
      });
    } catch (e) {
      setStatus('保存失败：' + errText(e), false);
      return;
    }

    /* 存盘成功：已存的旧值更新成刚存进去的 */
    stored.model = v.model;
    stored.customCommand = v.customCommand;
    stored.apiBaseUrl = v.apiBaseUrl;
    stored.apiKey = v.apiKey;
    stored.apiFormat = v.apiFormat;
    dirty.clear();

    setStatus('已保存', true);
    setTimeout(() => { window.api.closeSelf(); }, 600);
  }

  /* ---------- 测试连接 ---------- */

  async function doTest() {
    const btn = $('test');
    const v = rawValues();

    if (typeof window.api.testEngine !== 'function') {
      setStatus('测试失败：主进程还没有提供 testEngine 接口', false);
      return;
    }

    const oldText = btn.textContent;
    btn.textContent = '测试中…';
    btn.disabled = true;
    setStatus('正在测试连接…', null);

    try {
      const res = await window.api.testEngine({
        engine: v.engine,
        model: v.model,
        customCommand: v.customCommand,
        apiBaseUrl: v.apiBaseUrl,
        apiKey: v.apiKey,
        apiFormat: v.apiFormat,
      });
      if (res && res.ok) {
        const sample = String(res.sample || '').slice(0, 200);
        setStatus(sample ? '连接正常：' + sample : '连接正常', true);
      } else {
        setStatus('测试失败：' + errText(res && res.error ? res.error : (res || '引擎没有返回结果')), false);
      }
    } catch (e) {
      setStatus('测试失败：' + errText(e), false);
    } finally {
      btn.textContent = oldText;
      btn.disabled = false;
    }
  }

  /* ---------- 事件 ---------- */

  sel.addEventListener('change', () => {
    applyVisibility();
    clearErrors();
    setStatus('', null);
  });

  $('save').addEventListener('click', () => { doSave(); });
  $('test').addEventListener('click', () => { doTest(); });
  $('cancel').addEventListener('click', () => { window.api.closeSelf(); });

  /* 输入框里按 Enter = 点保存 */
  for (const key of Object.keys(FIELDS)) {
    const el = $(FIELDS[key].el);
    if (!el) continue;
    if (el.tagName !== 'SELECT') {
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); $('save').click(); }
      });
    }
    /* 记下用户动过哪些字段 */
    el.addEventListener('input', () => { dirty.add(key); });
  }

  /* API Key 的显示 / 隐藏 */
  const toggleKey = $('toggle-key');
  if (toggleKey) {
    toggleKey.addEventListener('click', () => {
      const inp = $('apiKey');
      const show = inp.type === 'password';
      inp.type = show ? 'text' : 'password';
      toggleKey.textContent = show ? '隐藏' : '显示';
    });
  }

  applyVisibility();
})();
