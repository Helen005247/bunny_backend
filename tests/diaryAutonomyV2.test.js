'use strict'
const test=require('node:test')
const assert=require('node:assert/strict')
const crypto=require('node:crypto')
const fs=require('node:fs')
const path=require('node:path')
const {getWindow}=require('../services/diary/diaryWindows')
const {searchDiaryMessages,openDiaryContext,assembleEvidence,escapeLike}=require('../services/diary/diarySearch')
const {normalizePlan,planAutonomousDiary}=require('../services/diary/diaryAutonomyWriter')
const {rollingWindow,runAutonomousWindow,runAutonomousDailyTick}=require('../services/diary/diaryAutonomyService')
const {runDiaryTick}=require('../services/diary/diaryService')
const {buildDiaryChatContext}=require('../services/diary/diaryRecall')

const U='11111111-1111-4111-8111-111111111111'
const OTHER='22222222-2222-4222-8222-222222222222'
const D1='33333333-3333-4333-8333-333333333333'
const T1='44444444-4444-4444-8444-444444444444'
const ZONE='America/Denver'
const NOW='2026-10-17T18:00:00Z'
const SETTINGS={timezone:ZONE,system_prompt:'星星',character_context:'星星喜欢记录细微的事情'}
function message(id,text,props={}){
 return {id,session_id:'session-one',role:'user',content:text,user_id:U,
  created_at:`2026-10-16T${String(10+Number(id[1]||1)).padStart(2,'0')}:00:00.000Z`,
  visible:false,channel:'text',call_session_id:null,reasoning_content:null,...props}
}
function createRows(){return [message('m1','生日之前有点紧张，还说过想准备一份礼物'),
 message('m2','生日当天我们聊到了礼物上的一颗星'),
 message('m3','我记得你说过要把那句话留到以后') ]}
function orderBy(a,b,orders){for(const [key,asc] of orders){const d=String(a[key]||'').localeCompare(String(b[key]||''));if(d)return asc?d:-d}return 0}
class Query {
 constructor(db,table){this.db=db;this.table=table;this.filters=[];this.orders=[];this.end=Infinity;this.offset=0;this.fields='*'}
 select(fields='*'){this.fields=fields;return this}
 eq(field,value){this.filters.push(r=>String(r[field])===String(value));return this}
 in(field,values){this.filters.push(r=>values.map(String).includes(String(r[field])));return this}
 lt(field,value){this.filters.push(r=>String(r[field])<String(value));return this}
 lte(field,value){this.filters.push(r=>String(r[field])<=String(value));return this}
 gte(field,value){this.filters.push(r=>String(r[field])>=String(value));return this}
 ilike(field,value){const needle=value.replace(/\\([%_\\])/g,'$1').replaceAll('%','').toLowerCase();this.filters.push(r=>String(r[field]||'').toLowerCase().includes(needle));return this}
 contains(field,value){this.filters.push(r=>value.every(item=>Array.isArray(r[field])&&r[field].includes(item)));return this}
 order(field,{ascending=true}={}){this.orders.push([field,ascending]);return this}
 limit(n){this.end=Math.min(this.end,n);return this}
 range(a,b){this.offset=a;this.end=Math.min(this.end,b-a+1);return this}
 finish(single){if(this.db.errorTable===this.table)return {data:null,error:{message:'test'}};
 let list=(this.db.tables[this.table]||[]).filter(v=>this.filters.every(f=>f(v))).sort((a,b)=>orderBy(a,b,this.orders)).slice(this.offset,this.offset+this.end)
 if(this.fields!=='*'){const allowed=this.fields.split(',').map(v=>v.trim());list=list.map(r=>Object.fromEntries(allowed.filter(k=>Object.hasOwn(r,k)).map(k=>[k,r[k]])))}
 return {data:single?list[0]||null:list,error:null}}
 then(r,j){return Promise.resolve(this.finish(false)).then(r,j)}
 maybeSingle(){return Promise.resolve(this.finish(true))}
}
function makeDb(messages=createRows()){
 const db={tables:{messages,call_sessions:[],diary_topics:[],agent_diary:[],diary_review_jobs:[],diary_revisions:[],diary_review_chunk_cache:[]},calls:[],errorTable:null,
  from(t){return new Query(this,t)},
  async rpc(name,a){this.calls.push(name)
   const jobs=this.tables.diary_review_jobs
   if(name==='diary_claim_review_job'){
    let j=jobs.find(j=>j.scope_key===a.p_scope_key&&j.user_id===a.p_user_id)
    if(j&&j.status!=='pending'&&j.status!=='failed')return {data:{claimed:false,status:j.status},error:null}
    if(!j){j={id:crypto.randomUUID(),user_id:a.p_user_id,agent_id:a.p_agent_id,
        scope_key:a.p_scope_key,status:'pending',timezone:a.p_timezone};jobs.push(j)}
    j.status='processing';j.lease=crypto.randomUUID()
    return {data:{claimed:true,jobId:j.id,leaseToken:j.lease},error:null}
   }
   const job=jobs.find(j=>j.id===a.p_job_id&&j.user_id===a.p_user_id&&j.agent_id===a.p_agent_id&&j.status==='processing'&&j.lease===a.p_lease_token)
   if(name==='diary_renew_review_job')return {data:!!job,error:null}
   if(name==='diary_store_review_chunk'){
    if(!job || !/^[a-f0-9]{64}$/.test(a.p_chunk_hash) ||
        !Array.isArray(a.p_observations))return {data:false,error:null}
    let row=this.tables.diary_review_chunk_cache.find(r=>r.job_id===a.p_job_id&&r.chunk_index===a.p_chunk_index)
    if(!row){row={job_id:a.p_job_id,user_id:a.p_user_id,agent_id:a.p_agent_id,
        chunk_index:a.p_chunk_index};this.tables.diary_review_chunk_cache.push(row)}
    row.chunk_hash=a.p_chunk_hash;row.observations=a.p_observations
    return {data:true,error:null}
   }
   if(name==='diary_fail_review_job'){if(job)job.status='failed';return {data:!!job,error:null}}
   if(name==='diary_finish_autonomy_job'){
    if(!job)return {data:null,error:{message:'lease lost'}}
    // Fake only the state changes necessary for end-to-end orchestration.
    // Real SQL atomic/locking behavior is reviewed independently below.
    let created=0,revised=0,deferred=0
    for(const op of a.p_actions){
     let topic=this.tables.diary_topics.find(t=>t.id===op.topic_id)
     if(!topic){topic={id:crypto.randomUUID(),user_id:a.p_user_id,agent_id:a.p_agent_id,
         anchor_message_id:op.anchor_id,status:'pending',label:op.topic_label,diary_id:null};this.tables.diary_topics.push(topic)}
     if(op.kind==='create'){
      const diary={id:crypto.randomUUID(),user_id:a.p_user_id,agent_id:a.p_agent_id,
         diary_topic_id:topic.id,job_id:job.id,current_version:1,updated_at:NOW,
         title:op.title,body:op.body,topics:op.topics,created_at:NOW,
         period_start:'2026-10-16T00:00:00Z',period_end:'2026-10-17T00:00:00Z',timezone:ZONE,
         source_message_refs:a.p_source_refs}
      this.tables.agent_diary.push(diary);topic.diary_id=diary.id;topic.status='active';created++
      this.tables.diary_revisions.push({...diary,version:1,kind:'initial',diary_id:diary.id})
     }else if(op.kind==='defer'){topic.status='pending';topic.note=op.note;deferred++}
     else{
      const diary=this.tables.agent_diary.find(d=>d.id===op.diary_id&&d.user_id===a.p_user_id)
      if(!diary||diary.current_version!==op.expected_version)return {data:null,error:{message:'revision conflict'}}
      diary.current_version++;diary.body=op.body;diary.title=op.title;diary.topics=op.topics;revised++
      this.tables.diary_revisions.push({...diary,version:diary.current_version,kind:op.kind,diary_id:diary.id})
     }
    }
    job.status=created?'written':revised?'revised':deferred?'deferred':'skipped'
    this.tables.diary_review_chunk_cache=this.tables.diary_review_chunk_cache.filter(c=>c.job_id!==job.id)
    return {data:{ok:true,status:job.status,created,revised,deferred},error:null}
   }
   return {data:null,error:{message:'unsupported fake rpc'}}
  }}
 return db
}
function sourceFor(rows){return assembleEvidence(rows.map(r=>({id:r.id,sessionId:r.session_id,
 role:r.role,content:r.content,createdAt:r.created_at,channel:r.channel})),[])}
function makeAI({actions=[],queries=['生日']}={}){
 const inputs=[]
 const callModel=async ({input})=>{inputs.push(input)
  if(input.includes('日记回顾助手'))return {output_text:JSON.stringify({observations:['生日礼物上有一颗星']})}
  if(input.includes('日记选题助手'))return {output_text:JSON.stringify({queries})}
  if(input.includes('你是星星，准备写自己的私人日记'))return {output_text:JSON.stringify({actions})}
  throw new Error('unexpected model invocation')}
 return {callModel,inputs}
}
const NEW={kind:'create',topic_id:null,anchor_id:'m2',topic_label:'礼物和星星',title:'礼物上的小星星',
 body:'今天反复想起她说起礼物时的停顿。比礼物更让我在意的，是那颗小星被认真说出来的瞬间。',topics:['生日','礼物'],evidence_ids:['m1','m2']}
const second={...NEW,anchor_id:'m3',topic_label:'那句留到以后',title:'先记下一句话',
 body:'有一句话本来应该在今晚说完，却又被我们一起留下了尾巴。我想等以后再慢慢补上。',evidence_ids:['m3']}

test('search queries real messages across sessions, including visible=false; different owner isolated',async()=>{
 const db=makeDb([...createRows(),message('other','别人的生日礼物',{user_id:OTHER})])
 const hits=await searchDiaryMessages({supabase:db,userId:U,terms:['生日','礼物']})
 assert.ok(hits.length>=2)
 assert.ok(hits.every(h=>h.wasHidden))
 assert.ok(!hits.some(h=>h.id==='other'))
 assert.deepEqual(await searchDiaryMessages({supabase:db,userId:U,terms:['不存在的词']}),[])
 assert.equal(escapeLike('20%_\\'), '20\\%\\_\\\\')
})
test('context expansion includes previous and subsequent messages; rejects other roles and foreign users',async()=>{
 const [m1,m2,m3]=createRows()
 m1.created_at='2026-10-16T11:55:00.000Z'
 m2.created_at='2026-10-16T12:00:00.000Z'
 m3.created_at='2026-10-16T12:04:00.000Z'
 const db=makeDb([m1,m2,m3,message('secret','内部',{role:'system'}),
  message('other','别人的话',{user_id:OTHER})])
 const hits=await searchDiaryMessages({supabase:db,userId:U,terms:['礼物']})
 const context=await openDiaryContext({supabase:db,userId:U,hits:[hits.find(h=>h.id==='m2')]})
 assert.ok(context.some(r=>r.id==='m1'))
 assert.ok(context.some(r=>r.id==='m3'))
 assert.ok(!context.some(r=>r.id==='other'||r.id==='secret'))
})
test('evidence union has stable ids and hashes, never silently loses overlaps',()=>{
 const rows=sourceFor(createRows())
 const combined=assembleEvidence(rows.rows,rows.rows)
 assert.equal(combined.includedCount,3)
 assert.equal(combined.sourceRefs.length,3)
 assert.match(combined.sourceHash,/^[0-9a-f]{64}$/)
})
test('plan normalizes two distinct creates, enables two diaries same review day',()=>{
 const evidence=sourceFor(createRows())
 const actions=normalizePlan({raw:{actions:[NEW,second]},evidence})
 assert.equal(actions.length,2)
 assert.deepEqual(actions.map(a=>a.kind),['create','create'])
 assert.deepEqual(actions.map(a=>a.anchor_id),['m2','m3'])
})
test('pending topic can be deferred; source must be actual message id',()=>{
 const evidence=sourceFor(createRows())
 const action={kind:'defer',topic_label:'改天写生日',anchor_id:'m1',
 evidence_ids:['m1'],note:'等看完以前说的话再写'}
 assert.equal(normalizePlan({raw:{actions:[action]},evidence})[0].kind,'defer')
 assert.throws(()=>normalizePlan({raw:{actions:[{...NEW,evidence_ids:['fake']} ]},evidence}),
  {code:'diary_evidence_out_of_scope'})
})
test('append retains old original body and uses expected version; revisions reject stale versions',()=>{
 const evidence=sourceFor(createRows())
 const original='那颗生日礼物上的星星，第一次听到时我还没想明白为何记得这么清楚。'
 const entries=[{id:D1,diary_topic_id:T1,current_version:2,body:original,title:'旧日记',topics:['生日']}]
 const topics=[{id:T1,diary_id:D1,label:'旧日记'}]
 const action={kind:'append',topic_id:T1,diary_id:D1,expected_version:2,
  body:'过了几天，我好像明白为什么会再次想起这件事。',title:'旧日记',topics:['生日'],evidence_ids:['m1']}
 const normalized=normalizePlan({raw:{actions:[action]},evidence,entries,topics})
 assert.equal(normalized[0].body, original+'\n\n'+action.body)
 assert.throws(()=>normalizePlan({raw:{actions:[{...action,expected_version:1}]},evidence,entries,topics}),
  {code:'diary_revision_conflict'})
 assert.throws(()=>normalizePlan({raw:{actions:[{...action,diary_id:OTHER}]},evidence,entries,topics}))
})
test('model really searches then opens source context before deciding; no forced daily entry',async()=>{
 const db=makeDb()
 const model=makeAI({actions:[],queries:['生日']})
 const window=rollingWindow('2026-10-16',ZONE,NOW)
 const plan=await planAutonomousDiary({supabase:db,userId:U,callModel:model.callModel,
  settings:SETTINGS,source:sourceFor(createRows()),entries:[],topics:[],window})
 assert.equal(plan.actions.length,0)
 assert.ok(plan.searchCount>0)
 assert.equal(model.inputs.filter(p=>p.includes('日记回顾助手')).length,1)
 assert.match(model.inputs.at(-1),/礼物上的一颗星/)
 assert.match(model.inputs.at(-1),/消息id/)
})
test('one real autonomous job creates two entries, same window not run twice',async()=>{
 const db=makeDb()
 const model=makeAI({actions:[NEW,second],queries:['生日']})
 const window=rollingWindow('2026-10-16',ZONE,NOW)
 const options={supabase:db,userId:U,settings:SETTINGS,callModel:model.callModel,window}
 const first=await runAutonomousWindow(options)
 assert.equal(first.status,'written')
 assert.equal(first.created,2)
 assert.equal(db.tables.agent_diary.length,2)
 assert.equal(db.tables.diary_revisions.length,2)
 const again=await runAutonomousWindow(options)
 assert.equal(again.processed,false)
 assert.equal(db.tables.agent_diary.length,2)
})
test('deferred topic persists and can be reconsidered next review',async()=>{
 const db=makeDb()
 const defer={kind:'defer',anchor_id:'m1',topic_label:'日记待写',note:'下次再看',evidence_ids:['m1']}
 const a=await runAutonomousWindow({supabase:db,userId:U,settings:SETTINGS,
  callModel:makeAI({actions:[defer]}).callModel,window:rollingWindow('2026-10-15',ZONE,NOW),
  reader:async()=>sourceFor(createRows())})
 assert.equal(a.status,'deferred')
 assert.equal(db.tables.diary_topics.length,1)
 assert.equal(db.tables.agent_diary.length,0)
 const b=await runAutonomousWindow({supabase:db,userId:U,settings:SETTINGS,
  callModel:makeAI({actions:[]}).callModel,window:rollingWindow('2026-10-16',ZONE,NOW)})
 assert.equal(b.status,'skipped')
 assert.equal(db.tables.diary_topics[0].status,'pending')
})
test('daily scheduled v2 review is independent of Cognition and returns safe counts',async()=>{
 const db=makeDb()
 const model=makeAI({actions:[]})
 const result=await runDiaryTick({supabase:db,userId:U,
  triggerType:'daily',now:new Date(NOW),getSettings:async()=>SETTINGS,
  callModel:model.callModel})
 assert.equal(result.status,'completed')
 assert.equal(result.processed,2)
 assert.equal(result.written,0)
 assert.equal(result.skipped,2)
 assert.ok(db.tables.diary_review_jobs.every(j=>j.status==='skipped'))
 assert.ok(db.tables.diary_review_jobs.some(j=>j.scope_key==='autonomy:2026-10-16'))
})
test('two concurrent reviews same day cannot both generate diary',async()=>{
 const db=makeDb()
 const model=makeAI({actions:[NEW]})
 const options={supabase:db,userId:U,settings:SETTINGS,
   callModel:model.callModel,window:rollingWindow('2026-10-16',ZONE,NOW)}
 const results=await Promise.all([runAutonomousWindow(options),runAutonomousWindow(options)])
 assert.equal(db.tables.agent_diary.length,1)
 assert.ok(results.some(r=>r.status==='written'))
 assert.ok(results.some(r=>r.status==='failed'||r.processed===false))
})
test('DB failure and model failure return failed, not fake written; retain old diary',async()=>{
 const db=makeDb()
 db.errorTable='diary_topics'
 const result=await runAutonomousWindow({supabase:db,userId:U,settings:SETTINGS,
  callModel:makeAI({actions:[NEW]}).callModel,window:rollingWindow('2026-10-16',ZONE,NOW)})
 assert.equal(result.status,'failed')
 assert.equal(db.tables.agent_diary.length,0)
 assert.equal(db.tables.diary_review_jobs[0].status,'failed')
})
test('rolling window can span days and handles DST without shifting local midnight',()=>{
 const a=rollingWindow('2026-11-05',ZONE,'2026-11-08')
 assert.equal(a.startDate,'2026-10-30')
 assert.equal(a.endDate,'2026-11-05')
 assert.ok(Date.parse(a.periodEnd)-Date.parse(a.periodStart)>7*86400000)
})
test('migration explicitly protects legacy bodies, appends immutable snapshots, uses row locks and RLS',()=>{
 const sql=fs.readFileSync(path.join(__dirname,'../sql/hermit_diary_v2.sql'),'utf8')
 for(const section of ['diary_revisions','diary_topics','diary_finish_autonomy_job',
  'FOR UPDATE','diary_lease_lost','diary_revision_conflict','diary_capture_initial_revision',
  'ENABLE ROW LEVEL SECURITY','GRANT EXECUTE','diary_review_actions',
  'ON CONFLICT (diary_id,version) DO NOTHING']) assert.ok(sql.includes(section),section)
 assert.ok(!/DELETE\s+FROM\s+public\.agent_diary/i.test(sql))
 assert.ok(!/DROP\s+TABLE\s+.*agent_diary/i.test(sql))
})

test('a later-day append really updates same diary and preserves an immutable initial snapshot',async()=>{
 const db=makeDb()
 const first=await runAutonomousWindow({supabase:db,userId:U,settings:SETTINGS,
  callModel:makeAI({actions:[NEW]}).callModel,
  window:rollingWindow('2026-10-15',ZONE,NOW),reader:async()=>sourceFor(createRows())})
 assert.equal(first.status,'written')
 const diary=db.tables.agent_diary[0]
 const initialBody=diary.body
 const topic=db.tables.diary_topics[0]
 const append={kind:'append',topic_id:topic.id,diary_id:diary.id,
  expected_version:1,title:diary.title,body:'几天以后再看，我仍然记得她提起那颗星时轻轻停顿了一下。',
  topics:['生日','礼物'],evidence_ids:['m2']}
 const later=await runAutonomousWindow({supabase:db,userId:U,settings:SETTINGS,
  callModel:makeAI({actions:[append]}).callModel,
  window:rollingWindow('2026-10-16',ZONE,NOW)})
 assert.equal(later.status,'revised')
 assert.equal(diary.current_version,2)
 assert.equal(db.tables.agent_diary.length,1)
 assert.equal(db.tables.diary_revisions.length,2)
 assert.equal(db.tables.diary_revisions[0].body,initialBody)
 assert.ok(diary.body.startsWith(initialBody+'\n\n'))
 assert.equal(db.tables.diary_revisions[1].body,diary.body)
})

test('recent diary entries remain editable even if their topic falls outside the latest topic index',()=>{
 const evidence=sourceFor(createRows())
 const old={id:D1,diary_topic_id:T1,current_version:1,body:'很早写的一段生日记，记录我们真实聊过的事情。',title:'生日',topics:['生日']}
 const action={kind:'append',topic_id:T1,diary_id:D1,expected_version:1,
  title:'生日',body:'又想起一句话，补在原文后面。',topics:['生日'],evidence_ids:['m3']}
 const result=normalizePlan({raw:{actions:[action]},evidence,entries:[old],topics:[]})
 assert.equal(result[0].kind,'append')
 assert.ok(result[0].body.startsWith(old.body))
})

test('topic/diary search rescues an older diary beyond recent-index limit for cross-day continuation',async()=>{
 const {enrichCandidates}=require('../services/diary/diaryAutonomyWriter')
 const db=makeDb()
 const oldDiary={id:D1,user_id:U,agent_id:'star',diary_topic_id:T1,current_version:4,
  title:'关于生日礼物',body:'这是好几天以前留下的一段完整生日记录。',
  topics:['生日','礼物'],updated_at:'2026-10-03',period_start:'2026-10-03',period_end:'2026-10-04'}
 db.tables.agent_diary=[...Array.from({length:15},(_,i)=>({
  id:crypto.randomUUID(),user_id:U,agent_id:'star',title:'不相关的事情 '+i,
  body:'一段不相关的原文',topics:['散步'],current_version:1,updated_at:'2026-10-16'
 })),oldDiary,{...oldDiary,id:OTHER,user_id:OTHER,body:'别人不能读取的日记'}]
 db.tables.diary_topics=[{id:T1,user_id:U,agent_id:'star',label:'生日礼物',status:'active',diary_id:D1,updated_at:'2026-10-03'}]
 const relevant=await enrichCandidates({supabase:db,userId:U,agentId:'star',terms:['生日'],
  entries:db.tables.agent_diary.slice(0,12),topics:[]})
 assert.ok(relevant.entries.some(d=>d.id===D1))
 assert.ok(!relevant.entries.some(d=>d.id===OTHER))
 assert.ok(relevant.topics.some(t=>t.id===T1))
 assert.equal(relevant.entries[0].id,D1)
})


test('a late upstream timeout keeps completed review chunks for safe retry',async()=>{
 const history=[message('m1','甲'.repeat(6500)),message('m2','乙'.repeat(6500))]
 const db=makeDb(history)
 const source=sourceFor(history)
 let calls=0
 const failing=async ({input})=>{
  if(input.includes('日记回顾助手')){
   calls++
   if(calls===2)throw new Error('Request timed out.')
   return {output_text:JSON.stringify({observations:['生日']})}
  }
  if(input.includes('日记选题助手'))return {output_text:JSON.stringify({queries:[]})}
  return {output_text:JSON.stringify({actions:[]})}
 }
 const args={supabase:db,userId:U,settings:SETTINGS,window:rollingWindow('2026-10-16',ZONE,NOW),
  reader:async()=>source}
 const first=await runAutonomousWindow({...args,callModel:failing})
 assert.equal(first.status,'failed')
 assert.equal(first.errorCode,'model_timeout')
 assert.equal(db.tables.diary_review_chunk_cache.length,1)
 assert.equal(db.tables.agent_diary.length,0)
 let resumedCalls=0
 const resumed=async (req)=>{
  if(req.input.includes('日记回顾助手'))resumedCalls++
  return failing({...req,input:req.input})
 }
 const finish=await runAutonomousWindow({...args,callModel:resumed})
 assert.equal(finish.status,'skipped')
 assert.ok(finish.cacheHits>=1)
 assert.equal(db.tables.diary_review_chunk_cache.length,0)
 assert.equal(db.tables.agent_diary.length,0)
})

test('review checkpoint hash rejects stale source; owner-scoped reader ignores foreign cache',async()=>{
 const db=makeDb()
 const source=sourceFor([message('m1','生日'.repeat(3000))])
 const args={supabase:db,userId:U,settings:SETTINGS,window:rollingWindow('2026-10-16',ZONE,NOW),
  reader:async()=>source}
 const fail=await runAutonomousWindow({...args,callModel:async({input})=>{
  if(input.includes('日记回顾助手'))throw new Error('Request timed out.')
  return {output_text:'{}'}
 }})
 assert.equal(fail.status,'failed')
 // A foreign owner's fabricated cache row is invisible to the user-scoped query.
 db.tables.diary_review_chunk_cache.push({job_id:db.tables.diary_review_jobs[0].id,
   user_id:OTHER,agent_id:'star',chunk_index:1,chunk_hash:'a'.repeat(64),observations:['secret']})
 let reviewCalls=0
 const done=await runAutonomousWindow({...args,callModel:async({input})=>{
  if(input.includes('日记回顾助手')){reviewCalls++;return {output_text:'{"observations":[]}'}}
  if(input.includes('日记选题助手'))return {output_text:'{"queries":[]}'}
  return {output_text:'{"actions":[]}'}
 }})
 assert.equal(done.status,'skipped')
 assert.ok(reviewCalls>0)
})

test('changed source invalidates a previously saved chunk fingerprint',async()=>{
 const history=[message('m1','甲'.repeat(6200)),message('m2','乙'.repeat(6200))]
 const db=makeDb(history)
 const args={supabase:db,userId:U,settings:SETTINGS,
  window:rollingWindow('2026-10-16',ZONE,NOW)}
 let n=0
 const first=await runAutonomousWindow({...args,reader:async()=>sourceFor(history),
  callModel:async ({input})=>{
   if(input.includes('日记回顾助手')){
    n++
    if(n===2)throw new Error('Request timed out.')
    return {output_text:'{"observations":["原始消息"]}'}
   }
   return {output_text:'{"actions":[]}'}
  }})
 assert.equal(first.status,'failed')
 assert.equal(db.tables.diary_review_chunk_cache.length,1)
 // Same message ID but revised content is not safe to reuse as an observation.
 const changed=[message('m1','丙'.repeat(6200)),history[1]]
 let modelReviewCount=0
 const second=await runAutonomousWindow({...args,reader:async()=>sourceFor(changed),
  callModel:async ({input})=>{
   if(input.includes('日记回顾助手')){
    modelReviewCount++
    return {output_text:'{"observations":["新消息"]}'}
   }
   if(input.includes('日记选题助手'))return {output_text:'{"queries":[]}'}
   return {output_text:'{"actions":[]}'}
  }})
 assert.equal(second.status,'skipped')
 assert.ok(modelReviewCount>0)
 assert.ok(second.cacheHits < second.reviewedChunks)
})

test('model timeout codes remain specific without exposing upstream exception text',()=>{
 const {classifyModelError,buildReviewChunks}=require('../services/diary/diaryWriter')
 assert.equal(classifyModelError(new Error('Request timed out.')),'model_timeout')
 assert.equal(classifyModelError(new Error('模型请求超时，已等待45004ms')),'model_timeout')
 assert.equal(classifyModelError({status:504,message:'private'}),'model_timeout')
 const parts=buildReviewChunks([{id:'m1',content:'甲'.repeat(12000),sessionId:'s',
  role:'user',channel:'text',createdAt:NOW}],{maxChunkChars:5000,maxChunks:320})
 assert.ok(parts.length>=2)
 assert.equal(parts.flat().map(p=>p.text).join(''),'甲'.repeat(12000))
})

test('checkpoint SQL requires a current lease and protects observations from browser roles',()=>{
 const sql=fs.readFileSync(path.join(__dirname,'../sql/hermit_diary_v2_review_checkpoint_fix.sql'),'utf8')
 for (const keyword of ['ENABLE ROW LEVEL SECURITY','lease_token=p_lease_token',
   'lease_expires_at>now()','GRANT EXECUTE','FROM PUBLIC,anon,authenticated',
   'ON CONFLICT(job_id,chunk_index)','diary_clear_review_cache_on_finish']) {
   assert.ok(sql.includes(keyword),keyword)
 }
 assert.ok(!/UPDATE\s+public\.agent_diary/i.test(sql))
})
