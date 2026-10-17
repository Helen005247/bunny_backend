'use strict'

const {addDays,localDateAt,localDayStart,validTimeZone}=require('./diaryWindows')
const {readDiaryMessages}=require('./diaryReader')
const {planAutonomousDiary,newReviewBudget}=require('./diaryAutonomyWriter')

const CATCHUP_DAYS=14
const ROLLING_DAYS=7 // legacy: preserve old job windows for existing checkpoints
const MAX_DAILY_JOBS_PER_TICK=1
const SHARED_LOOKUP_BATCH=25
const SCOPE=/^autonomy:(\d{4}-\d{2}-\d{2})$/
const DONE=new Set(['written','skipped','revised','deferred'])

function dbRows(response) {
    if(response?.error || !Array.isArray(response?.data)) throw new Error('diary_database_failure')
    return response.data
}
function dbRpc(response) {
    if(response?.error) throw new Error('diary_database_failure')
    return response?.data
}
function rollingWindow(day,timeZone,now) {
    const startDate=addDays(day,-(ROLLING_DAYS-1))
    const periodStart=localDayStart(startDate,timeZone)
    const periodEnd=localDayStart(addDays(day,1),timeZone)
    if(Date.parse(periodEnd)>new Date(now).getTime()) throw new Error('diary_period_not_ended')
    return {startDate,endDate:day,timeZone,periodStart,periodEnd,days:ROLLING_DAYS,partial:false}
}
// New intake windows do NOT reread seven overlapping days. Diary entry dates
// remain unconstrained: topic search and revisions may still span any period.
function intakeWindow(day,timeZone,now) {
    const periodStart=localDayStart(day,timeZone)
    const periodEnd=localDayStart(addDays(day,1),timeZone)
    if(Date.parse(periodEnd)>new Date(now).getTime()) throw new Error('diary_period_not_ended')
    return {startDate:day,endDate:day,timeZone,periodStart,periodEnd,days:1,partial:false}
}
async function loadDiaryCandidates({supabase,userId,agentId}) {
    const entries=dbRows(await supabase.from('agent_diary')
        .select('id,diary_topic_id,current_version,title,body,topics,period_start,period_end,updated_at')
        .eq('user_id',userId).eq('agent_id',agentId)
        .order('updated_at',{ascending:false}).limit(12))
    const topics=dbRows(await supabase.from('diary_topics')
        .select('id,label,note,status,diary_id,updated_at')
        .eq('user_id',userId).eq('agent_id',agentId)
        .in('status',['pending','active'])
        .order('updated_at',{ascending:false}).limit(20))
    return {entries,topics}
}
async function runAutonomousWindow({supabase,userId,agentId='star',callModel,settings,
    window,reader=readDiaryMessages,writer=planAutonomousDiary,
    budgetFactory=newReviewBudget}={}) {
    if(!supabase?.rpc || !userId || agentId!=='star' ||
        typeof callModel!=='function' || !window?.endDate ||
        typeof budgetFactory!=='function') throw new Error('invalid_diary_input')
    const scopeKey=`autonomy:${window.endDate}`
    const claim=dbRpc(await supabase.rpc('diary_claim_review_job',{
        p_user_id:userId,p_agent_id:agentId,p_scope_key:scopeKey,
        p_trigger_type:'daily',p_period_start:window.periodStart,
        p_period_end:window.periodEnd,p_timezone:window.timeZone,p_topic_hint:'',
    }))
    if(!claim || claim.claimed!==true) {
        if(DONE.has(claim?.status))return {status:claim.status,processed:false}
        return {status:'failed',processed:false,errorCode:'diary_job_busy'}
    }
    const jobId=claim.jobId,token=claim.leaseToken
    const loadCached=async()=>dbRows(await supabase.from('diary_review_chunk_cache')
        .select('chunk_index,chunk_hash,observations')
        .eq('job_id',jobId).eq('user_id',userId).eq('agent_id',agentId)
        .order('chunk_index',{ascending:true}).limit(320))
    const loadRollups=async()=>dbRows(await supabase.from('diary_review_rollup_cache')
        .select('group_index,group_hash,observations')
        .eq('job_id',jobId).eq('user_id',userId).eq('agent_id',agentId)
        .order('group_index',{ascending:true}).limit(64))
    const loadSharedChunks=async(hashes)=>{
        const rows=[]
        for(let offset=0;offset<hashes.length;offset+=SHARED_LOOKUP_BATCH) {
            rows.push(...dbRows(await supabase.from('diary_review_material_cache')
                .select('chunk_hash,observations')
                .eq('user_id',userId).eq('agent_id',agentId)
                .in('chunk_hash',hashes.slice(offset,offset+SHARED_LOOKUP_BATCH))
                .limit(SHARED_LOOKUP_BATCH)))
        }
        return rows
    }
    const storeChunk=async({index,hash,observations})=>{
        const ok=dbRpc(await supabase.rpc('diary_store_review_chunk',{
            p_user_id:userId,p_agent_id:agentId,p_job_id:jobId,
            p_lease_token:token,p_chunk_index:index,p_chunk_hash:hash,
            p_observations:observations,
        }))
        if(ok!==true)throw new Error('diary_lease_lost')
    }
    const storeRollup=async({index,hash,observations})=>{
        const ok=dbRpc(await supabase.rpc('diary_store_review_rollup',{
            p_user_id:userId,p_agent_id:agentId,p_job_id:jobId,
            p_lease_token:token,p_group_index:index,p_group_hash:hash,
            p_observations:observations,
        }))
        if(ok!==true)throw new Error('diary_lease_lost')
    }
    const renew=async()=>{
        const ok=dbRpc(await supabase.rpc('diary_renew_review_job',{
            p_user_id:userId,p_agent_id:agentId,p_job_id:jobId,p_lease_token:token,
        }))
        if(ok!==true)throw new Error('diary_lease_lost')
    }
    try {
        const source=await reader({supabase,userId,agentId,
            periodStart:window.periodStart,periodEnd:window.periodEnd})
        const {entries,topics}=await loadDiaryCandidates({supabase,userId,agentId})
        const planned=await writer({supabase,userId,agentId,callModel,settings,
            source,entries,topics,window,onChunkDone:renew,
            cachedChunks:await loadCached(),cachedRollups:await loadRollups(),
            loadSharedChunks,storeReviewedChunk:storeChunk,storeReviewedRollup:storeRollup,
            budget:budgetFactory()})
        if(planned.partial===true) {
            const paused=dbRpc(await supabase.rpc('diary_pause_review_job',{
                p_user_id:userId,p_agent_id:agentId,p_job_id:jobId,p_lease_token:token,
                p_phase:planned.phase,p_review_done:planned.reviewDone,
                p_review_total:planned.reviewTotal,p_rollup_done:planned.rollupDone,
                p_rollup_total:planned.rollupTotal,
            }))
            if(paused!==true)throw new Error('diary_lease_lost')
            return {status:'partial',processed:false,
                reviewDone:planned.reviewDone,reviewTotal:planned.reviewTotal,
                rollupDone:planned.rollupDone,rollupTotal:planned.rollupTotal,
                cacheHits:planned.cacheHits,reused:planned.reused,
                modelCalls:planned.modelCalls,phase:planned.phase}
        }
        const finalized=dbRpc(await supabase.rpc('diary_finish_autonomy_job',{
            p_user_id:userId,p_agent_id:agentId,p_job_id:jobId,p_lease_token:token,
            p_actions:planned.actions,p_source_count:planned.evidence.includedCount,
            p_source_hash:planned.evidence.sourceHash,p_source_refs:planned.evidence.sourceRefs,
        }))
        if(!finalized?.ok || !DONE.has(finalized.status))throw new Error('diary_database_failure')
        return {status:finalized.status,processed:true,
            created:Number(finalized.created||0),revised:Number(finalized.revised||0),
            deferred:Number(finalized.deferred||0),reviewedCount:source.includedCount,
            reviewedChunks:planned.chunks,cacheHits:planned.cacheHits,
            reused:planned.reused||0,modelCalls:planned.modelCalls||0,
            reviewDone:planned.reviewDone??planned.chunks,reviewTotal:planned.reviewTotal??planned.chunks,
            rollupDone:planned.rollupDone||0,rollupTotal:planned.rollupTotal||0,
            searchCount:planned.searchCount}
    } catch(error) {
        const {safeErrorCode}=require('./diaryService')
        const code=safeErrorCode(error)
        try {
            await supabase.rpc('diary_fail_review_job',{
                p_user_id:userId,p_agent_id:agentId,p_job_id:jobId,
                p_lease_token:token,p_error_code:code,
            })
        } catch(_) { /* No private data in error logs or scheduler output. */ }
        return {status:'failed',processed:true,errorCode:code}
    }
}
async function findAutonomyJobState({supabase,userId,agentId,now}) {
    const rows=dbRows(await supabase.from('diary_review_jobs')
        .select('scope_key,status,period_start,period_end,timezone,retry_after,lease_expires_at')
        .eq('user_id',userId).eq('agent_id',agentId)
        .like('scope_key','autonomy:%').in('status',['pending','failed','processing'])
        .order('period_end',{ascending:true}).limit(50))
    const nowMs=new Date(now).getTime()
    const valid=rows.filter(r=>SCOPE.test(r.scope_key) && validTimeZone(r.timezone) &&
        Date.parse(r.period_start)<Date.parse(r.period_end) &&
        Date.parse(r.period_end)<=nowMs)
    const ready=valid.filter(r=>r.status==='pending' ||
        (r.status==='failed' && (!r.retry_after || Date.parse(r.retry_after)<=nowMs)) ||
        (r.status==='processing' && r.lease_expires_at && Date.parse(r.lease_expires_at)<nowMs))
        .map(r=>({startDate:'',endDate:r.scope_key.slice(9),timeZone:r.timezone,
            periodStart:r.period_start,periodEnd:r.period_end,partial:false}))
    return {ready,blocked:valid.length>ready.length}
}
async function findResumableJobs(args) {
    return (await findAutonomyJobState(args)).ready
}
function tickResult(results) {
    return {status:'completed',processed:results.length,
        written:results.reduce((n,r)=>n+(r.created||0),0),
        revised:results.reduce((n,r)=>n+(r.revised||0),0),
        deferred:results.reduce((n,r)=>n+(r.deferred||0),0),
        skipped:results.filter(r=>r.status==='skipped').length,
        reviewedCount:results.reduce((n,r)=>n+(r.reviewedCount||0),0),
        reviewedChunks:results.reduce((n,r)=>n+(r.reviewedChunks||0),0),
        cacheHits:results.reduce((n,r)=>n+(r.cacheHits||0),0),
        reused:results.reduce((n,r)=>n+(r.reused||0),0),
        modelCalls:results.reduce((n,r)=>n+(r.modelCalls||0),0)}
}
async function runAutonomousDailyTick({supabase,userId,agentId='star',callModel,
    settings,now=new Date(),reader,writer,budgetFactory}={}) {
    const today=localDateAt(now,settings.timezone)
    const common={supabase,userId,agentId,callModel,settings,
        ...(reader?{reader}:{}),...(writer?{writer}:{}),
        ...(budgetFactory?{budgetFactory}:{})}
    const queue=await findAutonomyJobState({supabase,userId,agentId,now})
    // Old jobs (including the 77-page failed 7-day job) take priority across
    // calendar boundaries. Never change their stored source window on retry.
    for(const window of queue.ready) {
        const result=await runAutonomousWindow({...common,window})
        if(result.status==='partial')return {...result,processed:0}
        if(result.status==='failed')return {status:'failed',processed:0,errorCode:result.errorCode}
        if(result.processed)return tickResult([result])
    }
    // A failed job still in retry cooldown, or another worker processing,
    // blocks opening a new scope. This prevents burning extra model requests.
    if(queue.blocked)return {status:'partial',processed:0,phase:'retry_wait',
        reviewDone:0,reviewTotal:0,rollupDone:0,rollupTotal:0,
        cacheHits:0,reused:0,modelCalls:0}
    // Newly created jobs intake one local day only. Cross-day topics remain
    // discoverable via diary_topics and historical message search.
    for(const daysAgo of [1,...Array.from({length:CATCHUP_DAYS-1},(_,i)=>CATCHUP_DAYS-i)]) {
        const day=addDays(today,-daysAgo)
        const window=intakeWindow(day,settings.timezone,now)
        const result=await runAutonomousWindow({...common,window})
        if(result.status==='partial')return {...result,processed:0}
        if(result.status==='failed')return {status:'failed',processed:0,errorCode:result.errorCode}
        if(result.processed)return tickResult([result])
    }
    return tickResult([])
}
module.exports={runAutonomousDailyTick,runAutonomousWindow,rollingWindow,intakeWindow,
    loadDiaryCandidates,findResumableJobs,CATCHUP_DAYS,MAX_DAILY_JOBS_PER_TICK}
