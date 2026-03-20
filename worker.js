import { ASSETS_CONTENT, ASSETS_TYPES } from './assets-content.js';

const GITHUB_API = 'https://api.github.com';

// GitHub 要求带 User-Agent，否则可能返回 403
function githubHeaders(token, extra = {}) {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'ForkFlow/1.0 (Cloudflare Worker)',
    ...extra,
  };
}

// 轻量重试：用于 GitHub 读取接口，降低偶发网络/限流抖动影响
// 始终返回 status（最后一次 HTTP 响应码；纯网络异常无响应时为 null）
async function fetchJsonWithRetry(url, options, retries = 1) {
  let lastRes = null;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, options);
      lastRes = res;
      const st = res.status;
      if (res.ok) {
        const data = await res.json().catch(() => null);
        return { ok: true, status: st, data };
      }
      // 对 5xx / 429 做一次重试，其余直接返回
      if (!(st >= 500 || st === 429) || i === retries) {
        let errBody = null;
        try {
          errBody = await res.json();
        } catch {
          // ignore
        }
        return { ok: false, status: st, data: errBody };
      }
    } catch (e) {
      if (i === retries) {
        return {
          ok: false,
          status: null,
          data: null,
          fetchError: (e && e.message) || String(e),
        };
      }
    }
  }
  return {
    ok: false,
    status: lastRes && lastRes.status,
    data: null,
  };
}

// KV 写入失败诊断（用于排查配额/限流等；成功路径不额外写 KV，避免加倍消耗写入次数）
const KV_WRITE_ERROR_KEY = 'forkflow_kv_write_error';

async function kvPutJson(env, key, value) {
  const body = JSON.stringify(value);
  try {
    await env.REPOS_KV.put(key, body);
  } catch (e) {
    const diag = {
      at: new Date().toISOString(),
      kvKey: key,
      message: (e && e.message) || String(e),
      name: (e && e.name) || 'Error',
      payloadBytes: body.length,
      hint:
        '若出现 quota / limit / 429 等字样，多为 KV 写入配额或限流；本应用每次 updateRepo 会整表重写一次，刷新 N 个仓库约 N 次 put。',
    };
    try {
      await env.REPOS_KV.put(KV_WRITE_ERROR_KEY, JSON.stringify(diag));
    } catch {
      // 连诊断 key 都写不进去时只能依赖控制台日志
    }
    throw e;
  }
}

// ---------- KV 存储封装（替代本地 repos.json） ----------
// username 不为空时用 repos:${username} 做用户隔离；为空时退回全局 key（env token 场景）
function reposKvKey(username) {
  return username ? `repos:${username.toLowerCase()}` : 'repos';
}

// 首次以用户隔离 key 访问时，若该 key 为空，则从旧全局 key 里把属于该用户的仓库迁移过来
async function readRepos(env, username) {
  const key = reposKvKey(username);
  const raw = await env.REPOS_KV.get(key, 'json');
  if (raw && Array.isArray(raw) && raw.length > 0) return raw;

  // 尝试从旧全局 key 迁移（向下兼容）
  if (username) {
    const legacy = await env.REPOS_KV.get('repos', 'json');
    if (legacy && Array.isArray(legacy)) {
      const mine = legacy.filter(
        (r) => (r.owner || '').toLowerCase() === username.toLowerCase()
      );
      if (mine.length > 0) {
        // 迁移写入新 key；不删旧全局 key，避免其他用户数据丢失
        await kvPutJson(env, key, mine);
        return mine;
      }
    }
  }

  return Array.isArray(raw) ? raw : [];
}

async function writeRepos(env, repos, username) {
  await kvPutJson(env, reposKvKey(username), repos);
}

function nextId(repos) {
  const max = repos.reduce((m, r) => Math.max(m, parseInt(r.id, 10) || 0), 0);
  return String(max + 1);
}

async function listRepos(env, username) {
  return readRepos(env, username);
}

async function addRepo(env, owner, repo, branch = 'main', label = '', username) {
  const repos = await readRepos(env, username);
  const existing = repos.find(
    (r) =>
      r.owner.toLowerCase() === owner.toLowerCase() &&
      r.repo.toLowerCase() === repo.toLowerCase()
  );
  if (existing) {
    return { ok: false, message: '该仓库已存在' };
  }
  const id = nextId(repos);
  const item = { id, owner, repo, branch, label: label || `${owner}/${repo}` };
  repos.push(item);
  await writeRepos(env, repos, username);
  return { ok: true, item };
}

async function addMany(env, reposToAdd, username) {
  const current = await readRepos(env, username);
  let repos = [...current];
  let changed = 0;
  for (const r of reposToAdd) {
    const exists = repos.find(
      (x) =>
        x.owner.toLowerCase() === r.owner.toLowerCase() &&
        x.repo.toLowerCase() === r.repo.toLowerCase()
    );
    if (exists) continue;
    const id = nextId(repos);
    const item = {
      id,
      owner: r.owner,
      repo: r.repo,
      branch: r.branch || 'main',
      label: r.label || `${r.owner}/${r.repo}`,
    };
    repos.push(item);
    changed++;
  }
  if (changed > 0) {
    await writeRepos(env, repos, username);
  }
  return { ok: true, added: changed, total: repos.length };
}

async function removeRepo(env, id, username) {
  const current = await readRepos(env, username);
  const repos = current.filter((r) => r.id !== id);
  if (repos.length === current.length) {
    return { ok: false, message: '未找到该仓库' };
  }
  await writeRepos(env, repos, username);
  return { ok: true };
}

async function getRepo(env, id, username) {
  const repos = await readRepos(env, username);
  return repos.find((r) => r.id === id);
}

async function updateRepo(env, id, updates, username) {
  const repos = await readRepos(env, username);
  const idx = repos.findIndex((r) => r.id === id);
  if (idx === -1) return { ok: false, message: '未找到该仓库' };
  repos[idx] = { ...repos[idx], ...updates };
  await writeRepos(env, repos, username);
  return { ok: true, item: repos[idx] };
}

/**
 * 刷新单条仓库 GitHub 元信息（与 POST /api/refresh-meta 批内逻辑一致）。
 * @returns {{ result: object, kvWrites: number }}
 */
async function refreshOneRepoMeta(env, r, username, headers) {
  let kvWrites = 0;
  try {
    const infoRes = await fetch(
      `${GITHUB_API}/repos/${r.owner}/${r.repo}`,
      { headers }
    );
    if (!infoRes.ok) {
      if (infoRes.status === 404) {
        await removeRepo(env, r.id, username);
        kvWrites = 1;
        return {
          result: {
            id: r.id,
            owner: r.owner,
            repo: r.repo,
            ok: false,
            message: 'GitHub 仓库不存在，已自动从列表中移除',
          },
          kvWrites,
        };
      }
      const msg =
        (await infoRes.json().catch(() => ({}))).message || infoRes.statusText;
      return {
        result: {
          id: r.id,
          owner: r.owner,
          repo: r.repo,
          ok: false,
          message: msg,
        },
        kvWrites: 0,
      };
    }

    const info = await infoRes.json();

    if (!info.fork || !info.parent) {
      await removeRepo(env, r.id, username);
      kvWrites = 1;
      return {
        result: {
          id: r.id,
          owner: r.owner,
          repo: r.repo,
          ok: false,
          message: '仓库已不再是 Fork，已自动从列表中移除',
        },
        kvWrites,
      };
    }

    const forkPushedAt = info.pushed_at || null;
    const forkBranch = r.branch || info.default_branch || 'main';

    let forkLastCommitSha = null;
    let forkLastCommitMessage = null;
    let metaForkCommitHttpStatus = null;
    let metaForkCommitError = null;
    try {
      const c = await fetchJsonWithRetry(
        `${GITHUB_API}/repos/${r.owner}/${r.repo}/commits?per_page=1&sha=${forkBranch}`,
        { headers },
        1
      );
      metaForkCommitHttpStatus = typeof c.status === 'number' ? c.status : null;
      if (c.fetchError) {
        metaForkCommitError = String(c.fetchError).slice(0, 240);
      }
      if (c.ok) {
        const commits = c.data;
        if (Array.isArray(commits) && commits[0]) {
          forkLastCommitSha = commits[0].sha || null;
          forkLastCommitMessage =
            (commits[0].commit && commits[0].commit.message) || null;
        }
      }
    } catch {
      // ignore
    }

    let upstreamFullName = info.parent.full_name;
    let upstreamPushedAt = info.parent.pushed_at || null;
    let upstreamBranch = r.branch || info.parent.default_branch || 'main';

    let upstreamLastCommitSha = null;
    let upstreamLastCommitMessage = null;
    let metaUpstreamCommitHttpStatus = null;
    let metaUpstreamCommitError = null;
    try {
      const u = await fetchJsonWithRetry(
        `${GITHUB_API}/repos/${info.parent.owner.login}/${info.parent.name}/commits?per_page=1&sha=${upstreamBranch}`,
        { headers },
        1
      );
      metaUpstreamCommitHttpStatus = typeof u.status === 'number' ? u.status : null;
      if (u.fetchError) {
        metaUpstreamCommitError = String(u.fetchError).slice(0, 240);
      }
      if (u.ok) {
        const uCommits = u.data;
        if (Array.isArray(uCommits) && uCommits[0]) {
          upstreamLastCommitSha = uCommits[0].sha || null;
          upstreamLastCommitMessage =
            (uCommits[0].commit && uCommits[0].commit.message) || null;
        }
      }
    } catch {
      // ignore
    }

    let isBehindUpstream = false;
    let metaCompareHttpStatus = null;
    let metaCompareError = null;
    try {
      const [upOwner, upRepo] = upstreamFullName.split('/');
      const cmpRes = await fetch(
        `${GITHUB_API}/repos/${upOwner}/${upRepo}/compare/${upstreamBranch}...${r.owner}:${forkBranch}`,
        { headers }
      );
      metaCompareHttpStatus = cmpRes.status;
      if (cmpRes.ok) {
        const cmp = await cmpRes.json().catch(() => ({}));
        const behind = Number(cmp && cmp.behind_by);
        if (!Number.isNaN(behind) && behind > 0) {
          isBehindUpstream = true;
        }
      }
    } catch (e) {
      metaCompareError = ((e && e.message) || String(e)).slice(0, 240);
    }

    const metaRefreshedAt = new Date().toISOString();

    await updateRepo(env, r.id, {
      forkPushedAt,
      forkLastCommitSha: forkLastCommitSha || r.forkLastCommitSha || null,
      forkLastCommitMessage:
        forkLastCommitMessage || r.forkLastCommitMessage || null,
      upstreamFullName,
      upstreamPushedAt,
      upstreamLastCommitSha:
        upstreamLastCommitSha || r.upstreamLastCommitSha || null,
      upstreamLastCommitMessage:
        upstreamLastCommitMessage || r.upstreamLastCommitMessage || null,
      isBehindUpstream,
      metaRefreshedAt,
      metaForkCommitHttpStatus,
      metaUpstreamCommitHttpStatus,
      metaCompareHttpStatus,
      metaForkCommitError: metaForkCommitError || null,
      metaUpstreamCommitError: metaUpstreamCommitError || null,
      metaCompareError: metaCompareError || null,
    }, username);
    kvWrites = 1;

    const mergedForkSha = forkLastCommitSha || r.forkLastCommitSha || null;
    const mergedUpSha =
      upstreamLastCommitSha || r.upstreamLastCommitSha || null;

    return {
      result: {
        id: r.id,
        owner: r.owner,
        repo: r.repo,
        ok: true,
        forkPushedAt,
        forkLastCommitSha: mergedForkSha,
        upstreamFullName,
        upstreamPushedAt,
        upstreamLastCommitSha: mergedUpSha,
        isBehindUpstream,
        metaRefreshedAt,
        metaForkCommitHttpStatus,
        metaUpstreamCommitHttpStatus,
        metaCompareHttpStatus,
        metaForkCommitError: metaForkCommitError || null,
        metaUpstreamCommitError: metaUpstreamCommitError || null,
        metaCompareError: metaCompareError || null,
      },
      kvWrites,
    };
  } catch (err) {
    return {
      result: {
        id: r.id,
        owner: r.owner,
        repo: r.repo,
        ok: false,
        message: err.message || '刷新失败',
      },
      kvWrites: 0,
    };
  }
}

// ---------- GitHub 同步逻辑（来自 sync.js） ----------
async function syncOne(owner, repo, branch = 'main', token) {
  if (!token) {
    return { success: false, message: '未配置 GITHUB_TOKEN' };
  }
  try {
    const url = `${GITHUB_API}/repos/${owner}/${repo}/merge-upstream`;

    async function doMerge(targetBranch) {
      const res = await fetch(url, {
        method: 'POST',
        headers: githubHeaders(token, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ branch: targetBranch }),
      });
      const data = await res.json().catch(() => ({}));
      return { res, data };
    }

    // 第一次使用传入的 branch 尝试
    let { res, data } = await doMerge(branch);

    // 若分支不存在，自动回退到 GitHub 默认分支再试一次
    if (
      !res.ok &&
      data &&
      typeof data.message === 'string' &&
      /branch not found/i.test(data.message)
    ) {
      const infoRes = await fetch(`${GITHUB_API}/repos/${owner}/${repo}`, {
        headers: githubHeaders(token),
      });
      if (infoRes.ok) {
        const info = await infoRes.json().catch(() => ({}));
        const defBranch = info && info.default_branch;
        if (defBranch && defBranch !== branch) {
          ({ res, data } = await doMerge(defBranch));
        }
      }
    }

    // GitHub 在分支未落后时会返回类似：
    // "This branch is not behind the upstream xxx:main."
    // 成功快进时会返回：
    // "Successfully fetched and fast-forwarded from upstream xxx:main."
    if (
      data &&
      typeof data.message === 'string' &&
      data.message.includes('This branch is not behind the upstream')
    ) {
      data.message = '当前主分支已是最新';
    } else if (
      data &&
      typeof data.message === 'string' &&
      /Successfully fetched and fast-forwarded from upstream/i.test(data.message)
    ) {
      data.message = '已从上游同步最新代码';
    }

    if (!res.ok) {
      let msg = data.message || data.error || res.statusText || '';
      if (res.status === 409) {
        msg = '当前主分支已是最新';
      }
      return { success: false, message: msg, status: res.status };
    }
    return { success: true, data, message: data.message || '已从上游同步最新代码' };
  } catch (err) {
    let msg = err.message || '请求失败';
    if (/not behind/i.test(msg) && /upstream/i.test(msg)) {
      msg = '当前主分支已是最新';
    }
    return { success: false, message: msg };
  }
}

async function syncAll(repos, token) {
  const results = [];
  for (const r of repos) {
    const result = await syncOne(r.owner, r.repo, r.branch || 'main', token);
    results.push({
      id: r.id,
      owner: r.owner,
      repo: r.repo,
      success: result.success,
      message: result.message,
      data: result.data,
    });
  }
  return results;
}

// ---------- 工具函数 ----------
function jsonResponse(obj, init = {}) {
  return new Response(JSON.stringify(obj), {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
}

// 优先从请求头取 Token（OAuth 登录），否则用环境变量（GH_TOKEN 同步）
function getToken(request, env) {
  const auth = request.headers.get('Authorization');
  const bearer = auth && auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (bearer) return bearer;
  return (env.GITHUB_TOKEN || '').trim();
}

// 判断当前请求是否使用 OAuth Token（浏览器请求头带的）；env token 为 false
function isOAuthRequest(request) {
  const auth = request.headers.get('Authorization') || '';
  return auth.startsWith('Bearer ') && !!auth.slice(7).trim();
}

// 获取当前 OAuth 用户的 GitHub login（仅 OAuth 场景调用，env token 返回 null）
async function fetchUserLogin(token) {
  try {
    const r = await fetch('https://api.github.com/user', {
      headers: githubHeaders(token),
    });
    if (!r.ok) return null;
    const d = await r.json().catch(() => ({}));
    return (d.login || '').toLowerCase() || null;
  } catch {
    return null;
  }
}

// ---------- 主处理 ----------
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname, searchParams } = url;
    const token = getToken(request, env);

    // OAuth 场景下获取当前用户 login，用于 KV 数据隔离
    // env token 场景（非 OAuth）username = null，使用全局 'repos' key
    const username = (token && isOAuthRequest(request))
      ? await fetchUserLogin(token)
      : null;

    try {
      // ---------- OAuth 登录（可选，替代 GH_TOKEN 变量）----------
      const clientId = (env.GITHUB_OAUTH_CLIENT_ID || '').trim();
      const clientSecret = (env.GITHUB_OAUTH_CLIENT_SECRET || '').trim();
      const origin = `${url.protocol}//${url.host}`;

      if (request.method === 'GET' && pathname === '/api/auth/login') {
        if (!clientId) {
          return jsonResponse(
            { ok: false, message: '未配置 GITHUB_OAUTH_CLIENT_ID，请在 Worker 或 GitHub Secret 中配置' },
            { status: 501 }
          );
        }
        const redirectUri = `${origin}/api/auth/callback`;
        const scope = 'repo,read:user,workflow';
        const authUrl = `https://github.com/login/oauth/authorize?client_id=${encodeURIComponent(
          clientId
        )}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(scope)}`;
        return Response.redirect(authUrl, 302);
      }

      if (request.method === 'GET' && pathname === '/api/auth/callback') {
        const code = searchParams.get('code');
        if (!code || !clientId || !clientSecret) {
          return Response.redirect(origin + '/?auth=error', 302);
        }
        const redirectUri = `${origin}/api/auth/callback`;
        const r = await fetch('https://github.com/login/oauth/access_token', {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            'User-Agent': 'ForkFlow/1.0 (Cloudflare Worker)',
          },
          body: JSON.stringify({
            client_id: clientId,
            client_secret: clientSecret,
            code,
            redirect_uri: redirectUri,
          }),
        });
        const data = await r.json().catch(() => ({}));
        const accessToken = data.access_token;
        if (!accessToken) {
          return Response.redirect(origin + '/?auth=error&msg=' + encodeURIComponent(data.error_description || data.error || 'unknown'), 302);
        }
        return Response.redirect(origin + '/?token=' + encodeURIComponent(accessToken), 302);
      }

      // 获取仓库列表
      if (request.method === 'GET' && pathname === '/api/repos') {
        const repos = await listRepos(env, username);
        return jsonResponse({ ok: true, data: repos });
      }

      // 获取当前用户（用于 Owner 自动填充）
      if (request.method === 'GET' && pathname === '/api/current-user') {
        if (!token) {
          return jsonResponse(
            { ok: false, message: '请使用 GitHub 登录，或在仓库 Secrets 中配置 GH_TOKEN' },
            { status: 401 }
          );
        }
        const r = await fetch('https://api.github.com/user', {
          headers: githubHeaders(token),
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) {
          const msg = data.message || r.statusText;
          const doc = data.documentation_url ? ` | 文档: ${data.documentation_url}` : '';
          return jsonResponse(
            {
              ok: false,
              message: `获取当前 GitHub 用户失败: ${msg}`,
              debug: { status: r.status, githubMessage: data.message, githubDoc: data.documentation_url },
            },
            { status: 500 }
          );
        }
        return jsonResponse({
          ok: true,
          login: data.login || '',
          name: data.name || '',
          avatar_url: data.avatar_url || '',
        });
      }

      // 自检：确认 Token 是否配置正确（仅返回前后几位，不暴露完整 Token）
      if (request.method === 'GET' && pathname === '/api/debug-token') {
        const len = token.length;
        return jsonResponse({
          hasToken: !!token,
          tokenLength: len,
          tokenPrefix: len ? token.slice(0, 7) : '',
          tokenSuffix: len > 11 ? token.slice(-4) : '',
        });
      }

      // KV 写入失败诊断（需登录；不增加日常成功路径的 KV 写入）
      if (request.method === 'GET' && pathname === '/api/debug/kv') {
        if (!token) {
          return jsonResponse(
            { ok: false, message: '请使用 GitHub 登录或配置 GH_TOKEN' },
            { status: 401 }
          );
        }
        const err = await env.REPOS_KV.get(KV_WRITE_ERROR_KEY, 'json');
        return jsonResponse({
          ok: true,
          data: {
            lastKvWriteFailure: err && typeof err === 'object' ? err : null,
            reposKvKey: reposKvKey(username),
            note:
              '仅记录最近一次 KV put 抛错（含配额/限流）。成功路径不会额外写 KV。' +
              '每次 updateRepo 会整表 JSON.stringify 后 put 一次；' +
              'refresh-meta 每成功刷新 1 个仓库约 1 次 put，全量刷新约「仓库数」次 put。',
          },
        });
      }

      // 添加仓库
      if (request.method === 'POST' && pathname === '/api/repos') {
        const body = await request.json().catch(() => ({}));
        let { owner, repo, branch, label } = body || {};
        repo = (repo || '').trim();
        if (!repo) {
          return jsonResponse({ ok: false, message: '缺少 repo 名称' }, { status: 400 });
        }

        // 自动解析 owner
        if (!owner) {
          if (!token) {
            return jsonResponse(
              { ok: false, message: '请使用 GitHub 登录或配置 GH_TOKEN 后再添加仓库' },
              { status: 401 }
            );
          }
          const uRes = await fetch('https://api.github.com/user', {
            headers: githubHeaders(token),
          });
          const uData = await uRes.json().catch(() => ({}));
          if (!uRes.ok) {
            const msg = uData.message || uRes.statusText;
            return jsonResponse(
              {
                ok: false,
                message: `获取当前 GitHub 用户失败，请手动填写 Owner: ${msg}`,
              },
              { status: 500 }
            );
          }
          owner = uData.login || owner;
        }

        const result = await addRepo(env, owner, repo, branch || 'main', label, username);
        if (!result.ok) {
          return jsonResponse(result, { status: 400 });
        }

        // 尝试补充元信息（fork/上游 时间和 commit），失败不影响添加
        try {
          if (token && result.item && result.item.id) {
            const headers = githubHeaders(token);
            const infoRes = await fetch(
              `${GITHUB_API}/repos/${owner}/${repo}`,
              { headers }
            );
            if (infoRes.ok) {
              const info = await infoRes.json();
              const forkPushedAt = info.pushed_at || null;
              const forkBranch = branch || info.default_branch || 'main';

              let forkLastCommitSha = null;
              let forkLastCommitMessage = null;
              try {
                const cRes = await fetch(
                  `${GITHUB_API}/repos/${owner}/${repo}/commits?per_page=1&sha=${forkBranch}`,
                  { headers }
                );
                if (cRes.ok) {
                  const commits = await cRes.json();
                  if (Array.isArray(commits) && commits[0]) {
                    forkLastCommitSha = commits[0].sha || null;
                    forkLastCommitMessage =
                      (commits[0].commit && commits[0].commit.message) || null;
                  }
                }
              } catch {
                // ignore
              }

              let upstreamFullName = null;
              let upstreamPushedAt = null;
              let upstreamLastCommitSha = null;
              let upstreamLastCommitMessage = null;
              let isBehindUpstream = false;
              if (info.parent && info.parent.full_name) {
                upstreamFullName = info.parent.full_name;
                upstreamPushedAt = info.parent.pushed_at || null;
                const upstreamBranch = branch || info.parent.default_branch || 'main';
                try {
                  const uRes = await fetch(
                    `${GITHUB_API}/repos/${info.parent.owner.login}/${info.parent.name}/commits?per_page=1&sha=${upstreamBranch}`,
                    { headers }
                  );
                  if (uRes.ok) {
                    const uCommits = await uRes.json();
                    if (Array.isArray(uCommits) && uCommits[0]) {
                      upstreamLastCommitSha = uCommits[0].sha || null;
                      upstreamLastCommitMessage =
                        (uCommits[0].commit && uCommits[0].commit.message) || null;
                    }
                  }
                } catch {
                  // ignore
                }

                // compare 判断是否落后上游（用于前端“需同步”状态）
                try {
                  const [upOwner, upRepo] = upstreamFullName.split('/');
                  const cmpRes = await fetch(
                    `${GITHUB_API}/repos/${upOwner}/${upRepo}/compare/${upstreamBranch}...${owner}:${forkBranch}`,
                    { headers }
                  );
                  if (cmpRes.ok) {
                    const cmp = await cmpRes.json().catch(() => ({}));
                    const behind = Number(cmp && cmp.behind_by);
                    if (!Number.isNaN(behind) && behind > 0) {
                      isBehindUpstream = true;
                    }
                  }
                } catch {
                  // ignore
                }
              }
              await updateRepo(env, result.item.id, {
                forkPushedAt,
                forkLastCommitSha,
                forkLastCommitMessage,
                branch: forkBranch,
                upstreamFullName,
                upstreamPushedAt,
                upstreamLastCommitSha,
                upstreamLastCommitMessage,
                isBehindUpstream,
              }, username);
            }
          }
        } catch {
          // ignore
        }

        return jsonResponse(result);
      }

      // 刷新单个仓库元信息（约 1 次 KV put，不跑整表 refresh-meta 批次）
      const refreshOneMatch = pathname.match(/^\/api\/repos\/([^/]+)\/refresh-meta$/);
      if (request.method === 'POST' && refreshOneMatch) {
        if (!token) {
          return jsonResponse(
            { ok: false, message: '请使用 GitHub 登录或配置 GH_TOKEN' },
            { status: 401 }
          );
        }
        const id = refreshOneMatch[1];
        const r = await getRepo(env, id, username);
        if (!r) {
          return jsonResponse({ ok: false, message: '未找到该仓库' }, { status: 404 });
        }
        const hdr = githubHeaders(token);
        const { result, kvWrites } = await refreshOneRepoMeta(env, r, username, hdr);
        return jsonResponse({
          ok: true,
          message: result.ok ? '已刷新' : result.message || '刷新结束',
          data: result,
          diag: { kvWritesThisBatch: kvWrites },
        });
      }

      // 获取 / 删除 / 更新单个仓库
      if (pathname.startsWith('/api/repos/')) {
        const id = pathname.split('/').pop();

        // 获取单个
        if (request.method === 'GET') {
          const repo = await getRepo(env, id, username);
          if (!repo) {
            return jsonResponse({ ok: false, message: '未找到该仓库' }, { status: 404 });
          }
          return jsonResponse({ ok: true, data: repo });
        }

        // 删除
        if (request.method === 'DELETE') {
          const result = await removeRepo(env, id, username);
          if (!result.ok) {
            return jsonResponse(result, { status: 404 });
          }
          return jsonResponse(result);
        }

        // 更新（仅 branch/label 等）
        if (request.method === 'PATCH') {
          const body = await request.json().catch(() => ({}));
          const { branch, label } = body || {};
          const result = await updateRepo(env, id, { branch, label }, username);
          if (!result.ok) {
            return jsonResponse(result, { status: 404 });
          }
          return jsonResponse(result);
        }
      }

      // 同步单个仓库
      if (request.method === 'POST' && pathname.startsWith('/api/sync/')) {
        if (!token) {
          return jsonResponse(
            { ok: false, message: '请使用 GitHub 登录或配置 GH_TOKEN' },
            { status: 401 }
          );
        }
        const id = pathname.split('/').pop();
        const repo = await getRepo(env, id, username);
        if (!repo) {
          return jsonResponse({ ok: false, message: '未找到该仓库' }, { status: 404 });
        }
        const result = await syncOne(
          repo.owner,
          repo.repo,
          repo.branch || 'main',
          token
        );
        let message = result.message || '';
        if (
          !result.success &&
          (result.status === 409 ||
            (message &&
              /not behind/i.test(message) &&
              /upstream/i.test(message)))
        ) {
          message = '当前主分支已是最新';
        }

        // 若同步成功，则顺带刷新该仓库的元信息
        if (result.success) {
          try {
            const headers = githubHeaders(token);
            const infoRes = await fetch(
              `${GITHUB_API}/repos/${repo.owner}/${repo.repo}`,
              { headers }
            );
            if (infoRes.ok) {
              const info = await infoRes.json();
              const forkPushedAt = info.pushed_at || null;
              // 与本地一致：优先使用配置分支，否则使用 default_branch
              const forkBranch = repo.branch || info.default_branch || 'main';

              let forkLastCommitSha = null;
              let forkLastCommitMessage = null;
              try {
                const cRes = await fetch(
                  `${GITHUB_API}/repos/${repo.owner}/${repo.repo}/commits?per_page=1&sha=${forkBranch}`,
                  { headers }
                );
                if (cRes.ok) {
                  const commits = await cRes.json();
                  if (Array.isArray(commits) && commits[0]) {
                    forkLastCommitSha = commits[0].sha || null;
                    forkLastCommitMessage =
                      (commits[0].commit && commits[0].commit.message) || null;
                  }
                }
              } catch {
                // ignore
              }

              let upstreamFullName = null;
              let upstreamPushedAt = null;
              let upstreamLastCommitSha = null;
              let upstreamLastCommitMessage = null;
              let isBehindUpstream = false;
              if (info.parent && info.parent.full_name) {
                upstreamFullName = info.parent.full_name;
                upstreamPushedAt = info.parent.pushed_at || null;
                // 与本地一致：优先使用配置分支，否则使用上游 default_branch
                const upstreamBranch = repo.branch || info.parent.default_branch || 'main';
                try {
                  const uRes = await fetch(
                    `${GITHUB_API}/repos/${info.parent.owner.login}/${info.parent.name}/commits?per_page=1&sha=${upstreamBranch}`,
                    { headers }
                  );
                  if (uRes.ok) {
                    const uCommits = await uRes.json();
                    if (Array.isArray(uCommits) && uCommits[0]) {
                      upstreamLastCommitSha = uCommits[0].sha || null;
                      upstreamLastCommitMessage =
                        (uCommits[0].commit && uCommits[0].commit.message) || null;
                    }
                  }
                } catch {
                  // ignore
                }

                // compare 判断是否落后（与本地一致：compare 失败默认 false）
                try {
                  const [upOwner, upRepo] = upstreamFullName.split('/');
                  const cmpRes = await fetch(
                    `${GITHUB_API}/repos/${upOwner}/${upRepo}/compare/${upstreamBranch}...${repo.owner}:${forkBranch}`,
                    { headers }
                  );
                  if (cmpRes.ok) {
                    const cmp = await cmpRes.json().catch(() => ({}));
                    const behind = Number(cmp && cmp.behind_by);
                    if (!Number.isNaN(behind) && behind > 0) {
                      isBehindUpstream = true;
                    }
                  }
                } catch {
                  // ignore
                }
              }
              await updateRepo(env, id, {
                forkPushedAt,
                forkLastCommitSha,
                forkLastCommitMessage,
                upstreamFullName,
                upstreamPushedAt,
                upstreamLastCommitSha,
                upstreamLastCommitMessage,
                isBehindUpstream,
              }, username);
            }
          } catch {
            // 元信息刷新失败不影响同步结果
          }
        }

        return jsonResponse({ ok: result.success, message, data: result.data });
      }

      // 一键批量同步（分批：避免单次 invocation 超过 CF subrequest 上限）
      if (request.method === 'POST' && pathname === '/api/sync-all') {
        if (!token) {
          return jsonResponse(
            { ok: false, message: '请使用 GitHub 登录或配置 GH_TOKEN' },
            { status: 401 }
          );
        }
        const repos = await listRepos(env, username);
        if (repos.length === 0) {
          return jsonResponse({
            ok: true,
            data: [],
            message: '暂无配置的仓库',
            cursor: 0,
            limit: 0,
            processed: 0,
            total: 0,
            nextCursor: null,
          });
        }
        const cursor = Math.max(0, parseInt(searchParams.get('cursor') || '0', 10) || 0);
        const limitRaw = parseInt(searchParams.get('limit') || '8', 10);
        const limit = Math.min(12, Math.max(1, Number.isNaN(limitRaw) ? 8 : limitRaw));
        const slice = repos.slice(cursor, cursor + limit);
        const results = await syncAll(slice, token);
        const nextCursor = cursor + slice.length >= repos.length ? null : cursor + slice.length;
        return jsonResponse({
          ok: true,
          data: results,
          cursor,
          limit,
          processed: slice.length,
          total: repos.length,
          nextCursor,
        });
      }

      // 一键导入当前账号下所有 fork 仓库
      if (request.method === 'POST' && pathname === '/api/import-forks') {
        if (!token) {
          return jsonResponse(
            { ok: false, message: '请使用 GitHub 登录或配置 GH_TOKEN' },
            { status: 401 }
          );
        }
        const beforeRepos = await listRepos(env, username);

        const perPage = 100;
        let page = 1;
        let all = [];
        // 拉取当前 token 所属用户的所有仓库，筛选 fork==true
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const apiUrl = `${GITHUB_API}/user/repos?per_page=${perPage}&page=${page}&sort=updated`;
          const r = await fetch(apiUrl, {
            headers: githubHeaders(token),
          });
          if (!r.ok) {
            const d = await r.json().catch(() => ({}));
            const msg = d.message || r.statusText;
            return jsonResponse(
              { ok: false, message: `GitHub API 调用失败: ${msg}` },
              { status: 500 }
            );
          }
          const list = await r.json();
          if (!Array.isArray(list) || list.length === 0) break;
          all = all.concat(list);
          if (list.length < perPage) break;
          page += 1;
          if (page > 10) break; // 最多拉 1000 个
        }

        const forks = all.filter((r) => r.fork);
        if (forks.length === 0) {
          const current = await listRepos(env, username);
          return jsonResponse({
            ok: true,
            message: '未找到任何 fork 仓库',
            data: { added: 0, total: current.length },
          });
        }

        const toAdd = forks.map((r) => ({
          owner: r.owner.login,
          repo: r.name,
          branch: r.default_branch || 'main',
          label: r.full_name,
        }));

        const result = await addMany(env, toAdd, username);

        // 为本次新加入的仓库补充元信息（每轮只处理少量，避免与 user/repos 分页叠加后超过 subrequest 上限）
        const META_ENRICH_PER_IMPORT = 5;
        let newlyAddedCount = 0;
        if (result.added > 0) {
          const afterRepos = await listRepos(env, username);
          const beforeIds = new Set(beforeRepos.map((r) => r.id));
          const newlyAdded = afterRepos.filter((r) => !beforeIds.has(r.id));
          newlyAddedCount = newlyAdded.length;
          const toEnrich = newlyAdded.slice(0, META_ENRICH_PER_IMPORT);

          const headers = githubHeaders(token);

          for (const repo of toEnrich) {
            try {
              const infoRes = await fetch(
                `${GITHUB_API}/repos/${repo.owner}/${repo.repo}`,
                { headers }
              );
              if (!infoRes.ok) continue;
              const info = await infoRes.json();

              const forkPushedAt = info.pushed_at || null;
              const forkBranch = repo.branch || info.default_branch || 'main';

              let forkLastCommitSha = null;
              let forkLastCommitMessage = null;
              try {
                const cRes = await fetch(
                  `${GITHUB_API}/repos/${repo.owner}/${repo.repo}/commits?per_page=1&sha=${forkBranch}`,
                  { headers }
                );
                if (cRes.ok) {
                  const commits = await cRes.json();
                  if (Array.isArray(commits) && commits[0]) {
                    forkLastCommitSha = commits[0].sha || null;
                    forkLastCommitMessage =
                      (commits[0].commit && commits[0].commit.message) || null;
                  }
                }
              } catch {
                // ignore
              }

              let upstreamFullName = null;
              let upstreamPushedAt = null;
              let upstreamLastCommitSha = null;
              let upstreamLastCommitMessage = null;
              let isBehindUpstream = false;

              if (info.parent && info.parent.full_name) {
                upstreamFullName = info.parent.full_name;
                upstreamPushedAt = info.parent.pushed_at || null;
                const upstreamBranch = repo.branch || info.parent.default_branch || 'main';
                try {
                  const uRes = await fetch(
                    `${GITHUB_API}/repos/${info.parent.owner.login}/${info.parent.name}/commits?per_page=1&sha=${upstreamBranch}`,
                    { headers }
                  );
                  if (uRes.ok) {
                    const uCommits = await uRes.json();
                    if (Array.isArray(uCommits) && uCommits[0]) {
                      upstreamLastCommitSha = uCommits[0].sha || null;
                      upstreamLastCommitMessage =
                        (uCommits[0].commit && uCommits[0].commit.message) || null;
                    }
                  }
                } catch {
                  // ignore
                }

                // compare 判断是否落后上游（用于前端“需同步”状态）
                try {
                  const [upOwner, upRepo] = upstreamFullName.split('/');
                  const cmpRes = await fetch(
                    `${GITHUB_API}/repos/${upOwner}/${upRepo}/compare/${upstreamBranch}...${repo.owner}:${forkBranch}`,
                    { headers }
                  );
                  if (cmpRes.ok) {
                    const cmp = await cmpRes.json().catch(() => ({}));
                    const behind = Number(cmp && cmp.behind_by);
                    if (!Number.isNaN(behind) && behind > 0) {
                      isBehindUpstream = true;
                    }
                  }
                } catch {
                  // ignore
                }
              }

              await updateRepo(env, repo.id, {
                forkPushedAt,
                forkLastCommitSha,
                forkLastCommitMessage,
                upstreamFullName,
                upstreamPushedAt,
                upstreamLastCommitSha,
                upstreamLastCommitMessage,
                isBehindUpstream,
              }, username);
            } catch {
              // ignore 单个失败
            }
          }
        }

        let message = `检测到 ${forks.length} 个 fork 仓库，本次新增 ${result.added} 个，当前总数 ${result.total}`;
        if (newlyAddedCount > META_ENRICH_PER_IMPORT) {
          message += `；已为前 ${META_ENRICH_PER_IMPORT} 个补充元信息，另有 ${newlyAddedCount - META_ENRICH_PER_IMPORT} 个请点击「刷新仓库信息」补全（避免单次请求 GitHub 次数过多）。`;
        }

        return jsonResponse({
          ok: true,
          message,
          data: result,
        });
      }

      // 刷新所有仓库元信息（包括上游）
      if (request.method === 'POST' && pathname === '/api/refresh-meta') {
        if (!token) {
          return jsonResponse(
            { ok: false, message: '请使用 GitHub 登录或配置 GH_TOKEN' },
            { status: 401 }
          );
        }

        const repos = await listRepos(env, username);
        if (repos.length === 0) {
          return jsonResponse({ ok: true, message: '暂无配置的仓库', data: [] });
        }

        const headers = githubHeaders(token);

        // Worker 单次 invocation 有「对外 subrequest」上限（免费档约 50 次）。
        // 每条仓库：repo 信息 1 + fork commits 至多 2 + upstream commits 至多 2 + compare 1 ≈ 4～6 次。
        // 批次过大会在中途抛出 “Too many subrequests”，导致 meta*HttpStatus 全为 null。
        const cursor = Math.max(0, parseInt(searchParams.get('cursor') || '0', 10) || 0);
        const limitRaw = parseInt(searchParams.get('limit') || '6', 10);
        const limit = Math.min(8, Math.max(2, Number.isNaN(limitRaw) ? 6 : limitRaw));
        const slice = repos.slice(cursor, cursor + limit);
        const results = [];
        let kvWritesThisBatch = 0;

        for (const r of slice) {
          const { result, kvWrites } = await refreshOneRepoMeta(
            env,
            r,
            username,
            headers
          );
          results.push(result);
          kvWritesThisBatch += kvWrites;
        }

        const nextCursor = cursor + slice.length;
        return jsonResponse({
          ok: true,
          message: nextCursor >= repos.length ? '元信息刷新完成' : '元信息刷新中…',
          cursor,
          limit,
          processed: slice.length,
          total: repos.length,
          nextCursor: nextCursor >= repos.length ? null : nextCursor,
          diag: {
            kvWritesThisBatch,
            note:
              '每个成功刷新的仓库会触发 1 次 KV put（整表重写）。全量刷新总 put 次数约等于仓库总数。',
          },
          data: results,
        });
      }

      // 未匹配到 API：返回内联静态资源（/ → index.html）
      const assetPath =
        pathname === '/' || pathname === '' ? '/index.html' : pathname;
      const body = ASSETS_CONTENT[assetPath];
      if (body !== undefined) {
        const contentType = ASSETS_TYPES[assetPath] || ASSETS_TYPES['/index.html'];
        return new Response(body, {
          headers: { 'Content-Type': contentType },
        });
      }
      return new Response('Not Found', { status: 404 });
    } catch (e) {
      return jsonResponse(
        { ok: false, message: e.message || '服务器错误' },
        { status: 500 }
      );
    }
  },
};

