'use strict'

// Cognition is background work, not an interactive chat request. Give its
// single slow model attempt more time without changing the global chat timeout.
// The existing callModelWithRetry implementation only retries *quick* transient
// failures; it never retries a timeout or a slow upstream failure.
const DEFAULT_TIMEOUT_MS = 90000
const MIN_TIMEOUT_MS = 45000
const MAX_TIMEOUT_MS = 105000
const MAX_ATTEMPTS = 2

function cognitionModelTimeoutMs(value) {
    if (value === undefined || value === null || value === '') {
        return DEFAULT_TIMEOUT_MS
    }
    const parsed = Number(value)
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return DEFAULT_TIMEOUT_MS
    }
    return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.trunc(parsed)))
}

function createCognitionModelCaller({ callModelWithRetry,
    timeoutMs = process.env.COGNITION_MODEL_TIMEOUT_MS,
} = {}) {
    if (typeof callModelWithRetry !== 'function') {
        throw new TypeError('Cognition requires the existing model caller')
    }
    const timeout = cognitionModelTimeoutMs(timeoutMs)
    return (request) => callModelWithRetry(request, MAX_ATTEMPTS, { timeout })
}

module.exports = {
    cognitionModelTimeoutMs,
    createCognitionModelCaller,
}
