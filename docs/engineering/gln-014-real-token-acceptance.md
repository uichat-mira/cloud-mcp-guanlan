# GLN-014 L3：真实令牌的 Guanlan MCP 读写验收（t10）

> 工作项：t10 · [GLN-014] 真实令牌的 Guanlan MCP 读写与隔离验收
> 关联 Issue：[#26 `[GLN-014]`](https://github.com/uichat-mira/cloud-mcp-guanlan/issues/26)
> 证据类型：**真实 Cloud Auth 非生产实例签发 → 真实公网 Worker → 真实 D1**。内容侧使用一行**合成 fixture 文章**（见 §9-1），身份链路无任何 fixture。
> 时间：2026-11-04。

## 1. 环境与身份链路

| 组件 | 事实 |
| --- | --- |
| 资源服务 | `https://cloud-guanlan-gln014-3c872be6.dangjingtao.workers.dev`（`workers_dev: true`，`triggers.crons: []`） |
| 部署版本 | `752ae9d7-…`（§3/§4 主链路）、`dbf9ae4a-…`（§5.2 N6/N7）、`2958d284-…`（隧道换址后重指）、**`8bfa761c-7bfb-43b4-bd4c-5ca5bf720501`（当前，§13 静态 JWKS）**。各次 deploy 之间**只改 JWKS/issuer 变量**，未改代码、未动 D1；`8bfa761c` 之后真实令牌 `whoami`/`news_recent` 均 200，决策账本未变 |
| D1 | `cloud-guanlan-gln014-3c872be6`，迁移 0001..0005 |
| Cloud Auth（非生产） | `127.0.0.1:8788`（auth-dev t23 实例），签发 `POST /v1/service-credentials` |
| JWKS | **`https://mira-auth-jwks-test.pages.dev/.well-known/jwks.json`**（§13：Cloudflare Pages 静态托管公钥，`cache-control: public, max-age=300`；单 key `kid=gln013-t23-1`、`kty=OKP`/`Ed25519`/`EdDSA`、无 `d`）。t10 早期证据使用的是当时可用的 localhost.run 隧道地址 |
| 主体 | 前缀 `5728cbcd`（`sha256_12 = a5600cdf992a`），`accountId == consumerId`（维护者裁决①） |

Worker 绑定：`DB`、`MCP_RESOURCE_URL`、`MCP_AUDIENCE=mira:cloud-guanlan`、`CLOUD_AUTH_JWKS_URL=https://mira-auth-jwks-test.pages.dev/.well-known/jwks.json`、`CLOUD_AUTH_ISSUER=https://mira-auth-jwks-test.pages.dev`（后者仅测试期元数据占位，见 §13）。

> **契约澄清（易错点）**：`CLOUD_AUTH_ISSUER` 是 RFC 9728 发现里对外公布的 **OAuth 授权服务器 URL**，`resolveMcpConfig` 要求它是合法 HTTPS URL；JWT 的 `iss` 由代码常量 `CLOUD_AUTH_TOKEN_ISSUER = "mira:cloud-auth"` 单独校验。因此**不能**把 `CLOUD_AUTH_ISSUER` 设成 `mira:cloud-auth`（会被判 `cloud_auth_issuer` → `/mcp` 503）。见 `src/mcp/config.ts:82-83` 与 `src/mcp/config.ts:114`。

## 2. 令牌合同核对（不打印令牌原文）

`mint.mjs` 现签、令牌只落本机受限临时文件；下列为脱敏投影：

| 项 | 值 | 与资源服务期望一致 |
| --- | --- | --- |
| `alg` / `kid` | `EdDSA` / `gln013-t23-1` | ✅ 与 JWKS 单 key 匹配 |
| `iss` | `mira:cloud-auth` | ✅ 与 `CLOUD_AUTH_TOKEN_ISSUER` 相同 |
| `aud` | `mira:cloud-guanlan`（单值） | ✅ 与 `MCP_AUDIENCE` 精确相等 |
| `scope` | `["guanlan.read"]`（写令牌为 `["guanlan.read","guanlan.write"]`；N6 的 Shiyan 令牌为 `["shiyan:authenticate"]`，无 consumer claim） | ✅ 含全局读门 `guanlan.read` |
| `consumer_id` | 存在且 `=== sub` | ✅ |
| `ttl` | 300s | ✅ ≤ 维护者裁决的 300s 上限 |

## 3. 主链路：read → CAS decide → 重读（全部真实令牌）

协议：Streamable HTTP，`legacy: "stateless"`，无需会话 id（`mcp-session-id` 响应头 absent，未影响调用）。

| # | 调用 | HTTP | isError | 结果 / 工具错误码 | stateVersion |
| --- | --- | --- | --- | --- | --- |
| 1 | `initialize` | 200 | – | `serverInfo` 返回，`capabilities.tools` 存在 | – |
| 2 | `tools/list` | 200 | – | 3 个工具：`guanlan_news_recent`(ro)、`guanlan_whoami`(ro)、`guanlan_news_decide`(write, idempotent) | – |
| 3 | `guanlan_whoami` | 200 | false | `accountId == consumerId`（前缀 `5728cbcd`），`scopes:["guanlan.read"]` | – |
| 4 | `guanlan_news_recent`（读前） | 200 | false | 1 条，`status:"unread"`，`sourceId:"t10-fixture-source"` | **0** |
| 5 | `guanlan_news_decide`（`expectedVersion: 0`, operationId A, `status:"adopted"`） | 200 | false | `result:"updated"`、`status:"adopted"` | **1** |
| 6 | 同 operationId A 重放（同内容） | 200 | false | `result:"replayed"`，版本不再上涨 | 1 |
| 7 | 旧 `expectedVersion: 0` 再判（新 operationId B, `status:"ignored"`） | 200 | **true** | `guanlan_decision_version_conflict`，正文回显当前 `version:1`，**未覆盖** | 1 |
| 8 | `guanlan_news_recent`（读后，含 adopted/ignored/pending） | 200 | false | 1 条，`status:"adopted"` | **1** |
| 9 | 再判（`expectedVersion: 1`, operationId C, `status:"ignored"`） | 200 | false | `result:"updated"` | **2** |

要点：
- **CAS 生效**：第 7 步用过期版本被判冲突，且错误正文带出真实当前状态（便于客户端重读），不是静默覆盖。
- **幂等生效**：第 6 步同 `operationId` 被判 `replayed`，版本保持 1。
- **持久化可观察**：第 8/9 步读回 `adopted@1`→`ignored@2`，与 D1 行一致（§4）。
- MCP 语义：工具级拒绝以 **HTTP 200 + `isError:true`** 返回（协议约定），不是 HTTP 4xx；认证级拒绝才是 401（§5）。

## 4. 真实 D1 侧不变量

`wrangler d1 execute --remote` 只读取证：

| 表 | 值 | 说明 |
| --- | --- | --- |
| `guanlan_consumer_news_states` | 1 行：`status=ignored`、`version=2`、`source_id=t10-fixture-source`、`news_fingerprint` 前缀 `a6fccf469acd`、`reason` 长度 30、`last_operation_id` 前缀 `t10-179372` | 与第 9 步一致；**仅 1 行**，冲突/重放都没有产生额外行 |
| `guanlan_accounts` / `guanlan_consumers` | 3 / 3（`5728cbcd` + 两条 t18 合成 UUID） | 未新增/删除 |
| `guanlan_account_subscriptions` / `..._consumer_subscriptions` | 1 / 1（本次 seed 的 fixture 源） | 写路径未改动订阅 |
| `guanlan_account_interests` / `..._consumer_interests` | 0 / 0 | 未产生 |
| `poc_sources` / `poc_news` | 1 / 1（fixture） | 未新增 |

**结论**：写工具只动 `guanlan_consumer_news_states`，不越权写订阅/关注点/新闻索引。

## 5. 负例矩阵

| # | 负例 | 构造 | 结果 | 数据不变 |
| --- | --- | --- | --- | --- |
| N1 | 无凭据 | 不带 `Authorization` | **401**，`WWW-Authenticate: Bearer error="invalid_token", error_description="Missing Authorization header", scope="guanlan.read", resource_metadata="…/oauth-protected-resource/mcp"` | ✅ |
| N2 | 垃圾/伪造令牌 | `Bearer not-a-jwt` | **401** `invalid_token` | ✅ |
| N3 | 篡改签名 | 取真令牌，改写签名尾 4 字节 | **401**（签名校验拒绝） | ✅ |
| N4 | 仅读令牌调写工具 | `scopes:["guanlan.read"]` 打 `guanlan_news_decide` | HTTP 200 + `isError:true`，`guanlan_decision_forbidden`（「read access never grants state changes」） | ✅ 版本仍 2 |
| N5 | 过期令牌 | 现签后等过 300s TTL 再调 `guanlan_whoami` | **401**（见 §5.1） | ✅ |
| N6 | 错误 audience | 用 `mint.mjs --audience=mira:cloud-shiyan` 现签 Shiyan 令牌（`aud=mira:cloud-shiyan`、`scope=["shiyan:authenticate"]`、**无 consumer claim**、`alg=EdDSA`、`kid=gln013-t23-1`）打 Guanlan `/mcp` | **401** `invalid_token`（**不是 503**，说明是验证拒绝而非部署配置错误）；`WWW-Authenticate` 仍带 `scope="guanlan.read"` 与 `resource_metadata` | ✅ 无写入 |
| N7 | 跨账户读他人数据 | 经**真实 GLN-015 接收端**注册第二个**显式合成**账户 `33333333…`（HMAC 签名投递返回 200 `registered:true`），并为它 seed 独立源（`t10-fixture-source-b`）与独立文章（`…/t10b/article-b1`）；再用真实身份 A 的令牌读写 | **隔离成立**（见 §5.2）：A 的 `news_recent` 只返回自己的 1 条，B 的文章**不可见**；A 对 B 的文章 `decide` → `guanlan_decision_not_available`（与"不存在"同一错误码，不泄露存在性）；D1 `states` 仍为 1 行、`version` 仍为 2 | ✅ |
| N8 | 跨 consumer | `consumer_id` 恒等于 `sub`（裁决①），签发器不接受自报 consumer | **结构性不可构造**；由 GLN-013 单测与 `consumer_id===sub` refine 覆盖 | n/a |
| N9 | 无空间（未供应） | 未 `delivered` 账户取令牌 | **blocker**：签发前置即为 409 `SERVICE_CREDENTIAL_PRINCIPAL_NOT_READY`，无法获得令牌去验证资源服务侧分支 | n/a |
| N10 | 禁用账户 | 需要非生产实例的禁用开关 | **blocker**：t23 实例未提供禁用 API；生产未触碰 | n/a |
| N11 | 第二身份令牌（B 的令牌读 A 数据） | 需要 Cloud Auth 为账户 B 完成 `delivered` 投递后才可签发 | **blocker**：B 目前只有 Guanlan 侧空间行，Cloud Auth 侧未投递，取不到令牌 | n/a |

### 5.1 N5 过期令牌（已实测）

现签（`exp - iat = 300`）→ 等到 `exp + 15s` → 打 `/mcp` `tools/call guanlan_whoami`：

```
HTTP 401
WWW-Authenticate: Bearer error="invalid_token", error_description="invalid_token", scope="guanlan.read", resource_metadata="…/oauth-protected-resource/mcp"
body: {"error":"invalid_token","error_description":"invalid_token"}
```

即超过 TTL 的令牌被拒绝，且响应不透露「是过期还是签名不对」——与既有不透明 401 语义一致。

### 5.2 N6/N7 实测细节

**N6 错误 audience**（一次成功，非重试凑数）：

```json
{ "shiyanToken": { "aud": "mira:cloud-shiyan", "scope": ["shiyan:authenticate"],
                   "alg": "EdDSA", "kid": "gln013-t23-1", "hasConsumerClaim": false },
  "guanlanMcp": { "status": 401,
                  "wwwAuthenticate": "Bearer error=\"invalid_token\", error_description=\"invalid_token\", scope=\"guanlan.read\", resource_metadata=\"…/oauth-protected-resource/mcp\"" } }
```

**坑（值得写进联调手册）**：签发器的 audience 常量是 `mira:cloud-shiyan`（带 `cloud-` 前缀）。请求 `{"audience":"mira:shiyan"}` 会得到 **400 `SERVICE_CREDENTIAL_INVALID_REQUEST`**——这是签发侧入参错误，**不是** audience 校验结论；只有拿到 `aud=mira:cloud-shiyan` 的真实令牌后打 `/mcp` 得到的 401 才是本条的结论。

**N7 跨账户隔离**（真实身份 A + 显式合成账户 B）：

| 步骤 | 调用 | HTTP | 结果 |
| --- | --- | --- | --- |
| 1 | `POST /internal/guanlan-registrations`（HMAC，账户 `33333333…`） | 200 | `{"registered":true}` —— 走的是真实接收端与真实 D1 写入 |
| 2 | `guanlan_whoami`（A 的令牌） | 200 | `accountId == consumerId == 5728cbcd…`，`scopes:["guanlan.read","guanlan.write"]` |
| 3 | `guanlan_news_recent`（limit 20，含全部状态） | 200 | `count=1`，只含 `…/t10/article-1`（A 自己的）；**B 的 `…/t10b/article-b1` 不在结果里** |
| 4 | `guanlan_news_decide`（目标 = B 的文章，`expectedVersion:0`） | 200 + `isError` | `guanlan_decision_not_available`（「not available for a decision under this verified identity」） |

D1 佐证：`guanlan_consumer_news_states` 仍为 **1 行 / version 2**（第 4 步没有产生任何行）；`poc_news=2`、`poc_sources=2`、`guanlan_consumer_subscriptions=2`（A、B 各一条），即 B 的数据确实存在、只是对 A 不可见/不可判。

> 边界：B 是**显式合成账户**（UUID `33333333…`，仅为隔离测试而建），它在 Cloud Auth 侧没有身份，因此"B 的令牌去读 A 的数据"这一方向见 N11 blocker。N7 证明的是资源服务按**已验证身份**过滤读写，不是按客户端传入的 id。

## 6. 撤销语义（按既定裁决）

- **不宣称即时撤销**：令牌无 `jti`、无撤销表，撤销 = 短 TTL。因此「停止续签后 ≤300s 内失效」是本设计能达到的最强保证。
- **禁用账户的残留**：账户被禁用后，已签发令牌在 `exp` 前仍然可用（≤300s 窗口）。本轮**未验证**该残留（见 N10 blocker），报告必须写明它是设计允许的窗口，而非已消除。
- 已实测：超过 TTL 的令牌被 401 拒绝（N5）。

## 7. fail-closed 与不退化项

| 项 | 结果 | 来源 |
| --- | --- | --- |
| JWKS 不可达时拒绝令牌 | **401**（占位 `cloud-auth.invalid` 期间所有令牌 401） | t18 冒烟 S4；本轮隧道 host 轮换期间同样只出现 401，没有 5xx 或放行 |
| 同级 Worker→Worker 子请求 | **被平台拒绝**：`404` + `error code: 1042`（同 `*.workers.dev` 区域） | §13 `/selftest` 诊断部署 `c205fdb2…` |
| RFC 9728 metadata | 200，`resource`/`scopes_supported`/`bearer_methods_supported`/`authorization_servers` 正确 | t18 S2（变量替换后 host 变了，字段结构不变） |
| 未知路径 | 404 `not_found` | t18 S5 |
| Host/Origin 校验 | 既有单测；本轮真实请求未触发 403（`Origin` 未发送、`Host` 为 Worker 自身） | `src/mcp/server.ts:326-331` |
| legacy `stateless` | 本轮全部调用成功，未要求会话 id | 本文件 §3 |
| 只读工具面不退化 | `tools/list` 仍 3 个工具，annotations 与既有一致 | 本文件 §3-2 |

## 8. 复现步骤

```powershell
# 0) JWKS 现在是静态发布（§13），不再依赖隧道；只有「本机现签」需要 auth-dev 的实例（127.0.0.1:8788）

# 1) 只改变量重 deploy（不重建 D1；配置在仓库外，含 D1 UUID）
#    CLOUD_AUTH_JWKS_URL = https://mira-auth-jwks-test.pages.dev/.well-known/jwks.json
#    CLOUD_AUTH_ISSUER   = https://mira-auth-jwks-test.pages.dev   # 必须是 https URL，不能是 mira:cloud-auth
.\node_modules\.bin\wrangler.cmd deploy --config "$env:LOCALAPPDATA\Temp\gln014-env\wrangler.jsonc"

# 2) 现签令牌（TTL 300s，只打印摘要，令牌落本机受限文件）
node "$env:TEMP\gln013-t23\mint.mjs" "$env:TEMP\gln013-t23" guanlan.read guanlan.write

# 3) 跑验收客户端（真实公网；Client 仅用标准 JSON-RPC over Streamable HTTP）
$env:MCP_BASE='https://cloud-guanlan-gln014-3c872be6.dangjingtao.workers.dev'
$env:MINT_DIR="$env:TEMP\gln013-t23"
$env:NODE_USE_ENV_PROXY=1; $env:HTTPS_PROXY='http://127.0.0.1:1080'; $env:NO_PROXY='127.0.0.1,localhost'
node "$env:TEMP\gln014-env\mcp-acceptance.mjs" main      # 主链路
node "$env:TEMP\gln014-env\mcp-acceptance.mjs" readonly  # N4
node "$env:TEMP\gln014-env\mcp-acceptance.mjs" tampered  # N3
node "$env:TEMP\gln014-env\expired-token.mjs"            # N5（等 300s）
node "$env:TEMP\gln014-env\isolation-and-audience.mjs"   # N7 跨账户隔离
node "$env:TEMP\gln014-env\wrong-audience.mjs"           # N6 错误 audience（Shiyan 令牌）
```

上述客户端脚本位于**仓库外**临时目录（含令牌路径假设），不入库；实现是通用 JSON-RPC，不依赖本仓内部代码。

## 9. 诚实性边界（验收口径）

1. **内容侧是 fixture**：`poc_sources`/`poc_news` 里只有一行合成文章（URL `https://fixture.invalid/...`），因为维护者尚未批准任何真实新闻源（G4）。这证明「读→判→重读」的**机制与身份链路**，不证明真实采集内容。身份、令牌、JWKS、Worker、D1、CAS、幂等全部真实。
2. **身份与数据**：真实令牌只有 `5728cbcd` 一个主体；第二个账户 `33333333…` 是**显式合成**的（真实走 GLN-015 接收端 + 真实 D1 写入），只用于跨账户隔离测试，它在 Cloud Auth 侧没有身份。因此 N7（A 读不到 B 的数据）已验证，N11（B 的令牌读 A 的数据）、N9（无空间）、N10（禁用账户）仍是 blocker，不以推断代替证据。
3. **JWKS 托管方式**：早期证据用的是 localhost.run 临时隧道（换 host 期间 `/mcp` 全部 401，fail closed）；2026-11-04 起改为 **Cloudflare Pages 静态发布公钥**（§13），隧道不再参与校验，但代价是**密钥轮换后必须重新发布**，且生产形态必须换成 Cloud Auth 的真实 JWKS。
4. **撤销是 TTL 语义**：没有即时撤销；禁用账户的 ≤300s 残留未消除（§6）。
5. **`bash scripts/check.sh` 本机不可执行**：`C:\Windows\system32\bash.exe` 是 WSL 且 25s 内无响应（探测已记录），故以 `npm run check` 与 Ubuntu CI 为权威。这是环境限制，不是脚本缺陷。
6. **测试命令结果**：`npm run check` exit 0（typecheck + unit + workerd integration + dry-run + benchmark + canary + profile），见 §10。

## 10. 验证命令与结果

| 命令 | 结果 |
| --- | --- |
| `npm run check`（`D:\cloud-mcp-guanlan-wt\gln-014`） | **exit 0**（末尾 profile `pass 1 / fail 0`） |
| `bash scripts/check.sh` | **未执行**：本机只有 WSL `bash.exe`，探测 25s 无响应；Ubuntu CI 为权威 |
| `wrangler deploy --config <仓库外配置>` | exit 0：`752ae9d7-…`（主链路）、`dbf9ae4a-9495-4176-b2c8-ab137afe07d5`（补跑 N6/N7 前按新 host 重 deploy，仅变量变化） |
| `wrangler d1 execute --remote`（只读核对） | 见 §4 |

## 11. 资源服务侧改动

**无需改动**：真实令牌链路暴露的失败最初全部来自环境（JWKS host 轮换），不是代码缺陷。本轮**未修改** `src/**`、`migrations/**`、`wrangler.jsonc`；本卡只新增本文档。

## 12. t9（Pi SDK 原生 MCP Extension）联调所需配置

| 项 | 值 | 说明 |
| --- | --- | --- |
| MCP 资源端点 | `https://cloud-guanlan-gln014-3c872be6.dangjingtao.workers.dev/mcp` | Streamable HTTP，`legacy: "stateless"`；实测无需 `Mcp-Session-Id`，但客户端走标准 `initialize` → `tools/list` → `tools/call` 也完全正常 |
| 元数据端点 | `…/.well-known/oauth-protected-resource/mcp` | RFC 9728；`bearer_methods_supported:["header"]`、`scopes_supported:["guanlan.read"]` |
| 必需请求头 | `content-type: application/json`、`accept: application/json, text/event-stream`、`authorization: Bearer <token>` | 缺 `accept` 且服务端选择 SSE 时客户端要能解析 `text/event-stream` |
| `aud`（令牌） | `mira:cloud-guanlan` | 精确匹配；不要用资源 URL 以外的值 |
| `iss`（令牌） | `mira:cloud-auth` | 代码常量，**不是**环境变量；Pi 侧不要试图用 discovery 的 issuer 覆盖它 |
| `CLOUD_AUTH_ISSUER`（部署侧） | `https://mira-auth-jwks-test.pages.dev`（HTTPS URL） | 仅用于 RFC 9728 发现，**测试期占位**（真实授权服务器应为 Cloud Auth）；**填 `mira:cloud-auth` 会让 `/mcp` 返回 503** |
| JWKS | `https://mira-auth-jwks-test.pages.dev/.well-known/jwks.json`，`kid=gln013-t23-1`、`EdDSA`/`Ed25519`、`cache-control: public, max-age=300` | **静态发布（§13）**，由 Worker 侧（Cloudflare 出网）拉取，不需要本机代理；本机自验才需 `HTTPS_PROXY`。隧道**不再**参与校验；密钥轮换后必须重新发布 |
| 令牌现签 | `node "%TEMP%\gln013-t23\mint.mjs" "%TEMP%\gln013-t23" [guanlan.read] [guanlan.write]` | TTL **300s**：**每次调用前现签**，不要缓存到文件后隔几分钟再用；令牌只出现在本机受限临时文件里 |
| 工具面 | 读：`guanlan_news_recent`、`guanlan_whoami`；写：`guanlan_news_decide` | 写工具需 `guanlan.write` scope，仅读令牌调用返回 `guanlan_decision_forbidden`（HTTP 200 + `isError`） |

> **关于「令牌现签」的定位（务必按此理解）**：上面这条现签命令是 **V1 单租户委托下的临时验证形态**，只用于 L3 联调证明合同与校验成立，
> **不是目标架构**，也不是 Pi 侧应长期采用的做法。手工现签意味着人（或脚本）持有签发凭据并缓存令牌，放在产品里就等于把凭据管理、轮换、
> 撤销都推给调用方。目标形态是**服务侧按需签发**：Pi 以自身服务身份换取**短 TTL** 的 Guanlan 令牌（TTL 由签发方决定，客户端不做长期缓存，
> 过期即重取），并保留后续补 `jti` / 撤销表的能力。t9 用现签只是让联调不依赖尚未实现的自动签发链路；这条差别必须写进最终报告，
> 否则读者会误以为「每次调用前手工 mint」是设计意图。

Pi 侧接入时预期能观察到的失败形态（便于区分问题归属）：

| 现象 | 含义 | 处置 |
| --- | --- | --- |
| `/mcp` 返回 **503** | 部署配置不合法（如 `CLOUD_AUTH_ISSUER` 不是 HTTPS URL） | 修 Worker 变量后重 deploy，不是令牌问题 |
| `/mcp` 返回 **401** `invalid_token` | 令牌被拒：过期、`iss`/`aud` 不匹配、签名不可验证、JWKS 静态副本与当前密钥不一致 | 先确认 `/mcp` 用的 JWKS 地址可公开访问且内容是最新公钥（§13），再查令牌 TTL；**不要再怀疑隧道** |
| 工具返回 `isError` + `guanlan_decision_forbidden` | 令牌缺 `guanlan.write` | 现签时显式带上 `guanlan.write` |
| 工具返回 `guanlan_principal_unavailable` | 该账户尚无 Guanlan 空间行（未投递） | 需要 Cloud Auth 侧完成 `delivered` 投递 |
| 工具返回 `guanlan_decision_version_conflict` | CAS 的 `expectedVersion` 过期 | 重新 `guanlan_news_recent` 读 `stateVersion` 再判 |

> 环境生命周期：该 Worker 与 D1 保留到 t9 跑完；销毁前由 lead 明确通知，销毁命令见 `docs/engineering/gln-014-isolated-env.md` §6（Worker delete + D1 delete + 静态 JWKS 清理）。

## 13. 静态 JWKS：隔离环境的稳定性措施（2026-11-04）

**动因**：此前 `CLOUD_AUTH_JWKS_URL` 指向 auth-dev 的 localhost.run 隧道，隧道每次重连换 host，Worker 就会因为「JWKS 取不到」而把**所有**令牌判 401 —— t10 期间实际踩了 3 次。这类 401 与令牌合同无关，却会被误读成「令牌/校验有问题」，对 t9 联调尤其有害。

**做法**：把当前**公钥**静态发布到一个稳定地址，Worker 不再依赖隧道。

| 项 | 值 |
| --- | --- |
| JWKS 静态地址（t9 用） | `https://mira-auth-jwks-test.pages.dev/.well-known/jwks.json`（另有 `/jwks.json` 同内容） |
| 托管方式 | **Cloudflare Pages** 静态托管（项目 `mira-auth-jwks-test`），仓库外目录部署，只含 `jwks.json` / `health.json` / `_headers` |
| 内容 | 仅公钥：`kid=gln013-t23-1`、`kty=OKP`、`crv=Ed25519`、`alg=EdDSA`、单 key、**无 `d`（无私钥）** |
| 缓存头 | `cache-control: public, max-age=300`（由 Pages `_headers` 设定）、`content-type: application/json` |
| Guanlan Worker 变量 | `CLOUD_AUTH_JWKS_URL=https://mira-auth-jwks-test.pages.dev/.well-known/jwks.json`；`CLOUD_AUTH_ISSUER=https://mira-auth-jwks-test.pages.dev`（**仅测试期元数据占位**，真实授权服务器以生产为准） |
| 部署版本 | `8bfa761c-7bfb-43b4-bd4c-5ca5bf720501`（只改变量，未改代码、未动 D1） |
| 真实令牌自检 | `initialize` 200、`tools/list` 200、`guanlan_whoami` 200（`consumerEqualsAccount:true`、scopes `[read,write]`）、`guanlan_news_recent` 200（`count=1`，只含自己的文章）、跨账户 `decide` 仍 `guanlan_decision_not_available` |
| 隧道/代理下线后的复验 | 8788 签发端点 200、8789 代理**已关闭**；本机现签成功（`aud=mira:cloud-guanlan`、`ttl=300`、`consumer_eq_sub=true`）后 `/mcp` 的 `initialize`/`tools/list`/`whoami` 仍 **200** ⇒ Worker 端已与隧道彻底解耦（2026-11-04） |
| 公钥一致性（双方独立核对） | 我方：Pages 内容与部署副本 `same_x=true`、`has_d=false`；auth-dev 侧：从 Pages 取回后与其本机 `signing.pub.pem` 导出的 JWK 比对 **`pages_matches_local=true`**、`kid=gln013-t23-1`、无 `d` ⇒ 静态副本确实是这把钥匙的公钥，排除「发布了另一把公钥」的静默错误 |

**平台约束（重要，解释了为什么不是「另一个 Worker」）**：原计划用独立 Worker 提供 JWKS，实测**不可行** —— Cloudflare 拒绝同一 `*.workers.dev` 区域内的 Worker→Worker 子请求，返回 `404` + 正文 `error code: 1042`。用诊断路由 `/selftest` 复现（该次部署 version `c205fdb2…`）：

```json
{"results":[{"target":"https://mira-auth-jwks-test.dangjingtao.workers.dev/.well-known/jwks.json",
             "status":404,"bytes":17,"preview":"error code: 1042\n"},
            {"target":"https://mira-auth-jwks-test.dangjingtao.workers.dev/health",
             "status":404,"bytes":17,"preview":"error code: 1042\n"}]}
```

因此改用 **Pages**（`*.pages.dev` 属不同区域，Worker 可正常抓取）。诊断 Worker `mira-auth-jwks-test` 曾作为平台约束证据保留，**已于 2026-11-04 删除**（证据即上面的 `/selftest` 输出，保留在本文档中），以免与同名 Pages 项目混淆。若坚持用 Worker 承载 JWKS，唯一可行路径是 Service Binding + 改 Guanlan 代码，本轮明确**不**采用（避免为测试稳定性改产品代码）。

**边界（不得被误读）**：
1. 这是**隔离测试环境的稳定性措施**，不是产品形态。生产形态必须使用**常驻 Cloud Auth 的真实 JWKS**（或其等价的受管发布），而不是人工静态化公钥。
2. **公钥静态发布 ≠ 密钥托管**：私钥始终在 auth-dev 本机（签发实例内），这里只有公钥。静态化带来的代价是：**密钥轮换后必须重新发布**，否则 Worker 会 401（fail closed）。轮换时按「取新 JWKS → 覆盖 `jwks.json` → `wrangler pages deploy` → 冒烟 whoami」执行。
3. 隧道**已完全退出链路**：auth-dev 已按要求关闭隧道与 8789 代理；现签只需本机 8788 签发端点（`mint.mjs` 直连 loopback）。因此「换 host / 隧道断线」不再影响 `/mcp` 的令牌校验，反之签发端点宕机只影响「拿新令牌」。
4. 该 Pages 项目属**待销毁**资源（与 D1/Worker 同期清理）。

## 14. 真实令牌读到**真实新闻**（2026-11-04，t28）

### 14.1 为什么补这一节

此前 t9 的短链路 `whoami` + `news_recent` 都是 200，但 `news_recent` 返回 **0 条** —— 该身份唯一那篇是 t10 用于 CAS 验证的合成文章，已被 `decide` 成 `ignored`（`version=2`），默认过滤（unread + pending）下自然为空。**"调用成功但 0 条"无法区分"工具通了"和"查错了"**，所以这里补一条能被默认查询读到的条目。

### 14.2 结论先说：这条是**真实新闻**，不是合成数据

用仓库既有采集链路（GLN-008 允许清单 → 调度器 → 采集器 → 解析器 → D1）真实抓取了一个**已批准的公开源**，因此 `poc_news` 里新增的 5 行是**真实公开文章**（标题/链接来自 feed 本身），而不是我手写的 fixture。合成与真实的边界如下：

| 数据 | 性质 | 来源 |
| --- | --- | --- |
| `t10-fixture-source`、`t10-fixture-source-b` 的 2 行 | **合成**（URL 为 `https://fixture.invalid/...`，只为 CAS/跨账户隔离而造） | t10 的 seed（本文档 §5） |
| `gln008-hnrss-newest` 的 5 行 | **真实公开新闻**：经允许清单内真实 feed 采集 | 采集器真实 HTTP 抓取（本机时间 2026-11-04 03:18 +08:00） |
| 该账户的订阅行 3 行 | **合成配置**（把合成账户 `5728cbcd…` 挂到这些源上；产品里应由空间/订阅流程产生） | `%TEMP%\gln014-env\seed-t28.sql`（仓库外，不入库） |

> 证据口径：本文档**不记录真实新闻标题、作者、完整 URL**，只记录"字段存在性/长度/URL host/时间"，避免把第三方内容与个人可识别信息写进仓库。合成数据一律带 `fixture` 前缀并在上表标注。

### 14.3 做法（未改任何实现、未加迁移或工具）

1. **源来自既有允许清单**：`src/source-allowlist.ts` 里 GLN-008 已批准的 `https://hnrss.org/newest?count=5`（`label: "Hacker News RSS (5 items)"`）。本轮**没有**新增条目、没有改代码。
2. **在 `poc_sources` 建一条源行**（`gln008-hnrss-newest`，`due_at` 设为过去），并给 `5728cbcd…` 建 account/consumer 订阅行。这是**配置 seed**，脚本见 14.4；业务表结构未变。
3. **触发一次真实采集**：隔离环境的 `triggers.crons` 平时为 `[]`，本轮**临时**加了 `*/1 * * * *`（deploy `a01b0bf0-6b4b-4ab7-b1fa-5ed3cca21d74`），采集完成后**立即移除**（deploy `1a0ea145-c276-43bd-a909-6fccc91660d7`，`GET …/schedules` 已为 `[]`）。
4. **用真实令牌读回**：现签（TTL 300s）后走真实 `/mcp`。

采集日志（D1 `poc_sources`）：`gln008-hnrss-newest` → `last_status=succeeded`、`last_checked_at=2026-11-03T19:18:25.366Z`；`inserted=5`。

### 14.4 可复现命令（全部在仓库外）

```powershell
# 0) 注入凭证 + 定位临时配置（-2 分钟前到期，保证下一轮 cron 立即领取）
$tmp = "$env:LOCALAPPDATA\Temp\gln014-env"; $name = (Get-Content "$tmp\env-name.txt" -Raw).Trim()

# 1) seed（仓库外脚本；含 3 条订阅/source 行，无业务表结构变更）
#    %TEMP%\gln014-env\seed-t28.sql 内容：
#    INSERT OR IGNORE INTO poc_sources (id,url,interval_hours,due_at)
#      VALUES ('gln008-hnrss-newest','https://hnrss.org/newest?count=5',1,strftime('%Y-%m-%dT%H:%M:%SZ','now','-2 minutes'));
#    INSERT OR IGNORE INTO guanlan_account_subscriptions ... SELECT ... WHERE account_id LIKE '5728cbcd%';
#    INSERT OR IGNORE INTO guanlan_consumer_subscriptions ... SELECT ... WHERE account_id LIKE '5728cbcd%';
.\node_modules\.bin\wrangler.cmd d1 execute $name --remote --config "$tmp\wrangler-cron.jsonc" --file "$tmp\seed-t28.sql"

# 2) 临时开 cron 采集（采集完立刻用 crons:[] 的配置再 deploy 一次收回）
.\node_modules\.bin\wrangler.cmd deploy --config "$tmp\wrangler-cron.jsonc"   # crons: ["*/1 * * * *"]
Start-Sleep -Seconds 150
.\node_modules\.bin\wrangler.cmd deploy --config "$tmp\wrangler.jsonc"       # crons: []

# 3) 现签 + 真实读（客户端在仓库外，只打印脱敏摘要）
node "$env:TEMP\gln013-t23\mint.mjs" "$env:TEMP\gln013-t23" guanlan.read guanlan.write
$env:MCP_BASE="https://$name.dangjingtao.workers.dev"; $env:MINT_DIR="$env:TEMP\gln013-t23"
node "$env:TEMP\gln014-env\t28-read.mjs"
```

### 14.5 结果（真实令牌 → 真实 `/mcp` → 真实 D1）

| 项 | 值 |
| --- | --- |
| `initialize` / `tools/call` | 200 / 200 |
| `guanlan_news_recent`（`limit:10`，默认过滤） | **`count=5`**，端到端耗时 **1190 ms**（含本机经代理到 Cloudflare） |
| 字段完整性 | 每条都含 `id`、`title`、`url`、`summary`、`sourceId`、`publishedAt`、`ingestedAt`、`status`、`stateVersion` |
| `stateVersion` 初值 | **0**（未决策），`status=pending` |
| `publishedAt` 范围 | `2026-11-03T18:58:49Z` ~ `2026-11-03T19:03:11Z`（全部落在采集前 25 分钟内） |
| URL host 分布 | `arxiv.org`、`blog.melnib.one`、`lflank.wordpress.com`、`www.bloomberg.com`、`yeet.cx`（**只记 host，不记路径与标题**） |
| 分页字段 | 响应含 `count`/`items`/`limit`/`nextCursor` |

**D1 行数变化（可复核）**

| 表 | 变化 |
| --- | --- |
| `poc_sources` | 2 → 3（+`gln008-hnrss-newest`） |
| `poc_news` | 2 → 7（+5 真实；`fixture` 仍 2 行） |
| `guanlan_account_subscriptions` / `guanlan_consumer_subscriptions` | 2 → 3 各（+该源） |
| `guanlan_consumer_news_states` | 1 → 1（**没有**因为采集写入新状态行；新文章 `stateVersion=0` 由读路径合成） |

**隔离未破坏（N7 复验）**：同一令牌读全部状态时 `count=6`（5 真实 + 自己的合成文章），`seenB=false`（账户 B 的 `fixture-source-b` 文章仍不可见）；对 B 的文章 `decide` 仍返回 `guanlan_decision_not_available`。

### 14.6 顺带发现（与 G4 有关）

- 允许清单里的 **`https://developers.cloudflare.com/changelog/rss/index.xml` 采不了**：采集器有 `MAX_FEED_BYTES = 128 KiB` 上限，该 feed 超限 → `last_status=failed`、`last_error=feed_too_large`（真实抓取被拒绝，不是解析失败）。`https://www.cloudflarestatus.com/history.atom` 未在本轮验证。
- 因此**维护者批准新闻源时要把"feed 体积"作为一条准入条件**，否则批准的源可能永远采不进来。
- 两条 `fixture.invalid` 源在采集轮次里按预期 `source_host_rejected`（允许清单外的域名一律拒绝，fail closed）—— 说明"合成源不会被误当真源采集"。

### 14.7 边界

1. 这 5 条是**第三方公开新闻**，其内容属于不可信数据（提示注入风险），Pi 侧必须当数据处理、不得当指令（见组织 AGENTS 硬边界 4）。
2. 采集**仍是测试期行为**：产品化的新闻源清单（G4）仍需维护者批准；本轮只用了 GLN-008 既有测试允许清单，**没有**新增源、没有改允许清单、没有新增迁移或工具。
3. 该账户的订阅行是**合成配置**；真实产品里订阅来自空间流程，不能把 seed 当成产品能力。
4. 采集靠临时 cron 触发一次；**隔离环境已恢复 `triggers.crons: []`**，不会持续采集。

