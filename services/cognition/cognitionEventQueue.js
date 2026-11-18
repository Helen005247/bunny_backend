'use strict'

// Phase 4A durable event queue. All changes are server-side RPC operations.
// No Cognition state, Diary, chat, Thought or Thread write happens here.
const EVENT_TYPES = Object.freeze(['chat_finished', 'milestone_transition', 'external_event'])
const EVENT_TYPE_SET = new Set(EVENT_TYPES)
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function validateIdentity(userId, agentId) {
    if (typeof userId !== 'string' || !UUID.test(userId) ||
        agentId !== 'star') throw new Error('INVALID_EVENT_IDENTITY')
}
function validateEventInput({ userId, agentId, eventType, eventKey }) {
    validateIdentity(userId, agentId)
    if (!EVENT_TYPE_SET.has(eventType)) throw new Error('INVALID_EVENT_TYPE')
    if (typeof eventKey !== 'string' ||
        eventKey.length < 1 || eventKey.length > 160 ||
        eventKey !== eventKey.trim() || /[\x00-\x1f\x7f]/.test(eventKey)) {
        throw new Error('INVALID_EVENT_KEY')
    }
}
function unwrapRpc(result) {
    if (!result || result.error || !result.data ||
        typeof result.data !== 'object' || Array.isArray(result.data)) {
        throw new Error('COGNITION_EVENT_RPC_FAILED')
    }
    return result.data
}
async function enqueueCognitionEvent({ supabase, userId, agentId='star', eventType, eventKey }) {
    validateEventInput({userId,agentId,eventType,eventKey})
    const result=unwrapRpc(await supabase.rpc('cognition_phase4_enqueue_event', {
        p_user_id:userId, p_agent_id:agentId, p_event_type:eventType, p_event_key:eventKey
    }))
    if (typeof result.status!=='string' || typeof result.id!=='string') {
        throw new Error('INVALID_ENQUEUE_RESULT')
    }
    return {status:result.status,id:result.id}
}
async function claimCognitionEvent({supabase,userId,agentId='star'}) {
    validateIdentity(userId,agentId)
    const result=unwrapRpc(await supabase.rpc('cognition_phase4_claim_event', {
        p_user_id:userId, p_agent_id:agentId
    }))
    if (!['claimed','empty','cooldown'].includes(result.status)) {
        throw new Error('INVALID_CLAIM_RESULT')
    }
    if (result.status==='claimed') {
        if (!UUID.test(result.id || '') || !UUID.test(result.lease_token || '') ||
            !EVENT_TYPE_SET.has(result.event_type) || !Number.isSafeInteger(result.attempts) ||
            result.attempts<1 || result.attempts>100000) {
            throw new Error('INVALID_CLAIM_FIELDS')
        }
    }
    return result
}
async function settleCognitionEvent({supabase,eventId,leaseToken,result}) {
    if (!UUID.test(eventId || '') || !UUID.test(leaseToken || '') ||
        !['done','defer','uncertain'].includes(result)) {
        throw new Error('INVALID_SETTLE_INPUT')
    }
    const outcome=unwrapRpc(await supabase.rpc('cognition_phase4_settle_event', {
        p_event_id:eventId,p_lease_token:leaseToken,p_result:result
    }))
    if (!['done','pending','uncertain','stale'].includes(outcome.status)) {
        throw new Error('INVALID_SETTLE_RESULT')
    }
    return outcome
}
function classifyCognitionEventResult(r) {
    // Outcome "complete" must include a successful Runtime state commit.
    if (r?.executed===true && r.outcome==='complete' && r.stateUpdated===true) return 'done'
    if (r?.executed===false && [
        'context_review_partial','cooldown','wake_gate_skipped','no_user_messages',
    ].includes(r.reason)) return 'defer'
    // The request may have written a Thought or a Thread before failing.
    // A partial or ambiguous result is NEVER retried automatically.
    return 'uncertain'
}
async function dispatchOneCognitionEvent({
    supabase,userId,agentId='star',runTick,callModel,
    getSettings,getLatestMemory,getMilestoneContext,
    getCharacterLoreContext,getStoryLoreContext,
    eventQueue={claimCognitionEvent,settleCognitionEvent},
}) {
    validateIdentity(userId,agentId)
    if (typeof runTick !== 'function') throw new Error('MISSING_RUN_TICK')
    const claim=await eventQueue.claimCognitionEvent({supabase,userId,agentId})
    if (claim.status!=='claimed') return {status:claim.status,executed:false}
    const task={
        supabase,userId,agentId,callModel,getSettings,getLatestMemory,
        getMilestoneContext,getCharacterLoreContext,getStoryLoreContext,
        triggerType:claim.event_type,
        // A queue event may be re-attempted only after a confirmed safe deferral;
        // use an attempt-specific wake key so a partial context review does not
        // consume the logical event in the legacy Wake Gate metadata.
        triggerKey:`${claim.id}:${claim.attempts}`,
    }
    let classification='uncertain'
    try {
        const outcome=await runTick(task)
        classification=classifyCognitionEventResult(outcome)
    } catch (_) {
        // Never log model output, identities, Thought or raw provider error.
        classification='uncertain'
    }
    const settled=await eventQueue.settleCognitionEvent({
        supabase,eventId:claim.id,leaseToken:claim.lease_token,
        result:classification
    })
    // The SQL lease token is authoritative. Never call an executed task
    // "done" if SQL did not acknowledge the disposition.
    if (settled.status==='stale') return {status:'stale',executed:true}
    if (settled.status==='pending' && classification==='defer')
        return {status:'deferred',executed:false}
    if (settled.status==='done' && classification==='done')
        return {status:'done',executed:true}
    return {status:'uncertain',executed:true}
}
module.exports={
    EVENT_TYPES,validateEventInput,enqueueCognitionEvent,
    claimCognitionEvent,settleCognitionEvent,
    classifyCognitionEventResult,dispatchOneCognitionEvent,
}
