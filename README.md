# BeeCount Cloud · Workers Edition

把 [BeeCount-Cloud](https://github.com/TNT-Likely/BeeCount-Cloud) 1.9.0 的后端搬到 Cloudflare Workers 免费档：
**TypeScript + Hono + D1 + R2 + Durable Objects + Cron**，前端 React SPA 原样复用（同源托管）。
不依赖 Containers、Postgres、常驻进程或本地磁盘。

> 这是第三方社区移植，不是 BeeCount 官方发行版。原项目版权与许可见 `LICENSE` / `LICENSE_EN`；
> 前端与 API 语义来自 1.9.0 源码，供个人自建使用。

---

## 它长什么样

```
浏览器 / 手机 App
        │  /api/v1  （同源，无 CORS 烦恼）
Workers（Hono，~340 KB bundle）
        ├── D1            账本、交易、用户、同步日志（SQLite 方言）
        ├── R2            附件、头像、备份快照
        ├── Durable Object 每个用户一个 SyncHub：WebSocket 推送
        ├── Cron Trigger   每天 03:17 清理过期 token / 同步日志 / 导入任务
        └── Static Assets  现有 React 控制台（Vite 构建产物）
```

- 单实例 Serverless，按请求计费；家庭 2–4 台设备的用量远低于免费额度。
- 客户端协议与 1.9.0 保持一致：`/sync/full`、`/sync/pull`、`/sync/push`、`/read/*`、`/write/*`。
- 手机 App 可以直接把服务器地址指向本 Worker（`https://<worker>.<subdomain>.workers.dev`）。

---

## 功能对照

| 功能 | 状态 | 说明 |
|---|---|---|
| 邮箱密码注册 / 登录 / 刷新 / 登出 | ✅ | PBKDF2-SHA256（迭代数按 Workers CPU 预算调整） |
| 2FA（TOTP + 恢复码） | ✅ | Secret 以 AES-GCM 加密存 D1 |
| 多账本、交易、账户、分类、标签、预算 | ✅ | `/write/*` 全部实现，含重命名级联、删除保护 |
| 手机增量同步（LWW + 设备去重 + 幂等） | ✅ | 与 1.9.0 相同的 change 语义；`__user_global__` 哨兵保留 |
| 共享账本（邀请码、成员、角色、转让） | ✅ | 成员上限 5，邀请码 24h、一次性 |
| 附件（交易图 / 分类图标 / 头像） | ✅ | 存 R2，按 sha256 去重；缩略图直接回原图（无 Pillow） |
| CSV 导入（预览 / 映射 / 执行） | ✅ | SSE 进度；单次最多 2000 笔、5 万行解析；映射会在执行时生效，默认跳过重复交易 |
| Excel（.xlsx）导入 | ✅ | 内置零依赖解析器（ZIP + deflate-raw，识别共享字符串与日期格式）；旧版 .xls/.xlsb 请另存为 .xlsx |
| 只读统计、图表、CSV 导出 | ✅ | 工作台 / 单账本 / 成员统计 |
| AI 文字记账、截图记账、问答（SSE） | ✅ | 使用用户自己的 OpenAI 兼容 provider；也可用环境变量兜底 |
| 文档 RAG 检索 | ❌ | 未打包向量索引；问答直接走模型知识 |
| MCP Server（`/api/v1/mcp`） | ✅ | 无状态 Streamable HTTP：11 个读工具 + 6 个写工具；PAT 只能用于此端点 |
| rclone 远程备份 / 定时备份 | ❌ | 改为「R2 JSON 快照」：`/admin/backups/create`、`/admin/backups/restore` |
| 管理后台（用户 / 设备 / 健康 / 清理 / 备份） | ✅ | 在线设备数依赖 Durable Object 查询 |
| WebSocket 实时推送 | ✅ | DO 按用户聚合；断线后靠 `/sync/pull` 补齐 |

免费档硬限制（截至 2026-11）：

- Workers：10 万请求/天、**10ms CPU/请求**。因此没有图片缩放、没有 Excel 解析、密码哈希迭代数调低。
- D1 免费档还有一条容易踩的：**每个 Worker 请求最多 50 次查询**。批量推送和 CSV 导入因此改为
  `db.batch()`（一次 batch 只算 1 次查询）：100 条离线变更约 8 次查询，2000 行导入约 10 次查询。
- D1：500 MB/库、10 万写行/天、单行 2 MB。附件必须放 R2，不能进 D1。
- R2：10 GB 存储、出网免费。开通需一次 checkout（免费额度内不扣费）。
- Cron：5 个/账户。

---

## 本地开发

```bash
npm install
npx wrangler d1 migrations apply beecount-cloud --local

# 构建前端（首次或前端改动后）
bash scripts/build-frontend.sh

npx wrangler dev            # http://localhost:8787
```

可选：在 `.dev.vars` 里放 `JWT_SECRET=...`、`ADMIN_EMAIL=...`、`ADMIN_PASSWORD=...`。
没有 `ADMIN_EMAIL` 时，**第一个注册的账号自动成为管理员**（与原版 bootstrap 行为一致）。

跑测试：

```bash
npx tsc --noEmit
npx vitest run        # 用 miniflare 起真实 D1/R2/DO，覆盖注册→记账→同步→附件→共享→2FA
```

## 部署到 Cloudflare（免费档）

1. 登录并创建资源：

   ```bash
   npx wrangler login
   npx wrangler d1 create beecount-cloud
   npx wrangler r2 bucket create beecount-attachments
   ```

2. 把 `wrangler.jsonc` 里 `d1_databases[0].database_id` 换成上一步输出的 id。

3. 建表（远程）：

   ```bash
   npx wrangler d1 migrations apply beecount-cloud --remote
   ```

4. 设置密钥（不要把 JWT_SECRET 写进仓库）：

   ```bash
   openssl rand -hex 32 | npx wrangler secret put JWT_SECRET
   # 可选：固定首个管理员，避免开放注册时被别人抢注
   npx wrangler secret put ADMIN_EMAIL
   npx wrangler secret put ADMIN_PASSWORD
   ```

5. 构建前端并部署：

   ```bash
   bash scripts/build-frontend.sh
   npx wrangler deploy
   ```

6. 首次打开 `https://<worker>.<subdomain>.workers.dev`，注册第一个账号（或用 `ADMIN_EMAIL` 登录）。
   如果不想开放注册，在 `wrangler.jsonc` 的 `vars` 里加 `"ALLOW_REGISTRATION": "false"` 后重新部署。

升级时重复第 3、5 步；`wrangler d1 migrations apply` 只执行尚未记录的迁移。

### 可选环境变量

| 变量 | 用途 |
|---|---|
| `JWT_SECRET` | 必填（生产）。签发 access/refresh token；改动会让所有会话失效 |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | 首次启动自动建管理员（仅当 users 表为空） |
| `ALLOW_REGISTRATION` | `false` 关闭公开注册 |
| `AI_BASE_URL` / `AI_API_KEY` / `AI_MODEL` | 服务端兜底文本模型（用户没在 App 里配 provider 时使用） |
| `AI_VISION_MODEL` | 截图记账兜底模型 |

---

## 从 1.9.0 迁移数据

没有“直接把 SQLite/Postgres 文件塞进 D1”的路径（D1 只接受 SQL）。推荐：

1. 在旧实例导出账本 CSV（Web 控制台 → 交易 → 导出 CSV）。
2. 在新 Worker 里建账本，用「导入」逐个账本导入；账户 / 分类 / 标签会按名称自动创建。
3. 手机 App 重新登录新地址，走一次 `/sync/full` 即可。

大规模迁移可以写脚本直接调 `/sync/push`（change 格式与原版一致），比 CSV 更保真（保留 syncId、附件引用）。

---

## 代码结构

```
src/
  index.ts            Worker 入口、路由挂载、Cron、/ws
  durable/sync-hub.ts 每用户一个 WebSocket 扇出 DO
  routes/
    auth.ts           注册/登录/刷新/2FA
    sync.ts           full / pull / push / ledgers（LWW、设备游标）
    write.ts          账本/交易/账户/分类/标签/预算/汇率覆盖
    read.ts           账本列表、统计、工作台、图表、CSV 导出
    user.ts           profile / 头像 / PAT / 设备
    attachments.ts    R2 上传下载、分类图标、批量存在性
    sharing.ts        邀请码、成员、转让、成员统计、共享资源
    import.ts         CSV 上传/预览/SSE 执行
    ai.ts             文字/截图记账、问答流、provider 测试
    mcp.ts            MCP（无状态 Streamable HTTP，PAT 鉴权）
    admin.ts          用户、设备、健康、清理、备份、RAG 占位
  lib/                D1 helper、鉴权、JWT/TOTP、投影、快照、CSV
migrations/           D1 schema（0001 初始，0002 PAT 过期列）
frontend/             原版 React 控制台（apps/web + packages/*）
tests/                miniflare 集成测试
```

设计要点：

- **写入即投影**：`/write/*` 与 `/sync/push` 都先写 `sync_changes`，再更新读模型（`read_tx`、`user_accounts`…）。
  读路径只查投影，不解析快照，避免 10ms CPU 预算下重建整本账。
- **没有交互事务**：D1 只有 `batch()` 原子提交；跨语句的“读-改-写”用单条 `INSERT … ON CONFLICT` 或
  “先插 change 再投影”的幂等重放兜底。LWW 冲突检测在应用层完成。
- **变更编号**：`sync_changes.change_id` 用 SQLite AUTOINCREMENT；`app_meta.change_seq` 预留批量号段。
- **附件去重**：`(user_id, sha256, kind)` 唯一；R2 key 为 `u/<user>/<sha 前两位>/<sha>`。

## 已知取舍

- **缩略图**：没有 Pillow，`/attachments/:id/thumbnail` 返回原图（浏览器 CSS 缩放）。大图会多耗流量。
- **图片附件大小**：单文件 64 MB（同原版），但 Workers 请求体上限 100 MB 免费档。
- **导入上限**：一次执行 2000 笔（批次写入，约 10 次 D1 查询）；解析上限 5 万行，超出请拆分文件。
  预览页确认的字段映射会存入 `import_jobs`，执行时按该映射导入；默认按「类型 + 金额 + 时间 + 备注 + 分类」
  跳过已存在的交易，可在预览里选择 `insert_all` 强制全部插入。
- **MCP 工具集**：实现了上游文档里最常用的 17 个工具（账本/交易/分类/账户/标签/预算/统计/搜索的读写）。
  `upload_attachment` 与 `parse_and_create_from_text` 未移植；`create_transactions` 免费档一次最多 5 笔
  （每条交易都会触发投影写入，需控制单次请求的 D1 查询数）。PAT 有 `expires_at`，过期即 401。
- **备份**：`/admin/backups/*` 生成 JSON 快照到 R2；恢复会重写该账本的 `read_tx` 并逐条发 change。
  rclone 远程/定时备份接口保留为空实现，调用会返回 501。
- **在线设备**：管理后台的 `is_online` 是“该用户是否有打开的 WebSocket”，不是逐设备在线状态。
- **RAG / MCP**：未移植。相关接口返回明确的空状态或 501，不会静默假装成功。

## 许可

移植代码沿用原仓库的双许可（见 `LICENSE`、`LICENSE_EN`）。前端源码来自 BeeCount-Cloud 1.9.0，
其版权归原作者所有。使用前请自行确认你的部署场景符合原许可。
