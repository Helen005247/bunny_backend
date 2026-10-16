'use strict'

// Day boundaries must come from the user's IANA time zone, not UTC-midnight
// or a fixed 24-hour offset (23/25-hour DST days are normal).
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/
const MAX_BACKFILL_DAYS = 4

function validTimeZone(zone) {
    if (typeof zone !== 'string' || !zone.trim() || zone.length > 80) return null
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: zone }).format(new Date())
        return zone.trim()
    } catch (_) { return null }
}

function parseDate(date) {
    const match = typeof date === 'string' ? DATE_RE.exec(date) : null
    if (!match) throw new Error('invalid_diary_date')
    const [year, month, day] = match.slice(1).map(Number)
    const utc = Date.UTC(year, month - 1, day)
    if (year < 2000 || year > 2100 || !Number.isFinite(utc) ||
        new Date(utc).toISOString().slice(0, 10) !== date) {
        throw new Error('invalid_diary_date')
    }
    return utc
}

function addDays(date, amount) {
    if (!Number.isInteger(amount) || Math.abs(amount) > 90) throw new Error('invalid_day_count')
    return new Date(parseDate(date) + amount * 86400000).toISOString().slice(0, 10)
}

const formatters = new Map()
function dateParts(epoch, timeZone) {
    let fmt = formatters.get(timeZone)
    if (!fmt) {
        fmt = new Intl.DateTimeFormat('en-US', {
            timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit',
        })
        formatters.set(timeZone, fmt)
    }
    const parts = Object.fromEntries(fmt.formatToParts(new Date(epoch))
        .filter((p) => p.type !== 'literal').map((p) => [p.type, Number(p.value)]))
    return parts
}

function localDayStart(date, timeZone) {
    parseDate(date)
    if (!validTimeZone(timeZone)) throw new Error('invalid_diary_timezone')
    const nominal = Date.parse(`${date}T00:00:00.000Z`)
    let guess = nominal
    for (let i = 0; i < 5; i += 1) {
        const parts = dateParts(guess, timeZone)
        const localAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day,
            parts.hour, parts.minute, parts.second)
        const offset = localAsUtc - Math.floor(guess / 1000) * 1000
        const next = nominal - offset
        if (next === guess) break
        guess = next
    }
    const parts = dateParts(guess, timeZone)
    if (`${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}` !== date ||
        parts.hour !== 0 || parts.minute !== 0) {
        throw new Error('invalid_local_day_boundary')
    }
    return new Date(guess).toISOString()
}

function localDateAt(now, timeZone) {
    if (!validTimeZone(timeZone)) throw new Error('invalid_diary_timezone')
    const epoch = new Date(now).getTime()
    if (!Number.isFinite(epoch)) throw new Error('invalid_diary_now')
    const p = dateParts(epoch, timeZone)
    return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`
}

function getWindow({ startDate, endDate = startDate, timeZone, now = new Date(),
    allowPartialToday = false } = {}) {
    const start = parseDate(startDate)
    const end = parseDate(endDate)
    const days = Math.floor((end - start) / 86400000) + 1
    if (days < 1 || days > MAX_BACKFILL_DAYS) throw new Error('invalid_diary_range')
    const zone = validTimeZone(timeZone)
    if (!zone) throw new Error('invalid_diary_timezone')
    const nowMs = new Date(now).getTime()
    if (!Number.isFinite(nowMs)) throw new Error('invalid_diary_now')
    // Only the actual local day in progress may be a partial backfill.
    // Never silently turn a requested future end date into today's end time.
    if (endDate > localDateAt(now, zone)) throw new Error('diary_period_not_ended')
    const periodStart = localDayStart(startDate, zone)
    const expectedEnd = localDayStart(addDays(endDate, 1), zone)
    let endMs = Date.parse(expectedEnd)
    if (allowPartialToday) endMs = Math.min(endMs, nowMs)
    if (Date.parse(periodStart) >= endMs || (!allowPartialToday && endMs > nowMs)) {
        throw new Error('diary_period_not_ended')
    }
    return { startDate, endDate, timeZone: zone,
        periodStart, periodEnd: new Date(endMs).toISOString(), days,
        partial: endMs < Date.parse(expectedEnd) }
}

module.exports = { MAX_BACKFILL_DAYS, validTimeZone, parseDate, addDays,
    localDayStart, localDateAt, getWindow }
