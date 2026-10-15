'use strict'

// Background Cognition v2: handle Thought Thread decisions and, from Step 4,
// safely postpone due reviews that did not progress. No new heartbeat schedule,
// messages, Diary, or long-term memory writes.

const crypto = require('node:crypto')
const {
    createThoughtThread,
    listThoughtThreads,
    updateThoughtThread,
    completeThoughtThread,
    abandonThoughtThread,
} = require('./thoughtThreadService')

const MAX_ELIGIBLE = 6
const MAX_DUE_SCAN = 20
const MAX_RECENT_SCAN = 50
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MIN_REVIEW_DELAY_MS = 60 * 60 * 1000
const MAX_REVIEW_DELAY_MS = 30 * 24 * 60 * 60 * 1000
const IDLE_REVIEW_DELAY_MS = 24 * 60 * 60 * 1000

function boundedText(value, label, maxLength, { nullable = false, allowEmpty = false } = {}) {
    if (value === null && nullable) return null
    if (typeof value !== 'string' || value.length > maxLength) {
        throw new Error(`thread_action.${label} 必须是不超过 ${maxLength} 字符的字符串${nullable ? '或 null' : ''}`)
    }
    const result = value.trim()
    if (!allowEmpty && !result) {
        throw new Error(`thread_action.${label} 不能为空`)
    }
    return result
}

function modelThreadId(value) {
    const id = boundedText(value, 'thread_id', 36)
    if (!UUID_RE.test(id)) {
        throw new Error('thread_action.thread_id 必须是 UUID')
    }
    return id.toLowerCase()
}

function reviewTimestamp(value, now) {
    if (value === null) return null
    if (typeof value !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) {
        throw new Error('thread_action.next_review_at 必须是包含时区的 ISO 8601 时间或 null')
    }
    // Keep in sync with the calendar checks in the Step 2 storage service.
    const year = Number(value.slice(0, 4))
    const month = Number(value.slice(5, 7))
    const day = Number(value.slice(8, 10))
    if (year < 100 || month < 1 || month > 12 || day < 1 ||
        day > new Date(Date.UTC(year, month, 0)).getUTCDate()) {
        throw new Error('thread_action.next_review_at 日期无效')
    }
    const ms = Date.parse(value)
    if (!Number.isFinite(ms) ||
        ms < now.getTime() + MIN_REVIEW_DELAY_MS ||
        ms > now.getTime() + MAX_REVIEW_DELAY_MS) {
        throw new Error('thread_action.next_review_at 必须在当前时间后 1 小时至 30 天内')
    }
    return new Date(ms).toISOString()
}

function allowedFields(action, fields) {
    for (const key of Object.keys(action)) {
        if (!fields.includes(key)) {
            throw new Error(`thread_action 不支持字段: ${key}`)
        }
    }
}

function parseThreadAction(value, now = new Date()) {
    if (value === undefined || value === null) return { type: 'none' }
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        typeof value.type !== 'string') {
        throw new Error('thread_action 必须是含 type 的对象')
    }
    if (value.type === 'none') {
        allowedFields(value, ['type'])
        return { type: 'none' }
    }
    if (value.type === 'create') {
        allowedFields(value, ['type', 'title', 'current_draft', 'next_step', 'next_review_at'])
        return {
            type: 'create',
            title: boundedText(value.title, 'title', 160),
            currentDraft: boundedText(value.current_draft, 'current_draft', 3000),
            nextStep: value.next_step == null ? null :
                (boundedText(value.next_step, 'next_step', 1200,
                    { allowEmpty: true }) || null),
            nextReviewAt: value.next_review_at == null ? null :
                reviewTimestamp(value.next_review_at, now),
        }
    }
    if (value.type === 'update') {
        allowedFields(value, ['type', 'thread_id', 'current_draft', 'next_step', 'next_review_at'])
        const action = {
            type: 'update',
            threadId: modelThreadId(value.thread_id),
            currentDraft: boundedText(value.current_draft, 'current_draft', 3000),
        }
        if (Object.hasOwn(value, 'next_step')) {
            action.nextStep = value.next_step === null ? null :
                (boundedText(value.next_step, 'next_step', 1200,
                    { allowEmpty: true }) || null)
        }
        if (Object.hasOwn(value, 'next_review_at')) {
            action.nextReviewAt = reviewTimestamp(value.next_review_at, now)
        }
        return action
    }
    if (value.type === 'complete') {
        allowedFields(value, ['type', 'thread_id', 'result'])
        return {
            type: 'complete',
            threadId: modelThreadId(value.thread_id),
            result: boundedText(value.result, 'result', 6000),
        }
    }
    if (value.type === 'abandon') {
        allowedFields(value, ['type', 'thread_id'])
        return { type: 'abandon', threadId: modelThreadId(value.thread_id) }
    }
    throw new Error(`thread_action.type 不支持: ${value.type}`)
}

function topicIdentity(title) {
    return title.normalize('NFKC').toLocaleLowerCase('zh-CN')
        .replace(/[\p{P}\p{S}\s]+/gu, '')
}

function safeExcerpt(value, max) {
    return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

async function loadThreadContext({ supabase, userId, agentId, now }) {
    // Read only when the existing Wake Gate actually authorizes a tick.
    // Due items are prioritized even when recent unrelated drafts are numerous.
    const [due, recent] = await Promise.all([
        listThoughtThreads({ supabase, userId, agentId,
            dueBefore: now, limit: MAX_DUE_SCAN }),
        listThoughtThreads({ supabase, userId, agentId,
            status: 'all', limit: MAX_RECENT_SCAN }),
    ])
    const eligible = []
    const seen = new Set()
    for (const thread of [
        ...due,
        ...recent.filter((item) => item.status === 'open' &&
            (item.next_review_at === null ||
                Date.parse(item.next_review_at) <= now.getTime())),
    ]) {
        if (thread.status !== 'open' || seen.has(thread.id)) continue
        // Defensive: never resume a scheduled thread early, even if the DB
        // supplied an unexpected item in a due query.
        if (thread.next_review_at !== null &&
            !(Date.parse(thread.next_review_at) <= now.getTime())) continue
        eligible.push(thread)
        seen.add(thread.id)
        if (eligible.length >= MAX_ELIGIBLE) break
    }
    const known = [...recent, ...due].filter((item, index, all) =>
        all.findIndex((other) => other.id === item.id) === index)
    return { available: true, eligible, known }
}

function promptThreadContext(context) {
    if (!context?.available) {
        return { available: false, eligibleThreads: [], otherKnownTopics: [] }
    }
    const eligibleIds = new Set(context.eligible.map((row) => row.id))
    return {
        available: true,
        eligibleThreads: context.eligible.map((thread) => ({
            id: thread.id,
            version: thread.version,
            title: safeExcerpt(thread.title, 160),
            currentDraft: safeExcerpt(thread.current_draft, 3000),
            nextStep: safeExcerpt(thread.next_step, 800) || null,
            nextReviewAt: thread.next_review_at,
        })),
        // Titles only: not-yet-due or already-closed entries are NOT actionable.
        // This list helps avoid re-creating a topic with a new title.
        otherKnownTopics: context.known.filter((t) => !eligibleIds.has(t.id))
            .slice(0, 30).map((t) => ({
                title: safeExcerpt(t.title, 160),
                status: t.status,
                nextReviewAt: t.next_review_at,
            })),
    }
}

function assertEligibleThread(action, context) {
    if (!['update', 'complete', 'abandon'].includes(action.type)) return null
    const thread = context.eligible.find((entry) => entry.id === action.threadId)
    if (!thread) {
        // Never fetch/update an arbitrary model-supplied ID. It must come from
        // the read snapshot already scoped by both user_id and agent_id.
        throw new Error('thread_action.thread_id 不属于本轮允许继续的想法')
    }
    return thread
}

function createDedupeKey({ userId, agentId, sourceMessageId, title }) {
    // Keep repeat model calls and retries on the same message/topic idempotent.
    // No private message content is stored in the key.
    const hash = crypto.createHash('sha256')
        .update(JSON.stringify([userId, agentId, String(sourceMessageId), topicIdentity(title)]))
        .digest('hex')
    return `cog-v2s3:${hash}`
}

// A due review is an opportunity to revisit an existing draft. If no
// meaningful update happens, move its *schedule* forward one day, preserving
// all draft content and the open status. Never repeatedly wake on a past date.
function isDueThread(thread, now) {
    return thread?.status === 'open' && thread.next_review_at != null &&
        Number.isFinite(Date.parse(thread.next_review_at)) &&
        Date.parse(thread.next_review_at) <= now.getTime()
}

function nextIdleReview(now) {
    return new Date(now.getTime() + IDLE_REVIEW_DELAY_MS).toISOString()
}

async function deferUnadvancedDueThread({
    supabase, userId, agentId, wakeReasons, action, threadResult,
    context, now,
}) {
    if (!context?.available) {
        return { status: 'not_applicable', persisted: false }
    }
    const due = context.eligible.find((thread) => isDueThread(thread, now))
    if (!due) return { status: 'not_due', persisted: false }
    if (['update', 'complete', 'abandon'].includes(action.type) &&
        threadResult.persisted && context.eligible.some((thread) =>
            thread.id === action.threadId && isDueThread(thread, now))) {
        // At least one overdue draft was actually processed. Other due drafts
        // remain due for a later Heartbeat, rather than being hidden for a day.
        return { status: 'handled', persisted: false }
    }
    try {
        const changed = await updateThoughtThread({
            supabase, userId, agentId, threadId: due.id,
            expectedVersion: due.version, now,
            patch: { nextReviewAt: nextIdleReview(now) },
        })
        return { status: 'deferred', persisted: true, threadId: changed.id }
    } catch (error) {
        if (error?.code === 'THOUGHT_THREAD_CONFLICT') {
            // Another worker changed the draft, owner, or schedule. Never
            // overwrite it with our stale wake decision.
            return { status: 'conflict', persisted: false }
        }
        throw error
    }
}

function preflightThreadAction({ action, context }) {
    if (!context?.available || action.type === 'none') return
    assertEligibleThread(action, context)
}

async function persistThreadAction({
    supabase, userId, agentId, sourceMessageId, wakeReasons,
    action, context, now,
}) {
    if (!context?.available) return { status: 'unavailable', persisted: false }
    if (action.type === 'none') return { status: 'none', persisted: false }
    const args = { supabase, userId, agentId, now }
    try {
        if (action.type === 'create') {
            const match = context.known.find((t) =>
                topicIdentity(t.title) === topicIdentity(action.title) &&
                (t.status === 'open' ||
                    String(t.metadata?.source_message_id ?? t.metadata?.message_id ?? '') ===
                        String(sourceMessageId)))
            if (match) return { status: 'already_tracked', persisted: false }
            const result = await createThoughtThread({
                ...args, title: action.title,
                currentDraft: action.currentDraft, nextStep: action.nextStep,
                nextReviewAt: action.nextReviewAt,
                dedupeKey: createDedupeKey({ userId, agentId,
                    sourceMessageId, title: action.title }),
                metadata: { source: 'background_cognition_v2_step3',
                    source_message_id: String(sourceMessageId),
                    wake_reasons: wakeReasons.slice(0, 8) },
            })
            return { status: 'created', persisted: true, threadId: result.id }
        }
        const snapshot = assertEligibleThread(action, context)
        const target = { ...args, threadId: snapshot.id,
            expectedVersion: snapshot.version }
        if (action.type === 'update') {
            const patch = { currentDraft: action.currentDraft }
            if (Object.hasOwn(action, 'nextStep')) patch.nextStep = action.nextStep
            if (Object.hasOwn(action, 'nextReviewAt')) patch.nextReviewAt = action.nextReviewAt
            if (snapshot.current_draft === patch.currentDraft &&
                (!Object.hasOwn(patch, 'nextStep') || snapshot.next_step === patch.nextStep) &&
                (!Object.hasOwn(patch, 'nextReviewAt') ||
                    (snapshot.next_review_at === patch.nextReviewAt ||
                    (snapshot.next_review_at && patch.nextReviewAt &&
                    Date.parse(snapshot.next_review_at) === Date.parse(patch.nextReviewAt))))) {
                return { status: 'unchanged', persisted: false }
            }
            // When a due-triggered reflection changed a draft but omitted a
            // new schedule, don't leave the old (already-expired) review time.
            // An explicit nextReviewAt:null still clears scheduling instead.
            if (isDueThread(snapshot, now) &&
                !Object.hasOwn(patch, 'nextReviewAt')) {
                patch.nextReviewAt = nextIdleReview(now)
            }
            const result = await updateThoughtThread({ ...target, patch })
            return { status: 'updated', persisted: true, threadId: result.id }
        }
        if (action.type === 'complete') {
            const result = await completeThoughtThread({ ...target, result: action.result })
            return { status: 'completed', persisted: true, threadId: result.id }
        }
        const result = await abandonThoughtThread(target)
        return { status: 'abandoned', persisted: true, threadId: result.id }
    } catch (error) {
        if (error?.code === 'THOUGHT_THREAD_CONFLICT' ||
            error?.code === 'THOUGHT_THREAD_DEDUPE_CONFLICT') {
            // A second worker's version wins. Never overwrite newer material.
            return { status: 'conflict', persisted: false }
        }
        throw error
    }
}

module.exports = {
    deferUnadvancedDueThread,
    isDueThread,
    loadThreadContext,
    parseThreadAction,
    persistThreadAction,
    preflightThreadAction,
    promptThreadContext,
}
