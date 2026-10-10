'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const Module = require('node:module')
const {
    buildTimeContext, elapsedMinutes, findPreviousUserMessageAt,
    formatElapsed, getValidTimeZone,
} = require('../services/temporal/timeContext')

const NOW = new Date('2026-10-15T16:00:00Z')

test('Asia/Shanghai crosses UTC date boundary: 10/15 16:00Z is 10/16 midnight', () => {
    const result = buildTimeContext({ now: NOW, timeZone: 'Asia/Shanghai' })
    assert.equal(result.timeZone, 'Asia/Shanghai')
    assert.equal(result.localDateTime, '2026-10-16 00:00')
    assert.equal(result.weekday, '星期五')
    assert.equal(result.dayPart, '凌晨')
    assert.match(result.text, /用户当前本地时间：2026-10-16 00:00 星期五/)
})

test('LA 08:00 morning uses user timezone, not Render server locale', () => {
    const result = buildTimeContext({
        now: '2026-10-10T15:00:00Z', timeZone: 'America/Los_Angeles',
        currentUserMessageAt: '2026-10-10T14:59:59Z',
        previousUserMessageAt: '2026-10-10T14:49:59Z',
    })
    assert.equal(result.localDateTime, '2026-10-10 08:00')
    assert.equal(result.dayPart, '清晨 / 早上')
    assert.equal(result.elapsedMinutes, 10)
    assert.match(result.text, /本会话本条与上一条用户消息的间隔：10分钟/)
})

test('DST spring jump does not turn ten real minutes into 70', () => {
    const result = buildTimeContext({
        now: '2026-03-08T10:05:00Z', timeZone: 'America/Los_Angeles',
        currentUserMessageAt: '2026-03-08T10:05:00Z',
        previousUserMessageAt: '2026-03-08T09:55:00Z',
    })
    assert.equal(result.localDateTime, '2026-03-08 03:05')
    assert.equal(result.elapsedMinutes, 10)
})

test('bad or missing timezone never invents user local morning/evening', () => {
    for (const timeZone of [null, '', 'Mars/Olympus_Mons', 1]) {
        const result = buildTimeContext({ now: NOW, timeZone })
        assert.equal(result.timeZone, null)
        assert.equal(result.localDateTime, null)
        assert.equal(result.dayPart, null)
        assert.match(result.text, /用户时区未知/)
        assert.doesNotMatch(result.text, /当前时间段：/)
    }
    assert.equal(getValidTimeZone(' Asia/Shanghai '), 'Asia/Shanghai')
    assert.equal(getValidTimeZone('Not/A_Zone'), null)
})

test('duration gaps: missing, malformed, negative, minute/hour/day bounds', () => {
    assert.equal(elapsedMinutes(null, NOW), null)
    assert.equal(elapsedMinutes('not a date', NOW), null)
    assert.equal(elapsedMinutes(NOW, '2026-10-15T15:59:00Z'), null)
    assert.equal(elapsedMinutes('2026-10-15T15:59:01Z', NOW), 0)
    assert.equal(formatElapsed(0), '不到1分钟')
    assert.equal(formatElapsed(1), '1分钟')
    assert.equal(formatElapsed(59), '59分钟')
    assert.equal(formatElapsed(60), '1小时')
    assert.equal(formatElapsed(61), '1小时1分钟')
    assert.equal(formatElapsed(1440), '1天')
    assert.equal(formatElapsed(1440 + 60), '1天1小时')
    assert.equal(formatElapsed(-1), null)
    assert.throws(() => buildTimeContext({ now: 'broken' }), /now 时间无效/)
})

test('chat isolates preceding user message by ID, ignoring assistant and current message', () => {
    const current = { id: 200, role: 'user', created_at: '2026-10-10T15:00:00Z' }
    const history = [
        { id: 195, role: 'user', created_at: '2026-10-10T14:50:00Z' },
        { id: 196, role: 'assistant', created_at: '2026-10-10T14:59:00Z' },
        current,
        { id: 201, role: 'assistant', created_at: '2026-10-10T15:00:01Z' },
        { id: 202, role: 'user', created_at: '2026-10-10T15:10:00Z' },
    ]
    assert.equal(findPreviousUserMessageAt(history, current), '2026-10-10T14:50:00.000Z')
    assert.equal(findPreviousUserMessageAt([current], current), null)
    assert.equal(findPreviousUserMessageAt([], current), null)
    assert.equal(findPreviousUserMessageAt(history, { id: 200, created_at: 'bad date' }), null)
})

test('offline cognition gets same local clock and gap since last user message', () => {
    const result = buildTimeContext({
        now: NOW, timeZone: 'Asia/Shanghai', mode: 'cognition',
        lastUserMessageAt: '2026-10-15T04:00:00Z',
    })
    assert.equal(result.elapsedMinutes, 720)
    assert.match(result.text, /距离用户最后一条消息的时间：12小时/)
    assert.doesNotMatch(result.text, /本会话本条/)
})

test('offline cognition prompt actually includes shared time context', () => {
    // The upload is a delta ZIP: Step 2/3 persistence services live in the
    // deployed backend. Stub these unused imports to verify input creation.
    const originalLoad = Module._load
    try {
        Module._load = function(request, parent, isMain) {
            if (parent?.filename?.replace(/\\/g, '/').endsWith('/services/cognition/cognitionService.js')) {
                if (request === './runtimeStateService' || request === './thoughtService' ||
                    request === './wakeGate') return {}
            }
            return originalLoad.call(this, request, parent, isMain)
        }
        const { buildCognitionInput } = require('../services/cognition/cognitionService')
        const prompt = buildCognitionInput({
            now: NOW,
            state: { last_user_message_at: '2026-10-15T04:00:00Z',
                absence_checkpoint: 2 },
            wakeReasons: ['continued_absence'], messages: [],
            settings: { timezone: 'Asia/Shanghai' },
            memory: null, milestones: null, recentThoughts: [],
        })
        assert.match(prompt, /2026-10-16 00:00/)
        assert.match(prompt, /距离用户最后一条消息的时间：12小时/)
        assert.match(prompt, /未设置时区时，不推测当地早晚/)
    } finally {
        Module._load = originalLoad
    }
})
