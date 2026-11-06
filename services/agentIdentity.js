'use strict'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function normalizeUuid(value) {
    return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

function identityError(message, code) {
    const error = new Error(message)
    error.code = code
    return error
}

function matchesExpectedUserId(actual, expected) {
    const actualId = normalizeUuid(actual)
    const expectedId = normalizeUuid(expected)
    return UUID_RE.test(actualId) &&
        UUID_RE.test(expectedId) &&
        actualId === expectedId
}

/**
 * Build a resolver from server-controlled environment variables.
 *
 * HERMIT_STAR_USER_ID -> DB agent_id "star", voice/persona key "xingxing"
 * HERMIT_GUAI_USER_ID -> DB agent_id "guai", voice/persona key "guai"
 *
 * The caller must pass the authenticated Supabase user ID. Client-supplied
 * agent IDs and editable user metadata are deliberately not consulted.
 */
function createAgentIdentityResolver(env = process.env) {
    return function resolveAgentIdentity(userId) {
        const normalizedUserId = normalizeUuid(userId)
        const starUserId = normalizeUuid(env.HERMIT_STAR_USER_ID)
        const guaiUserId = normalizeUuid(env.HERMIT_GUAI_USER_ID)

        if (!UUID_RE.test(normalizedUserId)) {
            throw identityError(
                'Agent identity requires a valid authenticated user ID',
                'AGENT_IDENTITY_INVALID_USER'
            )
        }

        if (!UUID_RE.test(starUserId) || !UUID_RE.test(guaiUserId)) {
            throw identityError(
                'HERMIT_STAR_USER_ID and HERMIT_GUAI_USER_ID must both be configured',
                'AGENT_IDENTITY_CONFIG_INVALID'
            )
        }

        if (starUserId === guaiUserId) {
            throw identityError(
                'Star and Guai user IDs must be different',
                'AGENT_IDENTITY_CONFIG_COLLISION'
            )
        }

        if (normalizedUserId === starUserId) {
            return Object.freeze({
                userId: normalizedUserId,
                agentId: 'star',
                agentKey: 'xingxing',
            })
        }

        if (normalizedUserId === guaiUserId) {
            return Object.freeze({
                userId: normalizedUserId,
                agentId: 'guai',
                agentKey: 'guai',
            })
        }

        throw identityError(
            'No Hermit Agent is configured for this authenticated user',
            'AGENT_IDENTITY_NOT_MAPPED'
        )
    }
}

const resolveAgentIdentity = createAgentIdentityResolver()

module.exports = {
    createAgentIdentityResolver,
    matchesExpectedUserId,
    resolveAgentIdentity,
}
