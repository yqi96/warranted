// Canvas-based animated beam background for Phase 1 dashboard.
// Beams are pushed to the left and right edges — center stays dark
// so the content reads cleanly against a mostly-black background.
function initPhase1Bg() {
  const bg = document.getElementById('phase1-bg');
  if (!bg) return;
  bg.innerHTML = '';

  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;';
  bg.appendChild(canvas);

  const ctx = canvas.getContext('2d');
  let W = 0, H = 0, dpr = 1;

  function resize() {
    dpr = window.devicePixelRatio || 1;
    W = Math.round(bg.offsetWidth  * dpr);
    H = Math.round(bg.offsetHeight * dpr);
    canvas.width  = W;
    canvas.height = H;
  }
  new ResizeObserver(resize).observe(bg);
  resize();

  // Left-side beams: warm gold/ember — anchor near x=0
  // Right-side beams: cool violet/indigo — anchor near x=1
  // hw = half-width in logical px (multiplied by dpr at draw time)
  // bp = breathe phase offset, dp = drift phase offset
  const BEAMS = [
    // ── Left edge ──────────────────────────────────────────
    { x: -0.04, hw: 110, rgb: [230, 170,  55], bp: 0.00, dp: 0.00, peak: 0.38 },
    { x:  0.08, hw:  70, rgb: [210, 120,  30], bp: 2.60, dp: 1.50, peak: 0.26 },
    { x:  0.16, hw:  45, rgb: [200, 145,  50], bp: 4.80, dp: 3.10, peak: 0.16 },
    // ── Right edge ─────────────────────────────────────────
    { x:  0.84, hw:  45, rgb: [140, 110, 210], bp: 1.20, dp: 2.40, peak: 0.16 },
    { x:  0.92, hw:  70, rgb: [120,  90, 200], bp: 3.40, dp: 0.90, peak: 0.26 },
    { x:  1.04, hw: 110, rgb: [100,  80, 190], bp: 5.60, dp: 4.30, peak: 0.38 },
  ];

  const ANGLE = -36 * Math.PI / 180;
  // Each beam breathes between (peak * 0.30) and peak
  const BREATHE_LOW = 0.30;

  function draw(ts) {
    if (!W || !H) { requestAnimationFrame(draw); return; }
    ctx.clearRect(0, 0, W, H);

    BEAMS.forEach(b => {
      const breathe = BREATHE_LOW + (1 - BREATHE_LOW) * (0.5 + 0.5 * Math.sin(ts * 0.00055 + b.bp));
      const drift   = Math.sin(ts * 0.00028 + b.dp) * 18 * dpr;
      const cx      = b.x * W + drift;
      const hw      = b.hw * dpr;
      const alpha   = b.peak * breathe;
      const [r, g, bv] = b.rgb;

      ctx.save();
      ctx.translate(cx, H * 0.5);
      ctx.rotate(ANGLE);

      const grad = ctx.createLinearGradient(-hw, 0, hw, 0);
      grad.addColorStop(0.00, `rgba(${r},${g},${bv},0)`);
      grad.addColorStop(0.30, `rgba(${r},${g},${bv},${(alpha * 0.5).toFixed(3)})`);
      grad.addColorStop(0.50, `rgba(${r},${g},${bv},${alpha.toFixed(3)})`);
      grad.addColorStop(0.70, `rgba(${r},${g},${bv},${(alpha * 0.5).toFixed(3)})`);
      grad.addColorStop(1.00, `rgba(${r},${g},${bv},0)`);

      ctx.fillStyle = grad;
      const diag = Math.hypot(W, H);
      ctx.fillRect(-hw, -diag, hw * 2, diag * 2);
      ctx.restore();
    });

    requestAnimationFrame(draw);
  }

  requestAnimationFrame(draw);
}

document.addEventListener('DOMContentLoaded', initPhase1Bg);
