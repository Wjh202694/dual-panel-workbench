/**
 * 可拖动的中缝：调整上下两个面板的高度比
 * 关键点（沿用 Demo 的踩坑结论）：
 *  - 拖拽基准用「起始时的像素高度」，不是比例值，否则拖拽中比例持续漂移
 *  - 可用总高度恒定：屏幕高 − 顶栏 − 分割线
 */
export function initSplit({ split, label, screen, topEl, bottomEl, topbar, onChange }) {
  const PHI = 1.618;

  let ratio = PHI;
  let dragging = false;
  let startClientY = 0;
  let startHeight = 0;
  let lastDownAt = 0;

  function usableHeight() {
    const sH = screen.getBoundingClientRect().height;
    const tH = topbar ? topbar.getBoundingClientRect().height : 0;
    const spH = split.getBoundingClientRect().height;
    return Math.max(80, sH - tH - spH);
  }

  function heightToRatio(h) {
    const bottom = usableHeight() - h;
    if (bottom <= 0) return 20;
    return h / bottom;
  }

  function applyRatio(r) {
    ratio = Math.max(0.15, Math.min(20, r));
    screen.style.setProperty('--split-ratio', ratio.toFixed(4));
    const short = ratio >= 1;
    const a = short ? ratio : 1;
    const b = short ? 1 : ratio;
    label.textContent = a.toFixed(a >= 10 ? 1 : 3) + ' : ' + b.toFixed(b >= 10 ? 1 : 3);
    split.setAttribute('aria-valuenow', ratio.toFixed(3));
    split.setAttribute('aria-valuetext', '上方 : 下方 = ' + label.textContent);
    if (onChange) onChange(ratio);
  }

  function onSplitDown(e) {
    const now = e.timeStamp || Date.now();
    if (now - lastDownAt < 50) return;
    lastDownAt = now;
    dragging = true;
    startClientY = e.clientY;
    startHeight = topEl.getBoundingClientRect().height;
    split.classList.add('dragging');
    document.body.style.userSelect = 'none';
    // preventDefault 会阻断默认聚焦，这里显式聚焦以支持键盘操作
    try { split.focus({ preventScroll: true }); } catch (_) { split.focus(); }
    try { split.setPointerCapture(e.pointerId); } catch (_) {}
    e.preventDefault();
  }

  function onSplitMove(e) {
    if (!dragging) return;
    const dy = e.clientY - startClientY;
    const total = usableHeight();
    const newH = Math.max(40, Math.min(total - 40, startHeight + dy));
    applyRatio(heightToRatio(newH));
    e.preventDefault();
  }

  function onSplitUp() {
    if (!dragging) return;
    dragging = false;
    split.classList.remove('dragging');
    document.body.style.userSelect = '';
  }

  split.addEventListener('pointerdown', onSplitDown);
  split.addEventListener('mousedown', onSplitDown);
  document.addEventListener('pointermove', onSplitMove, { passive: false });
  document.addEventListener('mousemove', onSplitMove, { passive: false });
  document.addEventListener('pointerup', onSplitUp);
  document.addEventListener('mouseup', onSplitUp);
  document.addEventListener('pointercancel', onSplitUp);

  split.addEventListener('keydown', (e) => {
    const stepPx = e.shiftKey ? 40 : 12;
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      const total = usableHeight();
      const curH = (total * ratio) / (ratio + 1);
      const dir = e.key === 'ArrowUp' ? 1 : -1;
      const newH = Math.max(40, Math.min(total - 40, curH + dir * stepPx));
      applyRatio(heightToRatio(newH));
      e.preventDefault();
    } else if (e.key === 'Home' || e.key === 'Enter' || e.key === ' ') {
      applyRatio(PHI);
      e.preventDefault();
    }
  });

  split.addEventListener('dblclick', () => applyRatio(PHI));

  applyRatio(PHI);

  return {
    applyRatio,
    reset: () => applyRatio(PHI),
  };
}
