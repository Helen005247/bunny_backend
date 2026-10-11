'use strict'

// Called by GitHub Actions. Uses the existing authenticated Cognition tick;
// heartbeat NEVER overrides Wake Gate or forces a manual thought.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const MAX_ATTEMPTS = 2
const RETRYABLE_STATUS = new Set([429, 502, 503, 504])

function assertConfig({ endpoint, userId, secret }) {
    if (!UUID_RE.test(userId || '')) {
        throw new Error('缺少有效的 COGNITION_USER_ID（GitHub Actions Secret）')
    }
    if (typeof secret !== 'string' || secret.length < 24) {
        throw new Error('缺少有效的 COGNITION_TICK_SECRET（GitHub Actions Secret，至少24字符）')
    }
    let url
    try { url = new URL(endpoint) } catch (_) {
        throw new Error('COGNITION_ENDPOINT 格式不正确')
    }
    if (url.protocol !== 'https:' || url.username || url.password ||
        url.pathname !== '/internal/cognition/tick' || url.search || url.hash) {
        throw new Error('COGNITION_ENDPOINT 必须是 HTTPS /internal/cognition/tick')
    }
    return url.toString()
}

async function sendHeartbeat({ endpoint, userId, secret,
    fetchImpl = globalThis.fetch, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
    const url = assertConfig({ endpoint, userId, secret })
    if (typeof fetchImpl !== 'function') throw new Error('Node fetch 不可用')
    const body = JSON.stringify({ userId, agentId: 'star', triggerType: 'heartbeat' })
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        let response
        try {
            response = await fetchImpl(url, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    'x-cognition-secret': secret,
                },
                body,
                signal: AbortSignal.timeout(170000),
            })
        } catch (error) {
            if (attempt === MAX_ATTEMPTS) {
                throw new Error('Cognition Heartbeat 请求失败（网络或超时）')
            }
            await sleep(15000)
            continue
        }
        if (!response.ok) {
            // Never log request/response body: it may contain private data.
            if (attempt < MAX_ATTEMPTS && RETRYABLE_STATUS.has(response.status)) {
                await sleep(15000)
                continue
            }
            throw new Error(`Cognition Heartbeat HTTP ${response.status}`)
        }
        let result
        try { result = await response.json() } catch (_) {
            throw new Error('Cognition Heartbeat 返回值不是 JSON')
        }
        if (!result || result.ok !== true || typeof result.executed !== 'boolean') {
            throw new Error('Cognition Heartbeat 返回格式错误')
        }
        // Deliberately discard result.thought, thoughtId, and anything private.
        return {
            executed: result.executed,
            stored: result.stored === true,
            reason: result.executed ? null : (
                ['cooldown', 'wake_gate_skipped', 'no_user_messages',
                    'new_user_message_during_tick'].includes(result.reason)
                    ? result.reason : 'skipped'),
        }
    }
    throw new Error('Cognition Heartbeat 触发失败')
}

async function main() {
    const result = await sendHeartbeat({
        endpoint: process.env.COGNITION_ENDPOINT,
        userId: process.env.COGNITION_USER_ID,
        secret: process.env.COGNITION_TICK_SECRET,
    })
    console.log(`[cognition] heartbeat ok; executed=${result.executed}; ` +
        `stored=${result.stored}; reason=${result.reason || 'none'}`)
}

if (require.main === module) {
    main().catch((error) => {
        // No secrets, user IDs, user messages, or thoughts in public Action logs.
        console.error('[cognition] heartbeat failed:', error.message)
        process.exitCode = 1
    })
}

module.exports = { assertConfig, sendHeartbeat }
