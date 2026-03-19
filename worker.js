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

// ---------- KV 存储封装（替代本地 repos.json） ----------
async function readRepos(env) {
  const raw = await env.REPOS_KV.get('repos', 'json');
  if (!raw) return [];
  return Array.isArray(raw) ? raw : [];
}

async function writeRepos(env, repos) {
  await env.REPOS_KV.put('repos', JSON.stringify(repos));
}

function nextId(repos) {
  const max = repos.reduce((m, r) => Math.max(m, parseInt(r.id, 10) || 0), 0);
  return String(max + 1);
}

async function listRepos(env) {
  return readRepos(env);
}

async function addRepo(env, owner, repo, branch = 'main', label = '') {
  const repos = await readRepos(env);
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
  await writeRepos(env, repos);
  return { ok: true, item };
}

async function addMany(env, reposToAdd) {
  const current = await readRepos(env);
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
    await writeRepos(env, repos);
  }
  return { ok: true, added: changed, total: repos.length };
}

async function removeRepo(env, id) {
  const current = await readRepos(env);
  const repos = current.filter((r) => r.id !== id);
  if (repos.length === current.length) {
    return { ok: false, message: '未找到该仓库' };
  }
  await writeRepos(env, repos);
  return { ok: true };
}

async function getRepo(env, id) {
  const repos = await readRepos(env);
  return repos.find((r) => r.id === id);
}

async function updateRepo(env, id, updates) {
  const repos = await readRepos(env);
  const idx = repos.findIndex((r) => r.id === id);
  if (idx === -1) return { ok: false, message: '未找到该仓库' };
  repos[idx] = { ...repos[idx], ...updates };
  await writeRepos(env, repos);
  return { ok: true, item: repos[idx] };
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

// ---------- 主处理 ----------
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname, searchParams } = url;
    const token = getToken(request, env);

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
        const repos = await listRepos(env);
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

        const result = await addRepo(env, owner, repo, branch || 'main', label);
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
              });
            }
          }
        } catch {
          // ignore
        }

        return jsonResponse(result);
      }

      // 获取 / 删除 / 更新单个仓库
      if (pathname.startsWith('/api/repos/')) {
        const id = pathname.split('/').pop();

        // 获取单个
        if (request.method === 'GET') {
          const repo = await getRepo(env, id);
          if (!repo) {
            return jsonResponse({ ok: false, message: '未找到该仓库' }, { status: 404 });
          }
          return jsonResponse({ ok: true, data: repo });
        }

        // 删除
        if (request.method === 'DELETE') {
          const result = await removeRepo(env, id);
          if (!result.ok) {
            return jsonResponse(result, { status: 404 });
          }
          return jsonResponse(result);
        }

        // 更新（仅 branch/label 等）
        if (request.method === 'PATCH') {
          const body = await request.json().catch(() => ({}));
          const { branch, label } = body || {};
          const result = await updateRepo(env, id, { branch, label });
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
        const repo = await getRepo(env, id);
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
              const forkBranch = info.default_branch || repo.branch || 'main';

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
              if (info.parent && info.parent.full_name) {
                upstreamFullName = info.parent.full_name;
                upstreamPushedAt = info.parent.pushed_at || null;
                const upstreamBranch = info.parent.default_branch || 'main';
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
              }
              await updateRepo(env, id, {
                forkPushedAt,
                forkLastCommitSha,
                forkLastCommitMessage,
                upstreamFullName,
                upstreamPushedAt,
                upstreamLastCommitSha,
                upstreamLastCommitMessage,
              });
            }
          } catch {
            // 元信息刷新失败不影响同步结果
          }
        }

        return jsonResponse({ ok: result.success, message, data: result.data });
      }

      // 一键批量同步
      if (request.method === 'POST' && pathname === '/api/sync-all') {
        if (!token) {
          return jsonResponse(
            { ok: false, message: '请使用 GitHub 登录或配置 GH_TOKEN' },
            { status: 401 }
          );
        }
        const repos = await listRepos(env);
        if (repos.length === 0) {
          return jsonResponse({ ok: true, data: [], message: '暂无配置的仓库' });
        }
        const results = await syncAll(repos, token);
        return jsonResponse({ ok: true, data: results });
      }

      // 一键导入当前账号下所有 fork 仓库
      if (request.method === 'POST' && pathname === '/api/import-forks') {
        if (!token) {
          return jsonResponse(
            { ok: false, message: '请使用 GitHub 登录或配置 GH_TOKEN' },
            { status: 401 }
          );
        }
        const beforeRepos = await listRepos(env);

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
          const current = await listRepos(env);
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

        const result = await addMany(env, toAdd);

        // 为本次新加入的仓库补充元信息（只查新增的，避免整库刷新）
        if (result.added > 0) {
          const afterRepos = await listRepos(env);
          const beforeIds = new Set(beforeRepos.map((r) => r.id));
          const newlyAdded = afterRepos.filter((r) => !beforeIds.has(r.id));

          const headers = githubHeaders(token);

          for (const repo of newlyAdded) {
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
              });
            } catch {
              // ignore 单个失败
            }
          }
        }

        return jsonResponse({
          ok: true,
          message: `检测到 ${forks.length} 个 fork 仓库，本次新增 ${result.added} 个，当前总数 ${result.total}`,
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

        // 简化：不做复杂节流，由前端控制调用频率；如需可加 env 变量控制
        const repos = await listRepos(env);
        if (repos.length === 0) {
          return jsonResponse({ ok: true, message: '暂无配置的仓库', data: [] });
        }

        const headers = githubHeaders(token);

        const results = [];

        for (const r of repos) {
          try {
            const infoRes = await fetch(
              `${GITHUB_API}/repos/${r.owner}/${r.repo}`,
              { headers }
            );
            if (!infoRes.ok) {
              if (infoRes.status === 404) {
                await removeRepo(env, r.id);
                results.push({
                  id: r.id,
                  owner: r.owner,
                  repo: r.repo,
                  ok: false,
                  message: 'GitHub 仓库不存在，已自动从列表中移除',
                });
                continue;
              }
              const msg =
                (await infoRes.json().catch(() => ({}))).message ||
                infoRes.statusText;
              results.push({
                id: r.id,
                owner: r.owner,
                repo: r.repo,
                ok: false,
                message: msg,
              });
              continue;
            }

            const info = await infoRes.json();

            if (!info.fork || !info.parent) {
              await removeRepo(env, r.id);
              results.push({
                id: r.id,
                owner: r.owner,
                repo: r.repo,
                ok: false,
                message: '仓库已不再是 Fork，已自动从列表中移除',
              });
              continue;
            }

            const forkPushedAt = info.pushed_at || null;
            const forkBranch = r.branch || info.default_branch || 'main';

            let forkLastCommitSha = null;
            let forkLastCommitMessage = null;
            try {
              const cRes = await fetch(
                `${GITHUB_API}/repos/${r.owner}/${r.repo}/commits?per_page=1&sha=${forkBranch}`,
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

            let upstreamFullName = info.parent.full_name;
            let upstreamPushedAt = info.parent.pushed_at || null;
            let upstreamBranch = r.branch || info.parent.default_branch || 'main';
            let upstreamLastCommitSha = null;
            let upstreamLastCommitMessage = null;
            let isBehindUpstream = false;

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
                `${GITHUB_API}/repos/${upOwner}/${upRepo}/compare/${upstreamBranch}...${r.owner}:${forkBranch}`,
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

            await updateRepo(env, r.id, {
              forkPushedAt,
              forkLastCommitSha,
              forkLastCommitMessage,
              upstreamFullName,
              upstreamPushedAt,
              upstreamLastCommitSha,
              upstreamLastCommitMessage,
              isBehindUpstream,
            });

            results.push({
              id: r.id,
              owner: r.owner,
              repo: r.repo,
              ok: true,
              forkPushedAt,
              forkLastCommitSha,
              forkLastCommitMessage,
              upstreamFullName,
              upstreamPushedAt,
              upstreamLastCommitSha,
              upstreamLastCommitMessage,
            });
          } catch (err) {
            results.push({
              id: r.id,
              owner: r.owner,
              repo: r.repo,
              ok: false,
              message: err.message || '刷新失败',
            });
          }
        }

        return jsonResponse({
          ok: true,
          message: '元信息刷新完成',
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

