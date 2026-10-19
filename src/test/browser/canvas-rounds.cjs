// Run in isolation, without simultaneous builds/profiling. Each version gets four fresh browsers.
const fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process');
const dir=process.env.RESULT_DIR;
if(!dir||!process.env.BASE_URL||!process.env.BASELINE_URL) throw new Error('RESULT_DIR, BASE_URL and BASELINE_URL are required');
fs.mkdirSync(dir,{recursive:true});
const order=['before','after','before','after','before','after','before','after'], runs={before:[],after:[]};
for(const [i,version] of order.entries()) {
    const file=path.join(dir,`${i+1}-${version}.json`);
    const env={...process.env,BASE_URL:version==='before'?process.env.BASELINE_URL:process.env.BASE_URL,BASELINE_URL:'',RESULT_FILE:file};
    const out=execFileSync(process.execPath,[path.join(__dirname,'canvas-performance.cjs')],{env,encoding:'utf8',timeout:180000});
    fs.writeFileSync(file.replace('.json','.txt'),out);
    runs[version].push(JSON.parse(fs.readFileSync(file,'utf8')));
    console.log(`${i+1}/8 ${version} complete`);
}
const stats=values=>{const v=values.sort((a,b)=>a-b);return {median:(v[1]+v[2])/2,min:v[0],max:v[3]};};
const summary={order,interactions:{},direct:{}};
for(const r of runs.before[0].results) {
    const row=summary.interactions[r.name]={};
    for(const metric of ['busyMs','scriptMs','frameP95']) {
        row[metric]={};
        for(const v of ['before','after']) row[metric][v]=stats(runs[v].map(x=>x.results.find(y=>y.name===r.name)[metric]));
    }
}
for(const metric of Object.keys(runs.before[0].direct)) {
    summary.direct[metric]={};
    for(const v of ['before','after']) summary.direct[metric][v]=stats(runs[v].map(x=>x.direct[metric]));
}
fs.writeFileSync(path.join(dir,'summary.json'),JSON.stringify(summary,null,2));
console.log(JSON.stringify(summary,null,2));
