import { GUANLAN_MARK_SVG, brandCss } from "../brand";
import type { ManagementSnapshot, ManagementSource } from "./service";

const manageCss = `
.manage-shell{width:min(1240px,calc(100% - 36px));margin:0 auto;padding:28px 0 72px}
.manage-top{display:flex;align-items:center;justify-content:space-between;gap:20px;padding:10px 0 30px}
.manage-brand{display:flex;align-items:center;gap:13px;text-decoration:none}.manage-brand svg{width:44px;height:44px}
.manage-brand strong{display:block;font:600 22px/1.05 "Songti SC",STSong,serif}.manage-brand span{display:block;margin-top:5px;font-size:11px;letter-spacing:.13em;opacity:.45}
.manage-actions{display:flex;align-items:center;gap:10px}.ghost-btn,.small-btn{border:1px solid rgba(23,27,37,.16);background:transparent;color:inherit;border-radius:999px;text-decoration:none;cursor:pointer}
.ghost-btn{padding:9px 13px;font-size:13px}.small-btn{padding:8px 12px;font-size:12px}
.manage-hero{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:24px;align-items:end;padding:30px 0 34px;border-top:1px solid rgba(23,27,37,.08);border-bottom:1px solid rgba(23,27,37,.08)}
.manage-hero h1{margin:9px 0 11px;font:600 clamp(42px,6vw,72px)/.96 "Songti SC",STSong,serif;letter-spacing:-.04em}.manage-hero p{margin:0;max-width:680px;line-height:1.75;opacity:.64}
.identity{display:grid;gap:8px;min-width:240px}.identity-row{display:flex;justify-content:space-between;gap:18px;font-size:12px}.identity-row span:first-child{opacity:.45}.identity-row code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px}
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:26px 0}.stat{padding:18px 19px;border:1px solid rgba(23,27,37,.08);border-radius:18px;background:rgba(255,249,242,.58)}.stat strong{display:block;font:600 30px/1 "Iowan Old Style",Georgia,serif}.stat span{display:block;margin-top:8px;font-size:12px;opacity:.48}
.manage-section{padding:32px 0;border-top:1px solid rgba(23,27,37,.08)}.section-head{display:flex;align-items:end;justify-content:space-between;gap:20px;margin-bottom:18px}.section-head h2{margin:0;font:600 28px/1.1 "Songti SC",STSong,serif}.section-head p{margin:0;max-width:620px;font-size:13px;line-height:1.6;opacity:.5;text-align:right}
.notice{margin:18px 0 2px;padding:12px 14px;border-radius:14px;background:rgba(47,94,133,.10);font-size:13px}.notice.warn{background:rgba(247,214,184,.42)}
.source-list{display:grid;gap:12px}.source-card{padding:20px;border:1px solid rgba(23,27,37,.09);border-radius:22px;background:rgba(255,249,242,.62)}
.source-head{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:20px}.source-title{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.source-title h3{margin:0;font-size:18px}.source-url{display:block;margin-top:7px;font-size:12px;opacity:.46;overflow-wrap:anywhere}
.badge{display:inline-flex;align-items:center;min-height:24px;padding:0 9px;border-radius:999px;background:rgba(23,27,37,.06);font-size:11px;white-space:nowrap}.badge.good{background:rgba(69,128,92,.12)}.badge.bad{background:rgba(168,72,64,.12)}.badge.warm{background:rgba(247,214,184,.58)}
.source-meta{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px;margin-top:18px}.meta{padding:10px 12px;border-radius:13px;background:rgba(23,27,37,.035)}.meta span{display:block;font-size:10px;letter-spacing:.08em;opacity:.42;text-transform:uppercase}.meta strong{display:block;margin-top:5px;font-size:12px;font-weight:500;overflow-wrap:anywhere}
.manage-levels{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:14px}.level{padding:15px;border:1px solid rgba(23,27,37,.08);border-radius:16px}.level-head{display:flex;justify-content:space-between;gap:12px;align-items:center}.level-head strong{font-size:13px}.level-head span{font-size:11px;opacity:.48}
.inline-form{display:flex;gap:8px;align-items:center;margin-top:12px;flex-wrap:wrap}.inline-form input[type=number]{width:72px;padding:8px 9px;border:1px solid rgba(23,27,37,.14);border-radius:10px;background:transparent;color:inherit}.inline-form button{padding:8px 11px;border:0;border-radius:10px;background:var(--ink);color:var(--paper);cursor:pointer;font-size:12px}.inline-form button.secondary{border:1px solid rgba(23,27,37,.14);background:transparent;color:inherit}.inline-form button:disabled{opacity:.35;cursor:not-allowed}
.interests{display:flex;gap:8px;flex-wrap:wrap}.interest{padding:9px 12px;border:1px solid rgba(23,27,37,.09);border-radius:999px;font-size:12px}.interest small{margin-left:7px;opacity:.42}
.locked-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}.locked{padding:18px;border-radius:18px;background:rgba(23,27,37,.035)}.locked strong{display:block;font-size:14px}.locked p{margin:8px 0 0;font-size:12px;line-height:1.6;opacity:.5}
.manage-foot{padding-top:30px;font-size:11px;line-height:1.7;opacity:.42}
@media(prefers-color-scheme:dark){.ghost-btn,.small-btn,.source-card,.level{border-color:rgba(255,249,242,.12)}.stat,.source-card{background:rgba(255,249,242,.045)}.meta,.locked{background:rgba(255,249,242,.05)}.inline-form input[type=number]{border-color:rgba(255,249,242,.16)}.inline-form button{background:var(--paper);color:var(--deep)}.inline-form button.secondary{background:transparent;color:inherit;border-color:rgba(255,249,242,.16)}}
@media(max-width:860px){.manage-hero{grid-template-columns:1fr}.identity{min-width:0}.stats{grid-template-columns:1fr 1fr}.source-meta{grid-template-columns:1fr 1fr}.manage-levels{grid-template-columns:1fr}.locked-grid{grid-template-columns:1fr}.section-head{align-items:start;flex-direction:column}.section-head p{text-align:left}.manage-top{align-items:flex-start}.manage-actions{flex-direction:column;align-items:flex-end}}
@media(max-width:520px){.manage-shell{width:min(100% - 24px,1240px)}.stats{grid-template-columns:1fr 1fr}.source-head{grid-template-columns:1fr}.source-meta{grid-template-columns:1fr}.manage-actions{display:none}}
`;

const escapeHtml=(value:string):string=>value
  .replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;")
  .replaceAll('"',"&quot;").replaceAll("'","&#39;");

const maskId=(value:string):string=>value.length<=14?value:`${value.slice(0,8)}…${value.slice(-4)}`;

const formatTime=(value:string|null):string=>{
  if(!value)return "—";
  const parsed=Date.parse(value);
  if(!Number.isFinite(parsed))return "—";
  return new Date(parsed).toISOString().replace("T"," ").replace(".000Z","Z");
};

const statusInfo=(source:ManagementSource):{label:string;klass:string}=>{
  if(!source.registered)return{label:"未登记",klass:"warm"};
  if(source.lastStatus==="success")return{label:"采集正常",klass:"good"};
  if(source.lastStatus==="failed")return{label:"采集失败",klass:"bad"};
  return{label:"待首次检查",klass:""};
};

function subscriptionForm(
  source:ManagementSource,
  level:"account"|"consumer",
  value:number|null,
):string{
  if(!source.sourceId){
    return '<div class="inline-form"><button type="button" disabled>来源尚未登记</button></div>';
  }
  const id=escapeHtml(source.sourceId);
  const label=level==="account"?"账户订阅":"当前消费者";
  const current=value??source.effectiveIntervalHours??1;
  const remove=value===null?"":`
    <form class="inline-form" method="post" action="/manage/subscriptions">
      <input type="hidden" name="level" value="${level}">
      <input type="hidden" name="op" value="remove">
      <input type="hidden" name="sourceId" value="${id}">
      <button class="secondary" type="submit">取消${label}</button>
    </form>`;
  return `
    <form class="inline-form" method="post" action="/manage/subscriptions">
      <input type="hidden" name="level" value="${level}">
      <input type="hidden" name="op" value="upsert">
      <input type="hidden" name="sourceId" value="${id}">
      <input aria-label="${label}刷新周期（小时）" type="number" name="intervalHours" min="1" max="24" step="1" value="${current}">
      <span class="badge">小时</span>
      <button type="submit">保存</button>
    </form>${remove}`;
}

function sourceCard(source:ManagementSource):string{
  const status=statusInfo(source);
  const effective=source.effectiveOrigin
    ? `<span class="badge good">有效：${escapeHtml(source.effectiveOrigin)} · ${source.effectiveIntervalHours}h</span>`
    : '<span class="badge">未订阅</span>';
  return `<article class="source-card">
    <div class="source-head"><div>
      <div class="source-title"><h3>${escapeHtml(source.label)}</h3><span class="badge ${status.klass}">${status.label}</span>${effective}</div>
      <a class="source-url" href="${escapeHtml(source.url)}" target="_blank" rel="noreferrer">${escapeHtml(source.url)}</a>
    </div><span class="badge">${source.registered?"已进入采集库":"平台已批准"}</span></div>
    <div class="source-meta">
      <div class="meta"><span>最近检查</span><strong>${formatTime(source.lastCheckedAt)}</strong></div>
      <div class="meta"><span>下次到期</span><strong>${formatTime(source.dueAt)}</strong></div>
      <div class="meta"><span>采集周期</span><strong>${source.schedulerIntervalHours===null?"—":source.schedulerIntervalHours+" h"}</strong></div>
      <div class="meta"><span>重试</span><strong>${source.retryCount??"—"}</strong></div>
      <div class="meta"><span>最近错误</span><strong>${escapeHtml(source.lastError??"—")}</strong></div>
    </div>
    <div class="manage-levels">
      <section class="level"><div class="level-head"><strong>账户共享订阅</strong><span>${source.accountIntervalHours===null?"未设置":source.accountIntervalHours+" 小时"}</span></div>
        ${subscriptionForm(source,"account",source.accountIntervalHours)}
      </section>
      <section class="level"><div class="level-head"><strong>当前消费者覆盖</strong><span>${source.consumerIntervalHours===null?"继承账户":source.consumerIntervalHours+" 小时"}</span></div>
        ${subscriptionForm(source,"consumer",source.consumerIntervalHours)}
      </section>
    </div>
  </article>`;
}

export function renderManagementPage(
  snapshot:ManagementSnapshot,
  options:{notice?:string|null}={},
):string{
  const registered=snapshot.sources.filter(source=>source.registered).length;
  const subscribed=snapshot.sources.filter(source=>source.effectiveOrigin!==null).length;
  const failed=snapshot.sources.filter(source=>source.lastStatus==="failed").length;
  const overrides=snapshot.sources.filter(source=>source.consumerIntervalHours!==null).length;
  const notice=options.notice==="updated"
    ? '<div class="notice">配置已保存，下面显示的是写入后的最新有效视图。</div>'
    : options.notice==="unchanged"
      ? '<div class="notice">配置没有发生变化；当前值已经是你提交的状态。</div>'
      : options.notice==="removed"
        ? '<div class="notice">这一层订阅已取消，继承关系已重新计算。</div>'
        : "";
  const interests=snapshot.interests.length
    ? snapshot.interests.map(item=>`<span class="interest">${escapeHtml(item.value)}<small>${escapeHtml(item.kind)} · ${escapeHtml(item.origin)}</small></span>`).join("")
    : '<span class="interest">暂无关注点</span>';

  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>管理 · 观澜 Guanlan</title><link rel="icon" href="/favicon.svg" type="image/svg+xml"><style>${brandCss()}\n${manageCss}</style></head><body>
<main class="manage-shell">
  <header class="manage-top"><a class="manage-brand" href="/"><span>${GUANLAN_MARK_SVG}</span><span><strong>观澜</strong><span>GUANLAN / MANAGEMENT</span></span></a>
    <div class="manage-actions"><a class="ghost-btn" href="/">返回首页</a><form method="post" action="/manage/logout"><button class="small-btn" type="submit">退出管理</button></form></div></header>
  <section class="manage-hero"><div><div class="eyebrow">GUANLAN CLOUD CONTROL</div><h1>配置与采集</h1><p>这里是观澜自己的云端配置真相。账户共享订阅与当前消费者覆盖会直接影响 Agent 的有效来源；采集调度仍由平台统一运行，不会被个人偏好偷偷改写。</p></div>
    <div class="identity"><div class="identity-row"><span>账户</span><code>${escapeHtml(maskId(snapshot.accountId))}</code></div><div class="identity-row"><span>当前消费者</span><code>${escapeHtml(maskId(snapshot.consumerId))}</code></div></div></section>
  ${notice}
  <section class="stats"><div class="stat"><strong>${registered}</strong><span>已登记批准来源</span></div><div class="stat"><strong>${subscribed}</strong><span>当前有效订阅</span></div><div class="stat"><strong>${overrides}</strong><span>消费者覆盖</span></div><div class="stat"><strong>${failed}</strong><span>采集异常</span></div></section>
  <section class="manage-section"><div class="section-head"><h2>来源与订阅</h2><p>只显示维护者批准的公共来源。订阅周期是账户/消费者偏好，不直接改写共享采集器的调度周期。</p></div>
    <div class="source-list">${snapshot.sources.map(sourceCard).join("")}</div></section>
  <section class="manage-section"><div class="section-head"><h2>关注点</h2><p>当前只读展示 GLN-006 的有效合并结果；本卡没有安全的 interest mutation contract，所以这里不假装能编辑。</p></div><div class="interests">${interests}</div></section>
  <section class="manage-section"><div class="section-head"><h2>尚未开放</h2><p>这些能力需要独立安全合同，不通过 UI 旁路 SQL 提前放行。</p></div>
    <div class="locked-grid"><div class="locked"><strong>自定义 RSS / Atom</strong><p>GLN-008 当前仍是精确白名单；任意 URL 的 DNS / SSRF 边界尚未完成。</p></div>
    <div class="locked"><strong>关注点编辑</strong><p>存储模型已存在，但还没有与订阅变更同等级的 mutation/授权合同。</p></div>
    <div class="locked"><strong>消费者管理</strong><p>当前 consumer 由 Mira ID 已验证 subject 稳定派生；创建、切换和撤销另行设计。</p></div></div></section>
  <footer class="manage-foot">观澜 Web 管理面与 MCP 共用同一 D1 业务真相；Web 会话不保存 Mira ID access token，也不把 MCP scope 当作管理权限。</footer>
</main></body></html>`;
}
