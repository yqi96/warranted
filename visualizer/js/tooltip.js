const ttEl      = document.getElementById('tooltip');
const ttType    = document.getElementById('tt-type');
const ttContent = document.getElementById('tt-content');
const ttMeta    = document.getElementById('tt-meta');
let ttTimeout;

function showTooltip(event, nodeData) {
  clearTimeout(ttTimeout);
  const data = (currentLayout === 'tree') ? nodeData.data : nodeData;
  ttType.textContent = data.type.toUpperCase() + '  #' + data.id;
  ttType.style.color = TYPE_COLORS[data.type] || '#8E8E93';
  ttContent.textContent = data.content || '';
  ttMeta.innerHTML = '';

  if (data.type === 'claim' && data.data?.status) {
    const chip = document.createElement('span');
    chip.className = 'tt-chip status-' + data.data.status;
    chip.textContent = data.data.status;
    ttMeta.appendChild(chip);
    const cstate = getClaimCompileState(data.data);
    if (cstate) {
      const cchip = document.createElement('span');
      cchip.className = 'tt-chip compile-badge-' + cstate;
      cchip.textContent = cstate === 'passed' ? 'compiled' : cstate;
      ttMeta.appendChild(cchip);
    }
  }

  if (data.type === 'ground') {
    const veri = data.data?.verification;
    const src  = data.data?.source;
    if (veri) {
      const chip = document.createElement('span');
      chip.className = 'tt-chip veri-' + veri;
      chip.textContent = veri === 'verified' ? '✓ verified' : '⋯ pending';
      ttMeta.appendChild(chip);
    }
    if (src) {
      const chip = document.createElement('span');
      chip.className = 'tt-chip';
      chip.style.cssText = 'background:rgba(240,233,215,0.06);color:rgba(240,233,215,0.62);border:1px solid rgba(240,233,215,0.10);border-radius:6px;';
      chip.textContent = src;
      ttMeta.appendChild(chip);
    }
    if (data.data?.ref_claim_id) {
      const chip = document.createElement('span');
      chip.className = 'tt-chip';
      chip.style.cssText = 'background:rgba(200,165,80,0.12);color:#C8A448;border:1px solid rgba(200,165,80,0.22);border-radius:6px;';
      chip.textContent = '→ Claim #' + data.data.ref_claim_id;
      ttMeta.appendChild(chip);
    }
  }

  positionTooltip(event);
  ttEl.style.display = 'block';
}

function hideTooltip() {
  ttTimeout = setTimeout(() => { ttEl.style.display = 'none'; }, 120);
}

function positionTooltip(event) {
  const pad = 14;
  let x = event.clientX + pad, y = event.clientY + pad;
  const tw = ttEl.offsetWidth || 320, th = ttEl.offsetHeight || 100;
  if (x + tw > window.innerWidth  - 8) x = event.clientX - tw - pad;
  if (y + th > window.innerHeight - 8) y = event.clientY - th - pad;
  ttEl.style.left = Math.max(8, x) + 'px';
  ttEl.style.top  = Math.max(8, y) + 'px';
}

function showEdgeTooltip(event, edgeType) {
  clearTimeout(ttTimeout);
  const label = edgeType.replace(/_/g, ' ').toUpperCase();
  ttType.textContent = '── ' + label + ' ──';
  ttType.style.color = EDGE_COLORS[edgeType] ? 'rgba(200,164,72,0.65)' : 'rgba(255,255,255,0.40)';
  ttContent.textContent = '';
  ttMeta.innerHTML = '';
  positionTooltip(event);
  ttEl.style.display = 'block';
}

document.addEventListener('mousemove', e => {
  if (ttEl.style.display === 'block') positionTooltip(e);
});
