import {createHash,randomUUID} from 'node:crypto';

export class ToolFailure extends Error {
    constructor(code,message,retryable=false){super(message);this.code=code;this.retryable=retryable;}
}
export function configuration(env=process.env){
    const url=new URL(env.CUTTING_API_URL||'http://127.0.0.1:8080');
    if(!['http:','https:'].includes(url.protocol)||!['127.0.0.1','[::1]'].includes(url.hostname)||url.username||url.password||url.search||url.hash||url.pathname!=='/')
        throw new Error('CUTTING_API_URL must be a literal loopback origin. Remote multi-user access requires the later authenticated adapter.');
    for(const flag of ['CUTTING_MCP_COMPUTE','CUTTING_MCP_BUSINESS_READ'])if(env[flag]&&!['true','false'].includes(env[flag]))throw Error(flag+' must be true or false');
    return {origin:url.origin,compute:env.CUTTING_MCP_COMPUTE==='true',businessRead:env.CUTTING_MCP_BUSINESS_READ==='true'};
}
export function apiClient(config,{fetchImpl=fetch,timeoutMs=20000,maxResponseBytes=4194304}={}){
    return async (path,body,key)=>{
        const encoded=body===undefined?undefined:JSON.stringify(body);
        if(encoded&&Buffer.byteLength(encoded)>262144)throw new ToolFailure('PAYLOAD_TOO_LARGE','Input exceeds the API limit of 262144 bytes.');
        try{
            const response=await fetchImpl(config.origin+path,{method:encoded===undefined?'GET':'POST',redirect:'error',signal:AbortSignal.timeout(timeoutMs),
                headers:{Accept:'application/json',...(encoded===undefined?{}:{'Content-Type':'application/json'}),...(key?{'Idempotency-Key':key}:{})},body:encoded});
            const reader=response.body.getReader();let size=0;const chunks=[];
            try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>maxResponseBytes)throw new ToolFailure('RESPONSE_TOO_LARGE','Response exceeds the adapter limit; use a narrower query.');chunks.push(value);}}
            finally{await reader.cancel();}
            let data;try{data=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new ToolFailure('INVALID_RESPONSE','The service did not return JSON.');}
            if(!response.ok)throw new ToolFailure(typeof data.code==='string'?data.code:'HTTP_'+response.status,
                typeof data.message==='string'?data.message.slice(0,1000):'Service rejected the request.',data.retryable===true);
            return data;
        }catch(error){if(error instanceof ToolFailure)throw error;throw new ToolFailure('SERVICE_UNAVAILABLE','Service connection failed. A submitted job may already exist: retry with the SAME idempotency key and identical request.',true);}
    };
}
export function audited(tool,handler,audit=event=>process.stderr.write(JSON.stringify(event)+'\n')){
    return async args=>{
        const started=Date.now(),traceId=randomUUID(),inputHash=createHash('sha256').update(JSON.stringify(args)).digest('hex');
        try{
            const data=await handler(args);
            audit({traceId,tool,inputHash,status:'SUCCEEDED',elapsedMs:Date.now()-started,resultId:data?.id||null});
            return {content:[{type:'text',text:JSON.stringify(data)}],structuredContent:{data}};
        }catch(error){
            const failure=error instanceof ToolFailure?error:new ToolFailure('ADAPTER_ERROR','Adapter failed; check the local trace log.');
            audit({traceId,tool,inputHash,status:'FAILED',code:failure.code,elapsedMs:Date.now()-started});
            return {isError:true,content:[{type:'text',text:JSON.stringify({code:failure.code,message:failure.message,retryable:failure.retryable,traceId})}]};
        }
    };
}
