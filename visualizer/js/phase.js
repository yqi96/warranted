// ── Phase 1 / Phase 2 transition ──
// Phase 1: full-screen dashboard. Phase 2: graph view.
// FLIP animation: total-node big number flies to status bar.

const PHASE_KEY = 'toulmin-phase';

function initPhase() {
  const savedPhase = localStorage.getItem(PHASE_KEY);

  const phase1 = document.getElementById('phase-1');
  const phase2 = document.getElementById('phase-2');

  if (savedPhase === '2') {
    // Suppress transitions for instant initial positioning
    document.body.classList.add('no-transition');
    phase1.classList.add('hidden');
    phase2.classList.add('active');
    requestAnimationFrame(() => requestAnimationFrame(() => {
      document.body.classList.remove('no-transition');
    }));
  }
}

// Animate stat number from 0 to target
function animateCount(el, target, duration) {
  const start = performance.now();
  const from = 0;
  function step(now) {
    const t = Math.min((now - start) / duration, 1);
    const ease = 1 - Math.pow(1 - t, 3); // ease-out cubic
    el.textContent = Math.round(from + (target - from) * ease);
    if (t < 1) requestAnimationFrame(step);
    else el.textContent = target;
  }
  requestAnimationFrame(step);
}

// Update Phase 1 dashboard stats
//
// 三个数字答三个问题：挣到正向档的有多少、还没挣到的有多少、有多少条等着人看一眼。
// 最后一个不是"错误数"——标红是提示不是拒绝(design.md §2.5)。
function updatePhase1Stats(nodes, stats, totalArg) {
  const total    = totalArg ?? Object.values(stats).reduce((a, b) => a + b, 0);
  const settled  = (stats.possibly || 0) + (stats.probably || 0) + (stats.certainly || 0);
  const open     = stats.unestablished || 0;
  const flagged  = nodes.filter(hasAttention).length;

  const totalEl    = document.getElementById('phase1-total-num');
  const settledEl  = document.getElementById('phase1-settled');
  const openEl     = document.getElementById('phase1-open');
  const flaggedEl  = document.getElementById('phase1-flagged');

  if (!totalEl) return;

  // First load: animate counting up
  const wasZero = parseInt(totalEl.textContent) === 0;
  if (wasZero && total > 0) {
    animateCount(totalEl,   total,   900);
    animateCount(settledEl, settled, 800);
    animateCount(openEl,    open,    850);
    animateCount(flaggedEl, flagged, 820);
  } else {
    totalEl.textContent   = total;
    settledEl.textContent = settled;
    openEl.textContent    = open;
    flaggedEl.textContent = flagged;
  }

  // Attention items
  buildAttentionItems(nodes, stats);
}

function buildAttentionItems(nodes, stats) {
  const container = document.getElementById('phase1-attention');
  if (!container) return;
  container.innerHTML = '';

  const add = (cls, text) => {
    const item = document.createElement('div');
    item.className = 'attention-item' + (cls ? ' ' + cls : '');
    item.textContent = text;
    container.appendChild(item);
  };

  const warned  = nodes.filter(n => (n.warnings?.pending || 0) > 0);
  const found   = nodes.filter(n => (n.findings?.pending || 0) > 0);
  const bare    = nodes.filter(n => isPositive(n) && nodeStructure(n) === 'bare');
  const refuted = stats.refuted || 0;

  // 结构检查只"照"不"判"：这里列的是该重查的触发点，不是结论。
  if (warned.length) add('warning', `⚑ ${warned.length} 条命题有未处理的结构警告`);
  if (found.length)  add('warning', `⚑ ${found.length} 条命题有未处理的 finding`);
  // 正向档却空证据槽——S1 会报，单独提一句是因为它是最常见的那一种。
  if (bare.length)   add('', `○ ${bare.length} 条正向档命题证据槽为空`);
  if (refuted)       add('', `✕ ${refuted} 条已被推翻(仍可作为证据使用)`);
  if (!container.children.length) add('', '— 没有待处理项');
}

// Transition Phase 1 → Phase 2 with FLIP animation
function enterGraph() {
  const phase1 = document.getElementById('phase-1');
  const phase2 = document.getElementById('phase-2');
  const bigNum  = document.getElementById('phase1-total-num');
  const sbTotal = document.getElementById('stat-total');

  if (!phase1 || !phase2 || phase2.classList.contains('active')) return;

  // FLIP: record position of big number in Phase 1
  const firstRect = bigNum ? bigNum.getBoundingClientRect() : null;

  // Begin transition
  phase1.classList.add('exiting');
  phase2.classList.add('active');

  // FLIP: animate total count to status bar position
  if (firstRect && sbTotal) {
    // Show phase2 briefly to measure target position
    const lastRect = sbTotal.getBoundingClientRect();

    // Create a flying clone
    const clone = document.createElement('div');
    clone.textContent = bigNum.textContent;
    clone.style.cssText = `
      position: fixed;
      left: ${firstRect.left}px;
      top: ${firstRect.top}px;
      width: ${firstRect.width}px;
      height: ${firstRect.height}px;
      font-size: ${getComputedStyle(bigNum).fontSize};
      font-weight: 700;
      color: rgba(255,255,255,0.90);
      display: flex; align-items: center; justify-content: center;
      pointer-events: none;
      z-index: 9999;
      transition: none;
      transform-origin: center;
    `;
    document.body.appendChild(clone);

    const scaleX = lastRect.width / Math.max(firstRect.width, 1);
    const scaleY = lastRect.height / Math.max(firstRect.height, 1);
    const dx = lastRect.left + lastRect.width / 2 - (firstRect.left + firstRect.width / 2);
    const dy = lastRect.top  + lastRect.height / 2 - (firstRect.top  + firstRect.height / 2);

    requestAnimationFrame(() => {
      clone.style.transition = 'transform 0.5s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.5s ease';
      clone.style.transform  = `translate(${dx}px, ${dy}px) scale(${Math.max(scaleX, 0.1)}, ${Math.max(scaleY, 0.1)})`;
      clone.style.opacity    = '0';
      setTimeout(() => clone.remove(), 550);
    });
  }

  // Hide Phase 1 after animation
  setTimeout(() => {
    phase1.classList.add('hidden');
    phase1.classList.remove('exiting');
  }, 480);

  localStorage.setItem(PHASE_KEY, '2');
}

// Return to Phase 1 from Phase 2
function returnToPhase1() {
  const phase1 = document.getElementById('phase-1');
  const phase2 = document.getElementById('phase-2');

  if (!phase1 || !phase2 || !phase2.classList.contains('active')) return;

  // Remove hidden first so CSS transition can play (opacity/transform → visible)
  phase1.classList.remove('hidden', 'exiting');
  // Removing .active triggers phase-2 exit transition (opacity → 0, translateY → 50px)
  phase2.classList.remove('active');

  localStorage.setItem(PHASE_KEY, '1');
}

// Scroll-to-enter support
function setupPhaseScrollTrigger() {
  const phase1 = document.getElementById('phase-1');
  if (!phase1) return;

  phase1.addEventListener('wheel', e => {
    if (e.deltaY > 0) enterGraph(); // scroll down = graph is below
  }, { passive: true });

  phase1.addEventListener('touchstart', e => {
    const startY = e.touches[0].clientY;
    const onEnd = ev => {
      const dy = startY - ev.changedTouches[0].clientY;
      if (dy < -40) enterGraph(); // swipe down (finger moves down)
      phase1.removeEventListener('touchend', onEnd);
    };
    phase1.addEventListener('touchend', onEnd);
  }, { passive: true });

  const enterBtn = document.getElementById('phase1-enter');
  if (enterBtn) enterBtn.addEventListener('click', enterGraph);
}

// Initialise on DOMContentLoaded
document.addEventListener('DOMContentLoaded', () => {
  initPhase();
  setupPhaseScrollTrigger();
});
