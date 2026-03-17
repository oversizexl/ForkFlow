# Fork 仓库同步管理

Web 页面集中管理 GitHub Fork：**一键批量同步、一键导入 Fork、自动刷新/清理上游信息**。需 Node.js 18+ 与 GitHub Token（`repo` 权限）。

---

## 本地运行

```bash
npm install
```

在项目根目录创建 `.env`：`GITHUB_TOKEN=ghp_xxx`（可选 `PORT=3846`）。然后：

```bash
npm start
```

访问 `http://localhost:3846`。添加仓库时 Owner 可留空（用 Token 用户名）；支持单仓同步、批量同步、一键导入所有 Fork。

---

## 部署到 Cloudflare Workers

部署后**打开 Worker 链接即见前端**，同一域名下 `/api/*` 为接口，无需改代码。

### Secrets/变量（必填 vs 选填）

> 这些都配置在 **GitHub 仓库** → Settings → Secrets and variables → Actions。


| 名称                           |    必填    | 用途                                                                              |
| ---------------------------- | --- | ------------------------------------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`       | ✅   | GitHub Actions 调用 Wrangler 部署 Workers                                           |
| `CLOUDFLARE_ACCOUNT_ID`      | ✅   | 你的 Cloudflare Account ID                                                        |
| `CLOUDFLARE_KV_NAMESPACE_ID` | ✅   | KV namespace id（在 Cloudflare Workers KV 创建后复制）                                  |
| `GH_TOKEN`                   | ⛔   | GitHub PAT（`repo` + `read:user`）；不想做 OAuth 登录时用，部署时会同步到 Worker 的 `GITHUB_TOKEN` |
| `GH_OAUTH_CLIENT_ID`         | ⛔   | OAuth 登录：GitHub OAuth App 的 Client ID（见下）                                       |
| `GH_OAUTH_CLIENT_SECRET`     | ⛔   | OAuth 登录：GitHub OAuth App 的 Client Secret（见下）                                   |


**GitHub 鉴权（两种方式二选一，至少选一种）：**

- **方式 A：`GH_TOKEN`（最省事）**：所有人共用一套 PAT，无需在页面点登录。
- **方式 B：OAuth 登录（更安全）**：用户打开页面点「使用 GitHub 登录」，使用自己的账号授权；无需在仓库里保存 PAT。

OAuth App 创建入口：[GitHub Developer Settings → OAuth Apps](https://github.com/settings/developers)  
回调地址（必须匹配你的 Worker 域名）：`https://你的 Worker 域名/api/auth/callback`

### Fork 后自动部署

1. Fork 本仓库。
2. **Cloudflare**：拿 [Account ID](https://dash.cloudflare.com/)；建 [API Token](https://dash.cloudflare.com/profile/api-tokens)（Workers Scripts: Edit、KV: Edit）；在 **Workers KV** 里创建命名空间（或本地 `npx wrangler kv:namespace create REPOS_KV`），复制生成的 **id**。
3. **GitHub**：Fork 仓库 → Settings → Secrets and variables → Actions，添加必填的 `CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`、`CLOUDFLARE_KV_NAMESPACE_ID`；再二选一：配 `**GH_TOKEN`**（PAT）或配 `**GH_OAUTH_CLIENT_ID` + `GH_OAUTH_CLIENT_SECRET`**（OAuth 登录，见上表）。
4. 推送到 `main` 即触发部署。

本地部署：先运行 `node build-embed-assets.js` 生成前端内联文件，再在 wrangler.toml 填好 account_id 与 KV id，执行 `npx wrangler deploy`。

---

## 项目结构

```
server.js / worker.js   # 本地 Node 后端 / Workers 后端（KV）
sync.js, store.js       # 同步逻辑、本地存储
public/                 # 前端（部署时与 Worker 一起发布）
.github/workflows/      # 推 main 自动部署
```

---

## API 简表


| 方法           | 路径                   | 说明                                                |
| ------------ | -------------------- | ------------------------------------------------- |
| GET          | `/api/repos`         | 仓库列表                                              |
| POST         | `/api/repos`         | 添加仓库（body: `owner?`, `repo`, `branch?`, `label?`） |
| DELETE/PATCH | `/api/repos/:id`     | 删除/更新仓库                                           |
| GET          | `/api/current-user`  | 当前 GitHub 用户                                      |
| POST         | `/api/sync/:id`      | 同步单仓                                              |
| POST         | `/api/sync-all`      | 批量同步                                              |
| POST         | `/api/import-forks`  | 一键导入所有 Fork                                       |
| POST         | `/api/refresh-meta`  | 刷新元信息并清理已删除/Fork 取消的仓库                            |
| GET          | `/api/auth/login`    | 跳转 GitHub OAuth 授权（使用登录方式时）                       |
| GET          | `/api/auth/callback` | OAuth 回调，重定向回前端并带上 token                          |


---

MIT