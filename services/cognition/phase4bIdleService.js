'use strict'

// Phase 4B only reads the database and calls narrowly-scoped RPCs.
// The source of truth is the existing messages / call_sessions tables.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function idleMinutes(env = process.env) {
    const raw = env.COGNITION_PHASE4B_IDLE_MINUTES
    if (raw == null || String(raw).trim() === '') return 60
    if (!/^(?:[5-9]|[1-9][0-9]|1[0-7][0-9]|180)$/.test(String(raw).trim())) {
        throw new Error('INVALID_PHASE4B_IDLE_MINUTES')
    }
    const value = Number(raw)
    if (!Number.isSafeInteger(value) || value < 5 || value > 180) {
        throw new Error('INVALID_PHASE4B_IDLE_MINUTES')
    }
    return value
}
function ensureRpc(reply, valid) {
    if (!reply || reply.error || !reply.data || typeof reply.data !== 'object' ||
        !valid.includes(reply.data.status)) throw new Error('PHASE4B_RPC_ERROR')
    return reply.data
}
async function scanIdle({ supabase, userId, agentId='star', env=process.env }) {
    if (typeof userId !== 'string' || !UUID_RE.test(userId) || agentId !== 'star') {
        throw new Error('INVALID_PHASE4B_IDENTITY')
    }
    if (!supabase || typeof supabase.rpc !== 'function') throw new Error('INVALID_SUPABASE')
    return ensureRpc(await supabase.rpc('cognition_phase4b_scan_idle', {
        p_user_id:userId,p_agent_id:agentId,p_idle_minutes:idleMinutes(env),
    }), ['armed','voice_active','no_new_activity','not_idle','too_old','queued','already_queued'])
}
async function guardClaim({supabase, eventId, leaseToken, env=process.env}) {
    if (!supabase || typeof supabase.rpc !== 'function') throw new Error('INVALID_SUPABASE')
    if (!UUID_RE.test(eventId || '') || !UUID_RE.test(leaseToken || '')) {
        throw new Error('INVALID_PHASE4B_CLAIM')
    }
    return ensureRpc(await supabase.rpc('cognition_phase4b_guard_claim', {
        p_event_id:eventId,p_lease_token:leaseToken,p_idle_minutes:idleMinutes(env),
    }), ['allowed','skipped','stale'])
}
module.exports={idleMinutes,scanIdle,guardClaim}
