'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { buildCognitionInput, parseCognitionOutput } = require('../services/cognition/cognitionService')

const now = new Date('2026-11-11T12:00:00.000Z')
const input = {
    now,
    state: { last_user_message_at: '2026-11-11T11:45:00.000Z', absence_checkpoint: 0 },
    wakeReasons: ['manual'],
    messages: [{ role: 'user', text: '今天挺开心', at: '2026-11-11T11:40:00.000Z' }],
    settings: { timezone: 'Asia/Shanghai', system_prompt: '角色行为基线', character_context: '关系背景' },
    memory: { summary: '有依据的记忆' },
    conversationReviewSummary: ['历史聊天观察'],
    threadContext: { available: true, eligible: [], known: [] },
}

test('Thread guidance recognizes continuation without prescribing a fixed category or forcing create', () => {
    const prompt = buildCognitionInput(input)
    assert.match(prompt, /未来可以自然续想的真实主题/)
    assert.match(prompt, /不必是问题/)
    assert.match(prompt, /承诺、共同期待/)
    assert.match(prompt, /一次性回味、聊天复述/)
    assert.match(prompt, /没有真实后续/)
    assert.match(prompt, /next_review_at 无合理时间就为 null/)
    assert.doesNotMatch(prompt, /必须创建 Thread|必须从以下类型选择|按照以下步骤思考/)
})

test('existing Thought quality guidance and Thread update/dedup guards remain intact', () => {
    const prompt = buildCognitionInput(input)
    assert.match(prompt, /不是在为用户复述对话/)
    assert.match(prompt, /回味一个片刻也可以/)
    assert.match(prompt, /若没有属于本轮认知的关注、感受或延伸，就选择不保存/)
    assert.match(prompt, /优先考虑 eligibleThreads/)
    assert.match(prompt, /若 thoughtThreads\.available=false，thread_action 必须为 none/)
    assert.match(prompt, /next_review_at 如果非 null，必须包含时区/)
    assert.ok(prompt.length < 17500)
})

test('Thread can be created independently of Thought storage in existing JSON contract', () => {
    const result = parseCognitionOutput(JSON.stringify({
        should_store: false, thought: '', thought_reason: 'already_covered',
        emotion: '平静', significance: 0.5, pending_topic: null, review_after: null,
        thread_action: { type: 'create', title: '未来约定', current_draft: '已有确切约定，值得关注后续',
            next_step: '未来如果有真实进展再回看', next_review_at: null },
        thread_reason: 'worth_continuing',
    }), now)
    assert.equal(result.shouldStore, false)
    assert.equal(result.threadAction.type, 'create')
    assert.equal(result.threadAction.nextReviewAt, null)
    assert.equal(result.threadReason, 'worth_continuing')
})

test('declining both Thought and Thread remains a valid outcome', () => {
    const result = parseCognitionOutput(JSON.stringify({
        should_store: false, thought: '', thought_reason: 'no_new_information',
        significance: 0.5, thread_action: { type: 'none' },
        thread_reason: 'no_continuation_value',
    }), now)
    assert.equal(result.shouldStore, false)
    assert.equal(result.threadAction.type, 'none')
})
