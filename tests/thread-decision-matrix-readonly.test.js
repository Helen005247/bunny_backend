'use strict'
const assert = require('node:assert/strict')
const test = require('node:test')
// Run tests from backend root. Test-only require loads the local backend dependencies.
const { readonlyDb, buildVariants, parseResult, balancedOrder, optsFromArgs } =
  require('../scripts/thread-decision-matrix-readonly.js')

test('readonly wrapper blocks direct and chained writes', () => {
  let wrote = false
  const builder = {
    select() { return this },
    eq() { return this },
    then(resolve) { resolve({data: [], error:null}) },
    insert() { wrote=true; return this },
    update() { wrote=true; return this },
    upsert() { wrote=true; return this },
    delete() { wrote=true; return this }
  }
  const db = readonlyDb({from() {return builder}})
  assert.throws(()=>db.from('x').insert({}), /READ_ONLY_BLOCKED/)
  assert.throws(()=>db.from('x').select().eq('a',1).update({}), /READ_ONLY_BLOCKED/)
  assert.throws(()=>db.from('x').upsert({}), /READ_ONLY_BLOCKED/)
  assert.throws(()=>db.from('x').delete(), /READ_ONLY_BLOCKED/)
  assert.equal(wrote, false)
  assert.equal(typeof db.rpc, 'undefined')
})

test('four variants do not rewrite source context', () => {
  const sample = [
    'Thread 是未来可以自然续想的真实主题，不是每条 Thought 的升级版；承诺、共同期待、理解变化或兴趣都可能有延续价值，不必是问题。一次性回味、聊天复述和偏好清单不必建 Thread。',
    'Thought 和 Thread 独立判断；没有真实后续就选 none，不编造计划或日期。create 的 current_draft 写当前想法，next_step 写未来留意的方向（可为 null）；next_review_at 无合理时间就为 null，遵守已有主题的去重与 eligibleThreads 限制。',
    '这里是虚拟的【真实资料】',
    '请只输出一个 JSON 对象（不要 Markdown 代码块）:',
    '{"should_store":false,"thread_action":{"type":"none"}}'
  ].join('\n\n')
  const prompts=buildVariants(sample)
  assert.equal(prompts.A, sample)
  assert.ok(prompts.B.includes('Thread 决策校准'))
  assert.ok(prompts.C.includes('未来观察'))
  assert.ok(!prompts.C.includes('Thread 决策校准'))
  assert.ok(prompts.D.includes('只执行 Thread 价值评估'))
  for (const prompt of Object.values(prompts)) assert.ok(prompt.includes('虚拟的【真实资料】'))
})

test('thread-only create parses and preflights without DB write', () => {
  const now = new Date('2026-11-17T12:00:00Z')
  const context = { available:true, eligible:[], known:[] }
  const valid = parseResult('D', JSON.stringify({
    thread_action:{type:'create',title:'一个话题',current_draft:'初步想法',next_step:null,next_review_at:null},
    thread_reason:'worth_continuing'
  }), now, context)
  assert.equal(valid.decision,'create')
  assert.equal(valid.valid,true)
  const unavailable = parseResult('D', JSON.stringify({
    thread_action:{type:'none'},thread_reason:'no_continuation_value'
  }), now, context)
  assert.equal(unavailable.decision,'none')
  assert.equal(parseResult('D','not-json',now,context).decision,'invalid')
})

test('balanced order rotates group positions', () => {
  const all = Array.from({length:4},(_,i)=>balancedOrder(i))
  assert.equal(new Set(all.map(x=>x.join())).size,4)
  for (const position of [0,1,2,3]) {
    assert.deepEqual(all.map(a=>a[position]).sort(),['A','B','C','D'])
  }
})

test('arguments require bounded repeat and one mode', () => {
  assert.deepEqual(optsFromArgs(['--inspect']).repeat,4)
  assert.throws(()=>optsFromArgs(['--compare','--repeat=11']))
  assert.throws(()=>optsFromArgs(['--inspect','--compare']))
})


test('formal Cognition parser treats Thought and Thread decisions independently', () => {
  const when = new Date('2026-11-17T12:00:00Z')
  const context = { available: true, eligible: [], known: [] }
  const base = {
    emotion: '平静', significance: 0.5, pending_topic: null, review_after: null
  }
  const thoughtOnly = parseResult('A', JSON.stringify({
    ...base, should_store: true, thought: '这件事情值得记住',
    thought_reason: 'worth_recording',
    thread_action: { type: 'none' },
    thread_reason: 'no_continuation_value'
  }), when, context)
  assert.equal(thoughtOnly.thought, 'store')
  assert.equal(thoughtOnly.decision, 'none')
  assert.equal(thoughtOnly.valid, true)

  const threadOnly = parseResult('A', JSON.stringify({
    ...base, should_store: false, thought: '',
    thought_reason: 'no_new_information',
    thread_action: {
      type: 'create', title: '有延续价值的主题',
      current_draft: '基于现有事实，仍值得以后重新观察',
      next_step: null, next_review_at: null
    },
    thread_reason: 'worth_continuing'
  }), when, context)
  assert.equal(threadOnly.thought, 'none')
  assert.equal(threadOnly.decision, 'create')
  assert.equal(threadOnly.valid, true)
})

test('four variants compile with the real formal Cognition prompt builder', () => {
  const { buildCognitionInput } = require('../services/cognition/cognitionService')
  const now = new Date('2026-11-17T12:00:00Z')
  const input = buildCognitionInput({
    now, state: { last_user_message_at: '2026-11-17T10:00:00Z',
      last_cognition_at: null, metadata: {} },
    wakeReasons: ['periodic_autonomous'], messages: [],
    settings: { system_prompt: '角色设定', character_context: '关系背景', timezone: 'UTC' },
    memory: null, milestones: null, recentThoughts: [],
    threadContext: {available: true, eligible: [], known: []},
    conversationReviewSummary: []
  })
  const prompts=buildVariants(input)
  assert.equal(prompts.A,input)
  assert.ok(prompts.A.includes('"should_store":false'))
  assert.ok(prompts.A.includes('"thread_action":{"type":"none"}'))
  assert.ok(prompts.B.includes('Thread 决策校准'))
  assert.ok(prompts.C.includes('未结束的理解变化'))
  assert.ok(prompts.D.includes('只执行 Thread 价值评估'))
  for (const value of Object.values(prompts)) assert.ok(value.length < 17500)
})
