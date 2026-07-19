const dbPathInput = document.getElementById('db-path-input');
const dbSwitchBtn = document.getElementById('db-switch-btn');
const dbStatusEl  = document.getElementById('db-status');

function setDbCurrentPath(path) {
  const el1 = document.getElementById('db-current-path');
  const el2 = document.getElementById('db-current-path-2');
  if (el1) el1.textContent = path;
  if (el2) el2.textContent = path;
}

async function loadCurrentDb() {
  try {
    const res = await fetch('viz/current-db');
    const { dir } = await res.json();
    setDbCurrentPath(dir);
  } catch { setDbCurrentPath('未知'); }
}

function showDbStatus(type, msg) {
  dbStatusEl.className = 'db-status ' + type;
  dbStatusEl.textContent = msg;
  if (type === 'success') setTimeout(() => { dbStatusEl.className = 'db-status'; }, 3000);
}

dbSwitchBtn.addEventListener('click', async () => {
  const dir = dbPathInput.value.trim();
  if (!dir) { showDbStatus('error', '请输入目录路径'); return; }
  dbSwitchBtn.disabled = true;
  try {
    const res = await fetch('viz/switch-db', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dir })
    });
    const text = await res.text();
    let result;
    try { result = JSON.parse(text); } catch {
      showDbStatus('error', '切换失败: 服务器返回非 JSON 响应 — ' + text.slice(0, 120));
      return;
    }
    if (result.success) {
      showDbStatus('success', '✓ 已切换');
      setDbCurrentPath(dir);
      dbPathInput.value = '';
    } else {
      showDbStatus('error', result.error || '切换失败');
    }
  } catch (err) {
    showDbStatus('error', '切换失败: ' + err.message);
  } finally {
    dbSwitchBtn.disabled = false;
  }
});

dbPathInput.addEventListener('keydown', e => { if (e.key === 'Enter') dbSwitchBtn.click(); });

loadCurrentDb();
