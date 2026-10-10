export class ApiError extends Error {
    constructor(message, code, httpStatus = 0) {super(message);this.code=code;this.httpStatus=httpStatus;}
}
export async function requestJSON(url, body) {
    let response;
    try {response=await fetch(url,body===undefined?{cache:'no-store'}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});}
    catch {throw new ApiError('未收到服务器响应，请检查连接后重试。','NETWORK');}
    let result;
    try {result=await response.json();}
    catch {throw new ApiError('服务器未返回有效结果，请稍后重试。',response.status===401 || response.status===403?'AUTH':'INVALID_RESPONSE',response.status);}
    if(!response.ok)throw new ApiError(result.message || '请求未成功，请稍后重试。',
        response.status===401 || response.status===403?'AUTH':response.status===409?'CONFLICT':response.status===422?'UNSUPPORTED':response.status===400?'INVALID_INPUT':response.status===503?'UNAVAILABLE':'SERVICE',response.status);
    return result;
}
export function failurePresentation(error) {
    const code=error.code || error.status || 'SERVICE';
    const messages={
        NETWORK:['连接中断','需求和原预览保留。连接恢复后可重试。'],
        AUTH:['访问身份失效','请重新登录后重试，先保留当前页面中的内容。'],
        CONFLICT:['数据版本冲突','先重新打开任务或核对库存，再生成方案。'],
        INVALID_INPUT:['请求校验未通过','按下方原因核对需求、材料或工艺参数。'],
        UNSUPPORTED:['当前能力不支持','核对尺寸精度、形状和工艺；可从能力说明查看支持范围。'],
        UNAVAILABLE:['服务暂不可用','检查服务器引擎状态，恢复后重试。'],
        NO_SOLUTION_FOUND:['本次未找到方案','查看需求旁的未排入说明；未排入不表示已证明无解。'],
        STALE_INPUT:['结果已过期','等待期间输入或预览发生变化，未应用返回结果。请按当前内容重新排料。'],
        INVALID_RESPONSE:['服务器响应异常','未应用本次结果，请稍后重试。'],
        INVALID_RESULT:['结果校验未通过','本次结果不能用于裁切，请重试或检查服务器日志。'],
        FAILED:['求解执行失败','本次结果未应用，请重试或检查服务器引擎。'],
        SERVICE:['操作未完成','当前输入保留，请核对原因后重试。']
    };
    const [title,hint]=messages[code] || messages.SERVICE;
    return {code,title,hint,message:error.message || '未取得有效结果'};
}
