'use strict'

// A preview plan is private user data. Store complete normalized actions and
// evidence in a service-role-only table; never log titles, body, sources.
// Confirmation uses an atomic PostgreSQL RPC, never separate INSERT/UPDATE RPCs.
const crypto = require('node:crypto')
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const DIGEST = /^[0-9a-f]{64}$/

function invalid(message='invalid_diary_input') {
    const error=new Error(message); error.code=message; throw error
}
function summaryActionCounts(actions) {
    const counts={created:0,revised:0,deferred:0,skipped:0}
    for(const action of actions) {
        if(action.kind==='create')counts.created++
        else if(action.kind==='append'||action.kind==='rewrite')counts.revised++
        else if(action.kind==='defer')counts.deferred++
        else invalid('invalid_diary_plan')
    }
    if(!actions.length) counts.skipped=1
    return counts
}
function digestOfSavedPlan({userId,agentId,scopeHash,window,actions,evidence}) {
    return crypto.createHash('sha256').update(JSON.stringify([
        'hermit-diary-v2-manual-plan-v1',userId,agentId,scopeHash,
        window.startDate,window.endDate,window.periodStart,window.periodEnd,
        window.timeZone,window.topicHint||'',actions,evidence.sourceHash,evidence.sourceRefs,
    ])).digest('hex')
}
async function saveDiaryPreviewPlan({supabase,userId,agentId,window,
    scopeHash,actions,evidence,sourceMessages=0,searchHits=0}={}) {
    if(!supabase?.from || !UUID.test(userId||'') || agentId!=='star' ||
        !DIGEST.test(scopeHash||'') || !window?.periodStart || !window?.periodEnd ||
        !Array.isArray(actions)||actions.length>2|| !Array.isArray(evidence?.sourceRefs) ||
        evidence.sourceRefs.length>28 || !DIGEST.test(evidence.sourceHash||'') ||
        evidence.sourceRefs.length!==evidence.includedCount ||
        !Number.isSafeInteger(sourceMessages) || sourceMessages<0 ||
        !Number.isSafeInteger(searchHits)||searchHits<0) invalid()
    // Ensure each plan was produced by the normalized writer and all evidence
    // IDs were in its actual accessible prompt. SQL rechecks on commit.
    const ids=new Set(evidence.sourceRefs.map(x=>x.id))
    for(const action of actions) {
        if(!['create','append','rewrite','defer'].includes(action?.kind) ||
            !Array.isArray(action.evidence_ids)||!action.evidence_ids.length||
            action.evidence_ids.some(id=>!ids.has(id))) invalid('invalid_diary_plan')
    }
    const planDigest=digestOfSavedPlan({userId,agentId,scopeHash,window,actions,evidence})
    const row={user_id:userId,agent_id:agentId,scope_hash:scopeHash,
        plan_digest:planDigest,start_date:window.startDate,end_date:window.endDate,
        period_start:window.periodStart,period_end:window.periodEnd,
        timezone:window.timeZone,topic_hint:window.topicHint||'',
        actions,evidence_refs:evidence.sourceRefs,evidence_count:evidence.includedCount,
        evidence_hash:evidence.sourceHash,source_messages:sourceMessages,
        search_hits:searchHits}
    const response=await supabase.from('diary_acceptance_plans')
        .insert(row).select('id').single()
    if(response?.error||!UUID.test(response?.data?.id||''))invalid('diary_database_failure')
    return {planId:response.data.id,planDigest,actionCounts:summaryActionCounts(actions)}
}
async function commitDiaryPreviewPlan({supabase,userId,agentId='star',planId,planDigest}={}) {
    if(!supabase?.rpc || !UUID.test(userId||'') || agentId!=='star' ||
        !UUID.test(planId||'') || !DIGEST.test(planDigest||'')) invalid()
    const response=await supabase.rpc('diary_commit_acceptance_plan',{
        p_user_id:userId,p_agent_id:agentId,p_plan_id:planId,p_plan_digest:planDigest,
    })
    if(response?.error) {
        const safe=new Set(['diary_revision_conflict','diary_plan_expired',
            'diary_plan_not_found_or_mismatch','diary_manual_scope_already_processed',
            'diary_evidence_changed','diary_readback_failed'])
        const raw=String(response.error.message||'')
        invalid(safe.has(raw)?raw:'diary_database_failure')
    }
    const data=response?.data
    if(data?.ok!==true || data?.readbackOk!==true ||
        !['committed','already_committed'].includes(data?.status))
        invalid('diary_readback_failed')
    return {status:data.status,processed:1,planId,
        created:Number(data.created||0),revised:Number(data.revised||0),
        deferred:Number(data.deferred||0),committedActions:Number(data.actions||0),
        dbVerified:1,modelVerified:0,liveWriteVerified:data.status==='committed'&&
            Number(data.actions||0)>0 ? 1:0,readbackVerified:1}
}
module.exports={saveDiaryPreviewPlan,commitDiaryPreviewPlan,
    summaryActionCounts,digestOfSavedPlan}
