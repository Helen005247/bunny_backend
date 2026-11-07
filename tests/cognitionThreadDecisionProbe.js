'use strict'

// BC v2 Phase 2 Step 2: opt-in, read-only MODEL decision probe.
// This script uses synthetic conversations only. It does not import server.js,
// create a Supabase client, or write any Cognition/Thought/Thread records.

const path = require('node:path')
const { buildCognitionInput, parseCognitionOutput } = require('../services/cognition/cognitionService')
const { promptThreadContext } = require('../services/cognition/thoughtThreadCognition')

const MODEL = 'gpt-5.6-sol' // matches the uploaded cognitionService.js
const CASES = Object.freeze(['ordinary', 'continuation'])
const MAX_RESPONSE_CHARS = 12000

function syntheticFixture(name, now = new Date()) {
    if (!CASES.includes(name)) throw new Error('Invalid probe case')
    const old = new Date(now.getTime() - 90 * 60 * 1000).toISOString()
    const lastUser = new Date(now.getTime() - 89 * 60 * 1000).toISOString()
    const ordinary = name === 'ordinary'
    const messages = ordinary ? [
        { role: 'user', at: old, text: '今天午饭吃了面条，味道不错。' },
        { role: 'assistant', at: lastUser, text: '听起来挺好，吃饱了就休息一会儿。' },
    ] : [
        { role: 'user', at: old,
            text: '我下周要给朋友准备一段生日祝福，今天只是先讨论开头。过两三天我们还想一起完善结尾。你可以在这之前整理一个初稿方向，不用主动发消息。' },
        { role: 'assistant', at: lastUser,
            text: '可以，先有个自然的开头，后面再慢慢琢磨细节。' },
    ]
    const state = {
        last_user_message_at: old,
        absence_started_at: null, absence_checkpoint: 0,
        last_cognition_at: new Date(now.getTime() - 7 * 3600 * 1000).toISOString(),
        current_emotional_tone: '平静', pending_topic: null,
    }
    return {
        now, state, wakeReasons: ['periodic_autonomous'], messages,
        settings: {
            timezone: 'Asia/Shanghai',
            system_prompt: '你是星星。语气自然克制，不编造事实，不制造焦虑。',
            character_context: '与用户长期相处，重视真实的生活细节与独立判断。',
        },
        memory: null, milestones: null, recentThoughts: [],
        threadContext: { available: true, eligible: [], known: [] },
    }
}

function diagnose(modelOutput, now) {
    const outcome = parseCognitionOutput(modelOutput, now)
    const decision = outcome.threadActionInvalid ? 'invalid' :
        !outcome.threadActionProvided ? 'omitted' :
            outcome.threadAction.type === 'none' ? 'explicit_none' : outcome.threadAction.type
    return Object.freeze({
        decision,
        thoughtDecision: outcome.shouldStore ? 'store' : 'none',
        thoughtReason: outcome.thoughtReason,
        threadReason: outcome.threadReason,
        shouldStore: outcome.shouldStore,
        parseValid: true,
        context: 'empty',
    })
}

function safeTimeout(value) {
    const parsed = Number(value)
    return Number.isFinite(parsed) && parsed >= 45000 && parsed <= 105000
        ? parsed : 90000
}

async function run({ env = process.env, print = console.log } = {}) {
    if (!env.AI_API_KEY || !env.AI_BASE_URL) {
        throw new Error('AI_API_KEY or AI_BASE_URL is missing in local environment')
    }
    const base = new URL(env.AI_BASE_URL)
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) {
        throw new Error('AI_BASE_URL is not a safe HTTP(S) URL')
    }
    // Loaded lazily so pure, offline test imports never start network requests.
    const OpenAI = require('openai')
    const client = new OpenAI({ apiKey: env.AI_API_KEY, baseURL: env.AI_BASE_URL,
        maxRetries: 0, timeout: safeTimeout(env.COGNITION_MODEL_TIMEOUT_MS) })
    for (const name of CASES) {
        const now = new Date()
        const input = buildCognitionInput(syntheticFixture(name, now))
        const started = Date.now()
        try {
            const response = await client.responses.create({ model: MODEL, input })
            const output = response?.output_text
            if (typeof output !== 'string' || output.length > MAX_RESPONSE_CHARS) {
                print(`${name}: response_format=invalid; decision=unknown`)
                continue
            }
            try {
                const result = diagnose(output, now)
                print(`${name}: response_format=valid; thought_decision=${result.thoughtDecision}; thought_reason=${result.thoughtReason}; thread_decision=${result.decision}; thread_reason=${result.threadReason}; elapsed_ms=${Date.now() - started}`)
            } catch (_) {
                print(`${name}: response_format=invalid; decision=unknown; elapsed_ms=${Date.now() - started}`)
            }
        } catch (error) {
            // Never log raw exception messages: providers can embed request text.
            const code = error?.name === 'APIConnectionTimeoutError' ? 'timeout' :
                error?.status === 429 ? 'rate_limited' : 'model_call_failed'
            print(`${name}: request_status=${code}; decision=unknown; elapsed_ms=${Date.now() - started}`)
            throw new Error(`probe_${code}`)
        }
    }
}

if (require.main === module) {
    if (process.argv.length !== 3 || process.argv[2] !== '--live') {
        console.log('Dry mode: no network calls. For two paid synthetic model requests run: node tests/cognitionThreadDecisionProbe.js --live')
    } else {
        require('dotenv').config({ path: path.resolve(__dirname, '..', '.env'), quiet: true })
        run().catch(() => { console.error('Probe did not complete; see sanitized status above.'); process.exitCode = 1 })
    }
}

module.exports = { CASES, MODEL, syntheticFixture, diagnose, safeTimeout, run }
