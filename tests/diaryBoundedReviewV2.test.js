'use strict'
const test=require('node:test')
const assert=require('node:assert/strict')
const crypto=require('node:crypto')
const fs=require('node:fs')
const path=require('node:path')
const {buildReviewChunks}=require('../services/diary/diaryWriter')
const {reviewHash,rollupHash,planAutonomousDiary,newReviewBudget}=
  require('../services/diary/diaryAutonomyWriter')
const {runAutonomousWindow,runAutonomousDailyTick,rollingWindow,intakeWindow}=
  require('../services/diary/diaryAutonomyService')
const {safeLog}=require('../scripts/diary-review')

const U='11111111-1111-4111-8111-111111111111'
const OTHER='22222222-2222-4222-8222-222222222222'
const ZONE='America/Denver'
const NOW='2026-10-18T20:00:00Z'
const SETTINGS={timezone:ZONE,system_prompt:'星星',character_context:'写私人日记'}
const SESSION='aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'
function makeSource(n=4,len=3200){
 const rows=Array.from({length:n},(_,i)=>({
   id:`msg-${i+1}`,sessionId:SESSION,channel:'text',role:'user',
   createdAt:new Date(Date.parse('2026-10-16T08:00:00Z')+i*60000).toISOString(),
   content:'那天聊过的回忆'+String(i)+'，'+ '字'.repeat(len),
 }))
 return {rows,includedCount:rows.length,sourceHash:'a'.repeat(64),sourceRefs:rows.map(r=>({
   id:r.id,session_id:r.sessionId,at:r.createdAt,channel:r.channel
 }))}
}
function makeDB(){
 const tables={diary_review_jobs:[],diary_review_chunk_cache:[],
   diary_review_rollup_cache:[],diary_review_material_cache:[],
   agent_diary:[],diary_topics:[],messages:[],call_sessions:[]}
 const calls=[]
 class Q{
  constructor(name){this.name=name;this.filters=[];this.orders=[];this.max=Infinity}
  select(fields){this.fields=fields;return this}
  eq(k,v){this.filters.push(r=>String(r[k])===String(v));return this}
  in(k,values){this.filters.push(r=>values.map(String).includes(String(r[k])));return this}
  like(k,v){this.filters.push(r=>String(r[k]||'').startsWith(v.replaceAll('%','')));return this}
  ilike(k,v){this.filters.push(r=>String(r[k]||'').toLowerCase().includes(v.replaceAll('%','').toLowerCase()));return this}
  contains(k,v){assert.equal(k,'topics');assert.equal(typeof v,'string');const tags=JSON.parse(v);this.filters.push(r=>tags.every(x=>Array.isArray(r[k])&&r[k].includes(x)));return this}
  order(k,{ascending=true}={}){this.orders.push({k,ascending});return this}
  limit(n){this.max=Math.min(this.max,n);return this}
  finish(){let rows=tables[this.name].filter(r=>this.filters.every(f=>f(r)))
   for(const {k,ascending} of this.orders.slice().reverse()) rows=rows.sort((a,b)=>
    String(a[k]||'').localeCompare(String(b[k]||''))*(ascending?1:-1))
   rows=rows.slice(0,this.max)
   if(this.fields && this.fields!=='*'){
    const fields=this.fields.split(',').map(s=>s.trim())
    rows=rows.map(r=>Object.fromEntries(fields.filter(f=>f in r).map(f=>[f,r[f]])))
   }
   return {data:rows,error:null}
  }
  then(resolve,reject){return Promise.resolve(this.finish()).then(resolve,reject)}
 }
 const db={tables,calls,from(name){if(!(name in tables))throw new Error('fake table missing '+name);return new Q(name)},
  async rpc(name,a){calls.push(name)
   const jobs=tables.diary_review_jobs
   if(name==='diary_claim_review_job'){
    let job=jobs.find(j=>j.user_id===a.p_user_id&&j.agent_id===a.p_agent_id&&j.scope_key===a.p_scope_key)
    if(!job){job={id:crypto.randomUUID(),user_id:a.p_user_id,agent_id:a.p_agent_id,
       scope_key:a.p_scope_key,period_start:a.p_period_start,period_end:a.p_period_end,
       timezone:a.p_timezone,status:'pending',retry_after:null};jobs.push(job)}
    if(!['pending','failed'].includes(job.status)&&!(job.status==='processing'&&
         job.lease_expires_at&&Date.parse(job.lease_expires_at)<Date.now())||
       job.period_start!==a.p_period_start||job.period_end!==a.p_period_end||
       (job.retry_after && Date.parse(job.retry_after)>Date.now())){
       return {data:{claimed:false,status:job.status},error:null}
    }
    job.status='processing';job.lease=crypto.randomUUID();job.retry_after=null
    return {data:{claimed:true,jobId:job.id,leaseToken:job.lease},error:null}
   }
   const job=jobs.find(j=>j.id===a.p_job_id&&j.user_id===a.p_user_id&&
     j.agent_id===a.p_agent_id&&j.status==='processing'&&j.lease===a.p_lease_token)
   if(name==='diary_renew_review_job')return {data:!!job,error:null}
   if(name==='diary_pause_review_job'){
    if(!job)return {data:false,error:null}
    job.status='pending';job.lease=null;job.review_done=a.p_review_done
    job.review_total=a.p_review_total;job.result_code='review_partial'
    return {data:true,error:null}
   }
   if(name==='diary_store_review_chunk'){
    if(!job)return {data:false,error:null}
    const row={job_id:job.id,user_id:a.p_user_id,agent_id:a.p_agent_id,
      chunk_index:a.p_chunk_index,chunk_hash:a.p_chunk_hash,observations:a.p_observations}
    const i=tables.diary_review_chunk_cache.findIndex(r=>r.job_id===job.id&&r.chunk_index===row.chunk_index)
    if(i<0)tables.diary_review_chunk_cache.push(row)
    else tables.diary_review_chunk_cache[i]=row
    if(!tables.diary_review_material_cache.some(r=>r.user_id===a.p_user_id&&r.agent_id===a.p_agent_id&&r.chunk_hash===row.chunk_hash))
      tables.diary_review_material_cache.push({user_id:a.p_user_id,agent_id:a.p_agent_id,
        chunk_hash:row.chunk_hash,observations:row.observations})
    return {data:true,error:null}
   }
   if(name==='diary_store_review_rollup'){
    if(!job)return {data:false,error:null}
    const row={job_id:job.id,user_id:a.p_user_id,agent_id:a.p_agent_id,
      group_index:a.p_group_index,group_hash:a.p_group_hash,observations:a.p_observations}
    const i=tables.diary_review_rollup_cache.findIndex(r=>r.job_id===job.id&&r.group_index===row.group_index)
    if(i<0)tables.diary_review_rollup_cache.push(row)
    else tables.diary_review_rollup_cache[i]=row
    return {data:true,error:null}
   }
   if(name==='diary_fail_review_job'){
    if(job){job.status='failed';job.lease=null;job.result_code=a.p_error_code}
    return {data:!!job,error:null}
   }
   if(name==='diary_finish_autonomy_job'){
    if(!job)return {data:null,error:{message:'lease lost'}}
    if(a.p_actions.length)throw new Error('fixture only allows no-action plans')
    job.status='skipped';job.lease=null
    tables.diary_review_chunk_cache=tables.diary_review_chunk_cache.filter(r=>r.job_id!==job.id)
    tables.diary_review_rollup_cache=tables.diary_review_rollup_cache.filter(r=>r.job_id!==job.id)
    return {data:{ok:true,status:'skipped',created:0,revised:0,deferred:0},error:null}
   }
   throw new Error('unsupported rpc '+name)
  }}
 return db
}
function model(){const calls=[];return {calls,async callModel({input}){
 calls.push(input)
 if(input.includes('日记回顾助手'))return {output_text:'{"observations":["生日那天的一句话"]}'}
 if(input.includes('日记回顾资料的归纳助手'))return {output_text:'{"observations":["很久前有一段真实聊天"]}'}
 if(input.includes('日记选题助手'))return {output_text:'{"queries":[]}'}
 if(input.includes('你是星星，准备写自己的私人日记'))return {output_text:'{"actions":[]}'}
 throw new Error('unexpected prompt')
 }}
}

test('old deployed SHA fingerprint remains stable, and a changed message invalidates it',()=>{
 const src=makeSource(1,80).rows[0]
 const chunks=buildReviewChunks([src],{maxChunkChars:5000,maxChunks:320})
 const original=crypto.createHash('sha256').update('diary-v2-review-v2\n').update(JSON.stringify(chunks[0])).digest('hex')
 assert.equal(reviewHash(chunks[0]),original)
 const changed=structuredClone(chunks[0]);changed[0].text+='编辑'
 assert.notEqual(reviewHash(changed),original)
 assert.match(rollupHash([{chunk:1,observations:['一件事']}]),/^[a-f0-9]{64}$/)
})
test('boundary budget: no negative or unbounded number of model calls',()=>{
 assert.throws(()=>newReviewBudget({maxModelCalls:0}))
 assert.throws(()=>newReviewBudget({maxElapsedMs:0}))
 let now=1000
 const b=newReviewBudget({maxModelCalls:2,maxElapsedMs:90000,clock:()=>now})
 assert.equal(b.canStart(2),true)
 b.consume();assert.equal(b.canStart(2),false)
 b.consume();assert.equal(b.canStart(),false)
 now=100001;assert.equal(b.canStart(),false)
})
test('a bounded review pauses without marking failure; retry resumes checkpoints and completes once',async()=>{
 const db=makeDB(),source=makeSource(5,3300),ai=model()
 const window=rollingWindow('2026-10-16',ZONE,NOW)
 const base={supabase:db,userId:U,agentId:'star',callModel:ai.callModel,
   settings:SETTINGS,window,reader:async()=>source}
 const first=await runAutonomousWindow({...base,
   budgetFactory:()=>newReviewBudget({maxModelCalls:2,maxElapsedMs:160000})})
 assert.equal(first.status,'partial')
 assert.equal(first.processed,false)
 assert.ok(first.reviewDone>0 && first.reviewDone<first.reviewTotal)
 assert.equal(db.tables.diary_review_jobs[0].status,'pending')
 assert.equal(db.tables.diary_review_jobs[0].result_code,'review_partial')
 assert.equal(db.tables.diary_review_chunk_cache.length,first.reviewDone)
 const second=await runAutonomousWindow({...base,
   budgetFactory:()=>newReviewBudget({maxModelCalls:25,maxElapsedMs:160000})})
 assert.equal(second.status,'skipped')
 assert.ok(second.cacheHits>=first.reviewDone)
 assert.equal(db.tables.diary_review_jobs[0].status,'skipped')
 assert.equal(db.tables.diary_review_chunk_cache.length,0)
 assert.equal(db.tables.diary_review_rollup_cache.length,0)
 const finalAgain=await runAutonomousWindow(base)
 assert.equal(finalAgain.processed,false)
 assert.equal(db.tables.diary_review_jobs.length,1)
 assert.equal(db.tables.agent_diary.length,0)
})
test('77 previously saved review chunks survive; continuation creates grouped rollups instead of giant summary',async()=>{
 const source=makeSource(85,3100)
 const chunks=buildReviewChunks(source.rows,{maxChunkChars:5000,maxChunks:320})
 assert.ok(chunks.length>=77)
 const cachedChunks=chunks.slice(0,77).map((chunk,i)=>({
   chunk_index:i+1,chunk_hash:reviewHash(chunk),observations:['真实事件 '+i]
 }))
 const db=makeDB(),ai=model()
 const shared=(hashes)=>db.tables.diary_review_material_cache.filter(r=>hashes.includes(r.chunk_hash))
 const stored=[],rollups=[]
 const first=await planAutonomousDiary({supabase:db,userId:U,settings:SETTINGS,
   source,window:rollingWindow('2026-10-16',ZONE,NOW),callModel:ai.callModel,
   cachedChunks,loadSharedChunks:shared,storeReviewedChunk:async item=>stored.push(item),
   storeReviewedRollup:async item=>rollups.push(item),
   budget:newReviewBudget({maxModelCalls:2,maxElapsedMs:160000})})
 assert.equal(first.partial,true)
 assert.equal(first.cacheHits,77)
 assert.equal(ai.calls.filter(s=>s.includes('日记回顾助手')).length,2)
 assert.equal(first.reviewDone,79)
 assert.equal(first.reviewTotal,chunks.length)
 assert.ok(stored.length===2)
 assert.equal(rollups.length,0)
})
test('all pages reviewed: rollups are checkpointed and re-used on the next run',async()=>{
 const source=makeSource(18,3200),chunks=buildReviewChunks(source.rows,{maxChunkChars:5000,maxChunks:320})
 assert.ok(chunks.length>8)
 const db=makeDB(),ai=model(),cached=chunks.map((chunk,i)=>({
  chunk_index:i+1,chunk_hash:reviewHash(chunk),observations:['片段事实 '+i]
 }))
 const rollups=[]
 const options={supabase:db,userId:U,settings:SETTINGS,source,
  window:rollingWindow('2026-10-16',ZONE,NOW),callModel:ai.callModel,
  cachedChunks:cached,storeReviewedRollup:async item=>rollups.push(item),
  loadSharedChunks:async()=>[]}
 const first=await planAutonomousDiary({...options,budget:newReviewBudget({maxModelCalls:1,maxElapsedMs:160000})})
 assert.equal(first.partial,true)
 assert.equal(first.phase,'rollup')
 assert.equal(first.rollupDone,1)
 assert.equal(rollups.length,1)
 const startCalls=ai.calls.length
 const resumed=await planAutonomousDiary({...options,
   cachedRollups:rollups.map(x=>({group_index:x.index,group_hash:x.hash,observations:x.observations})),
   budget:newReviewBudget({maxModelCalls:20,maxElapsedMs:160000})})
 assert.equal(resumed.partial,undefined)
 assert.ok(resumed.rollupDone>1)
 assert.equal(resumed.actions.length,0)
 assert.equal(ai.calls.filter((_,i)=>i>=startCalls).length>=2,true)
})
test('cross-date reusable materials are owner scoped and require exact hash',async()=>{
 const source=makeSource(1,200)
 const db=makeDB(),ai=model(),hash=reviewHash(buildReviewChunks(source.rows,{maxChunkChars:5000,maxChunks:320})[0])
 db.tables.diary_review_material_cache.push({user_id:OTHER,agent_id:'star',chunk_hash:hash,
   observations:['别人秘密']})
 const args={supabase:db,userId:U,agentId:'star',callModel:ai.callModel,
  settings:SETTINGS,source,window:rollingWindow('2026-10-16',ZONE,NOW),
  loadSharedChunks:async hashes=> (await db.from('diary_review_material_cache')
   .select('chunk_hash,observations').eq('user_id',U).eq('agent_id','star').in('chunk_hash',hashes)).data}
 const noReuse=await planAutonomousDiary(args)
 assert.equal(noReuse.cacheHits,0)
 assert.ok(ai.calls.some(x=>x.includes('日记回顾助手')))
 db.tables.diary_review_material_cache.push({user_id:U,agent_id:'star',chunk_hash:hash,
   observations:['属于当前用户的旧回顾']})
 ai.calls.length=0
 const yesReuse=await planAutonomousDiary(args)
 assert.equal(yesReuse.cacheHits,1)
 assert.equal(yesReuse.reused,1)
 assert.ok(!ai.calls.some(x=>x.includes('日记回顾助手')))
})
test('rollover prioritizes an unfinished seven-day job, not a new date scope',async()=>{
 const db=makeDB(),source=makeSource(1,200),ai=model()
 const original=rollingWindow('2026-10-16',ZONE,NOW)
 db.tables.diary_review_jobs.push({id:crypto.randomUUID(),user_id:U,agent_id:'star',
  scope_key:'autonomy:2026-10-16',status:'pending',timezone:ZONE,
  period_start:original.periodStart,period_end:original.periodEnd,retry_after:null})
 const observed=[]
 const tick=await runAutonomousDailyTick({supabase:db,userId:U,agentId:'star',
  settings:SETTINGS,callModel:ai.callModel,now:new Date(NOW),
  reader:async args=>{observed.push(args);return source}})
 assert.equal(tick.status,'completed')
 assert.equal(db.tables.diary_review_jobs.length,1)
 assert.equal(observed[0].periodStart,original.periodStart)
})
test('retry cooldown on oldest unfinished job prevents opening a fresh overlapping scope',async()=>{
 const db=makeDB(),ai=model()
 const old=rollingWindow('2026-10-16',ZONE,NOW)
 db.tables.diary_review_jobs.push({id:crypto.randomUUID(),user_id:U,agent_id:'star',
  scope_key:'autonomy:2026-10-16',status:'failed',timezone:ZONE,
  period_start:old.periodStart,period_end:old.periodEnd,
  retry_after:'2099-01-01T00:00:00Z'})
 const result=await runAutonomousDailyTick({supabase:db,userId:U,agentId:'star',
  settings:SETTINGS,callModel:ai.callModel,now:new Date(NOW)})
 assert.equal(result.status,'partial')
 assert.equal(result.phase,'retry_wait')
 assert.equal(ai.calls.length,0)
 assert.equal(db.tables.diary_review_jobs.length,1)
})
test('new automatic intake covers one ended local day, including DST; does not dictate diary period',()=>{
 const date='2026-11-01'
 const one=intakeWindow(date,ZONE,'2026-11-04T04:00:00Z')
 assert.equal(one.startDate,date)
 assert.equal(one.days,1)
 assert.equal(Date.parse(one.periodEnd)-Date.parse(one.periodStart),25*3600000)
 assert.equal(rollingWindow(date,ZONE,'2026-11-04T04:00:00Z').days,7)
})
test('progress line does not expose notes, UUIDs or model prompts and labels partial honestly',()=>{
 const raw=safeLog({status:'partial',code:'review_partial',reviewDone:77,reviewTotal:110,
  rollupDone:0,rollupTotal:0,cacheHits:77,modelCalls:3,
  privateDiaryBody:'only-owner',userId:U})
 assert.match(raw,/status=partial/)
 assert.match(raw,/review=77\/110/)
 assert.match(raw,/code=review_partial/)
 assert.doesNotMatch(raw,/only-owner|11111111|私密/)
})
test('SQL has idempotent storage and safe leases; cannot truncate diaries',()=>{
 const sql=fs.readFileSync(path.join(__dirname,'../sql/hermit_diary_v2_bounded_review_fix.sql'),'utf8')
 for(const k of ['diary_pause_review_job','review_partial','diary_review_material_cache',
   'diary_review_rollup_cache','lease_token=p_lease_token','lease_expires_at>now()',
   'ENABLE ROW LEVEL SECURITY','TO service_role','diary_review_chunk_cache',
   'ON CONFLICT (user_id,agent_id,chunk_hash) DO NOTHING']) assert.ok(sql.includes(k),k)
 assert.ok(!/\b(?:UPDATE|DELETE\s+FROM|TRUNCATE)\s+public\.agent_diary\b/i.test(sql))
 assert.ok(!/\bDROP\s+TABLE\s+.*diary_(?:revisions|review_jobs)/i.test(sql))
})

test('hard budget counts provider JSON-format recovery calls and pauses instead of returning fake success',async()=>{
 const db=makeDB(),source=makeSource(1,100)
 let remoteCalls=0
 const result=await runAutonomousWindow({supabase:db,userId:U,agentId:'star',
  settings:SETTINGS,window:rollingWindow('2026-10-16',ZONE,NOW),
  reader:async()=>source,budgetFactory:()=>newReviewBudget({maxModelCalls:2,maxElapsedMs:150000}),
  callModel:async({input})=>{
   remoteCalls++
   if(remoteCalls===1)return {output_text:'NOT JSON'}
   return {output_text:'{"observations":["刚刚看到一条旧消息"]}'}
  }})
 assert.equal(result.status,'partial')
 assert.equal(result.processed,false)
 assert.equal(remoteCalls,2)
 assert.equal(result.modelCalls,2)
 assert.equal(db.tables.diary_review_jobs[0].status,'pending')
 assert.equal(db.tables.diary_review_chunk_cache.length,1)
})

test('expired processing lease is re-claimable; live lease is blocked',async()=>{
 const {findResumableJobs}=require('../services/diary/diaryAutonomyService')
 const db=makeDB(),window=rollingWindow('2026-10-16',ZONE,NOW)
 const oldJob={id:crypto.randomUUID(),user_id:U,agent_id:'star',
  scope_key:'autonomy:2026-10-16',status:'processing',timezone:ZONE,
  period_start:window.periodStart,period_end:window.periodEnd,
  lease_expires_at:'2026-10-17T00:00:00Z',retry_after:null}
 db.tables.diary_review_jobs.push(oldJob)
 let eligible=await findResumableJobs({supabase:db,userId:U,agentId:'star',now:new Date(NOW)})
 assert.equal(eligible.length,1)
 oldJob.lease_expires_at='2026-10-19T00:00:00Z'
 eligible=await findResumableJobs({supabase:db,userId:U,agentId:'star',now:new Date(NOW)})
 assert.equal(eligible.length,0)
 const result=await runAutonomousDailyTick({supabase:db,userId:U,agentId:'star',
  settings:SETTINGS,callModel:model().callModel,now:new Date(NOW)})
 assert.equal(result.status,'partial')
 assert.equal(result.phase,'retry_wait')
})
