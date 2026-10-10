'use strict'

// Background Cognition Step 4 — one deterministic time source for chat and
// offline cognition. Dates are instants (UTC in storage); the user's timezone
// is taken ONLY from their saved settings, never inferred from server locale.

function asDate(value) {
    if (value == null || value === '') return null
    try {
        const date = value instanceof Date ? value : new Date(value)
        return Number.isFinite(date.getTime()) ? date : null
    } catch (_) {
        return null
    }
}

function getValidTimeZone(value) {
    const zone = typeof value === 'string' ? value.trim() : ''
    if (!zone) return null
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: zone })
        return zone
    } catch (_) {
        return null
    }
}

function getDayPart(hour) {
    if (hour >= 5 && hour <= 8) return '清晨 / 早上'
    if (hour >= 9 && hour <= 11) return '上午'
    if (hour >= 12 && hour <= 13) return '中午'
    if (hour >= 14 && hour <= 17) return '下午'
    if (hour >= 18 && hour <= 21) return '晚上'
    if (hour >= 22) return '深夜'
    return '凌晨'
}

function formatLocalTime(date, timeZone) {
    const parts = new Intl.DateTimeFormat('zh-CN', {
        timeZone,
        year: 'numeric', month: '2-digit', day: '2-digit',
        weekday: 'long', hour: '2-digit', minute: '2-digit',
        hourCycle: 'h23',
    }).formatToParts(date)
    const items = Object.fromEntries(parts.map(({ type, value }) => [type, value]))
    const hour = Number(items.hour)
    return {
        localDateTime: `${items.year}-${items.month}-${items.day} ${items.hour}:${items.minute}`,
        weekday: items.weekday,
        dayPart: getDayPart(hour),
    }
}

// Duration uses actual elapsed time, not wall-clock subtraction across DST.
// Negative, future, missing or malformed timestamps are never guessed.
function elapsedMinutes(from, to) {
    const start = asDate(from)
    const end = asDate(to)
    if (!start || !end || end.getTime() < start.getTime()) return null
    return Math.floor((end.getTime() - start.getTime()) / 60000)
}

function formatElapsed(minutes) {
    if (!Number.isInteger(minutes) || minutes < 0) return null
    if (minutes === 0) return '不到1分钟'
    if (minutes < 60) return `${minutes}分钟`
    const days = Math.floor(minutes / 1440)
    const hours = Math.floor((minutes % 1440) / 60)
    const remainderMinutes = minutes % 60
    if (days >= 1) {
        return `${days}天${hours ? `${hours}小时` : ''}`
    }
    return `${hours}小时${remainderMinutes ? `${remainderMinutes}分钟` : ''}`
}

// The current user message is already persisted by chat before the history
// query. Exclude that exact ID, not merely "the last row" (assistant rows and
// retries can appear after it). The supplied history is session-scoped.
function findPreviousUserMessageAt(messages, currentMessage) {
    const currentDate = asDate(currentMessage?.created_at)
    if (!currentDate || !Array.isArray(messages)) return null
    const currentId = currentMessage?.id == null ? null : String(currentMessage.id)
    let latest = null
    for (const row of messages) {
        if (!row || row.role !== 'user') continue
        if (currentId !== null && String(row.id) === currentId) continue
        const candidate = asDate(row.created_at)
        if (!candidate || candidate > currentDate) continue
        if (!latest || candidate > latest) latest = candidate
    }
    return latest ? latest.toISOString() : null
}

function buildTimeContext({
    now = new Date(), timeZone = null, mode = 'chat',
    currentUserMessageAt = null, previousUserMessageAt = null,
    lastUserMessageAt = null,
} = {}) {
    const nowDate = asDate(now)
    if (!nowDate) throw new Error('Time Context: now 时间无效')
    if (mode !== 'chat' && mode !== 'cognition') {
        throw new Error('Time Context: mode 必须是 chat 或 cognition')
    }

    const validZone = getValidTimeZone(timeZone)
    const local = validZone ? formatLocalTime(nowDate, validZone) : null
    const gapMinutes = mode === 'chat'
        ? elapsedMinutes(previousUserMessageAt, currentUserMessageAt)
        : elapsedMinutes(lastUserMessageAt, nowDate)

    const lines = [
        '【基础时间信息（背景事实，不是必须提起的话题）】',
        `当前 UTC 时刻：${nowDate.toISOString()}`,
    ]
    if (local) {
        lines.push(`用户设置的时区：${validZone}`)
        lines.push(`用户当前本地时间：${local.localDateTime} ${local.weekday}`)
        lines.push(`当前时间段：${local.dayPart}`)
    } else {
        lines.push('用户时区未知：不要根据服务器 UTC 时间猜测用户当地的早晚或星期。')
    }

    if (gapMinutes !== null) {
        const label = mode === 'chat'
            ? '本会话本条与上一条用户消息的间隔'
            : '距离用户最后一条消息的时间'
        lines.push(`${label}：${formatElapsed(gapMinutes)}`)
    } else {
        lines.push(mode === 'chat'
            ? '本会话上一条用户消息的时间尚不确定。'
            : '最近一次用户消息的时间尚不确定。')
    }
    lines.push('时间和消息间隔只作情境参考；除非相关，不必主动提起。不要仅凭间隔推断用户在睡觉、情绪异常或发生危险。')

    return {
        currentUtc: nowDate.toISOString(),
        timeZone: validZone,
        localDateTime: local?.localDateTime || null,
        weekday: local?.weekday || null,
        dayPart: local?.dayPart || null,
        elapsedMinutes: gapMinutes,
        text: lines.join('\n'),
    }
}

module.exports = {
    buildTimeContext,
    elapsedMinutes,
    findPreviousUserMessageAt,
    formatElapsed,
    getDayPart,
    getValidTimeZone,
}
