'use strict'

const { addDays,localDateAt,localDayStart }=require('./diaryWindows')
const { readDiaryMessages }=require('./diaryReader')
const { planAutonomousDiary }=require('./diaryAutonomyWriter')

const CATCHUP_DAYS=14
const ROLLING_DAYS=7
const MAX_DAILY_JOBS_PER_TICK=2

function dbRows(response) {
    if (response?.error || !Array.isArray(response?.data))
        throw new Error('diary_database_failure')
    return response.data
}
function dbRpc(response) {
    if (response?.error) throw new Error('diary_database_failure')
    return response?.data
}
function rollingWindow(day,timeZone,now) {
    const startDate=addDays(day,-(ROLLING_DAYS-1))
    const periodStart=localDayStart(startDate,timeZone)
    const periodEnd=localDayStart(addDays(day,1),timeZone)
    if (Date.parse(periodEnd)>new Date(now).getTime()) throw new Error('diary_period_not_ended')
    return {startDate,endDate:day,timeZone,periodStart,periodEnd,days:ROLLING_DAYS,partial:false}
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
    window,reader=readDiaryMessages,writer=planAutonomousDiary }={}) {
    if (!supabase?.rpc || !userId || agentId!=='star' ||
        typeof callModel!=='function' || !window?.endDate) throw new Error('invalid_diary_input')
    const scopeKey=`autonomy:${window.endDate}`
    const claim=dbRpc(await supabase.rpc('diary_claim_review_job',{
        p_user_id:userId,p_agent_id:agentId,p_scope_key:scopeKey,
        p_trigger_type:'daily',p_period_start:window.periodStart,
        p_period_end:window.periodEnd,p_timezone:window.timeZone,p_topic_hint:'',
    }))
    if (!claim || claim.claimed!==true) {
        if (['written','skipped','revised','deferred'].includes(claim?.status))
            return {status:claim.status,processed:false}
        return {status:'failed',processed:false,errorCode:'diary_job_busy'}
    }
    const jobId=claim.jobId, token=claim.leaseToken
    const renew=async()=>{
        const renewed=dbRpc(await supabase.rpc('diary_renew_review_job',{
            p_user_id:userId,p_agent_id:agentId,p_job_id:jobId,p_lease_token:token,
        }))
        if (renewed!==true) throw new Error('diary_lease_lost')
    }
    try {
        const source=await reader({supabase,userId,agentId,
            periodStart:window.periodStart,periodEnd:window.periodEnd})
        const {entries,topics}=await loadDiaryCandidates({supabase,userId,agentId})
        const planned=await writer({supabase,userId,agentId,callModel,settings,
            source,entries,topics,window,onChunkDone:renew})
        const finalized=dbRpc(await supabase.rpc('diary_finish_autonomy_job',{
            p_user_id:userId,p_agent_id:agentId,p_job_id:jobId,p_lease_token:token,
            p_actions:planned.actions,p_source_count:planned.evidence.includedCount,
            p_source_hash:planned.evidence.sourceHash,
            p_source_refs:planned.evidence.sourceRefs,
        }))
        if (!finalized?.ok || !['written','skipped','revised','deferred'].includes(finalized.status))
            throw new Error('diary_database_failure')
        return {status:finalized.status,processed:true,
            created:Number(finalized.created||0),revised:Number(finalized.revised||0),
            deferred:Number(finalized.deferred||0),
            reviewedCount:source.includedCount,reviewedChunks:planned.chunks,
            searchCount:planned.searchCount}
    } catch(error) {
        const {safeErrorCode}=require('./diaryService')
        const code=safeErrorCode(error)
        try {
            await supabase.rpc('diary_fail_review_job',{
                p_user_id:userId,p_agent_id:agentId,p_job_id:jobId,
                p_lease_token:token,p_error_code:code,
            })
        } catch(_){ /* No private data in error logs or scheduler output. */ }
        return {status:'failed',processed:true,errorCode:code}
    }
}
async function runAutonomousDailyTick({supabase,userId,agentId='star',callModel,
    settings,now=new Date(),reader,writer}={}) {
    const today=localDateAt(now,settings.timezone)
    const results=[]
    // Oldest-first catch-up guarantees missed days eventually get a review.
    // Keep a strict paid-call cap per scheduled tick.
    const scheduledDays=[1,...Array.from({length:CATCHUP_DAYS-1},(_,i)=>CATCHUP_DAYS-i)]
    for (const daysAgo of scheduledDays) {
        const day=addDays(today,-daysAgo)
        const window=rollingWindow(day,settings.timezone,now)
        const result=await runAutonomousWindow({supabase,userId,agentId,callModel,
            settings,window,...(reader?{reader}:{}),...(writer?{writer}:{})})
        if (result.status==='failed' || result.status==='unavailable')
            return {status:'failed',processed:results.length,
                errorCode:result.errorCode||'diary_database_failure'}
        if (result.processed) results.push(result)
        if (results.length>=MAX_DAILY_JOBS_PER_TICK) break
    }
    return {status:'completed',processed:results.length,
        written:results.reduce((n,r)=>n+r.created,0),
        revised:results.reduce((n,r)=>n+r.revised,0),
        deferred:results.reduce((n,r)=>n+r.deferred,0),
        skipped:results.filter(r=>r.status==='skipped').length,
        reviewedCount:results.reduce((n,r)=>n+(r.reviewedCount||0),0)}
}
module.exports={runAutonomousDailyTick,runAutonomousWindow,rollingWindow,
    loadDiaryCandidates,CATCHUP_DAYS,MAX_DAILY_JOBS_PER_TICK}
