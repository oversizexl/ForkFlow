import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import * as store from './store.js';
import { syncOne, syncAll } from './sync.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3846;
const envToken = process.env.GITHUB_TOKEN;
const oauthClientId = process.env.GITHUB_OAUTH_CLIENT_ID;
const oauthClientSecret = process.env.GITHUB_OAUTH_CLIENT_SECRET;

function githubHeaders(token, extra = {}) {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'ForkFlow/1.0 (Node server)',
    ...extra,
  };
}

// 优先从请求头 Authorization: Bearer xxx 取 Token，退回到 .env 中的 GITHUB_TOKEN
function getTokenFromReq(req) {
  const auth = req.headers.authorization || req.headers.Authorization;
  if (auth && typeof auth === 'string' && auth.startsWith('Bearer ')) {
    return auth.slice(7).trim();
  }
  return (envToken || '').trim();
}

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- API ----------

// GitHub OAuth 登录（本地版，可选，替代 .env 中的 GITHUB_TOKEN）
app.get('/api/auth/login', (req, res) => {
  if (!oauthClientId) {
    return res
      .status(501)
      .json({ ok: false, message: '未配置 GITHUB_OAUTH_CLIENT_ID，请在 .env 中配置后再使用 GitHub 登录' });
  }
  const origin = `${req.protocol}://${req.get('host')}`;
  const redirectUri = `${origin}/api/auth/callback`;
  const scope = 'repo,read:user,workflow';
  const authUrl = `https://github.com/login/oauth/authorize?client_id=${encodeURIComponent(
    oauthClientId
  )}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(scope)}`;
  res.redirect(authUrl);
});

app.get('/api/auth/callback', async (req, res) => {
  const code = req.query.code;
  const origin = `${req.protocol}://${req.get('host')}`;
  if (!code || !oauthClientId || !oauthClientSecret) {
    return res.redirect(origin + '/?auth=error');
  }
  const redirectUri = `${origin}/api/auth/callback`;
  try {
    const r = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'ForkFlow/1.0 (Node server)',
      },
      body: JSON.stringify({
        client_id: oauthClientId,
        client_secret: oauthClientSecret,
        code,
        redirect_uri: redirectUri,
      }),
    });
    const data = await r.json().catch(() => ({}));
    const accessToken = data.access_token;
    if (!accessToken) {
      const msg = encodeURIComponent(data.error_description || data.error || 'unknown');
      return res.redirect(origin + '/?auth=error&msg=' + msg);
    }
    return res.redirect(origin + '/?token=' + encodeURIComponent(accessToken));
  } catch (e) {
    return res.redirect(origin + '/?auth=error&msg=' + encodeURIComponent(e.message || 'unknown'));
  }
});

// 元信息刷新节流：限制一定时间内的实际 GitHub 刷新频率，避免触发限流
let lastMetaRefreshAt = 0;
const MIN_REFRESH_INTERVAL_MS = 5 * 1000; // 5 秒内只允许一次「全量」刷新

// 获取所有 fork 项目
app.get('/api/repos', (req, res) => {
  try {
    const repos = store.listRepos();
    res.json({ ok: true, data: repos });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

// 获取当前 Token 对应的 GitHub 用户（用于前端自动填充 Owner）
app.get('/api/current-user', async (req, res) => {
  const token = getTokenFromReq(req);
  if (!token) {
    return res
      .status(401)
      .json({ ok: false, message: '请使用 GitHub 登录，或在 .env 中配置 GITHUB_TOKEN' });
  }
  try {
    const r = await fetch('https://api.github.com/user', {
      headers: githubHeaders(token),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg = data.message || r.statusText;
      return res.status(500).json({ ok: false, message: `获取当前 GitHub 用户失败: ${msg}` });
    }
    res.json({
      ok: true,
      login: data.login || '',
      name: data.name || '',
      avatar_url: data.avatar_url || '',
    });
  } catch (e) {
    res
      .status(500)
      .json({ ok: false, message: `获取当前 GitHub 用户失败: ${e.message || '未知错误'}` });
  }
});

// 添加项目 (body: { owner?, repo, branch?, label? })
app.post('/api/repos', (req, res) => {
  (async () => {
    try {
      let { owner, repo, branch, label } = req.body || {};
      repo = (repo || '').trim();

      if (!repo) {
        return res.status(400).json({ ok: false, message: '缺少 repo 名称' });
      }

      const token = getTokenFromReq(req);

      // 如果未显式填写 owner，则默认使用当前 Token 对应用户的登录名
      if (!owner) {
        if (!token) {
          return res
            .status(401)
            .json({ ok: false, message: '请使用 GitHub 登录或在 .env 中配置 GITHUB_TOKEN 后再添加仓库' });
        }
        try {
          const uRes = await fetch('https://api.github.com/user', {
            headers: githubHeaders(token),
          });
          if (!uRes.ok) {
            const uData = await uRes.json().catch(() => ({}));
            const msg = uData.message || uRes.statusText;
            return res.status(500).json({
              ok: false,
              message: `获取当前 GitHub 用户失败，请手动填写 Owner: ${msg}`,
            });
          }
          const uData = await uRes.json();
          owner = uData.login || owner;
        } catch (err) {
          return res.status(500).json({
            ok: false,
            message: `获取当前 GitHub 用户失败，请手动填写 Owner: ${
              err.message || '未知错误'
            }`,
          });
        }
      }

      const result = store.addRepo(owner, repo, branch || 'main', label);
      if (!result.ok) return res.status(400).json(result);

      // 为新添加的仓库补充基础元信息（时间 & 上游），与导入逻辑保持一致
      try {
        if (token) {
          const headers = githubHeaders(token);

          const infoRes = await fetch(
            `https://api.github.com/repos/${owner}/${repo}`,
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
                `https://api.github.com/repos/${owner}/${repo}/commits?per_page=1&sha=${forkBranch}`,
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
              // 忽略单个仓库 commit 查询失败
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
                  `https://api.github.com/repos/${info.parent.owner.login}/${info.parent.name}/commits?per_page=1&sha=${upstreamBranch}`,
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
                // 忽略上游 commit 查询失败
              }

              // compare 判断是否落后上游（用于前端“需同步”红色状态）
              try {
                const [upOwner, upRepo] = upstreamFullName.split('/');
                const cmpRes = await fetch(
                  `https://api.github.com/repos/${upOwner}/${upRepo}/compare/${upstreamBranch}...${owner}:${forkBranch}`,
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
                // compare 失败时保持默认 false
              }
            }

            if (result.item && result.item.id) {
              store.updateRepo(result.item.id, {
                forkPushedAt,
                forkLastCommitSha,
                forkLastCommitMessage,
                upstreamFullName,
                upstreamPushedAt,
                upstreamLastCommitSha,
                upstreamLastCommitMessage,
                isBehindUpstream,
              });
            }
          }
        }
      } catch {
        // 元信息补充失败不影响添加结果
      }

      res.json(result);
    } catch (e) {
      res.status(500).json({ ok: false, message: e.message });
    }
  })();
});

// 获取单个项目
app.get('/api/repos/:id', (req, res) => {
  try {
    const repo = store.getRepo(req.params.id);
    if (!repo) return res.status(404).json({ ok: false, message: '未找到该仓库' });
    res.json({ ok: true, data: repo });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

// 删除项目
app.delete('/api/repos/:id', (req, res) => {
  try {
    const result = store.removeRepo(req.params.id);
    if (!result.ok) return res.status(404).json(result);
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

// 更新项目 (body: { branch?, label? })
app.patch('/api/repos/:id', (req, res) => {
  try {
    const { branch, label } = req.body || {};
    const result = store.updateRepo(req.params.id, { branch, label });
    if (!result.ok) return res.status(404).json(result);
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

// 同步单个项目
app.post('/api/sync/:id', async (req, res) => {
  const token = getTokenFromReq(req);
  if (!token) {
    return res
      .status(401)
      .json({ ok: false, message: '请使用 GitHub 登录或在 .env 中配置 GITHUB_TOKEN' });
  }
  try {
    const repo = store.getRepo(req.params.id);
    if (!repo) return res.status(404).json({ ok: false, message: '未找到该仓库' });
    const result = await syncOne(repo.owner, repo.repo, repo.branch || 'main', token);
    let message = result.message || '';
    // GitHub 在分支未落后或无法快进时常返回 409 及类似英文提示，这里统一转成中文
    if (
      !result.success &&
      (
        result.status === 409 ||
        (message && /not behind/i.test(message) && /upstream/i.test(message))
      )
    ) {
      message = '当前主分支已是最新';
    }

    // 若同步成功，则顺带刷新该仓库的元信息（最近 commit / 上游 / 是否落后）
    if (result.success) {
      try {
        const headers = githubHeaders(token);
        const infoRes = await fetch(
          `https://api.github.com/repos/${repo.owner}/${repo.repo}`,
          { headers }
        );
        if (infoRes.ok) {
          const info = await infoRes.json();
          const forkPushedAt = info.pushed_at || null;
          // 需同步判断必须以用户配置的分支为准；否则会出现“列表显示为 branch=X，但后台按 default_branch=X' 判断”的情况
          const forkBranch = repo.branch || info.default_branch || 'main';

          let forkLastCommitSha = null;
          let forkLastCommitMessage = null;
          try {
            const cRes = await fetch(
              `https://api.github.com/repos/${repo.owner}/${repo.repo}/commits?per_page=1&sha=${forkBranch}`,
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
            // 忽略单个仓库 commit 查询失败
          }

          let upstreamFullName = null;
          let upstreamPushedAt = null;
          let upstreamLastCommitSha = null;
          let upstreamLastCommitMessage = null;

          let isBehindUpstream = false;

          if (info.parent && info.parent.full_name) {
            upstreamFullName = info.parent.full_name;
            upstreamPushedAt = info.parent.pushed_at || null;
            // 同理：上游对比也应优先使用用户配置的分支名
            const upstreamBranch = repo.branch || info.parent.default_branch || 'main';
            try {
              const uRes = await fetch(
                `https://api.github.com/repos/${info.parent.owner.login}/${info.parent.name}/commits?per_page=1&sha=${upstreamBranch}`,
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
              // 忽略上游 commit 查询失败
            }

            // compare 判断是否落后
            try {
              const [upOwner, upRepo] = upstreamFullName.split('/');
              const cmpRes = await fetch(
                `https://api.github.com/repos/${upOwner}/${upRepo}/compare/${upstreamBranch}...${repo.owner}:${forkBranch}`,
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
              // compare 失败时保持默认 false
            }
          }

          store.updateRepo(req.params.id, {
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
      } catch {
        // 元信息刷新失败不影响同步结果
      }
    }

    res.json({ ok: result.success, message, data: result.data });
  } catch (e) {
    const message = e.message || '同步失败';
    res.status(500).json({ ok: false, message });
  }
});

// 一键批量同步
app.post('/api/sync-all', async (req, res) => {
  const token = getTokenFromReq(req);
  if (!token) {
    return res
      .status(401)
      .json({ ok: false, message: '请使用 GitHub 登录或在 .env 中配置 GITHUB_TOKEN' });
  }
  try {
    const repos = store.listRepos();
    if (repos.length === 0) {
      return res.json({
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
    const cursor = Math.max(0, parseInt(req.query.cursor ?? '0', 10) || 0);
    const limitParam = req.query.limit;
    const limit =
      limitParam === undefined || limitParam === ''
        ? repos.length
        : Math.min(100, Math.max(1, parseInt(String(limitParam), 10) || 8));
    const slice = repos.slice(cursor, cursor + limit);
    const results = await syncAll(slice, token);
    const nextCursor = cursor + slice.length >= repos.length ? null : cursor + slice.length;
    res.json({
      ok: true,
      data: results,
      cursor,
      limit: slice.length,
      processed: slice.length,
      total: repos.length,
      nextCursor,
    });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

// 一键导入当前账号下所有 fork 仓库
app.post('/api/import-forks', async (req, res) => {
  const token = getTokenFromReq(req);
  if (!token) {
    return res
      .status(401)
      .json({ ok: false, message: '请使用 GitHub 登录或在 .env 中配置 GITHUB_TOKEN' });
  }
  try {
    const beforeRepos = store.listRepos();

    const perPage = 100;
    let page = 1;
    let all = [];
    /* 拉取当前 token 所属用户的所有仓库，筛选 fork==true */
    /* 注意：如果仓库太多可以按需改成只拉取前几页 */
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const url = `https://api.github.com/user/repos?per_page=${perPage}&page=${page}&sort=updated`;
      const r = await fetch(url, {
        headers: githubHeaders(token),
      });
      if (!r.ok) {
        const msg = (await r.json().catch(() => ({}))).message || r.statusText;
        return res.status(500).json({ ok: false, message: `GitHub API 调用失败: ${msg}` });
      }
      const list = await r.json();
      if (!Array.isArray(list) || list.length === 0) break;
      all = all.concat(list);
      if (list.length < perPage) break;
      page += 1;
      if (page > 10) break; // 简单保护，最多拉 1000 个
    }

    const forks = all.filter((r) => r.fork);
    if (forks.length === 0) {
      return res.json({ ok: true, message: '未找到任何 fork 仓库', data: { added: 0, total: store.listRepos().length } });
    }

    const toAdd = forks.map((r) => ({
      owner: r.owner.login,
      repo: r.name,
      branch: r.default_branch || 'main',
      label: r.full_name,
    }));

    const result = store.addMany(toAdd);

    // 为本次新加入的仓库补充元信息（只查这几个新仓库，避免跑整库刷新）
    if (result.added > 0) {
      const afterRepos = store.listRepos();
      const beforeIds = new Set(beforeRepos.map((r) => r.id));
      const newlyAdded = afterRepos.filter((r) => !beforeIds.has(r.id));

      const headers = githubHeaders(token);

      for (const repo of newlyAdded) {
        try {
          // 1) 拉取 fork 仓库基础信息
          const infoRes = await fetch(
            `https://api.github.com/repos/${repo.owner}/${repo.repo}`,
            { headers }
          );
          if (!infoRes.ok) continue;
          const info = await infoRes.json();

          const forkPushedAt = info.pushed_at || null;
              const forkBranch = repo.branch || info.default_branch || 'main';

          // 2) 拉取 fork 仓库最新一条 commit
          let forkLastCommitSha = null;
          let forkLastCommitMessage = null;
          try {
            const cRes = await fetch(
              `https://api.github.com/repos/${repo.owner}/${repo.repo}/commits?per_page=1&sha=${forkBranch}`,
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
            // 忽略单个仓库 commit 查询失败
          }

          // 3) 如果存在上游 parent，再拉取上游基础信息 + 最新 commit
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
                `https://api.github.com/repos/${info.parent.owner.login}/${info.parent.name}/commits?per_page=1&sha=${upstreamBranch}`,
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
              // 忽略上游 commit 查询失败
            }

                // compare 判断是否落后上游（用于前端“需同步”红色状态）
                try {
                  const [upOwner, upRepo] = upstreamFullName.split('/');
                  const cmpRes = await fetch(
                    `https://api.github.com/repos/${upOwner}/${upRepo}/compare/${upstreamBranch}...${repo.owner}:${forkBranch}`,
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
                  // compare 失败时保持默认 false
                }
          }

          store.updateRepo(repo.id, {
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
          // 新增仓库的元信息补充失败时忽略，不影响导入结果
        }
      }
    }

    res.json({
      ok: true,
      message: `检测到 ${forks.length} 个 fork 仓库，本次新增 ${result.added} 个，当前总数 ${result.total}`,
      data: result,
    });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

/** 单条仓库元信息刷新（与全量 refresh-meta 中单次逻辑一致）；不计入全量节流 */
async function refreshOneRepoMetaServer(r, token) {
  const headers = githubHeaders(token);
  try {
    const infoRes = await fetch(`https://api.github.com/repos/${r.owner}/${r.repo}`, {
      headers,
    });
    if (!infoRes.ok) {
      if (infoRes.status === 404) {
        store.removeRepo(r.id);
        return {
          id: r.id,
          owner: r.owner,
          repo: r.repo,
          ok: false,
          message: 'GitHub 仓库不存在，已自动从列表中移除',
        };
      }
      const msg = (await infoRes.json().catch(() => ({}))).message || infoRes.statusText;
      return { id: r.id, owner: r.owner, repo: r.repo, ok: false, message: msg };
    }
    const info = await infoRes.json();

    if (!info.fork || !info.parent) {
      store.removeRepo(r.id);
      return {
        id: r.id,
        owner: r.owner,
        repo: r.repo,
        ok: false,
        message: '仓库已不再是 Fork，已自动从列表中移除',
      };
    }

    const forkPushedAt = info.pushed_at || null;
    const forkBranch = r.branch || info.default_branch || 'main';

    let forkLastCommitSha = null;
    let forkLastCommitMessage = null;
    try {
      const cRes = await fetch(
        `https://api.github.com/repos/${r.owner}/${r.repo}/commits?per_page=1&sha=${forkBranch}`,
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

    try {
      const uRes = await fetch(
        `https://api.github.com/repos/${info.parent.owner.login}/${info.parent.name}/commits?per_page=1&sha=${upstreamBranch}`,
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

    let isBehindUpstream = false;
    try {
      const [upOwner, upRepo] = upstreamFullName.split('/');
      if (upOwner && upRepo) {
        const cmpRes = await fetch(
          `https://api.github.com/repos/${upOwner}/${upRepo}/compare/${upstreamBranch}...${r.owner}:${forkBranch}`,
          { headers }
        );
        if (cmpRes.ok) {
          const cmp = await cmpRes.json().catch(() => ({}));
          const behind = Number(cmp && cmp.behind_by);
          if (!Number.isNaN(behind) && behind > 0) {
            isBehindUpstream = true;
          }
        }
      }
    } catch {
      // ignore
    }

    store.updateRepo(r.id, {
      forkPushedAt,
      forkLastCommitSha,
      forkLastCommitMessage,
      upstreamFullName,
      upstreamPushedAt,
      upstreamLastCommitSha,
      upstreamLastCommitMessage,
      isBehindUpstream,
    });

    return {
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
    };
  } catch (err) {
    return {
      id: r.id,
      owner: r.owner,
      repo: r.repo,
      ok: false,
      message: err.message || '刷新失败',
    };
  }
}

// 刷新单个仓库元信息（不计入全量 refresh-meta 的 5 秒节流）
app.post('/api/repos/:id/refresh-meta', async (req, res) => {
  const token = getTokenFromReq(req);
  if (!token) {
    return res
      .status(401)
      .json({ ok: false, message: '请使用 GitHub 登录或在 .env 中配置 GITHUB_TOKEN' });
  }
  try {
    const r = store.getRepo(req.params.id);
    if (!r) {
      return res.status(404).json({ ok: false, message: '未找到该仓库' });
    }
    const data = await refreshOneRepoMetaServer(r, token);
    res.json({
      ok: true,
      message: data.ok ? '已刷新' : data.message || '刷新结束',
      data,
    });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

// 刷新所有仓库的时间和最新 commit 信息（包括上游）
app.post('/api/refresh-meta', async (req, res) => {
  const token = getTokenFromReq(req);
  if (!token) {
    return res
      .status(401)
      .json({ ok: false, message: '请使用 GitHub 登录或在 .env 中配置 GITHUB_TOKEN' });
  }
  try {
    const force = req.query && req.query.force === '1';
    const now = Date.now();
    const diff = now - lastMetaRefreshAt;
    if (!force && diff < MIN_REFRESH_INTERVAL_MS) {
      // 距离上次刷新太近，直接返回跳过信息，并提示剩余时间，避免再次访问 GitHub
      const remainingMs = MIN_REFRESH_INTERVAL_MS - diff;
      const remainingSec = Math.max(1, Math.ceil(remainingMs / 1000));
      const remainingText =
        remainingSec >= 60
          ? `${Math.ceil(remainingSec / 60)} 分钟`
          : `${remainingSec} 秒`;
      return res.json({
        ok: true,
        skipped: true,
        message: `距离上次刷新过近，还剩 ${remainingText} 才可调用 GitHub API`,
        data: [],
      });
    }
    lastMetaRefreshAt = now;

    const repos = store.listRepos();
    if (repos.length === 0) {
      return res.json({ ok: true, message: '暂无配置的仓库', data: [] });
    }

    const results = [];
    for (const r of repos) {
      results.push(await refreshOneRepoMetaServer(r, token));
    }

    res.json({
      ok: true,
      message: '元信息刷新完成',
      data: results,
    });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

// 前端 SPA 回退
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Fork 同步管理服务已启动: http://localhost:${PORT}`);
  if (!envToken && !oauthClientId) {
    console.warn(
      '未设置 GITHUB_TOKEN 或 GITHUB_OAUTH_CLIENT_ID，本地同步功能将不可用，请在 .env 中配置 PAT 或 OAuth Client'
    );
  }
});
