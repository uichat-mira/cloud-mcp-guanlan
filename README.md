# 观澜 Guanlan

**Mira Cloud 的持续新闻采集与消费记忆服务。**

观澜持续采集用户有权访问的新闻源，保存标题、摘要、原文链接与必要元数据，并向授权 Agent 提供统一、可追溯、可分页的候选视图。观澜负责**采集、过滤、去重和记账**；理解原文、判断价值与采取行动仍由 Agent 完成。

> **当前状态（2026-11-27）：** 业务底座已有 Workers/D1 采集、租约、来源安全、多用户数据模型、订阅读取、消费状态账本，以及标准 MCP 的 `guanlan_news_recent`、`guanlan_whoami`、`guanlan_news_decide`。GLN-015 已在隔离 Cloudflare Worker/D1 上完成 **Mira ID Open Platform V1 应用声明 + MCP 2026-07-28** 云端 smoke，并切换到正式公开实例身份 **`https://guanlan.tomz.io` / `APP_ID=guanlan.tomz.io` / `https://guanlan.tomz.io/mcp`**；旧 workers.dev APP_ID 只保留为历史验证事实。旧 HMAC 账号空间注册、固定 `mira:cloud-guanlan` audience、客户端 consumer claim 与 legacy MCP fallback 已退出目标架构。仍待真实 Mira ID 账号完成应用所有权登记与 V1 服务凭据纵切，尚未启用生产 Cron。

## 产品与架构真相

**[产品与服务设计 v1](docs/product-design.md)** 是产品边界的单一真相源。当前身份与协议切换以 **[GLN-015 工程合同](docs/engineering/gln-015-registration-receiver.md)** 与 [Issue #28](https://github.com/uichat-mira/cloud-mcp-guanlan/issues/28) 为准；Guanlan 自有管理面以 **[GLN-016 Web 管理合同](docs/engineering/gln-016-web-management.md)** 与 [Issue #34](https://github.com/uichat-mira/cloud-mcp-guanlan/issues/34) 为准。正式 Web 品牌资产见 **[观澜 Guanlan Web 品牌物料](docs/branding/guanlan/README.md)**；首页、Mira ID OAuth 结果页、`/manage` 与 `/brand` 共用同一套品牌语义。

当前链路：

`观澜部署实例 → Mira ID 应用登记 → 用户 OAuth PKCE 授权 → application service grant → APP_ID + serviceId + resource 短期凭据 → 标准 MCP → Guanlan tools`

观澜发布 `/.well-known/mira-application`，声明应用 **观澜 Guanlan** 与 `serviceId = news` 的 MCP 服务。Mira ID 管应用身份、实例所有权、账号授权和短期服务凭据；观澜只管理新闻业务数据与资源端授权。MCP wire protocol 保持官方标准，不为 Mira 魔改。

## 核心原则

- **独立应用，不自建账号。** 身份与应用授权由 Mira ID 负责；观澜不保存密码，也不使用 Cloud Auth 创建账号时的 HMAC 投递旁路。首页通过标准 OAuth 授权码 + PKCE S256 建立服务 grant，Mira ID 密码只提交给 Mira ID。
- **实例级服务身份。** 服务凭据精确绑定 `APP_ID + serviceId + resource`；同名服务不能因为 serviceId 相同而互相信任。应用所有权登记的 AppSecret 在观澜运行时只保存 SHA-256 摘要，明文不作为长期 Worker secret。
- **首期消费身份 = Cloud Account subject。** MCP 凭据中的已验证 `sub` 同时作为默认稳定 consumer，跨设备与模型会话共享处理账本。历史多-consumer 数据模型保留，但未来重新开放命名 consumer 必须另立产品与授权合同。
- **公共源 + 私有订阅。** 私人订阅和关注点不公开；相同可抓取 URL 可在后台复用采集，但不得泄漏订阅关系。
- **轻量索引。** 保存标题、摘要、原文 URL、时间与必要元数据；不默认抓正文，不在观澜内运行 LLM，也不做事件级语义聚类。
- **读取无副作用，决定显式写回。** 未读、待决、已采用、已忽略由明确写操作改变；换会话后仍可继续。
- **标准 MCP。** 只接受 `2026-07-28` 当前协议路径；旧 `2025-06-18` / `2025-11-25` initialize 不静默降级。
- **一个服务声明的真实权限。** 当前 Mira ID V1 对 `news` 签发 manifest 声明的完整 `guanlan.read + guanlan.write` scope；`guanlan_news_decide` 仍检查 write 作为纵深防御。
- **管理面归 Guanlan。** `/manage` 是云端新闻配置的官方 Web UI；Desktop/Mobile 后续提供入口和上下文衔接，不各自维护订阅/关注点的影子状态机。管理会话来自已确认的 Mira ID application session，MCP read/write scope 不自动成为配置权限。
- **建议不等于配置修改。** Agent 可以提出来源/关注点调整建议，但配置变更需要独立、明确的产品授权路径。

## 当前 MCP 工具

- `guanlan_whoami`：读取当前已验证账号、consumer 与 scope。
- `guanlan_news_recent`：读取该账号可见的新闻候选、状态与分页。
- `guanlan_news_decide`：把 pending / adopted / ignored 等消费结果写回该账号的持久账本。

真实 Tool Schema 与 ToolAnnotations 以 MCP `tools/list` 为准；Mira ID manifest 只引用 tool name 和外层治理提示，不复制 schema。

## 部署方向

Cloudflare Workers + D1 仍是当前首选运行形态，但**是否长期留在 Cloudflare 由上线后的真实运行数据决定**。GLN-003 已做过隔离 Canary 与 CPU 剖析；这不等于生产容量承诺，也不应阻塞观澜先完成产品化与 Mira ID 纵切。

仓库默认配置 `wrangler.jsonc` 目前仍是不可生产部署的占位配置；生产 D1、密钥、Cron 和环境晋级必须走独立部署纪律，不能从功能分支直接冒充生产。启用 Guanlan Web 管理面还需要独立高熵 `GUANLAN_WEB_SESSION_SECRET`；它只用于签名短时 HttpOnly 管理会话，不得提交到仓库、日志或前端。

## 工程状态

已进入 `dev` 的业务基础包括：

- [GLN-003](https://github.com/uichat-mira/cloud-mcp-guanlan/issues/6)：Cloudflare 隔离运行研究与 CPU 剖析。
- [GLN-005](https://github.com/uichat-mira/cloud-mcp-guanlan/issues/11)：多用户持久化模型。
- [GLN-006](https://github.com/uichat-mira/cloud-mcp-guanlan/issues/13)：有效订阅读取。
- [GLN-007](https://github.com/uichat-mira/cloud-mcp-guanlan/issues/14)：消费决策账本。
- [GLN-008](https://github.com/uichat-mira/cloud-mcp-guanlan/issues/15)：来源安全准入。
- [GLN-009](https://github.com/uichat-mira/cloud-mcp-guanlan/issues/16)：授权新闻分页与状态查询。
- [GLN-010](https://github.com/uichat-mira/cloud-mcp-guanlan/issues/22)：MCP 消费状态写回。
- [GLN-015](https://github.com/uichat-mira/cloud-mcp-guanlan/issues/28)：Mira ID V1 应用实例与标准 MCP 切换（当前进行中）。
- [GLN-016](https://github.com/uichat-mira/cloud-mcp-guanlan/issues/34)：Guanlan 自有 Web 管理界面 V1（来源、两级订阅与采集健康）。

工程约束见 [AGENTS.md](AGENTS.md)。有运行时代码变更时执行 `bash scripts/check.sh` / `npm run check`；Actions 的 Repository Contract 与 Mira Gate 是证据，不替代维护者对实际链路的验收。

## 与 Mira Desktop / Mobile 的关系

观澜不是把 Desktop NewsHub 原样搬到云端，也不是内置 Agent。Desktop / Mobile 通过 Mira ID 的账号关联服务目录发现观澜，再按标准 MCP 消费同一云端能力。端侧的工具选择、渐进式披露和本地治理属于客户端职责。

## License

[MIT](LICENSE)
