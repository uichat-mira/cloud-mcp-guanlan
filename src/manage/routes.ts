import { renderGuanlanResultPage } from "../brand";
import { resolveApplicationInstance } from "../application/instance";
import {
  createD1SubscriptionMutator,
  managementGrantFromPrincipal,
  SubscriptionMutationError,
  type GuanlanManagementAuthority,
} from "../subscription-mutations";
import { ManagementReadError, readManagementSnapshot } from "./service";
import { renderManagementPage } from "./page";
import {
  clearManagementSessionCookie,
  MANAGEMENT_LOGOUT_PATH,
  MANAGEMENT_PATH,
  MANAGEMENT_SUBSCRIPTIONS_PATH,
  readManagementSession,
  type ManagementSessionEnv,
} from "./session";

export type ManagementEnv = ManagementSessionEnv & {
  DB: D1Database;
};

const allowedPaths = new Set([
  MANAGEMENT_PATH,
  MANAGEMENT_SUBSCRIPTIONS_PATH,
  MANAGEMENT_LOGOUT_PATH,
]);

function securityHeaders(contentType="text/html; charset=utf-8"):Headers{
  return new Headers({
    "cache-control":"no-store",
    pragma:"no-cache",
    "content-type":contentType,
    "content-security-policy":"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    "referrer-policy":"no-referrer",
    "x-content-type-options":"nosniff",
  });
}

function redirect(location:string,headers=securityHeaders("text/plain; charset=utf-8")):Response{
  headers.set("location",location);
  return new Response(null,{status:303,headers});
}

function errorPage(status:number,title:string,message:string,detail:string,actionHref:"/"|"/auth/start"|"/manage",actionLabel:string,headers=securityHeaders()):Response{
  return new Response(renderGuanlanResultPage({
    kind:"error",title,message,detail,actionHref,actionLabel,
  }),{status,headers});
}

function validateOrigin(request:Request,origin:string):boolean{
  return request.headers.get("origin")===origin;
}

function uniqueParam(params:URLSearchParams,key:string):string|null{
  const values=params.getAll(key);
  return values.length===1?values[0]!:null;
}

type ParsedMutation={
  level:GuanlanManagementAuthority;
  op:"upsert"|"remove";
  sourceId:string;
  intervalHours?:number;
};

function parseMutationBody(body:string):ParsedMutation|null{
  if(body.length>2048)return null;
  const params=new URLSearchParams(body);
  const allowed=new Set(["level","op","sourceId","intervalHours"]);
  let hasUnknown=false;
  params.forEach((_value,key)=>{if(!allowed.has(key))hasUnknown=true;});
  if(hasUnknown)return null;

  const level=uniqueParam(params,"level");
  const op=uniqueParam(params,"op");
  const sourceId=uniqueParam(params,"sourceId");
  if((level!=="account"&&level!=="consumer")||(op!=="upsert"&&op!=="remove")||!sourceId)return null;

  if(op==="remove"){
    if(params.has("intervalHours"))return null;
    return{level,op,sourceId};
  }
  const intervalRaw=uniqueParam(params,"intervalHours");
  if(!intervalRaw||!/^(?:[1-9]|1[0-9]|2[0-4])$/u.test(intervalRaw))return null;
  return{level,op,sourceId,intervalHours:Number(intervalRaw)};
}

function noticeFromUrl(url:URL):string|null{
  if(url.search==="")return null;
  let unexpected=false;
  url.searchParams.forEach((_value,key)=>{if(key!=="notice")unexpected=true;});
  if(unexpected)return null;
  const values=url.searchParams.getAll("notice");
  if(values.length!==1)return null;
  return ["updated","unchanged","removed"].includes(values[0]!)?values[0]!:null;
}

async function requireSession(request:Request,env:ManagementEnv){
  return readManagementSession(request,env);
}

export async function handleManagementRequest(
  request:Request,
  env:ManagementEnv,
):Promise<Response|null>{
  const url=new URL(request.url);
  if(!allowedPaths.has(url.pathname))return null;

  const instance=resolveApplicationInstance(env);
  if(!instance||url.origin!==instance.origin){
    return new Response(JSON.stringify({error:"not_found"}),{
      status:404,headers:securityHeaders("application/json; charset=utf-8"),
    });
  }

  const session=await requireSession(request,env);
  if(!session.ok){
    if(session.failure==="not_configured"){
      return errorPage(503,"管理界面未配置","观澜尚未配置 Web 管理会话密钥。","management_session_not_configured","/","返回观澜");
    }
    const headers=securityHeaders("text/plain; charset=utf-8");
    clearManagementSessionCookie(headers);
    if(request.method==="GET"&&url.pathname===MANAGEMENT_PATH){
      headers.set("location","/auth/start");
      return new Response(null,{status:302,headers});
    }
    return errorPage(401,"管理会话已失效","请重新通过 Mira ID 建立观澜管理会话。","management_session_required","/auth/start","重新连接",headers);
  }

  if(url.pathname===MANAGEMENT_PATH){
    if(request.method!=="GET"){
      return errorPage(405,"请求方式不支持","管理首页只接受 GET 请求。","method_not_allowed","/manage","返回管理");
    }
    const notice=noticeFromUrl(url);
    if(url.search!==""&&!notice){
      return errorPage(400,"参数无效","管理页包含无法识别的参数。","unexpected_parameter","/manage","返回管理");
    }
    try{
      const snapshot=await readManagementSnapshot(env.DB,session.principal);
      return new Response(renderManagementPage(snapshot,{notice}),{status:200,headers:securityHeaders()});
    }catch(error){
      if(error instanceof ManagementReadError&&error.code==="subject_unavailable"){
        return errorPage(409,"观澜空间尚未准备好","当前 Mira ID 主体还没有可用的观澜账户/消费者空间。",error.message,"/","返回观澜");
      }
      return errorPage(503,"暂时无法读取配置","观澜无法从 D1 得到可信的配置视图。","management_storage_unavailable","/manage","重试");
    }
  }

  if(url.pathname===MANAGEMENT_LOGOUT_PATH){
    if(request.method!=="POST"){
      return errorPage(405,"请求方式不支持","退出管理只接受 POST 请求。","method_not_allowed","/manage","返回管理");
    }
    if(!validateOrigin(request,instance.origin)){
      return errorPage(403,"请求被拒绝","退出请求不是从观澜同源页面发起。","origin_rejected","/manage","返回管理");
    }
    const headers=securityHeaders("text/plain; charset=utf-8");
    clearManagementSessionCookie(headers);
    return redirect("/",headers);
  }

  if(request.method!=="POST"){
    return errorPage(405,"请求方式不支持","订阅变更只接受 POST 请求。","method_not_allowed","/manage","返回管理");
  }
  if(!validateOrigin(request,instance.origin)){
    return errorPage(403,"请求被拒绝","订阅变更不是从观澜同源页面发起。","origin_rejected","/manage","返回管理");
  }
  const contentType=request.headers.get("content-type")?.split(";",1)[0]?.trim().toLowerCase();
  if(contentType!=="application/x-www-form-urlencoded"){
    return errorPage(415,"请求格式不支持","订阅变更必须来自观澜表单。","unsupported_media_type","/manage","返回管理");
  }

  const parsed=parseMutationBody(await request.text());
  if(!parsed){
    return errorPage(400,"配置没有保存","提交的订阅配置不符合观澜合同。","invalid_input","/manage","返回管理");
  }
  if(!session.authorities.includes(parsed.level)){
    return errorPage(403,"配置没有保存","当前管理会话没有这一层的配置权限。","management_authority_missing","/manage","返回管理");
  }

  const authorization=managementGrantFromPrincipal(session.principal,parsed.level);
  if(!authorization.ok){
    return errorPage(403,"配置没有保存","当前管理会话无法形成可信的配置授权。",authorization.failure,"/manage","返回管理");
  }

  try{
    const mutator=createD1SubscriptionMutator(env.DB);
    const result=await mutator.mutate(authorization.grant,parsed);
    if(!result.ok){
      const status=result.failure==="forbidden"?403:
        result.failure==="invalid_input"?400:
        result.failure==="account_not_found"||result.failure==="consumer_not_found"?409:404;
      return errorPage(status,"配置没有保存","观澜拒绝了这次订阅变更。",result.failure,"/manage","返回管理");
    }
    const notice=parsed.op==="remove"?"removed":result.changed?"updated":"unchanged";
    return redirect(`/manage?notice=${notice}`);
  }catch(error){
    if(error instanceof SubscriptionMutationError){
      return errorPage(503,"配置没有保存","D1 没有完成可信的订阅变更。",error.code,"/manage","重试");
    }
    return errorPage(503,"配置没有保存","观澜暂时无法完成订阅变更。","management_storage_unavailable","/manage","重试");
  }
}
