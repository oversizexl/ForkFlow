const API = '';
const TOKEN_KEY = 'forkflow_gh_token';

function getStoredToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) || '';
  } catch {
    return '';
  }
}
function setStoredToken(token) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {}
}
function clearStoredToken() {
  setStoredToken('');
}

// 处理 OAuth 回调：URL 带 ?token= 时写入 storage 并去掉 URL 中的 token
function handleOAuthCallback() {
  const params = new URLSearchParams(window.location.search);
  const token = params.get('token');
  const authError = params.get('auth');
  if (token) {
    setStoredToken(token);
    params.delete('token');
    const qs = params.toString();
    const newUrl = window.location.pathname + (qs ? '?' + qs : '') + window.location.hash;
    window.history.replaceState({}, '', newUrl);
    return true;
  }
  if (authError) {
    params.delete('auth');
    params.delete('msg');
    const qs = params.toString();
    window.history.replaceState({}, '', window.location.pathname + (qs ? '?' + qs : ''));
    showToast('GitHub 登录失败，请重试', 'error');
  }
  return false;
}

/** 根据 token 更新顶栏登录态；有 token 时请求一次 /api/current-user，供首屏与 Owner 预填复用 */
async function updateAuthUI() {
  const hasToken = !!getStoredToken();
  const loginBtn = document.getElementById('loginBtn');
  const logoutBtn = document.getElementById('logoutBtn');
  const authUser = document.getElementById('authUser');
  const authAvatar = document.getElementById('authAvatar');
  const authName = document.getElementById('authName');

  if (!hasToken) {
    if (loginBtn) loginBtn.style.display = 'inline-flex';
    if (logoutBtn) logoutBtn.style.display = 'none';
    if (authUser) authUser.style.display = 'none';
    return null;
  }

  if (loginBtn) loginBtn.style.display = 'none';
  if (logoutBtn) logoutBtn.style.display = 'inline-flex';

  if (!authUser || !authAvatar || !authName) return null;

  try {
    const data = await api('/api/current-user');
    if (!data.ok) return null;
    authUser.style.display = 'flex';
    authAvatar.src =
      data.avatar_url || 'https://avatars.githubusercontent.com/u/9919?v=4';
    authName.textContent = data.login || data.name || '';
    return data;
  } catch {
    // 忽略用户信息获取失败，只保留登录/退出按钮状态
    return null;
  }
}

function showToast(message, type = 'info') {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.className = `toast ${type} show`;
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => {
    el.classList.remove('show');
  }, 3500);
}

// 通用确认弹框，返回 Promise<boolean>
function confirmDialog(message, title = '请确认操作') {
  return new Promise((resolve) => {
    const modal = document.getElementById('confirmModal');
    const titleEl = document.getElementById('confirmTitle');
    const msgEl = document.getElementById('confirmMessage');
    const okBtn = document.getElementById('confirmOkBtn');
    const cancelBtn = document.getElementById('confirmCancelBtn');

    if (!modal || !okBtn || !cancelBtn || !titleEl || !msgEl) {
      // 兜底：如果元素不存在，退回原生 confirm
      // eslint-disable-next-line no-alert
      resolve(window.confirm(message));
      return;
    }

    titleEl.textContent = title;
    msgEl.textContent = message;

    modal.classList.add('show');
    modal.setAttribute('aria-hidden', 'false');

    const cleanup = (result) => {
      modal.classList.remove('show');
      modal.setAttribute('aria-hidden', 'true');
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      modal.removeEventListener('click', onBackdrop);
      document.removeEventListener('keydown', onKeydown);
      resolve(result);
    };

    const onOk = (e) => {
      e.preventDefault();
      cleanup(true);
    };
    const onCancel = (e) => {
      e.preventDefault();
      cleanup(false);
    };
    const onBackdrop = (e) => {
      if (e.target === modal) {
        cleanup(false);
      }
    };
    const onKeydown = (e) => {
      if (e.key === 'Escape') {
        cleanup(false);
      }
    };

    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    modal.addEventListener('click', onBackdrop);
    document.addEventListener('keydown', onKeydown);
  });
}

// 刷新 Loading 弹框
function showLoadingModal(message) {
  const modal = document.getElementById('loadingModal');
  const msgEl = document.getElementById('loadingMessage');
  if (!modal || !msgEl) return;
  if (message) msgEl.textContent = message;
  modal.classList.add('show');
  modal.setAttribute('aria-hidden', 'false');
}

function hideLoadingModal() {
  const modal = document.getElementById('loadingModal');
  if (!modal) return;
  modal.classList.remove('show');
  modal.setAttribute('aria-hidden', 'true');
}

async function api(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...options.headers };
  const token = getStoredToken();
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const res = await fetch(API + path, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    clearStoredToken();
    void updateAuthUI();
  }
  if (!res.ok) throw new Error(data.message || res.statusText);
  return data;
}

let allReposCache = [];
let searchKeyword = '';
let currentPage = 1;
const PAGE_SIZE = 10;
let filterMode = 'all'; // 'all' | 'behind'

// 支持多关键词模糊匹配（空格分词，全部命中即可）
function applyFilter() {
  const kw = searchKeyword.trim().toLowerCase();
  let base = allReposCache;

  if (filterMode === 'behind') {
    base = base.filter((r) => r.isBehindUpstream);
  }

  if (!kw) return base;

  const tokens = kw.split(/\s+/).filter(Boolean);

  return base.filter((r) => {
    const name = (r.label || `${r.owner}/${r.repo}`).toLowerCase();
    const full = `${r.owner}/${r.repo}`.toLowerCase();
    const branch = (r.branch || 'main').toLowerCase();
    const id = String(r.id || '').toLowerCase();
    const upstream = (r.upstreamFullName || '').toLowerCase();

    const haystack = `${name} ${full} ${branch} ${id} ${upstream}`;
    // 所有关键词都要在任意字段中出现
    return tokens.every((t) => haystack.includes(t));
  });
}

function updateTotal(count) {
  const el = document.getElementById('repoTotal');
  if (el) {
    el.textContent = `总数：${count}`;
  }
}

function shortSha(sha) {
  if (!sha) return '';
  return sha.slice(0, 7);
}

function formatTime(t) {
  if (!t) return '';
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString();
}

function renderList(repos) {
  const tbody = document.getElementById('repoList');
  const list = Array.isArray(repos) ? [...repos] : [];
  // 按 fork 时间倒序：最近更新时间在前；没有时间的排在最后
  list.sort((a, b) => {
    const ta = a && a.forkPushedAt ? new Date(a.forkPushedAt).getTime() : 0;
    const tb = b && b.forkPushedAt ? new Date(b.forkPushedAt).getTime() : 0;
    return tb - ta;
  });
  allReposCache = list;
  const filtered = applyFilter();
  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (currentPage > totalPages) currentPage = totalPages;

  updateTotal(allReposCache.length);

  const start = (currentPage - 1) * PAGE_SIZE;
  const visible = filtered.slice(start, start + PAGE_SIZE);

  if (visible.length === 0) {
    tbody.innerHTML =
      '<tr class="empty"><td colspan="4">暂无仓库，请先添加 Fork 仓库</td></tr>';
    renderPagination(0, 1);
    return;
  }
  tbody.innerHTML = visible
    .map(
      (r) => `
    <tr data-id="${r.id}">
      <td>
        <div class="name-main">
          <a class="repo-link" href="https://github.com/${r.upstreamFullName || `${r.owner}/${r.repo}`}" target="_blank" rel="noopener">${
            escapeHtml(r.upstreamFullName || `${r.owner}/${r.repo}`)
          }</a>
        </div>
        <div class="name-meta">
          ${
            r.upstreamFullName || r.upstreamPushedAt || r.upstreamLastCommitSha
              ? `<a class="commit-line-link" href="https://github.com/${
                  r.upstreamFullName || `${r.owner}/${r.repo}`
                }/commit/${r.upstreamLastCommitSha || ''}" target="_blank" rel="noopener noreferrer">
                  <span class="commit-line">
                    <span class="commit-time">${escapeHtml(
                      formatTime(r.upstreamPushedAt) || '未知时间'
                    )}</span>${
                      r.upstreamLastCommitSha
                        ? escapeHtml(` · ${shortSha(r.upstreamLastCommitSha)}`)
                        : ''
                    }${
                      r.upstreamLastCommitMessage
                        ? escapeHtml(` · ${r.upstreamLastCommitMessage}`)
                        : ''
                    }
                  </span>
                </a>`
              : ''
          }
        </div>
      </td>
      <td>
        <div class="name-main">
          <a class="repo-link" href="https://github.com/${r.owner}/${r.repo}" target="_blank" rel="noopener">
            ${escapeHtml(r.label || `${r.owner}/${r.repo}`)}
          </a>
          ${
            r.isBehindUpstream
              ? '<span class="repo-status-pill repo-status-behind">需同步</span>'
              : ''
          }
        </div>
        <div class="name-meta">
          ${
            r.forkPushedAt || r.forkLastCommitSha
              ? `<a class="commit-line-link" href="https://github.com/${r.owner}/${r.repo}/commit/${
                  r.forkLastCommitSha || ''
                }" target="_blank" rel="noopener noreferrer">
                  <span class="commit-line">
                    <span class="commit-time">${escapeHtml(
                      formatTime(r.forkPushedAt) || '未知时间'
                    )}</span>${
                      r.forkLastCommitSha
                        ? escapeHtml(` · ${shortSha(r.forkLastCommitSha)}`)
                        : ''
                    }${
                      r.forkLastCommitMessage
                        ? escapeHtml(` · ${r.forkLastCommitMessage}`)
                        : ''
                    }
                  </span>
                </a>`
              : ''
          }
        </div>
      </td>
      <td><code>${escapeHtml(r.branch || 'main')}</code></td>
      <td>
        <div class="cell-actions">
          <button type="button" class="btn btn-primary btn-sm sync-one" data-id="${r.id}">同步</button>
          <button type="button" class="btn btn-danger btn-sm delete-one" data-id="${r.id}">删除</button>
        </div>
        <div class="cell-status" id="status-${r.id}"></div>
      </td>
    </tr>`
    )
    .join('');

  tbody.querySelectorAll('.sync-one').forEach((btn) => {
    btn.addEventListener('click', () => syncOne(btn.dataset.id));
  });
  tbody.querySelectorAll('.delete-one').forEach((btn) => {
    btn.addEventListener('click', () => deleteOne(btn.dataset.id));
  });

  renderPagination(total, totalPages);
}

function renderPagination(total, totalPages) {
  const el = document.getElementById('pagination');
  if (!el) return;
  if (total === 0) {
    el.innerHTML = '<span>暂无数据</span>';
    return;
  }
  el.innerHTML = `
    <div>共 ${total} 条 · 第 ${currentPage} / ${totalPages} 页</div>
    <div class="pagination-controls">
      <button id="pagePrev" ${currentPage === 1 ? 'disabled' : ''}>上一页</button>
      <button id="pageNext" ${currentPage === totalPages ? 'disabled' : ''}>下一页</button>
    </div>
  `;
  const prev = document.getElementById('pagePrev');
  const next = document.getElementById('pageNext');
  if (prev) {
    prev.onclick = () => {
      if (currentPage > 1) {
        currentPage -= 1;
        renderList(allReposCache);
      }
    };
  }
  if (next) {
    next.onclick = () => {
      if (currentPage < totalPages) {
        currentPage += 1;
        renderList(allReposCache);
      }
    };
  }
}

function escapeHtml(s) {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

function setCellStatus(id, text, ok) {
  const el = document.getElementById(`status-${id}`);
  if (!el) return;
  el.textContent = text;
  el.className = 'cell-status ' + (ok ? 'ok' : 'fail');
}

async function loadRepos() {
  try {
    const { data } = await api('/api/repos');
    renderList(data || []);
  } catch (e) {
    showToast('加载列表失败: ' + e.message, 'error');
  }
}

async function syncOne(id) {
  const btn = document.querySelector(`.sync-one[data-id="${id}"]`);
  if (btn) btn.disabled = true;
  setCellStatus(id, '同步中…', true);
  try {
    const result = await api(`/api/sync/${id}`, { method: 'POST' });
    const msg = result.message || (result.ok ? '已同步' : '失败');
    setCellStatus(id, msg, result.ok);
    showToast(result.ok ? '同步成功' : msg, result.ok ? 'success' : 'error');
    if (result.ok) {
      // 同步成功后，只拉取该仓库的新数据，更新缓存并局部刷新列表
      const one = await api(`/api/repos/${id}`);
      if (one && one.ok && one.data) {
        const idx = allReposCache.findIndex((r) => String(r.id) === String(id));
        if (idx !== -1) {
          allReposCache[idx] = one.data;
        }
        renderList(allReposCache);
      }
    }
  } catch (e) {
    const msg = e.message || '';
    setCellStatus(id, msg, false);
    showToast(msg, 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function deleteOne(id) {
  const ok = await confirmDialog('确定要从列表中移除该仓库吗？此操作不会取消对该项目的 Fork。', '确认移除仓库');
  if (!ok) return;
  try {
    await api(`/api/repos/${id}`, { method: 'DELETE' });
    showToast('已移除', 'success');
    loadRepos();
  } catch (e) {
    showToast('删除失败: ' + e.message, 'error');
  }
}

async function syncAll() {
  const btn = document.getElementById('syncAllBtn');
  const resultEl = document.getElementById('batchResult');
  const ok = await confirmDialog(
    '将对所有已配置的仓库依次执行同步操作，可能需要一定时间，确定要开始吗？',
    '确认一键批量同步'
  );
  if (!ok) return;

  btn.disabled = true;
  // 使用统一 loading 弹框
  showLoadingModal('正在对所有仓库执行一键批量同步，这可能需要一点时间…');

  const loadingCancelBtn = document.getElementById('loadingCancelBtn');
  const controller = new AbortController();
  let cancelled = false;

  const handleCancel = () => {
    if (cancelled) return;
    cancelled = true;
    controller.abort();
    hideLoadingModal();
    btn.disabled = false;
    showToast('批量同步已取消', 'info');
    // 取消后收起批量结果区域
    resultEl.className = 'batch-result';
    resultEl.innerHTML = '';
  };

  if (loadingCancelBtn) {
    loadingCancelBtn.onclick = handleCancel;
  }

  resultEl.className = 'batch-result visible';
  resultEl.innerHTML = '<p>正在批量同步…</p>';
  try {
    let cursor = 0;
    const limit = 8;
    const allData = [];
    let lastMessage = '';

    // Worker 等有 subrequest 上限：与 refresh-meta 一样分批请求
    while (true) {
      const qs = `?cursor=${cursor}&limit=${limit}`;
      const result = await api('/api/sync-all' + qs, {
        method: 'POST',
        signal: controller.signal,
      });
      lastMessage = result.message || lastMessage;
      if (cancelled) return;

      if (Array.isArray(result.data) && result.data.length) {
        allData.push(...result.data);
      }

      if (typeof result.total === 'number' && typeof result.processed === 'number') {
        const done = Math.min(result.total, cursor + result.processed);
        showLoadingModal(`正在批量同步…（${done}/${result.total}）`);
      }

      if (result.nextCursor === null || result.nextCursor === undefined) {
        break;
      }
      cursor = Number(result.nextCursor) || 0;
    }

    if (cancelled) return;
    const data = allData;
    if (!data || data.length === 0) {
      resultEl.innerHTML = `<p>${lastMessage || '暂无仓库或已同步'}</p>`;
      showToast(lastMessage || '完成', 'info');
      return;
    }
    const ok = data.filter((r) => r.success);
    const fail = data.filter((r) => !r.success);
    resultEl.innerHTML = `
      <h3>批量同步结果</h3>
      <ul>
        ${ok.map((r) => `<li class="ok">${r.owner}/${r.repo}: ${r.message || '成功'}</li>`).join('')}
        ${fail.map((r) => `<li class="fail">${r.owner}/${r.repo}: ${r.message || '失败'}</li>`).join('')}
      </ul>
    `;
    showToast(`已处理 ${data.length} 个仓库，成功 ${ok.length}，失败 ${fail.length}`, fail.length ? 'error' : 'success');
    loadRepos();
  } catch (e) {
    if (!cancelled && e.name !== 'AbortError') {
      resultEl.innerHTML = `<p class="fail">${escapeHtml(e.message)}</p>`;
      showToast(e.message, 'error');
    }
  } finally {
    if (!cancelled) {
      hideLoadingModal();
      btn.disabled = false;
    }
  }
}

const addSection = document.getElementById('addSection');
const addForm = document.getElementById('addForm');
const addOpenBtn = document.getElementById('addOpenBtn');
const addCancelBtn = document.getElementById('addCancelBtn');
const ownerInput = document.getElementById('owner');

addOpenBtn.addEventListener('click', () => {
  addSection.classList.remove('collapsed');
});

addCancelBtn.addEventListener('click', () => {
  addSection.classList.add('collapsed');
});

addForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(addForm);
  const owner = (fd.get('owner') || '').trim();
  const repo = (fd.get('repo') || '').trim();
  const branch = (fd.get('branch') || 'main').trim() || 'main';
  const label = (fd.get('label') || '').trim();
  if (!repo) {
    showToast('请填写 Repo', 'error');
    return;
  }
  try {
    await api('/api/repos', {
      method: 'POST',
      body: JSON.stringify({ owner, repo, branch, label }),
    });
    showToast('已添加', 'success');
    addForm.reset();
    addSection.classList.add('collapsed');
    loadRepos();
  } catch (e) {
    showToast(e.message, 'error');
  }
});

document.getElementById('syncAllBtn').addEventListener('click', syncAll);

// OAuth 回调与登录/登出 UI（只请求一次 current-user：顶栏 + Owner 预填 + loadRepos）
handleOAuthCallback();
(async () => {
  const user = await updateAuthUI();
  if (ownerInput && user?.ok && user.login && !ownerInput.value) {
    ownerInput.value = user.login;
  }
  if (user?.ok) {
    await loadRepos();
  }
})();
document.getElementById('loginBtn')?.addEventListener('click', () => {
  window.location.href = API + '/api/auth/login';
});
document.getElementById('logoutBtn')?.addEventListener('click', () => {
  clearStoredToken();
  void updateAuthUI();
  const ownerInput = document.getElementById('owner');
  if (ownerInput) ownerInput.value = '';
  allReposCache = [];
  renderList(allReposCache);
  showToast('已退出登录', 'info');
});

// 列表筛选：全部 / 仅需同步
document.getElementById('filterAllBtn')?.addEventListener('click', () => {
  filterMode = 'all';
  document.getElementById('filterAllBtn').classList.add('filter-btn-active');
  document.getElementById('filterBehindBtn').classList.remove('filter-btn-active');
  renderList(allReposCache);
});

document.getElementById('filterBehindBtn')?.addEventListener('click', () => {
  filterMode = 'behind';
  document.getElementById('filterBehindBtn').classList.add('filter-btn-active');
  document.getElementById('filterAllBtn').classList.remove('filter-btn-active');
  renderList(allReposCache);
});

// 搜索框监听
const searchInput = document.getElementById('searchInput');
if (searchInput) {
  searchInput.addEventListener('input', () => {
    searchKeyword = searchInput.value || '';
    currentPage = 1;
    // 如果清空输入，则重新拉一次数据，保证列表完整 & 计数准确
    if (!searchKeyword.trim()) {
      loadRepos();
    } else {
      renderList(allReposCache);
    }
  });
}

// 刷新仓库元信息（fork / upstream 时间和 commit）
const refreshMetaBtn = document.getElementById('refreshMetaBtn');
if (refreshMetaBtn) {
  refreshMetaBtn.addEventListener('click', async () => {
    const ok = await confirmDialog(
      '将调用 GitHub API 刷新所有仓库的最新时间和 commit，可能稍微有点慢，继续吗？',
      '确认刷新仓库信息'
    );
    if (!ok) return;

    refreshMetaBtn.disabled = true;
    showLoadingModal('正在调用 GitHub API 获取最新时间和 commit，这可能需要一点时间…');

    const loadingCancelBtn = document.getElementById('loadingCancelBtn');
    const controller = new AbortController();
    let cancelled = false;

    const handleCancel = () => {
      if (cancelled) return;
      cancelled = true;
      controller.abort();
      hideLoadingModal();
      refreshMetaBtn.disabled = false;
      showToast('刷新已取消', 'info');
    };

    if (loadingCancelBtn) {
      loadingCancelBtn.onclick = handleCancel;
    }

    try {
      let cursor = 0;
      // 与 Worker 默认一致：避免单次请求 GitHub subrequest 超过 CF 免费档上限（约 50）
      const limit = 6;
      let lastMessage = '';

      // Worker 端会分批刷新；这里循环跑完所有批次，避免只刷新前几个仓库
      // Node 端若返回不含 nextCursor，也会在第一轮直接结束
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const qs = `?cursor=${cursor}&limit=${limit}`;
        const result = await api('/api/refresh-meta' + qs, {
          method: 'POST',
          signal: controller.signal,
        });
        lastMessage = result.message || lastMessage;

        if (cancelled) return;

        if (typeof result.total === 'number' && typeof result.processed === 'number') {
          const done = Math.min(result.total, cursor + result.processed);
          showLoadingModal(`正在刷新仓库信息…（${done}/${result.total}）`);
        }

        if (result.nextCursor === null || result.nextCursor === undefined) {
          break;
        }
        cursor = Number(result.nextCursor) || 0;
      }
      if (cancelled) return;
      showToast(lastMessage || '刷新完成', 'success');
      loadRepos();
    } catch (e) {
      if (cancelled || e.name === 'AbortError') return;
      showToast(e.message, 'error');
    } finally {
      if (!cancelled) {
        hideLoadingModal();
        refreshMetaBtn.disabled = false;
      }
    }
  });
}

// 一键导入当前账号下所有 fork 仓库
const importForksBtn = document.getElementById('importForksBtn');
if (importForksBtn) {
  importForksBtn.addEventListener('click', async () => {
    const ok = await confirmDialog(
      '将从当前 Token 对应账号中导入所有 Fork 仓库，已存在的会自动跳过，继续吗？',
      '确认导入所有 Fork 仓库'
    );
    if (!ok) return;

    importForksBtn.disabled = true;
    showLoadingModal('正在导入当前账号下所有 Fork 仓库，这可能需要一点时间…');

    const loadingCancelBtn = document.getElementById('loadingCancelBtn');
    const controller = new AbortController();
    let cancelled = false;

    const handleCancel = () => {
      if (cancelled) return;
      cancelled = true;
      controller.abort();
      hideLoadingModal();
      importForksBtn.disabled = false;
      showToast('导入已取消', 'info');
    };

    if (loadingCancelBtn) {
      loadingCancelBtn.onclick = handleCancel;
    }

    try {
      const { message } = await api('/api/import-forks', {
        method: 'POST',
        signal: controller.signal,
      });
      if (!cancelled) {
        showToast(message || '导入完成', 'success');
        loadRepos();
      }
    } catch (e) {
      if (!cancelled && e.name !== 'AbortError') {
        showToast(e.message, 'error');
      }
    } finally {
      if (!cancelled) {
        hideLoadingModal();
        importForksBtn.disabled = false;
      }
    }
  });
}
