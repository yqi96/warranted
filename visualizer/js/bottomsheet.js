// ── Bottom Sheet ──
// Slides up from bottom to show node details.
// openBottomSheet(data)  — open or crossfade to new node
// closeBottomSheet()     — slide down and clear

let _bsCurrentNodeId = null;
let _bsOpen = false;

function openBottomSheet(data) {
  const sheet   = document.getElementById('bottom-sheet');
  const content = document.getElementById('bs-content');
  const nodeId  = String(data.id);

  if (_bsCurrentNodeId === nodeId && _bsOpen) return;

  if (_bsOpen) {
    // Already open: crossfade to new node content
    content.classList.add('switching');
    setTimeout(() => {
      content.innerHTML = buildNodeDetailHtml(data);
      content.classList.remove('switching');
      _bsCurrentNodeId = nodeId;
    }, 180);
  } else {
    content.innerHTML = buildNodeDetailHtml(data);
    sheet.classList.add('open');
    _bsCurrentNodeId = nodeId;
    _bsOpen = true;
  }
}

function closeBottomSheet() {
  const sheet   = document.getElementById('bottom-sheet');
  const content = document.getElementById('bs-content');
  sheet.classList.remove('open');
  _bsOpen = false;
  _bsCurrentNodeId = null;
  setTimeout(() => { if (!_bsOpen) content.innerHTML = ''; }, 350);
}
