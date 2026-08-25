# Edgetunnel

本仓库是面向 Cloudflare Workers 的 Edgetunnel 实现，并扩展了 Xboard 用户白名单与流量回传能力。本文档是本项目的主要运行说明，所有命令默认在仓库根目录执行。 

## 1. 运行模式

项目支持两种互斥的鉴权方式：

| 模式 | 适用场景 | 核心配置 |
| --- | --- | --- |
| 个人 UUID 模式 | 个人使用或不接入 Xboard | 配置 `UUID`；不要启用 `XBOARD_KV_REQUIRED` |
| Xboard 生产模式 | Xboard 用户统一鉴权、停用与流量统计 | 绑定 `XBOARD_KV`，并设置 `XBOARD_KV_REQUIRED="true"` |

> 生产环境接入 Xboard 时，必须启用 `XBOARD_KV_REQUIRED`。这样即使误删或错误配置 KV binding，Worker 也会显式拒绝鉴权，而不会静默退回个人 UUID 模式。

## GitHub 与 Cloudflare Pages 部署关系

本项目不使用 GitHub Actions 进行构建或部署。推送到 GitHub 后，由 Cloudflare Pages 的 GitHub 集成负责拉取仓库、执行构建并发布；因此不要为部署额外配置 GitHub Actions Secrets。

当前保留的两个 fork 原始工作流只用于仓库维护：

- `.github/workflows/sync.yml`：仅在 Actions 页面手动触发上游同步；
- `.github/workflows/Auto-close-empty-PRs.yml`：仅在 Actions 页面手动输入 PR 编号后，检查并关闭说明为空或过短的 PR。

这两个工作流都只保留 `workflow_dispatch` 手动入口，不会定时运行，也不会在新建 PR 时自动运行。它们与 Pages 部署相互独立，不会改变 Pages 的自动部署机制。

Cloudflare Pages 推荐配置：

```text
Production branch: main
Build command: npm ci && npm run build:pages
Build output directory: dist-pages
Root directory: 留空（仓库根目录就是 edgetunnel）
```

`dist/` 和 `dist-pages/` 都是本地或 Pages 构建生成的临时目录，不应提交到 Git。
## 2. 环境要求

- Node.js 18 或更高版本，推荐使用当前 LTS。
- npm 9 或更高版本。
- Cloudflare 账户。
- Wrangler CLI；本项目已将 Wrangler 固定在开发依赖中，应优先通过 `npx wrangler` 调用。

检查本机环境：

```bash
node --version
npm --version
npx wrangler --version
```

首次登录 Cloudflare：

```bash
npx wrangler login
```

CI/CD 环境不要执行交互式登录，应通过安全变量提供 `CLOUDFLARE_API_TOKEN` 和 `CLOUDFLARE_ACCOUNT_ID`。

## 3. 安装依赖

```bash
# 按 package-lock.json 安装完全一致的依赖，适合开发机和 CI。
npm ci
```

仅当明确需要升级依赖时才运行 `npm install`，并检查 `package-lock.json` 的变化。

## 4. 本地开发、检查与测试

```bash
# 将根目录 _worker.js 及其本地模块打包为 dist/worker.js。
npm run build

# 运行精简后的核心回归测试，不会访问线上 Xboard 或 Cloudflare。
npm test

# 执行真实部署前的 Wrangler dry-run，不会发布到 Cloudflare。
npm run deploy:dry
```

本地启动 Worker：

```bash
# 先生成 dist/worker.js。
npm run build

# 使用 wrangler.toml 启动本地开发服务。
npx wrangler dev
```

修改 `_worker.js` 或 `src/` 后需要重新运行 `npm run build`。提交前至少执行：

```bash
npm run build
npm test
node --check dist/worker.js
```

`npm run deploy:dry` 仅在需要诊断 Wrangler 配置时手动执行，不是 Cloudflare Pages Git 集成的必需步骤。

## 5. Wrangler 基础配置

主配置文件是 `wrangler.toml`：

```toml
name = "v20251104"          # Cloudflare Worker 名称，可按环境修改
main = "dist/worker.js"     # npm run build 生成的部署入口
compatibility_date = "2025-11-04"
keep_vars = true             # 部署时保留控制台中已有的变量和 Secret
```

修改 `name` 后应先确认没有覆盖错误的 Worker。`compatibility_date` 的升级需要单独测试，不要在普通文档或配置整理中顺手更新。

## 6. 个人 UUID 模式配置

最小配置是 `UUID`。敏感值建议使用 Wrangler Secret，不要直接写入 `wrangler.toml`：

```bash
# 按提示输入 VLESS UUID。
npx wrangler pages secret put UUID --project-name edgt1

# 可选：设置管理页面密码；未设置时程序会按现有兼容逻辑选择其他凭据。
npx wrangler pages secret put ADMIN --project-name edgt1

# 可选：覆盖默认加密密钥。
npx wrangler pages secret put KEY --project-name edgt1
```

个人模式下：

- 不配置 `XBOARD_KV`；
- 不设置 `XBOARD_KV_REQUIRED`，或显式设置为 `false`；
- Worker 使用 `UUID` 进行鉴权。

## 7. Xboard 生产模式配置

### 7.1 创建 Cloudflare KV namespace

```bash
# 创建用于保存 Xboard 白名单快照的 KV namespace。
npx wrangler kv namespace create XBOARD_KV
```

命令会返回 namespace ID。将它写入本地或私有部署配置，不要把真实 ID、API Token 或账户信息提交到公开仓库。

### 7.2 配置绑定和生产防护

在 `wrangler.toml` 中启用：

```toml
[vars]
# 启用后，如果 XBOARD_KV 缺失或不是有效 KV binding，Worker 将显式失败。
XBOARD_KV_REQUIRED = "true"

[[kv_namespaces]]
# binding 名称必须固定为 XBOARD_KV，不能自行改名。
binding = "XBOARD_KV"
id = "替换为实际的_KV_NAMESPACE_ID"
```

`XBOARD_KV_REQUIRED` 以下值会被识别为开启：

- 布尔值 `true`；
- 数字 `1`；
- 忽略大小写和首尾空白的字符串 `"true"`；
- 字符串 `"1"`。

生产环境推荐固定使用字符串 `"true"`。

### 7.3 缺失 KV 时的显式失败策略

启用 `XBOARD_KV_REQUIRED` 后：

1. `XBOARD_KV` 未绑定，或者绑定对象不具备 KV 的 `get()` 能力；
2. Worker 立即进入 Xboard fail-closed；
3. 不使用内存中的旧快照；
4. 不读取旧 Secret fallback；
5. 所有 Xboard UUID 鉴权均被拒绝，并记录稳定错误：

```text
XBOARD_KV binding is required when XBOARD_KV_REQUIRED is enabled.
```

未启用该开关且未绑定 KV 时，项目仍保留个人 UUID 模式，以兼容原有部署。

### 7.4 Xboard 快照读取参数

| 变量 | 默认值 | 说明 |
| --- | ---: | --- |
| `XBOARD_CACHE_TTL_SECONDS` | `30` | 正常 KV 快照在 Worker 内存中的短缓存时间 |
| `XBOARD_MAX_STALE_SECONDS` | `600` | KV 读取异常时，已有有效快照允许继续使用的最长时间 |

`XBOARD_NEGATIVE_CACHE_TTL_SECONDS` 默认为 `30` 秒，用于快照缺失、损坏、过期或 KV 读取失败后的 fail-closed 负缓存，避免每次请求重复读取 KV。`XBOARD_MAX_STALE_SECONDS` 只用于“KV 已正确绑定但读取发生异常”的情况，不会绕过 `XBOARD_KV_REQUIRED` 对缺失 binding 的检查。

### 7.5 Xboard 快照写入入口

生产模式提供固定入口：

```text
PUT /__xboard/snapshot
Authorization: Bearer <EDGETUNNEL_SYNC_TOKEN>
Content-Type: application/json
```

在 Cloudflare Pages 中把 `EDGETUNNEL_SYNC_TOKEN` 配置为 Secret，并在 Xboard/Hugging Face 中配置同值 Secret。入口只接受 `PUT`，请求体上限为 5 MiB；写入前会校验 schema v2（同时兼容读取旧 v1，但按 `generatedAt + 12 小时`计算租约），并在配置了 `XBOARD_NODE_ID` 时校验快照 `serverId`。成功后以 `expirationTtl=43200` 写入固定键 `xboard:snapshot`，不会在响应或日志中回显 Token、UUID 或完整快照。

```bash
npx wrangler pages secret put EDGETUNNEL_SYNC_TOKEN --project-name edgt1
```

不要把该 Secret 写入 `wrangler.toml` 或提交到 Git。

Xboard 的自适应订阅拉取也支持使用同一个 Secret 做服务端鉴权：Xboard 向目标的 `/sub` 地址发起请求时，会发送 `Authorization: Bearer <EDGETUNNEL_SYNC_TOKEN>`。Worker 优先接受该 Header，同时保留原有带 `token` 查询参数的个人客户端订阅鉴权；因此不要把同步 Secret 拼进订阅 URL，也不要记录到日志。多目标部署时，每个目标的 Xboard 配置必须使用对应 Worker 的同步 Secret。

### 7.6 流量与在线设备回传参数

| 变量 | 是否必需 | 说明 |
| --- | --- | --- |
| `XBOARD_API_BASE` | 启用回传时必需 | Xboard API 地址，末尾 `/` 会自动移除 |
| `XBOARD_NODE_ID` | 启用回传时必需 | 对应的 Xboard 节点 ID |
| `XBOARD_SERVER_TOKEN` | 启用回传时必需 | 服务端鉴权令牌，应使用 Secret |
| `XBOARD_TRAFFIC_PUSH_INTERVAL_SECONDS` | 否 | 流量批量推送间隔，默认 `60` 秒 |
| `XBOARD_ONLINE_PUSH_INTERVAL_SECONDS` | 否 | 在线设备心跳间隔，默认 `60` 秒；运行时限制为 `1`～`240` 秒，`0` 仅用于显式禁用心跳/测试 |
| `XBOARD_TRAFFIC_ORPHAN_TTL_SECONDS` | 否 | 无主流量记录的保留时间 |

Edgetunnel 只读取 Cloudflare 边缘注入的 `CF-Connecting-IP`，不会信任客户端可伪造的 `X-Forwarded-For`、`X-Real-IP` 或 `True-Client-IP`。通过 Xboard 快照认证的 VLESS 连接建立后会调用 `POST /api/v1/server/UniProxy/alive?merge=1`；`merge=1` 让多个 Worker isolate 的设备心跳在 Xboard 中合并，避免后一次上报覆盖其他实例看到的 IP。

连接保持期间即使没有新流量，也会按心跳间隔刷新在线状态，因此生产建议保持 `60` 秒，且不要超过运行时上限 `240` 秒。连接关闭时只停止本地心跳，不会绕过批处理间隔强制发送 alive；Xboard 会在最后一次心跳超过 300 秒后自动把设备判定为离线。`0` 会显式禁用周期心跳，仅适用于测试或临时排障，不建议生产使用。

设置敏感令牌：

```bash
npx wrangler pages secret put XBOARD_SERVER_TOKEN --project-name edgt1
```

完整的 Xboard 联合部署、快照协议、队列超时和生产验证步骤见 Xboard 仓库的 `docs/edgetunnel-xboard-deployment.md`。

## 8. 其他常用 Worker 变量

| 变量 | 作用 | 建议 |
| --- | --- | --- |
| `HOST` | 限制或指定访问域名 | 多个值按项目现有数组格式配置 |
| `PATH` | 指定访问路径 | 不以 `/` 开头时程序会自动补齐 |
| `PROXYIP` | 配置反代 IP | 部署前验证可用性 |
| `URL` | 配置伪装页地址或类型 | 默认值为 `nginx` |
| `DEBUG` | 开启调试日志 | 仅排障时使用 `true` 或 `1` |
| `OFF_LOG` | 关闭 KV 日志 | `true` 或 `1` 表示关闭 |
| `BEST_SUB` | 开启优选订阅逻辑 | 使用前确认订阅生成流程 |
| `PRELOAD_RACE_DIAL` | 开启预加载竞速拨号 | 仅在验证收益后启用 |
| `PROXY_CONCURRENT_DIAL` | 反代并发拨号数 | 必须是大于等于 1 的整数 |
| `TCP_CONCURRENT_DIAL` | TCP 并发拨号数 | 必须是大于等于 1 的整数 |
| `GO2SOCKS5` | 扩展 SOCKS5 白名单 | 仅配置可信目标 |
| `KV` | 旧有日志等功能使用的 KV binding | 不等同于 `XBOARD_KV`，不要混用 |

`PASSWORD`、`TOKEN`、`KEY`、`UUID` 等凭据应使用 Secret 管理。

## 9. 部署与回滚

### 9.1 Workers 部署

```bash
# 1. 安装依赖。
npm ci

# 2. 运行测试与部署预检。
npm test
npm run deploy:dry

# 3. 发布到 wrangler.toml 中 name 指定的 Worker。
npx wrangler deploy
```

查看实时日志：

```bash
npx wrangler tail
```

回滚时不要直接删除 KV namespace。应先恢复上一版代码或配置，然后重新部署，并确认 Xboard 白名单快照仍可读取。

### 9.2 Cloudflare Pages

本仓库支持由 GitHub 提交触发 Cloudflare Pages 自动构建。`npm run build:pages` 会先生成 Workers 使用的 `dist/worker.js`，再复制为 Pages Functions 入口 `dist-pages/_worker.js`；`dist-pages/` 是临时构建产物，不提交到 Git。

Cloudflare Pages 项目使用以下 Git 构建配置：

```text
Production branch: main
Build command: npm ci && npm run build:pages
Build output directory: dist-pages
Root directory: GitHub 仓库就是 edgetunnel 时留空或填写 /；仅当仓库是 monorepo 时填写 edgetunnel
```

在 Pages 项目的 **Settings → Bindings** 中为 Production 和 Preview 分别确认：

```text
Variable name: XBOARD_KV
KV namespace: 选择 Xboard 写入快照所使用的同一个 namespace
```

在 **Settings → Variables and Secrets** 中为 Production 和 Preview 设置：

```env
# 生产鉴权防护。
XBOARD_KV_REQUIRED=true

# Cloudflare Tunnel 暴露的 Xboard HTTPS 地址，不能填写 127.0.0.1 或 localhost。
XBOARD_API_BASE=https://你的隧道域名

# 与 Xboard 中 Edgetunnel 节点对应的节点 ID。
XBOARD_NODE_ID=你的节点ID

# 可选；生产建议 60 秒。运行时限制为 1～240 秒，0 仅用于测试，不建议线上使用。
XBOARD_ONLINE_PUSH_INTERVAL_SECONDS=60
```

将 `XBOARD_SERVER_TOKEN` 配置为 **Secret**，其值必须与 Xboard 后台的服务端 Token 完全一致。`XBOARD_KV_REQUIRED=true` 是生产防护开关；如果 `XBOARD_KV` 缺失或不是有效 KV binding，Pages 运行时会显式失败，不会静默退回个人 UUID 模式。Cloudflare 无法访问你的本机 Laragon 服务，因此 `XBOARD_API_BASE` 必须使用当前可访问的 Cloudflare Tunnel HTTPS 地址。

本地只验证 Pages 构建产物，不会执行部署：

```bash
npm ci
npm run build:pages
node --check dist-pages/_worker.js
```

最终提交并推送到 GitHub 后，Cloudflare Pages 才会按上述配置自动部署。提交前不要把真实 UUID、Cloudflare Token、账户 ID 或 KV namespace ID 写入仓库。

## 10. Xboard 联调顺序

建议严格按以下顺序上线：

1. 创建 Cloudflare KV namespace；
2. 在 Worker/Pages 中绑定为 `XBOARD_KV`；
3. 配置 `XBOARD_KV_REQUIRED=true`；
4. 在 Xboard 中配置 Cloudflare namespace ID、账户 ID 和 API Token；
5. 在 Xboard 执行 `php artisan edgetunnel:sync-whitelist --dry-run`；
6. 确认 UUID 数量正确后执行真实同步；
7. 运行 `npm run deploy:dry`；
8. 发布 Worker；
9. 按 Xboard 生产检查清单验证正常用户、禁用用户和 KV 故障场景。

## 11. 常见问题

### Worker 提示缺少 `XBOARD_KV`

确认 `wrangler.toml` 或 Cloudflare 控制台中存在 binding，且名称严格为 `XBOARD_KV`。namespace 的显示名称可以不同，但 binding 名称不能变化。

### 开启生产防护后所有用户都无法连接

先查看 `npx wrangler tail`。如果出现缺失 binding 的稳定错误，应恢复正确的 KV binding，而不是关闭 `XBOARD_KV_REQUIRED`。如果 binding 正常，再检查 KV 中是否已经发布 `xboard:snapshot`。

### 修改源码后部署内容没有变化

Wrangler 入口是 `dist/worker.js`，部署前必须重新执行 `npm run build`。`npm run deploy:dry` 和 `npx wrangler deploy` 会读取该入口。

### 本地测试成功但线上失败

重点核对 Cloudflare 环境中的 Variables、Secrets、KV bindings 和 Worker 名称。`wrangler.toml` 的注释模板不会自动创建线上资源。

## 12. 安全与发布要求

- 不提交真实 UUID、管理员密码、Server Token、Cloudflare API Token 或 KV namespace ID。
- 生产 Xboard 部署必须启用 `XBOARD_KV_REQUIRED=true`。
- 紧急撤权应发布合法的空白名单快照，不要通过删除 KV binding 实现。
- 发布前必须执行测试和 dry-run；dry-run 成功不等于已完成真实生产验证。
- 本项目仅供合法、合规的网络与系统管理场景使用，使用者需自行承担部署和运营责任。
