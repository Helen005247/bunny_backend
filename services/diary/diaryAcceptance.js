'use strict'

// Diary v2 acceptance: real source messages + real planning/search, but no
// writes to production diary/jobs/topics/revisions/actions. The ONLY writes
// in preview are resumable observations in dedicated acceptance cache tables.
// A separate Postgres RPC tests atomic writes inside a rollback-only subtransaction.
const crypto = require('node:crypto')
const { getWindow, validTimeZone } = require('./diaryWindows')
const { readDiaryMessages } = require('./diaryReader')
const { loadDiaryCandidates } = require('./diaryAutonomyService')
const { planAutonomousDiary, newReviewBudget } = require('./diaryAutonomyWriter')

const MAX_ACCEPTANCE_CHUNKS = 320
const MAX_ACCEPTANCE_ROLLUPS = 64
const HASH = /^[0-9a-f]{64}$/

function rows(result) {
    if (result?.error || !Array.isArray(result?.data)) throw new Error('diary_database_failure')
    return result.data
}
function requireOk(result) {
    if (result?.error) throw new Error('diary_database_failure')
    return result?.data
}
function acceptanceHash({userId,agentId,window,topicHint}) {
    const inputs=[userId,agentId,window.periodStart,window.periodEnd,
        window.timeZone,topicHint]
    return crypto.createHash('sha256').update(JSON.stringify(inputs)).digest('hex')
}
function countKinds(actions) {
    const results={previewCreate:0,previewAppend:0,previewRewrite:0,
        previewDefer:0,previewSkipped:0}
    for (const action of actions) {
        const key={create:'previewCreate',append:'previewAppend',
            rewrite:'previewRewrite',defer:'previewDefer'}[action.kind]
        if (!key) throw new Error('invalid_diary_plan')
        results[key]++
    }
    if (actions.length===0) results.previewSkipped=1
    return results
}
async function runAcceptancePreview({supabase,getSettings,callModel,userId,
    agentId='star',startDate,endDate,topicHint='',now=new Date(),
    reader=readDiaryMessages,writer=planAutonomousDiary,
    budgetFactory=()=>newReviewBudget()}={}) {
    if(!supabase?.from || typeof getSettings!=='function' ||
        typeof callModel!=='function' || !userId || agentId!=='star' ||
        typeof startDate!=='string' || typeof endDate!=='string' ||
        typeof topicHint!=='string' || topicHint.length>200) {
        throw new Error('invalid_diary_input')
    }
    const settings=await getSettings(userId)
    const timezone=validTimeZone(settings?.timezone)
    if(!timezone) throw new Error('settings_timezone_missing')
    // Require complete, past local calendar dates. Never silently truncate.
    const window=getWindow({startDate,endDate,timeZone:timezone,now,
        allowPartialToday:false})
    const scopeHash=acceptanceHash({userId,agentId,window,topicHint:topicHint.trim()})
    const filters={user_id:userId,agent_id:agentId,scope_hash:scopeHash}
    const storedChunks=rows(await supabase.from('diary_acceptance_chunk_cache')
        .select('chunk_index,chunk_hash,observations')
        .eq('user_id',userId).eq('agent_id',agentId).eq('scope_hash',scopeHash)
        .order('chunk_index',{ascending:true}).limit(MAX_ACCEPTANCE_CHUNKS))
    const storedRollups=rows(await supabase.from('diary_acceptance_rollup_cache')
        .select('group_index,group_hash,observations')
        .eq('user_id',userId).eq('agent_id',agentId).eq('scope_hash',scopeHash)
        .order('group_index',{ascending:true}).limit(MAX_ACCEPTANCE_ROLLUPS))
    const loadSharedChunks=async(hashes)=>{
        const shared=[]
        for(let offset=0;offset<hashes.length;offset+=40) {
            const batch=hashes.slice(offset,offset+40)
            if(batch.length) shared.push(...rows(await supabase.from('diary_review_material_cache')
                .select('chunk_hash,observations').eq('user_id',userId)
                .eq('agent_id',agentId).in('chunk_hash',batch).limit(40)))
        }
        return shared
    }
    const storeReviewedChunk=async({index,hash,observations})=>{
        if(!Number.isInteger(index) || index<1 || index>MAX_ACCEPTANCE_CHUNKS ||
            !HASH.test(hash)) throw new Error('invalid_diary_input')
        requireOk(await supabase.from('diary_acceptance_chunk_cache').upsert({
            ...filters,chunk_index:index,chunk_hash:hash,observations,
            updated_at:new Date().toISOString(),
        },{onConflict:'user_id,agent_id,scope_hash,chunk_index'}))
    }
    const storeReviewedRollup=async({index,hash,observations})=>{
        if(!Number.isInteger(index) || index<1 || index>MAX_ACCEPTANCE_ROLLUPS ||
            !HASH.test(hash)) throw new Error('invalid_diary_input')
        requireOk(await supabase.from('diary_acceptance_rollup_cache').upsert({
            ...filters,group_index:index,group_hash:hash,observations,
            updated_at:new Date().toISOString(),
        },{onConflict:'user_id,agent_id,scope_hash,group_index'}))
    }
    const source=await reader({supabase,userId,agentId,
        periodStart:window.periodStart,periodEnd:window.periodEnd})
    const {entries,topics}=await loadDiaryCandidates({supabase,userId,agentId})
    const plan=await writer({supabase,userId,agentId,callModel,settings,
        source,window:{...window,topicHint:topicHint.trim()},entries,topics,
        cachedChunks:storedChunks,cachedRollups:storedRollups,
        loadSharedChunks,storeReviewedChunk,storeReviewedRollup,
        onChunkDone:async()=>{},budget:budgetFactory()})
    const progress={mode:'acceptance_preview',sourceCount:source.includedCount,
        reviewedCount:source.includedCount,
        cacheHits:plan.cacheHits||0,reused:plan.reused||0,
        modelCalls:plan.modelCalls||0,reviewDone:plan.reviewDone||0,
        reviewTotal:plan.reviewTotal||0,rollupDone:plan.rollupDone||0,
        rollupTotal:plan.rollupTotal||0}
    if(plan.partial) return {...progress,status:'partial',processed:0,
        errorCode:'acceptance_preview_partial'}
    return {...progress,status:'previewed',processed:1,
        searchCount:plan.searchCount||0,...countKinds(plan.actions||[])}
}

async function runAcceptanceProbe({supabase,userId,agentId='star'}={}) {
    if (!supabase?.rpc || !userId || agentId!=='star')
        throw new Error('invalid_diary_input')
    const response=await supabase.rpc('diary_v2_acceptance_probe',{
        p_user_id:userId,p_agent_id:agentId,
    })
    const result=requireOk(response)
    if(!result || result.ok!==true || result.rolled_back!==true) {
        return {mode:'acceptance_probe',status:'failed',processed:0,
            errorCode:'acceptance_probe_failed',
            probeStage:Number.isInteger(result?.stage)?result.stage:0,
            probeSqlstate:typeof result?.sqlstate==='string' && /^[A-Z0-9]{5}$/.test(result.sqlstate)
                ? result.sqlstate:'unknown'}
    }
    const keys=['probeCreate','probeAppend','probeRewrite','probeDefer',
        'probeDuplicate','probeConflict','probeAtomic']
    if(keys.some(k=>result[k]!==true)) {
        return {mode:'acceptance_probe',status:'failed',processed:0,
            errorCode:'acceptance_probe_failed',
            probeStage:Number.isInteger(result?.stage)?result.stage:0,
            probeSqlstate:typeof result?.sqlstate==='string' && /^[A-Z0-9]{5}$/.test(result.sqlstate)
                ? result.sqlstate:'unknown'}
    }
    return {mode:'acceptance_probe',status:'verified',processed:1,
        ...Object.fromEntries(keys.map(k=>[k,1])),rolledBack:1}
}

module.exports={runAcceptancePreview,runAcceptanceProbe,acceptanceHash,countKinds}
