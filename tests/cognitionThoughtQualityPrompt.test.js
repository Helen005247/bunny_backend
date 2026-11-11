'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { buildCognitionInput, parseCognitionOutput } = require('../services/cognition/cognitionService')

const now = new Date('2026-11-11T12:00:00.000Z')
const common = {
    now,
    state: { last_user_message_at: '2026-11-11T11:45:00.000Z', absence_checkpoint: 0 },
    wakeReasons: ['manual'],
    settings: { timezone: 'Asia/Shanghai', system_prompt: '角色行为基线', character_context: '共同经历基线' },
    messages: [
        { role: 'user', at: '2026-11-11T11:40:00.000Z', text: '今天我很高兴', wasHidden: false },
        { role: 'assistant', at: '2026-11-11T11:41:00.000Z', text: '听你这么说，我也替你开心', wasHidden: false },
    ],
    conversationReviewSummary: ['有依据的共同回忆索引'],
    memory: { summary: '已保存的关系记忆' },
    threadContext: { available: true, eligible: [], known: [] },
}

test('Thought guidance separates role attention from chat paraphrase without prescribing an output template', () => {
    const prompt = buildCognitionInput(common)
    assert.match(prompt, /不是在为用户复述对话/)
    assert.match(prompt, /不必把整段聊天概括一遍/)
    assert.match(prompt, /回味一个片刻也可以/)
    assert.match(prompt, /不要求得出道理、纠正自己或制定计划/)
    assert.match(prompt, /仅仅改成第一人称也不算/)
    assert.match(prompt, /若没有属于本轮认知的关注、感受或延伸，就选择不保存/)
    assert.doesNotMatch(prompt, /第一类|第二类|第三类|按照以下步骤思考|必须按类型轮流/)
})

test('quality instructions preserve bounded real context and existing Thought/Thread JSON contract', () => {
    const prompt = buildCognitionInput(common)
    assert.match(prompt, /今天我很高兴/)
    assert.match(prompt, /有依据的共同回忆索引/)
    assert.match(prompt, /角色行为基线/)
    assert.match(prompt, /共同经历基线/)
    assert.match(prompt, /"should_store":false/)
    assert.match(prompt, /"thread_action":\{"type":"none"\}/)
    assert.match(prompt, /若 thoughtThreads\.available=false，thread_action 必须为 none/)
    assert.match(prompt, /不要编造新事实、用户承诺或未来已经发生的事情/)
    assert.ok(prompt.length < 17500)
})

test('nothing-to-save remains a valid model decision without a synthetic Thought or Thread', () => {
    const result = parseCognitionOutput(JSON.stringify({
        should_store: false,
        thought: '',
        thought_reason: 'already_covered',
        emotion: '平静',
        significance: 0.5,
        pending_topic: null,
        review_after: null,
        thread_action: { type: 'none' },
        thread_reason: 'no_continuation_value',
    }), now)
    assert.equal(result.shouldStore, false)
    assert.equal(result.thought, '')
    assert.equal(result.thoughtReason, 'already_covered')
    assert.equal(result.threadAction.type, 'none')
})
