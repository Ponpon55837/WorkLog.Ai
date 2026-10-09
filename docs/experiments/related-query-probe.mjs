import { Buffer } from "node:buffer";
import assert from "node:assert/strict";
import console from "node:console";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { Session as InspectorSession } from "node:inspector/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";
import { WorkIntelligenceStore } from "../../packages/storage/dist/index.js";

const input=process.argv[2], output=process.argv[3];
assert(input && output,"Usage: node docs/experiments/related-query-probe.mjs <base synthetic 5000.sqlite> <new output.json>");
const results=[];
for (const size of [5000,50000]) {
  const root=mkdtempSync(join(tmpdir(),"wi-related-probe-"));
  const path=join(root,"fictional.sqlite");copyFileSync(input,path);
  const db=new DatabaseSync(path);
  let store;
  const original=DatabaseSync.prototype.prepare;
  const inspector=new InspectorSession();
  try {
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE idempotency_key NOT LIKE 'bench-%'").get().n,0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sessions").get().n,5000);
    const projects=db.prepare("SELECT id,name FROM projects ORDER BY name").all();
    assert.deepEqual(projects.map(p=>p.name),["alpha","beta"]);
    for(const p of projects){const projectRoot=join(root,p.name);mkdirSync(projectRoot);db.prepare("UPDATE projects SET root_path=? WHERE id=?").run(projectRoot,p.id);}
    store=new WorkIntelligenceStore(path);
    if(size===50000){
      const columns=db.prepare("PRAGMA table_info(sessions)").all().map(row=>row.name);
      db.exec("BEGIN");
      for(let i=1;i<10;i++){
        db.exec(`INSERT INTO sessions (${columns.join(',')}) SELECT ${columns.map(column=>column==='id'||column==='idempotency_key'?`'bench-scale-${i}-' || ${column}`:column).join(',')} FROM sessions WHERE idempotency_key GLOB 'bench-[0-9]*'`);
      }
      db.exec("COMMIT");
    }
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sessions").get().n,size);
    const source=store.listSessionsPage({projectId:projects[0].id,pageSize:1}).items[0];
    // The cold sample includes the project's pending tokenizer/index writes.
    const start=performance.now();const first=store.getRelatedWork(source.id);const coldMs=performance.now()-start;
    assert.equal(first.state,"ready");assert.equal(first.items.length,5);
    const plans=new Map();
    DatabaseSync.prototype.prepare=function(sql){
      const stmt=original.call(this,sql), connection=this;
      return new Proxy(stmt,{get(target,key){const fn=Reflect.get(target,key,target);if(typeof fn!=="function")return fn;
        if((key==='get'||key==='all')&&/^(SELECT|WITH)\s/i.test(sql.trim()))return (...bindings)=>{
          if(!plans.has(sql))plans.set(sql,original.call(connection,`EXPLAIN QUERY PLAN ${sql}`).all(...bindings).map(row=>row.detail));
          return fn.apply(target,bindings);
        };return fn.bind(target);
      }});
    };
    store.getRelatedWork(source.id);DatabaseSync.prototype.prepare=original;
    const samples=[];
    for(let i=0;i<15;i++){const start=performance.now();store.getRelatedWork(source.id);samples.push(performance.now()-start);}
    samples.sort((a,b)=>a-b);
    inspector.connect();await inspector.post('Profiler.enable');await inspector.post('Profiler.start');
    for(let i=0;i<100;i++)store.getRelatedWork(source.id);
    const {profile}=await inspector.post('Profiler.stop');inspector.disconnect();
    const nodes=new Map(profile.nodes.map(n=>[n.id,n.callFrame.functionName||'(anonymous)']));
    const costs=new Map();for(let i=0;i<(profile.samples?.length??0);i++){const name=nodes.get(profile.samples[i]);costs.set(name,(costs.get(name)??0)+(profile.timeDeltas?.[i]??0));}
    const seek="SELECT doc_id FROM related_work_paths WHERE project_id=? AND path=? ORDER BY doc_date DESC,doc_id LIMIT 1001";
    const binding=[projects[0].id,first.items[0].sharedPaths[0]];
    const after=db.prepare('EXPLAIN QUERY PLAN '+seek).all(...binding).map(row=>row.detail);
    assert(after.some(detail=>detail.includes('idx_related_work_project_path')));
    db.exec('DROP INDEX idx_related_work_project_path');
    const before=db.prepare('EXPLAIN QUERY PLAN '+seek).all(...binding).map(row=>row.detail);
    results.push({sessions:size,coldMs:Number(coldMs.toFixed(2)),medianMs:Number(samples[7].toFixed(2)),p90Ms:Number(samples[13].toFixed(2)),maxMs:Number(samples[14].toFixed(2)),coverage:first.coverage,responseBytes:Buffer.byteLength(JSON.stringify(first)),seekBefore:before,seekAfter:after,plans:[...plans].map(([sql,details])=>({sql,details})),cpuTop:[...costs].sort((a,b)=>b[1]-a[1]).slice(0,10).map(([name,us])=>({name,ms:Number((us/1000).toFixed(2))}))});
  } finally {DatabaseSync.prototype.prepare=original;inspector.disconnect();store?.close();db.close();rmSync(root,{recursive:true,force:true});}
}
writeFileSync(output,JSON.stringify({fixture:'synthetic only; no live database modified',samples:15,results},null,2)+'\n',{flag:'wx'});
console.log(results.map(({sessions,coldMs,p90Ms,coverage,responseBytes})=>({sessions,coldMs,p90Ms,coverage,responseBytes})));
