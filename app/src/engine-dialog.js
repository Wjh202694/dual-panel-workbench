/**
 * 提炼引擎设置窗口（独立小窗口，不动主界面）
 */
(async function () {
  const $ = (id) => document.getElementById(id);

  const engines = await window.api.listEngines();
  const sel = $('engine');
  for (const e of engines) {
    const o = document.createElement('option');
    o.value = e.id;
    o.textContent = e.label;
    sel.appendChild(o);
  }

  const cfg = await window.api.getEngineSettings();
  sel.value = cfg.engine || 'opencode';
  $('model').value = cfg.model || '';
  $('cmd').value = cfg.customCommand || '';

  $('save').addEventListener('click', async () => {
    const patch = {
      engine: sel.value,
      model: $('model').value.trim(),
      customCommand: $('cmd').value.trim(),
    };
    await window.api.saveEngineSettings(patch);
  });

  $('cancel').addEventListener('click', () => {
    window.api.closeSelf();
  });

  $('model').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('save').click();
  });
})();
