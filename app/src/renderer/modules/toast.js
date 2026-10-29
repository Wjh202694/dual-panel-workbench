/** 轻量提示条 */
export function createToaster(host) {
  function show(message, kind = 'info', ms = 3200) {
    const el = document.createElement('div');
    el.className = 'toast' + (kind === 'info' ? '' : ' toast--' + kind);
    el.textContent = message;
    host.appendChild(el);
    setTimeout(() => {
      el.style.transition = 'opacity .2s ease';
      el.style.opacity = '0';
      setTimeout(() => el.remove(), 220);
    }, ms);
    return el;
  }
  return { show };
}
