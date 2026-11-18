'use strict'

// Scheduled job (Node 22): one authenticated Phase 4B scan + possible dispatch.
// Never sends or prints messages, thoughts, tokens, or raw API error bodies.
async function main() {
    const endpoint = process.env.COGNITION_PHASE4B_ENDPOINT || ''
    const userId = process.env.COGNITION_USER_ID || ''
    const secret = process.env.COGNITION_TICK_SECRET || ''
    if (!/^https:\/\/[^/?#]+\/internal\/cognition\/phase4b\/scan-dispatch$/.test(endpoint) ||
        !/^[0-9a-f-]{36}$/i.test(userId) || secret.length < 24) {
        throw new Error('PHASE4B_JOB_CONFIG_MISSING')
    }
    const response = await fetch(endpoint, {
        method:'POST',
        headers:{'Content-Type':'application/json','x-cognition-secret':secret},
        body:JSON.stringify({userId,agentId:'star'}),
        signal:AbortSignal.timeout(240000),
    })
    if (!response.ok) throw new Error(`PHASE4B_HTTP_${response.status}`)
    const result = await response.json()
    if (!result?.ok || typeof result.scan !== 'string' ||
        typeof result.dispatch !== 'string') throw new Error('PHASE4B_INVALID_REPLY')
    console.log(`[cognition] phase4b scan=${result.scan}; dispatch=${result.dispatch}; `+
        `executed=${result.executed===true}`)
    if (['uncertain','stale'].includes(result.dispatch)) {
        throw new Error('PHASE4B_REQUIRES_REVIEW')
    }
}
main().catch(error => {
    console.error(`[cognition] phase4b job failed; code=${
        /^PHASE4B_[A-Z0-9_]+$/.test(error?.message||'')?error.message:'PHASE4B_REQUEST_FAILED'}`)
    process.exitCode=1
})
