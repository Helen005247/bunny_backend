'use strict'

// Heartbeat pacing is fixed. Manual pacing is temporarily configurable for
// production diagnostics, but safely returns to the same 60-minute default.
const HEARTBEAT_COOLDOWN_MINUTES = 60
const DEFAULT_MANUAL_COOLDOWN_MINUTES = 60
const MIN_MANUAL_COOLDOWN_MINUTES = 1
const MAX_MANUAL_COOLDOWN_MINUTES = 60

function getManualCooldownMinutes(env = process.env) {
    const raw = env?.COGNITION_MANUAL_COOLDOWN_MINUTES
    if (raw == null || String(raw).trim() === '') {
        return DEFAULT_MANUAL_COOLDOWN_MINUTES
    }

    const value = String(raw).trim()
    if (!/^(?:[1-9]|[1-5][0-9]|60)$/.test(value)) {
        throw new Error('COGNITION_MANUAL_COOLDOWN_MINUTES 必须是 1～60 的整数')
    }
    const minutes = Number(value)
    if (minutes < MIN_MANUAL_COOLDOWN_MINUTES ||
        minutes > MAX_MANUAL_COOLDOWN_MINUTES) {
        throw new Error('COGNITION_MANUAL_COOLDOWN_MINUTES 必须是 1～60 的整数')
    }
    return minutes
}

function getCognitionCooldownMinutes(triggerType, env = process.env) {
    if (triggerType === 'heartbeat') return HEARTBEAT_COOLDOWN_MINUTES
    if (triggerType === 'manual') return getManualCooldownMinutes(env)
    throw new Error('不支持的 Cognition cooldown trigger')
}

module.exports = {
    DEFAULT_MANUAL_COOLDOWN_MINUTES,
    HEARTBEAT_COOLDOWN_MINUTES,
    getCognitionCooldownMinutes,
    getManualCooldownMinutes,
}
