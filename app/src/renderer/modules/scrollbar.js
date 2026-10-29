/**
 * 自绘滚动条（沿用原 Demo 实现）
 * 原生 ::-webkit-scrollbar 无法拖动，故自己画：滑块高度 = 轨道高 × (视口高 / 内容高)
 *
 * opts.blank：面板为空时也撑出一段高于视口的空白内容，
 * 让滑块保持短滑块、仍可拖动（与 Demo 的空白下方面板行为一致）
 */
export function initScrollPanel({ viewport, content, seg, thumb, pct, blank = false }) {
  let maxScroll = 0;
  let thumbH = 0;
  let dragging = false;
  let startY = 0;
  let startOffset = 0;
  let lastDownAt = 0;

  const track = thumb.parentElement;

  function metrics() {
    const vh = viewport.clientHeight;
    // 空白面板：撑出高于视口的纯空白内容区，使滑块保持短滑块、仍可拖动
    // （导入文档后内容已填充，不再需要固定高度）
    if (blank && !content.dataset.filled) {
      content.style.height = Math.max(vh * 1.9, vh + 120) + 'px';
    }
    const ch = content.scrollHeight;
    maxScroll = Math.max(0, ch - vh);
    const trackH = track.clientHeight;
    thumbH = maxScroll > 0 ? Math.max(28, trackH * (vh / ch)) : trackH;
    thumb.style.height = thumbH + 'px';
    layout();
  }

  function current() {
    return viewport.scrollTop;
  }

  function layout() {
    const trackH = track.clientHeight;
    const travel = Math.max(0, trackH - thumbH);
    const ratio = maxScroll > 0 ? current() / maxScroll : 0;
    thumb.style.top = ratio * travel + 'px';
    const pctVal = Math.round(ratio * 100);
    pct.textContent = pctVal;
    thumb.setAttribute('aria-valuenow', pctVal);
    thumb.setAttribute('aria-valuemax', maxScroll > 0 ? '100' : '0');
  }

  function scrollTo(px) {
    viewport.scrollTop = Math.max(0, Math.min(maxScroll, px));
    layout();
  }

  /* --- 拖拽滑块：用绝对坐标换算，pointer / mouse 双事件源也不会重复累加 --- */
  function beginDrag(clientY) {
    dragging = true;
    startY = clientY;
    startOffset = current();
    thumb.classList.add('dragging');
  }

  function moveDrag(clientY) {
    if (!dragging) return;
    const travel = Math.max(0, track.clientHeight - thumbH);
    const dy = clientY - startY;
    scrollTo(startOffset + (dy / travel) * maxScroll);
  }

  function endDrag() {
    if (!dragging) return;
    dragging = false;
    thumb.classList.remove('dragging');
  }

  function onDown(e) {
    if (maxScroll <= 0) return;
    // pointerdown 与 mousedown 先后触发，用时间戳去重
    const now = e.timeStamp || Date.now();
    if (now - lastDownAt < 50) return;
    lastDownAt = now;

    const rect = thumb.getBoundingClientRect();
    const clientY = e.clientY;
    const onThumb = clientY >= rect.top && clientY <= rect.bottom;
    if (onThumb || Math.abs(clientY - (rect.top + rect.height / 2)) < 16) {
      beginDrag(clientY);
      try { seg.setPointerCapture(e.pointerId); } catch (_) {}
    } else {
      const trackRect = track.getBoundingClientRect();
      const travel = Math.max(0, trackRect.height - thumbH);
      const thumbTop = clientY - trackRect.top - thumbH / 2;
      const r = Math.max(0, Math.min(1, thumbTop / travel));
      scrollTo(r * maxScroll);
    }
    e.preventDefault();
  }

  seg.addEventListener('pointerdown', onDown);
  seg.addEventListener('mousedown', onDown);
  thumb.addEventListener('pointerdown', onDown);
  thumb.addEventListener('mousedown', onDown);
  document.addEventListener('pointermove', (e) => moveDrag(e.clientY), { passive: true });
  document.addEventListener('mousemove', (e) => moveDrag(e.clientY), { passive: true });
  document.addEventListener('pointerup', endDrag);
  document.addEventListener('mouseup', endDrag);
  document.addEventListener('pointercancel', endDrag);

  viewport.addEventListener('scroll', layout, { passive: true });

  thumb.addEventListener('keydown', (e) => {
    const step = 48;
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') { scrollTo(current() + step); e.preventDefault(); }
    else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') { scrollTo(current() - step); e.preventDefault(); }
    else if (e.key === 'PageDown') { scrollTo(current() + viewport.clientHeight * 0.8); e.preventDefault(); }
    else if (e.key === 'PageUp') { scrollTo(current() - viewport.clientHeight * 0.8); e.preventDefault(); }
    else if (e.key === 'Home') { scrollTo(0); e.preventDefault(); }
    else if (e.key === 'End') { scrollTo(maxScroll); e.preventDefault(); }
  });

  viewport.addEventListener(
    'wheel',
    (e) => {
      if (maxScroll <= 0) return;
      scrollTo(current() + e.deltaY);
      e.preventDefault();
    },
    { passive: false }
  );

  const ro = new ResizeObserver(metrics);
  ro.observe(viewport);
  ro.observe(content);
  window.addEventListener('load', metrics);
  metrics();

  return { metrics, scrollTo };
}
