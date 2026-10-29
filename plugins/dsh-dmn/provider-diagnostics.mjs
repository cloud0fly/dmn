// Retain only fixed vocabulary: provider errors may contain credentials or prompts.
export function providerDiagnostic(reason){
 const message=typeof reason?.failure?.message==='string'?reason.failure.message:'';
 const status=message.match(/\b(400|401|403|404|413|429|500|502|503|504)\b/);
 const business=message.match(/"code"\s*:\s*"?(1000|1001|1003|1005|1113|1200|1210|1211|1212|1213|1214|1215|1220|1221|1222|1230|1234|1261|1301|1302|1305|1308|1309|1310|1311|1313|1314|1315|1316|1317|1318|1319|1320|1321)"?(?=[\s,}])/);
 return {finish:['error','aborted','max-tokens','tool-calls'].includes(reason?.kind)?reason.kind:'unknown',
  code:/^[A-Z_]{2,40}$/.test(reason?.failure?.code??'')?reason.failure.code:'UNKNOWN',
  ...(status?{httpStatus:Number(status[1])}:{}),
  ...(business?{businessCode:business[1]}:{}),
  mentions:['model','messages','temperature','max_tokens','max_completion_tokens','reasoning','thinking','tools','stream','api_key','authorization','quota','balance','subscription','coding','plan'].filter(word=>new RegExp('\\b'+word+'\\b','i').test(message))};
}
