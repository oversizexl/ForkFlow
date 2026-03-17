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

### 配置在哪（务必区分）

| 配置项 | 位置 |
|--------|------|
| `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_KV_NAMESPACE_ID` | **GitHub 仓库** → Settings → Secrets and variables → **Actions**（CI 部署用；KV id 在 Cloudflare 创建 KV 后复制过来） |
| `GITHUB_TOKEN` | **GitHub 仓库** → Settings → Secrets and variables → **Actions**（你的 GitHub PAT，需 `repo` + `read:user`；每次部署会自动同步到 Worker，无需再去 Cloudflare 里配） |

无需改 wrangler.toml。GITHUB_TOKEN 配在 GitHub 后，每次部署都会通过 `wrangler secret put` 写入 Worker，不用在 Cloudflare 里重复配置。

### Fork 后自动部署

1. Fork 本仓库。
2. **Cloudflare**：拿 [Account ID](https://dash.cloudflare.com/)；建 [API Token](https://dash.cloudflare.com/profile/api-tokens)（Workers Scripts: Edit、KV: Edit）；在 **Workers KV** 里创建命名空间（或本地 `npx wrangler kv:namespace create REPOS_KV`），复制生成的 **id**。
3. **GitHub**：Fork 仓库 → Settings → Secrets and variables → Actions，添加四个 Secret：`CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`、`CLOUDFLARE_KV_NAMESPACE_ID`、**`GITHUB_TOKEN`**（你的 GitHub PAT，权限勾选 `repo` 和 `read:user`）。
4. 推送到 `main` 即触发部署；GITHUB_TOKEN 会在每次部署时自动同步到 Worker，无需在 Cloudflare 里再配。

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

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/repos` | 仓库列表 |
| POST | `/api/repos` | 添加仓库（body: `owner?`, `repo`, `branch?`, `label?`） |
| DELETE/PATCH | `/api/repos/:id` | 删除/更新仓库 |
| GET | `/api/current-user` | 当前 GitHub 用户 |
| POST | `/api/sync/:id` | 同步单仓 |
| POST | `/api/sync-all` | 批量同步 |
| POST | `/api/import-forks` | 一键导入所有 Fork |
| POST | `/api/refresh-meta` | 刷新元信息并清理已删除/Fork 取消的仓库 |

---

MIT
