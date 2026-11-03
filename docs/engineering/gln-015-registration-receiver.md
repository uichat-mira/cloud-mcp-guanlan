# GLN-015 · 观澜账户空间注册接收端

> Issue：[uichat-mira/cloud-mcp-guanlan#28](https://github.com/uichat-mira/cloud-mcp-guanlan/issues/28)（`[GLN-015]`）
> 分支：`feat/gln-015-registration-receiver`（基线 `origin/dev` = `fbaecaa`）
> 上游合同：`uichat-mira/cloud-auth` `apps/api/src/guanlan-registration.ts`（GLN-012，PR #130 已合入 `dev`）
> 交叉引用：[GLN-014](gln-014-contract-recon.md) / [验收矩阵](gln-014-acceptance-matrix.md)、Issue #26

## 1. 为什么需要这一块

在 GLN-015 之前，观澜对 `guanlan_accounts` / `guanlan_consumers` **只有 SELECT/COUNT**：
`src/subscriptions.ts`、`src/subscription-mutations.ts` 只读这两张表，`src/app.ts` 没有任何注册路由。
于是即使 Cloud Auth 签发了合法令牌，真实账户在观澜也没有空间行，读/写路径一律返回
`guanlan_principal_unavailable`（`src/mcp/service.ts:557-565`）。

Cloud Auth 一侧（GLN-012）负责产生**投递意图**并受控投递；观澜一侧负责把它落成**自己的**账户空间。
本卡只做后半段，不改 Cloud Auth、不复制它的数据、不引入跨服务共享表。

## 2. 端点

| 项 | 值 |
| --- | --- |
| 路径 | `POST /internal/guanlan-registrations`（`REGISTRATION_PATH`，`src/registration.ts`） |
| 面向 | Cloud Auth 的机器投递，**不是** agent 面、**不是** MCP 工具面 |
| 鉴权 | 仅 HMAC（无 OAuth、无 Cloud Session、无用户凭证） |
| 密钥 | `MIRA_GUANLAN_REGISTRATION_SECRET`，≥32 字符；**未配置即关闭**（`503 registration_not_configured`） |
| 其他方法 | 非 `POST` → `405 method_not_allowed` |
| 响应体 | 成功 `{"accountId":"<same>","registered":true}`；失败 `{"error":"<closed enum>"}` |

端点不提供 `GET`/列表/删除语义；它没有读能力，也不能改订阅、关注点或新闻账本。

## 3. 与 Cloud Auth 发送端的逐项对照

来源：`cloud-auth` `apps/api/src/guanlan-registration.ts` → `createGuanlanRegistrationTransport()`，
以及其契约测试 `apps/api/tests/contract/guanlan-registration.test.ts`。

| 项 | Cloud Auth（发送端，已合入 dev） | 观澜（本接收端） | 一致 |
| --- | --- | --- | --- |
| 方法 | `POST` | 仅接受 `POST`，其余 405 | ✅ |
| 目标 | `MIRA_GUANLAN_REGISTRATION_URL`，必须 `https:` | 路径固定 `/internal/guanlan-registrations`，由部署方拼成 https URL | ✅ |
| 请求头 | `content-type: application/json` | 不依赖 content-type 做判断（只用签名与 body） | ✅ |
| 时间戳头 | `x-mira-timestamp`：Unix 秒字符串 | 同样读取该头 | ✅ |
| 签名头 | `x-mira-signature: sha256=<64 hex>` | 同样读取该头；形状不符即 401 | ✅ |
| 签名输入 | `timestamp + "." + body`（body 是发送端 `JSON.stringify` 的原样字符串） | 用**收到的原始 body 文本**重算，前缀同样是 `timestamp + "."` | ✅ |
| 算法 | HMAC-SHA256，共享 secret ≥32 字符 | 同一算法；secret <32 字符视为未配置（fail closed） | ✅ |
| 时间窗 | 参考 fixture：±300 秒 | `REGISTRATION_TIMESTAMP_WINDOW_SECONDS = 300`，含边界（±300 通过、±301 拒绝） | ✅ |
| 载荷 | `{"version":1,"accountId":"<UUID>"}` | 要求 `version === 1`、`accountId` 为字符串且满足 `0003` 的 1..128 + `trim` 约束 | ✅ |
| 成功判据 | `response.ok` **且** body `accountId` 相同 **且** `registered === true` | 只在 D1 提交并复核后返回该形状 | ✅ |
| 失败语义 | 非 2xx / 网络错 / 收据不匹配 → 计一次失败并退避重试（最多 8 次） | 所有拒绝都是非 2xx；不返回 2xx 表达业务拒绝 | ✅ |
| 超时/重定向 | 发送端 8s 超时、`redirect:"error"` | 接收端不做重定向，也不依赖出网 | ✅ |
| 幂等键 | `accountId`（每账号一个 outbox 行） | `accountId`（表主键 + `INSERT OR IGNORE`） | ✅ |
| 禁用/拒绝账户 | 置 `withheld`，不投递；重新启用只恢复 `withheld` | 接收端没有任何「激活」动作，只有插入语义（见 §5） | ✅ |

## 4. 数据写入（唯一写路径）

一次成功投递在**一个 D1 原子批处理**里完成：

1. `INSERT OR IGNORE INTO guanlan_accounts(account_id, created_at)`
2. `INSERT OR IGNORE INTO guanlan_consumers(account_id, consumer_id = account_id, created_at)`
   —— 按维护者裁决①：`consumer_id` 等于 Cloud Account id。
3. `INSERT OR IGNORE INTO guanlan_registration_receipts(account_id, first_delivered_at, last_delivered_at, deliveries = 1)`

重复投递只执行一条语句：`UPDATE guanlan_registration_receipts SET last_delivered_at=?, deliveries=deliveries+1`
—— **首次投递与重复投递各只记一次**，不会重复计数（这是实现期由真实 D1 测试发现的缺陷，已修正）。

批处理结束后**重新读一次真实状态**再决定响应：只有 `account` + `consumer` + `receipt` 三者都存在才返回
`{accountId, registered:true}`；否则返回 `409 space_state_conflict`。Cloud Auth 只会把该收据记为
`delivered`，所以观澜绝不能凭「批处理没抛错」就宣称成功。

**绝不写入**：订阅（`guanlan_*_subscriptions`）、关注点（`guanlan_*_interests`）、
新闻账本（`guanlan_consumer_news_states`）、`poc_sources`/`poc_news`。测试逐项断言这些表保持 0 行。

## 5. 幂等、回放与「不复活」

| 数据库状态 | 含义 | 动作 | 结果 |
| --- | --- | --- | --- |
| account 无、consumer 无、receipt 无 | 首次注册 | 建两行 + 收据 | `200` |
| account 有、consumer 有 | 重复投递（Cloud Auth 重试/补投） | 只更新收据时间与计数 | `200` |
| account 有、consumer 无 | 空间被运维拆除 | 不写入 | `409 space_state_conflict` |
| account 无、receipt 有 | 注册后被删除 | 不写入 | `409 space_state_conflict` |
| account 无、consumer 有 | 违反外键，理论上不可能 | 不写入 | `409 space_state_conflict` |

- **回放（replay）**：时间窗内重复到达的同一份已签名请求会被**再次接受**，但因为写路径是
  「插入或忽略」，副作用与首次相同（行数不变）。时间窗外的回放一律 `401 invalid_timestamp`。
  这里刻意不使用 nonce 表：Cloud Auth 的重试本身就会重发同一 payload，拒绝重发会造成永久失败。
- **乱序**：不同账户之间的投递互不依赖；同一账户的乱序只表现为收据计数顺序不同，空间行不会重复。
- **不复活**：`guanlan_registration_receipts` 的存在是「这个账户曾经注册过」的唯一证据。
  一旦收据存在，插入语句的 `WHERE NOT EXISTS (…)` 守卫就会阻止重建已删除的空间；
  空间被拆（account 在、consumer 缺）时也直接拒绝。删除动作本身属于运维/清理，另有工作项，
  本卡不提供删除 API，只保证**投递不会把它撤销掉**。
- **并发**：所有写入都在单个 `db.batch()` 内，且最终以真实状态复核；6 路并发重复投递在真实 D1 上仍只产生 1 行 account + 1 行 consumer。

## 6. 错误语义（封闭枚举，不泄漏内部状态）

| 状态码 | `error` | 触发条件 | 是否写库 |
| --- | --- | --- | --- |
| `405` | `method_not_allowed` | 非 `POST` | 否 |
| `503` | `registration_not_configured` | `MIRA_GUANLAN_REGISTRATION_SECRET` 缺失或 <32 字符 | 否 |
| `413` | `payload_too_large` | `content-length` 或实际 body > 4096 字节 | 否 |
| `401` | `invalid_timestamp` | 头缺失/非数字/超出 ±300s | 否 |
| `401` | `invalid_signature` | 头形状不符或 HMAC 校验失败（含错误 secret、被篡改 body） | 否 |
| `400` | `invalid_request` | body 非 JSON 对象、`version !== 1`、`accountId` 不合规 | 否 |
| `409` | `space_state_conflict` | 见 §5 的三种冲突状态 | 否 |
| `500` | `registration_unavailable` | D1 故障 | 可能（由 D1 决定），可重试 |

响应体只有 `{error: <code>}` 一个字段，不区分「账户不存在」与「签名正确但状态冲突」之外的信息，
不回显任何标识符、密钥、SQL 或堆栈。签名比较使用 `crypto.subtle.verify`（平台常量时间比较），
代码中没有任何对 secret/摘要的 `===` 比较。

## 7. 部署配置

1. **文件位置**：本仓库 `wrangler.jsonc` 保持不可部署的占位形态，真实 D1 UUID / 账户 ID 不入库。
2. **密钥**：`wrangler secret put MIRA_GUANLAN_REGISTRATION_SECRET`（≥32 字符随机值），
   与 Cloud Auth 侧 `MIRA_GUANLAN_REGISTRATION_SECRET` **同一个值**；只在运行环境注入，不写进仓库、PR、日志。
3. **迁移**：本卡新增 `migrations/0005_guanlan_registration_receipts.sql`。
   隔离环境需要按序执行 `0001` → `0005`；只应用 `0003`/`0004` 的旧环境缺少收据表，
   接收端会以 `500 registration_unavailable` fail closed（不会静默成功）。
4. **Cloud Auth 侧配置**：`MIRA_GUANLAN_REGISTRATION_URL=https://<worker-host>/internal/guanlan-registrations`。
5. **Cron**：与本端点无关；接收端不需要定时任务。
6. **鉴权边界**：不新增任何公开 REST 读能力；`/mcp` 与 metadata 行为不变（测试断言 `/mcp` 仍为
   `503 mcp_not_configured`、`/health` 仍为 `200 publicApi:false`、未知路径仍为 `404`）。

## 8. 验证证据

| 层 | 命令 | 结果 |
| --- | --- | --- |
| T1 单元（离线） | `node --test tests/registration.test.mjs` | **10/10 通过**：非 POST、缺/短密钥、±300 边界、非数字时间戳、坏签名（错 secret / 被篡改 body / 畸形头）、schema 边界（`version`、空/超长/带空白 `accountId`、非对象 body）、超大体（头声明与实际长度两条路径）、重放再次通过校验 |
| T2/T3 真实 workerd + 真实 D1 | `node --test tests/registration-workerd.test.mjs` | **8/8 通过**：首次建两行 + 收据（并断言私有表全 0 行）、重复与乱序幂等、6 路并发只建一份、拒绝矩阵零写入、缺密钥 503、拆除空间 409 不重建、注册后删除 409 不复活、`/health`+`/mcp`+404 行为不变 |
| 仓库门禁 | `npm run check` | 见 PR 描述（typecheck / unit / integration / dry-run / benchmark / canary / profile） |
| T4 真实部署 | 未执行 | **blocker**：隔离非生产 Cloudflare 环境尚未就绪（凭证见 Issue #26 评论），本卡不含真实部署证据 |

签名在测试中由 **Node 自带 `crypto` 独立计算**，不复用被测实现；`accountId` 用假名常量，不含真实账户 ID。

## 9. 已知边界与后续

- **不做**跨服务的禁用/删除通知、强撤销、观澜侧数据清理（`cloud-auth` PR #130 已明确列为后续共同合同）。
- **不做**删除 API。拆除/删除目前只能由运维直接操作 D1，本卡只保证投递不会复活它们。
- **不做**订阅变更工具面（属独立工作项建议，见 GLN-014 验收矩阵 §7）。
- Cloud Auth 侧 `failed` 表示「本批未确认」，可能只是安排了重试；观澜的 `409` 会让该账户在 8 次预算内
  耗尽后进入终态 `failed`，需要管理员 `guanlan-retry`。这是刻意选择：宁可让运维显式确认，也不静默复活。
