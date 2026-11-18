'use strict'
// Offline validation of the comparison tool itself; no simulated Thread
// outcome, no provider calls, no user Thought data.
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const src = require('../scripts/thread-real-ab-readonly.js')
const { buildCognitionInput } = require('../services/cognition/cognitionService')
const now = new Date('2026-11-17T12:00:00.000Z')
function fields() {
    return {
        now, state: {
            last_user_message_at: '2026-11-17T10:00:00.000Z',
            absence_started_at: null, absence_checkpoint: 0,
            last_cognition_at: '2026-11-17T07:00:00.000Z',
            current_emotional_tone: '平静', pending_topic: null,
        }, wakeReasons: ['periodic_autonomous'], messages: [],
        settings: { timezone: 'Asia/Shanghai', system_prompt: 'character',
            character_context: 'role' }, memory: null, milestones: { text: '' },
        threadContext: { available: true, eligible: [], known: [] },
        conversationReviewSummary: [], previousCheckpoint: 0,
        characterLore: { context: '' }, storyLore: { context: '' },
    }
}
const thoughts = Array.from({length:8}, (_, i) => ({
    created_at: `2026-11-${String(17-i).padStart(2,'0')}T11:00:00.000Z`,
    content: `record${i}:` + '甲'.repeat(130),
}))
test('prompt differs only in previousThoughts field, no prompt instructions change', () => {
    const pair = src.makePair(buildCognitionInput, fields(), thoughts)
    assert.equal(pair.baselineCount, 3)
    assert.equal(pair.expandedCount, 8)
    assert.ok(pair.expandedChars > pair.baselineChars)
    const a = src.extractPromptData(pair.baseline).data.previousThoughts
    const b = src.extractPromptData(pair.expanded).data.previousThoughts
    assert.equal(a[0].text.length,80)
    assert.equal(b[0].text.length,138)
    assert.equal(b[7].text.length,138)
})
test('safe read-only wrapper does not expose writes or rpc', () => {
    const spy = []
    const wrapper = src.readOnlyClient({from(name) {
        spy.push(name)
        return {select(...args) { spy.push(args); return {maybeSingle() { return Promise.resolve({data: null,error:null}) }} } }
    }})
    assert.equal(typeof wrapper.rpc, 'undefined')
    assert.equal(typeof wrapper.from('x').insert, 'undefined')
    assert.equal(typeof wrapper.from('x').select, 'function')
    wrapper.from('x').select('id')
    assert.equal(spy[0], 'x')
})
test('normal formal none response is categorized correctly', () => {
    const payload = JSON.stringify({should_store:false,thought:'',thought_reason:'already_covered',
        emotion:'平静',significance:0.5,pending_topic:null,review_after:null,
        thread_action:{type:'none'},thread_reason:'no_continuation_value'})
    const result = src.inspectOutcome(payload,now,fields().threadContext)
    assert.equal(result.decision,'explicit_none')
    assert.equal(result.reason,'no_continuation_value')
    assert.equal(result.preflight,true)
})
test('formal create response must pass parser and preflight', () => {
    const payload = JSON.stringify({should_store:false,thought:'',thought_reason:'already_covered',
        emotion:'平静',significance:0.5,pending_topic:null,review_after:null,
        thread_action:{type:'create',title:'一条可以延续的思路',current_draft:'目前的想法',
            next_step:'以后继续想',next_review_at:null},thread_reason:'worth_continuing'})
    const result = src.inspectOutcome(payload,now,fields().threadContext)
    assert.equal(result.decision,'create')
    assert.equal(result.preflight,true)
})
