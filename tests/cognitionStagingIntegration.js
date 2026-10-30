'use strict'

// Hermit BC-V2-003: explicit opt-in integration acceptance on a SEPARATE
// Supabase staging project. Never point this at Hermit's production project.
// A disposable test identity and synthetic text keep Star's real state untouched.

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const {
    createThoughtThread,
    getThoughtThread,
    listThoughtThreads,
    updateThoughtThread,
} = require('../services/cognition/thoughtThreadService')
const {
    loadThreadContext,
    parseThreadAction,
    persistThreadAction,
    preflightThreadAction,
    promptThreadContext,
} = require('../services/cognition/thoughtThreadCognition')

const CONFIRM = 'I_HAVE_A_SEPARATE_STAGING_PROJECT'

function parseProjectUrl(input, label) {
    if (typeof input !== 'string' || !input.trim()) {
        throw new Error(`${label} is required`)
    }
    let url
    try { url = new URL(input) } catch (_) { throw new Error(`${label} is not a URL`) }
    if (url.protocol !== 'https:' || !/^[a-z0-9-]+\.supabase\.co$/i.test(url.hostname) ||
        url.username || url.password || url.search || url.hash ||
        (url.pathname !== '/' && url.pathname !== '')) {
        throw new Error(`${label} must be a plain https://<project>.supabase.co URL`)
    }
    return url.hostname.toLowerCase()
}

function validateStagingConfig(env = process.env) {
    if (env.BC_STAGING_CONFIRM !== CONFIRM) {
        throw new Error('staging confirmation missing; refusing all writes')
    }
    const stagingHost = parseProjectUrl(env.BC_STAGING_SUPABASE_URL,
        'BC_STAGING_SUPABASE_URL')
    const productionHost = parseProjectUrl(env.BC_PRODUCTION_SUPABASE_URL,
        'BC_PRODUCTION_SUPABASE_URL')
    if (stagingHost === productionHost) {
        throw new Error('staging and production point to the SAME project; refusing all writes')
    }
    if (typeof env.BC_STAGING_SERVICE_ROLE_KEY !== 'string' ||
        env.BC_STAGING_SERVICE_ROLE_KEY.length < 20) {
        throw new Error('BC_STAGING_SERVICE_ROLE_KEY is missing')
    }
    return { stagingHost, stagingUrl: `https://${stagingHost}`,
        key: env.BC_STAGING_SERVICE_ROLE_KEY }
}

async function acceptance({ supabase, onStatus = () => {} }) {
    const userId = crypto.randomUUID()
    const anotherUserId = crypto.randomUUID()
    const agentId = `bc-stage-${crypto.randomBytes(6).toString('hex')}`
    const otherAgentId = `${agentId}-other`
    const sourceMessageId = `staging-${crypto.randomUUID()}`
    const wakeReasons = ['periodic_autonomous']
    const base = { supabase, userId, agentId }
    const now = new Date()
    const synthetic = {
        title: 'BC staging integration test - synthetic topic',
        current_draft: 'Synthetic draft v1 - no user information',
        next_step: 'Test second simulated round',
        next_review_at: null,
    }
    let threadId = null
    let failure = null
    try {
        const initial = await loadThreadContext({ ...base, now })
        assert.equal(initial.available, true)
        assert.equal(initial.eligible.length, 0)
        onStatus('PASS: initial isolated context is empty')

        const createAction = parseThreadAction({ type: 'create', ...synthetic }, now)
        preflightThreadAction({ action: createAction, context: initial })
        const created = await persistThreadAction({ ...base, sourceMessageId,
            wakeReasons, action: createAction, context: initial, now })
        assert.equal(created.status, 'created')
        assert.equal(created.persisted, true)
        threadId = created.threadId
        assert.match(threadId, /^[0-9a-f-]{36}$/i)
        const first = await getThoughtThread({ ...base, threadId })
        assert.equal(first.title, synthetic.title)
        assert.equal(first.current_draft, synthetic.current_draft)
        assert.equal(first.status, 'open')
        assert.equal(first.version, 0)
        onStatus('PASS: create + fresh Supabase readback')

        // Repeat EXACTLY the same request; the dedupe key must prevent a second row.
        const repeated = await persistThreadAction({ ...base, sourceMessageId,
            wakeReasons, action: createAction, context: initial, now })
        assert.equal(repeated.threadId, threadId)
        const owned = await listThoughtThreads({ ...base, status: 'all' })
        assert.equal(owned.length, 1)
        onStatus('PASS: duplicate request did not create a second thread')

        assert.equal(await getThoughtThread({ supabase, userId: anotherUserId,
            agentId, threadId }), null)
        assert.equal(await getThoughtThread({ supabase, userId,
            agentId: otherAgentId, threadId }), null)
        onStatus('PASS: user/agent scoped reads do not return the test thread')

        // Simulate a later round. No real model is called and no runtime state
        // or messages are touched. Check that the prompt snapshot contains it.
        const nextRound = await loadThreadContext({ ...base, now: new Date(now.getTime() + 60000) })
        const prompt = promptThreadContext(nextRound)
        assert.equal(prompt.available, true)
        assert.equal(prompt.eligibleThreads.length, 1)
        assert.equal(prompt.eligibleThreads[0].id, threadId)
        const updateAction = parseThreadAction({
            type: 'update', thread_id: threadId,
            current_draft: 'Synthetic draft v2 - second simulated round',
            next_step: 'Synthetic next step', next_review_at: null,
        }, new Date(now.getTime() + 60000))
        preflightThreadAction({ action: updateAction, context: nextRound })
        const updated = await persistThreadAction({ ...base, sourceMessageId,
            wakeReasons, action: updateAction, context: nextRound,
            now: new Date(now.getTime() + 60000) })
        assert.equal(updated.status, 'updated')
        assert.equal(updated.threadId, threadId)
        const second = await getThoughtThread({ ...base, threadId })
        assert.equal(second.version, 1)
        assert.equal(second.current_draft, updateAction.currentDraft)
        onStatus('PASS: second simulated round resumed SAME id, version 1')

        await assert.rejects(() => updateThoughtThread({ ...base, threadId,
            expectedVersion: 0, patch: { currentDraft: 'stale overwrite' },
            now: new Date(now.getTime() + 120000) }),
        (err) => err?.code === 'THOUGHT_THREAD_CONFLICT')
        onStatus('PASS: stale version update rejected')

        const finalContext = await loadThreadContext({ ...base,
            now: new Date(now.getTime() + 180000) })
        const finishAction = parseThreadAction({ type: 'complete', thread_id: threadId,
            result: 'Synthetic completion - end of staging acceptance',
        }, new Date(now.getTime() + 180000))
        preflightThreadAction({ action: finishAction, context: finalContext })
        const completed = await persistThreadAction({ ...base, sourceMessageId,
            wakeReasons, action: finishAction, context: finalContext,
            now: new Date(now.getTime() + 180000) })
        assert.equal(completed.status, 'completed')
        const closed = await getThoughtThread({ ...base, threadId })
        assert.equal(closed.status, 'completed')
        assert.equal(closed.version, 2)
        assert.ok(closed.closed_at)
        const post = await loadThreadContext({ ...base,
            now: new Date(now.getTime() + 240000) })
        assert.equal(post.eligible.some((item) => item.id === threadId), false)
        onStatus('PASS: completion + closed thread excluded from next round')
    } catch (error) {
        failure = error
    } finally {
        if (threadId) {
            try {
                const { data, error } = await supabase.from('agent_thought_threads')
                    .delete().eq('id', threadId).eq('user_id', userId)
                    .eq('agent_id', agentId).select('id')
                if (error) throw error
                if (!Array.isArray(data) || data.length !== 1 || data[0].id !== threadId) {
                    throw new Error('cleanup did not confirm exactly one deleted row')
                }
                const after = await getThoughtThread({ ...base, threadId })
                assert.equal(after, null)
                onStatus('PASS: synthetic thread deleted and absence verified')
            } catch (cleanupError) {
                // A cleanup failure MUST NOT be hidden, even after a test failure.
                // These are synthetic staging-only identifiers, not real user data.
                onStatus(`CLEANUP FAILED: check staging thread id=${threadId} agent=${agentId}`)
                if (failure) failure = new AggregateError([failure, cleanupError],
                    'acceptance failed and staging cleanup failed')
                else failure = cleanupError
            }
        }
    }
    if (failure) throw failure
    return true
}

async function main() {
    const config = validateStagingConfig() // MUST happen before client or writes.
    const { createClient } = require('@supabase/supabase-js')
    const supabase = createClient(config.stagingUrl, config.key, {
        auth: { persistSession: false, autoRefreshToken: false },
    })
    console.log('Running synthetic Thread acceptance on confirmed separate staging project')
    await acceptance({ supabase, onStatus: (message) => console.log(message) })
    console.log('STAGING THREAD ACCEPTANCE PASSED (this is not production Cognition acceptance)')
}

if (require.main === module) {
    main().catch((error) => {
        // Never print env, credentials, database rows, user messages or Thought text.
        console.error('STAGING THREAD ACCEPTANCE FAILED:', error?.name || 'Error',
            error?.code || 'UNCLASSIFIED')
        process.exitCode = 1
    })
}

module.exports = { parseProjectUrl, validateStagingConfig, acceptance }
