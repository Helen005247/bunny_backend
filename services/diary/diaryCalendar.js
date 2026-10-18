'use strict'

// Calendar placement follows the diary's FIRST write, not the date of the
// events recalled within it. Revisions do not move an existing diary.
// Use each row's stored timezone; no browser/device timezone assumptions.
const YEAR_MIN = 2000
const YEAR_MAX = 2100

function parseMonthQuery(query) {
    const yearValue = query?.year
    const monthValue = query?.month
    const limitValue = query?.limit ?? '50'
    const offsetValue = query?.offset ?? '0'
    if (![yearValue, monthValue, limitValue, offsetValue].every(v =>
        typeof v === 'string' && /^\d{1,6}$/.test(v))) return null
    const year = Number(yearValue)
    const month = Number(monthValue)
    const limit = Number(limitValue)
    const offset = Number(offsetValue)
    if (year < YEAR_MIN || year > YEAR_MAX || month < 1 || month > 12 ||
        limit < 1 || limit > 50 || offset < 0 || offset > 100000) return null
    return { year, month, limit, offset }
}

function dateKeyInTimezone(instant, timezone) {
    if (typeof instant !== 'string' || !Number.isFinite(Date.parse(instant))) return null
    let formatter
    try {
        formatter = new Intl.DateTimeFormat('en-GB', {
            timeZone: typeof timezone === 'string' && timezone.trim() ? timezone : 'UTC',
            year: 'numeric', month: '2-digit', day: '2-digit',
        })
    } catch (_) {
        // Legacy entries without a valid IANA zone are not discarded.
        formatter = new Intl.DateTimeFormat('en-GB', {
            timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit',
        })
    }
    const parts = formatter.formatToParts(new Date(instant))
    const value = part => parts.find(p => p.type === part)?.value
    return `${value('year')}-${value('month')}-${value('day')}`
}

function monthUtcSearchBounds(year, month) {
    // Worldwide UTC offsets lie between UTC-12 and UTC+14. Cover the entire
    // requested local month before filtering each record's actual diary date.
    const startUtc = Date.UTC(year, month - 1, 1)
    const endUtc = Date.UTC(year, month, 1)
    return {
        start: new Date(startUtc - 14 * 60 * 60 * 1000).toISOString(),
        end: new Date(endUtc + 12 * 60 * 60 * 1000).toISOString(),
    }
}

function monthCalendarEntries(rows, year, month) {
    const prefix = `${year}-${String(month).padStart(2, '0')}-`
    return rows.map(row => ({
        id: row.id,
        title: row.title,
        created_at: row.created_at,
        updated_at: row.updated_at,
        diary_date: dateKeyInTimezone(row.created_at, row.timezone),
    })).filter(row => typeof row.diary_date === 'string' && row.diary_date.startsWith(prefix))
}

module.exports = { parseMonthQuery, dateKeyInTimezone,
    monthUtcSearchBounds, monthCalendarEntries }
