'use strict'
const test=require('node:test')
const assert=require('node:assert/strict')
const crypto=require('node:crypto')
const fs=require('node:fs')
const path=require('node:path')
const {saveDiaryPreviewPlan,commitDiaryPreviewPlan,digestOfSavedPlan}=
    require('../services/diary/diaryPlanStore')
const {runAcceptancePreview,runManualV2Live}=
    require('../services/diary/diaryAcceptance')
const {runDiaryV2Verification}=
    require('../services/diary/diaryVerification')
const {assertConfig,safeLog,dispatchAndPoll}=
    require('../scripts/diary-review')
const {assembleEvidence}=require('../services/diary/diarySearch')

const USER='11111111-1111-4111-8111-111111111111'
const OTHER='22222222-2222-4222-8222-222222222222'
const PLAN=crypto.randomUUID(),D='d'.repeat(64),H='a'.repeat(64)
const url='https://unit.example/internal/diary/tick'
const shared={endpoint:url,userId:USER,secret:'secret'.repeat(6),startDate:'',endDate:'',topicHint:''}
const window={startDate:'2026-10-14',endDate:'2026-10-15',timeZone:'Asia/Shanghai',
    periodStart:'2026-10-13T16:00:00Z',periodEnd:'2026-10-15T16:00:00Z',topicHint:'生日'}
const evidence=assembleEvidence([
    {id:'m1',sessionId:'a',content:'生日和手写信',role:'user',
        channel:'text',createdAt:'2026-10-14T08:10:00Z'},
    {id:'m2',sessionId:'a',content:'我想把礼物的细节写进日记',role:'assistant',
        channel:'text',createdAt:'2026-10-14T08:15:00Z'},
],[])
const actions=[{kind:'create',anchor_id:'m1',topic_label:'礼物',
    title:'礼物日记',body:'一段经过真实聊天核实的记录，内容有超过二十五个字符，不能当作正式生日记。',
    evidence_ids:['m1'],topics:['生日']}]
function fakeStoreDb(){
    const plans=[];const calls=[];let committed=false
    const from=table=>({insert(row){
        if(table!=='diary_acceptance_plans')throw new Error('unexpected write')
        calls.push({table,row});plans.push({...row,id:PLAN});return this
    },select(){return this},async single(){return {data:{id:PLAN},error:null}}})
    const rpc=async(name,args)=>{
        calls.push({name,args})
        assert.equal(name,'diary_commit_acceptance_plan')
        if(args.p_user_id!==USER)return {error:{message:'owner mismatch'}}
        if(args.p_plan_digest!==D && args.p_plan_digest!==plans[0]?.plan_digest)
            return {error:{message:'digest mismatch'}}
        if(committed)return {data:{ok:true,status:'already_committed',
            readbackOk:true,created:0,revised:0,deferred:0,actions:1}}
        committed=true
        return {data:{ok:true,status:'committed',readbackOk:true,
            created:1,revised:0,deferred:0,actions:1}}
    }
    return {from,rpc,plans,calls}
}

test('five-mode dispatcher is opt-in; scheduled/daily and legacy backfill remain unchanged',()=>{
    const dates={...shared,startDate:'2026-10-14',endDate:'2026-10-15'}
    for(const m of ['preview','live'])assert.equal(assertConfig({...dates,acceptanceMode:m}),url)
    assert.equal(assertConfig({...shared,acceptanceMode:'off'}),url)
    assert.equal(assertConfig({...dates,acceptanceMode:'off'}),url)
    assert.equal(assertConfig({...shared,acceptanceMode:'verify',topicHint:'生日'}),url)
    assert.equal(assertConfig({...shared,acceptanceMode:'probe'}),url)
    assert.equal(assertConfig({...shared,acceptanceMode:'commit',planId:PLAN,
        planDigest:D,confirmWrite:'WRITE'}),url)
    assert.throws(()=>assertConfig({...shared,acceptanceMode:'live'}),/requires both/)
    assert.throws(()=>assertConfig({...shared,acceptanceMode:'verify'}),/keyword/)
    assert.throws(()=>assertConfig({...dates,acceptanceMode:'verify',topicHint:'生日'}),/keyword/)
    assert.throws(()=>assertConfig({...shared,acceptanceMode:'commit',
        planId:PLAN,planDigest:D}),/WRITE/)
    assert.throws(()=>assertConfig({...dates,acceptanceMode:'commit',planId:PLAN,
        planDigest:D,confirmWrite:'WRITE'}),/WRITE/)
    assert.throws(()=>assertConfig({...shared,acceptanceMode:'off',planId:PLAN}),/confirmation fields/)
})

test('complete preview persists immutable normalized plan, evidence and fingerprint separately',async()=>{
    const db=fakeStoreDb()
    const first=await saveDiaryPreviewPlan({supabase:db,userId:USER,agentId:'star',
        window,scopeHash:H,actions,evidence,sourceMessages:996,searchHits:2})
    assert.equal(first.planId,PLAN)
    assert.match(first.planDigest,/^[a-f0-9]{64}$/)
    assert.equal(db.plans.length,1)
    assert.deepEqual(db.plans[0].actions,actions)
    assert.equal(db.plans[0].evidence_count,2)
    assert.equal(db.plans[0].source_messages,996)
    assert.equal(db.calls.filter(c=>c.table==='diary_acceptance_plans').length,1)
    const altered=JSON.parse(JSON.stringify(actions));altered[0].body+=' 版本变化'
    assert.notEqual(first.planDigest,digestOfSavedPlan({userId:USER,agentId:'star',
        scopeHash:H,window,actions:altered,evidence}))
    await assert.rejects(saveDiaryPreviewPlan({supabase:db,userId:OTHER,agentId:'star',
        window,scopeHash:H,actions:[{...actions[0],evidence_ids:['made-up']}],evidence}),
        /invalid_diary_plan/)
    assert.equal(db.plans.length,1)
})

test('commit is atomic DB RPC, explicit digest/owner check, repeat confirm does not create duplicates',async()=>{
    const db=fakeStoreDb()
    const saved=await saveDiaryPreviewPlan({supabase:db,userId:USER,agentId:'star',
        window,scopeHash:H,actions,evidence})
    const first=await commitDiaryPreviewPlan({supabase:db,userId:USER,
        planId:PLAN,planDigest:saved.planDigest})
    assert.equal(first.status,'committed')
    assert.equal(first.liveWriteVerified,1)
    assert.equal(first.readbackVerified,1)
    const second=await commitDiaryPreviewPlan({supabase:db,userId:USER,
        planId:PLAN,planDigest:saved.planDigest})
    assert.equal(second.status,'already_committed')
    assert.equal(second.liveWriteVerified,0)
    await assert.rejects(commitDiaryPreviewPlan({supabase:db,userId:OTHER,
        planId:PLAN,planDigest:saved.planDigest}),/diary_database_failure/)
    await assert.rejects(commitDiaryPreviewPlan({supabase:db,userId:USER,
        planId:'not-a-uuid',planDigest:saved.planDigest}),/invalid_diary_input/)
    assert.equal(db.calls.filter(c=>c.name==='diary_commit_acceptance_plan').length,3)
})

test('live uses real preview planner then immediately confirms EXACT saved output; partial never commits',async()=>{
    const db=fakeStoreDb()
    const modelSource={rows:[],includedCount:0}
    const option={supabase:db,userId:USER,agentId:'star',startDate:'2026-10-14',
        endDate:'2026-10-15',topicHint:'生日',now:new Date('2026-10-17T12:00:00Z'),
        getSettings:async()=>({timezone:'Asia/Shanghai'}),callModel:async()=>{},
        reader:async()=>modelSource,
        writer:async()=>({partial:true,phase:'review',reviewDone:1,reviewTotal:2,
            cacheHits:0,modelCalls:1}),
        budgetFactory:()=>({})}
    // Stub acceptance cache lookups for the empty, partial plan.
    db.from=table=>({select(){return this},eq(){return this},in(){return this},order(){return this},
        limit(){return Promise.resolve({data:[],error:null})}})
    const partial=await runManualV2Live(option)
    assert.equal(partial.status,'partial')
    assert.equal(db.calls.length,0)
})

test('controlled verify checks search, context, revision snapshots, full diary recall and rollback-only probes',async()=>{
    const diaryId=crypto.randomUUID()
    const entry={id:diaryId,current_version:2,title:'生日回忆',body:'真实的生日日记正文',topics:['生日']}
    const db={rpc:async(name)=>({data:name==='diary_v2_two_create_probe'
        ? {ok:true,rolled_back:true,twoCreate:true}:null,error:null}),
      from:table=>{
        let ver=2
        const chain={eq(k,v){if(k==='version')ver=v;return chain},order(){return chain},limit(){return Promise.resolve({data:[entry],error:null})},
          select(){return chain},maybeSingle(){return Promise.resolve({data:{...entry,version:ver},error:null})}}
        return chain
      }}
    const args={supabase:db,userId:USER,keyword:'生日',
      probe:async()=>({status:'verified',rolledBack:1}),
      search:async()=>[{id:'m1',sessionId:'s1',createdAt:'2026-10-15T08:00:00Z'}],
      openContext:async()=>[{id:'m1'},{id:'m2'}],
      recall:async()=>({mode:'full',matched:1,fullChars:60})}
    const result=await runDiaryV2Verification(args)
    assert.equal(result.status,'verified')
    assert.deepEqual([result.dbVerified,result.searchVerified,result.contextVerified,
        result.versionVerified,result.recallVerified,result.twoCreateVerified],
        [1,1,1,1,1,1])
    assert.equal(result.modelVerified,0)
    assert.equal(result.liveWriteVerified,0)
    const missed=await runDiaryV2Verification({...args,search:async()=>[]})
    assert.equal(missed.errorCode,'verify_search_no_hits')
    const badContext=await runDiaryV2Verification({...args,openContext:async()=>[]})
    assert.equal(badContext.errorCode,'verify_context_missing')
    const badRecall=await runDiaryV2Verification({...args,
      recall:async()=>({mode:'unavailable',matched:0,fullChars:0})})
    assert.equal(badRecall.errorCode,'verify_recall_unavailable')
})

test('dispatcher posts distinct trigger types and never logs private plan body; invalid confirmation never sends',async()=>{
    const got=[]
    const runId=crypto.randomUUID()
    const mockFetch=async(_,opts)=>{
        if(opts.method==='POST') {
            got.push(JSON.parse(opts.body))
            return {status:202,json:async()=>({ok:true,runId})}
        }
        return {ok:true,json:async()=>({ok:true,status:'committed',
            mode:'acceptance_commit',processed:1,created:1,readbackVerified:1,
            dbVerified:1,modelVerified:0,liveWriteVerified:1})}
    }
    const sleep=async()=>{}
    let clock=0
    const nowMs=()=>clock+=50
    const options={...shared,fetchImpl:mockFetch,sleep,nowMs}
    await dispatchAndPoll({...options,acceptanceMode:'commit',planId:PLAN,planDigest:D,confirmWrite:'WRITE'})
    assert.equal(got[0].triggerType,'acceptance_commit')
    assert.equal(got[0].confirmWrite,true)
    await dispatchAndPoll({...options,acceptanceMode:'live',startDate:'2026-10-14',endDate:'2026-10-15'})
    assert.equal(got[1].triggerType,'manual_v2_live')
    await dispatchAndPoll({...options,acceptanceMode:'verify',topicHint:'生日'})
    assert.equal(got[2].triggerType,'acceptance_verify')
    await dispatchAndPoll({...options,acceptanceMode:'off'})
    assert.equal(got[3].triggerType,'daily')
    await dispatchAndPoll({...options,acceptanceMode:'off',startDate:'2026-10-14',endDate:'2026-10-15'})
    assert.equal(got[4].triggerType,'backfill')
    await assert.rejects(dispatchAndPoll({...options,acceptanceMode:'commit',
        planId:PLAN,planDigest:D}),/WRITE/)
    assert.equal(got.length,5)
    const line=safeLog({mode:'manual_v2_live',status:'committed',previewAppend:1,
        modelVerified:1,dbVerified:1,liveWriteVerified:1,planId:PLAN,planDigest:D,
        sourceCount:996,privateBody:'DO NOT LOG THIS SECRET DIARY'})
    assert.match(line,/actual_write=1/)
    assert.doesNotMatch(line,/DO NOT LOG THIS SECRET DIARY/)
})

test('SQL migration preserves original diaries and uses a single claim+finish transaction for saved plan',()=>{
    const sql=fs.readFileSync(path.join(__dirname,'../sql/hermit_diary_v2_manual_acceptance.sql'),'utf8')
    assert.match(sql,/CREATE TABLE IF NOT EXISTS public\.diary_acceptance_plans/)
    assert.match(sql,/ALTER TABLE public\.diary_acceptance_plans ENABLE ROW LEVEL SECURITY/)
    assert.match(sql,/REVOKE ALL ON public\.diary_acceptance_plans FROM PUBLIC,anon,authenticated/)
    assert.match(sql,/FOR UPDATE/)
    assert.match(sql,/diary_claim_review_job/)
    assert.match(sql,/diary_finish_autonomy_job/)
    assert.match(sql,/diary_revision_conflict|diary_readback_failed/)
    assert.match(sql,/RAISE EXCEPTION USING ERRCODE='PT002'/)
    assert.doesNotMatch(sql,/\b(?:DELETE|TRUNCATE)\s+(?:FROM\s+)?public\.(?:agent_diary|diary_revisions)/i)
    const yml=fs.readFileSync(path.join(__dirname,'../.github/workflows/hermit-diary-review.yml'),'utf8')
    assert.match(yml,/cron: '17 11 \* \* \*'/)
    for(const mode of ['preview','live','commit','verify','probe']) assert.ok(yml.includes('- '+mode))
    assert.match(yml,/DIARY_PLAN_DIGEST/)
})

test('owner-only plan HTTP API returns saved body privately, never reveals another owner plan',async()=>{
    const Module=require('node:module');const original=Module._load
    Module._load=function(name,...args){
        if(name==='express')return {Router:()=>({routes:new Map(),
            get(route,handler){this.routes.set(route,handler)}})}
        return original.call(this,name,...args)
    }
    const mockSupabase={from(table){
        assert.equal(table,'diary_acceptance_plans')
        const conditions=[]
        const chain={
            select(){return this},
            eq(k,v){conditions.push([k,v]);return this},
            order(){return this},
            limit(){return Promise.resolve({data:[{
                id:PLAN,actions:[{kind:'append',title:'私密日记',body:'仅允许主人查看的私人内容'}]
            }],error:null})},
            maybeSingle(){
                const allowed=conditions.some(([k,v])=>k==='user_id'&&v===USER)
                return Promise.resolve({data:allowed
                    ? {id:PLAN,actions:[{kind:'append',body:'仅允许主人查看的私人内容'}]}
                    : null,error:null})
            }
        }
        return chain
    }}
    let router
    try { router=require('../routes/diary').createUserDiaryRouter({supabase:mockSupabase}) }
    finally {Module._load=original}
    function response(){return {code:200,body:null,status(n){this.code=n;return this},
      set(){return this},json(value){this.body=value;return this}}}
    const show=router.routes.get('/acceptance/plans/:id')
    assert.equal(typeof show,'function')
    const own=response();await show({userId:USER,params:{id:PLAN}},own)
    assert.equal(own.code,200)
    assert.equal(own.body.plan.actions[0].body,'仅允许主人查看的私人内容')
    const other=response();await show({userId:OTHER,params:{id:PLAN}},other)
    assert.equal(other.code,404)
    const unknown=response();await show({userId:USER,params:{id:'bad'}},unknown)
    assert.equal(unknown.code,400)
    const noAuth=response();await show({params:{id:PLAN}},noAuth)
    assert.equal(noAuth.code,503)
    const listing=router.routes.get('/acceptance/plans')
    const listResponse=response();await listing({userId:USER},listResponse)
    assert.ok(!('actions' in listResponse.body.plans[0]))
    assert.deepEqual(listResponse.body.plans[0].actionKinds,['append'])
})

test('live complete: real-range V2 plans append and commits that SAME persisted plan without waiting for a random choice',async()=>{
    const db=fakeStoreDb()
    const existingBody='原有生日记绝对不能被悄悄覆盖：这是受版本保护的原文。'
    let writerCalls=0
    const src={rows:evidence.rows,includedCount:2}
    const oldFrom=db.from
    db.from=table=>table==='diary_acceptance_plans'?oldFrom(table):{
        select(){return this},eq(){return this},in(){return this},order(){return this},
        limit(){return Promise.resolve({data:[],error:null})},
    }
    const result=await runManualV2Live({supabase:db,userId:USER,agentId:'star',
        startDate:'2026-10-14',endDate:'2026-10-15',topicHint:'生日',
        now:new Date('2026-10-17T12:00:00Z'),getSettings:async()=>({timezone:'Asia/Shanghai'}),
        callModel:async()=>{throw Error('model_should_use_injected_writer')},
        reader:async()=>src,
        writer:async()=>{writerCalls++;return {actions:[{kind:'append',diary_id:PLAN,
          topic_id:crypto.randomUUID(),expected_version:1,title:'生日记续篇',
          body:existingBody+'\n\n后来他又想起一件小事。',topics:['生日'],evidence_ids:['m1']}],
          evidence,reviewDone:1,reviewTotal:1,rollupDone:0,rollupTotal:0,
          modelCalls:2,searchCount:1,cacheHits:0}},
    })
    assert.equal(writerCalls,1)
    assert.equal(result.status,'committed')
    assert.equal(result.mode,'manual_v2_live')
    assert.equal(result.modelVerified,1)
    assert.equal(result.liveWriteVerified,1)
    assert.equal(db.plans.length,1)
    assert.equal(db.plans[0].actions[0].kind,'append')
    assert.match(db.plans[0].actions[0].body,/后来他又想起一件小事/)
    assert.equal(db.calls.filter(c=>c.name==='diary_commit_acceptance_plan').length,1)
})
