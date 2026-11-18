'use strict'

// Thread decision matrix: actual database reads + model requests, never DB writes.
// Run only from the Hermit backend root. All variants share one frozen context snapshot.
// Official Cognition logic is imported (not rewritten) for prompt / parsing / preflight.

const path = require('node:path')
// Load external SDKs only when running the CLI, not when importing pure test helpers.

const {
  buildCognitionInput,
  getLatestUserMessage,
  parseCognitionOutput,
} = require('../services/cognition/cognitionService')
const {
  getRuntimeState,
} = require('../services/cognition/runtimeStateService')
const { getRecentThoughts } = require('../services/cognition/thoughtService')
const {
  loadThreadContext,
  parseThreadAction,
  preflightThreadAction,
} = require('../services/cognition/thoughtThreadCognition')
const { readCognitionConversation } = require('../services/cognition/conversationContextV2')
const { getMilestoneContext } = require('../services/milestones/milestoneContext')
const milestoneService = require('../services/milestones/milestoneService')
const milestoneMemoryBridge = require('../services/milestones/milestoneMemoryBridge')

const MODEL = 'gpt-5.6-sol'
const GROUPS = ['A', 'B', 'C', 'D']
const THREAD_REASON_CODES = new Set([
  'worth_continuing', 'already_tracked', 'no_continuation_value',
  'not_due', 'insufficient_context'
])

function readonlyDb(rawDb) {
  const blocked = new Set(['insert', 'update', 'upsert', 'delete', 'rpc'])
  const guard = (obj) => {
    if (obj === null || (typeof obj !== 'object' && typeof obj !== 'function')) return obj
    return new Proxy(obj, {
      get(target, key) {
        if (blocked.has(key)) {
          return () => { throw new Error('READ_ONLY_BLOCKED:' + String(key)) }
        }
        const v = Reflect.get(target, key, target)
        if (typeof v === 'function') {
          return (...args) => guard(v.apply(target, args))
        }
        return v
      }
    })
  }
  // Do not expose auth, storage, RPC, or any general client methods.
  return Object.freeze({ from(table) { return guard(rawDb.from(table)) } })
}

function mustReplace(text, before, after, label) {
  if (!text.includes(before)) throw new Error('源码 Prompt 结构已变化：' + label)
  return text.replace(before, after)
}

function buildVariants(original) {
  const exampleMarker = '请只输出一个 JSON 对象（不要 Markdown 代码块）:'
  if (!original.includes(exampleMarker)) throw new Error('未识别正式 Cognition 输出结构')

  // A = unchanged formal Cognition input, including existing default JSON example.
  const A = original

  // B isolates the effect of "none as default" anchoring; requirements unchanged.
  const B = mustReplace(
    original, exampleMarker,
    '【Thread 决策校准】下方 JSON 是字段格式示例，示例中的 none 不是预设答案。' +
    '请独立比较 none 与 create 的实际适用性；真实值得继续的主题可以创建，' +
    '没有明确延续价值仍必须选择 none。不得为了实验强制创建。\n\n' + exampleMarker,
    'B/default-anchor'
  )

  // C changes only the Thread significance threshold, without altering Thought rules.
  let C = mustReplace(
    original,
    'Thread 是未来可以自然续想的真实主题，不是每条 Thought 的升级版；承诺、共同期待、理解变化或兴趣都可能有延续价值，不必是问题。一次性回味、聊天复述和偏好清单不必建 Thread。',
    'Thread 可以保存有真实事实依据、以后值得自然再想一次的开放主题。' +
    '未结束的理解变化、关系中的持续观察、共同期待或兴趣，都可能成立；' +
    '不要求它已经跨越多条 Thought、不要求明确任务或截止日期。' +
    '纯粹一次性回味、聊天复述、偏好清单、已有结论或重复主题仍不应创建。',
    'C/thread-criteria-1'
  )
  C = mustReplace(
    C,
    'Thought 和 Thread 独立判断；没有真实后续就选 none，不编造计划或日期。create 的 current_draft 写当前想法，next_step 写未来留意的方向（可为 null）；next_review_at 无合理时间就为 null，遵守已有主题的去重与 eligibleThreads 限制。',
    'Thought 和 Thread 独立判断。Thread 有依据且存在可以说清的未来观察、疑问或重访方向时，' +
    '可以 create，即便现在没有具体行动计划；没有真实未来方向时选 none。' +
    '不编造用户承诺、计划或日期。create 的 current_draft 写当前想法，' +
    'next_step 写将来可能关注的方向（可以为 null）；next_review_at 没有合理时间就为 null。' +
    '严格遵守已有主题去重及 eligibleThreads 限制。',
    'C/thread-criteria-2'
  )

  // D changes only the decision *task*: an independent Thread-only model request.
  // Keep ALL original role and source-context blocks up to the output-schema marker.
  const prefix = original.slice(0, original.indexOf(exampleMarker))
  const D = prefix + [
    '本轮只执行 Thread 价值评估，不生成 Thought、情绪或状态更新。',
    '只依据上述真实资料，判断是否存在可在未来自然续想、尚未被已有 Thread 覆盖的真实主题。',
    '不要求有外部任务、严格时间表或必须出现多次；也不要强迫新建。',
    '若没有适合续想的主题，选择 none；已有 eligibleThreads 有真正进展时可选择 update 等合法动作。',
    '只输出 JSON 对象，不要 Markdown：',
    '{"thread_action":{"type":"none"},"thread_reason":"no_continuation_value"}',
    '上面的 none 仅为格式示例，不是预设答案。',
    'thread_reason 只能选 worth_continuing、already_tracked、no_continuation_value、not_due、insufficient_context。',
    'thread_action 的形式：{"type":"none"} 或',
    '{"type":"create","title":"简短标题","current_draft":"初步想法","next_step":null,"next_review_at":null}；',
    '若已有 eligibleThreads，可用 update / complete / abandon，但只可处理其 id。',
    '不能修改 otherKnownTopics，不得虚构事实、时间或承诺，next_review_at 没有合理时间应为 null。'
  ].join('\n\n')
  if ([A, B, C, D].some(p => p.length >= 17500))
    throw new Error('至少一组超过正式 Cognition 输入上限 17500 字符')
  return { A, B, C, D }
}

function parseResult(group, outputText, now, context) {
  let action, reason, thought = 'not_applicable'
  try {
    if (group === 'D') {
      const raw = String(outputText || '').trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'')
      const data = JSON.parse(raw)
      if (!data || typeof data !== 'object' || Array.isArray(data) ||
          !Object.hasOwn(data,'thread_action')) throw new Error('missing_thread_action')
      action = parseThreadAction(data.thread_action, now)
      reason = THREAD_REASON_CODES.has(data.thread_reason) ? data.thread_reason : 'unreported'
    } else {
      const parsed = parseCognitionOutput(outputText, now)
      if (parsed.threadActionInvalid) throw new Error('invalid_thread_action')
      if (!parsed.threadActionProvided) throw new Error('omitted_thread_action')
      action = parsed.threadAction
      reason = parsed.threadReason
      thought = parsed.shouldStore ? 'store' : 'none'
    }
    preflightThreadAction({ action, context })
    return { decision: action.type, reason, thought, valid: true, action }
  } catch (err) {
    return {
      decision: 'invalid', reason: 'invalid_or_unparseable', thought,
      valid: false, errorCode: err?.name || 'Error'
    }
  }
}

function balancedOrder(round) {
  const start = round % GROUPS.length
  return GROUPS.slice(start).concat(GROUPS.slice(0, start))
}

function optsFromArgs(args) {
  const inspect = args.includes('--inspect')
  const compare = args.includes('--compare')
  if (inspect === compare) throw new Error('指定 --inspect 或 --compare（只能选一个）')
  const repeatArg = args.find(x => x.startsWith('--repeat='))
  const repeat = repeatArg ? Number(repeatArg.split('=')[1]) : 4
  if (!Number.isSafeInteger(repeat) || repeat < 2 || repeat > 10)
    throw new Error('--repeat 必须在 2 到 10 之间')
  return { inspect, compare, repeat, showCandidates: args.includes('--show-candidates') }
}

async function checkedRows(query, label) {
  const { data, error } = await query
  if (error) throw new Error(label + ':' + String(error.code || error.message))
  return data
}

async function loadSnapshot(db, userId, now) {
  const agentId = 'star'
  const [state, latest] = await Promise.all([
    getRuntimeState({ supabase:db, userId, agentId }),
    getLatestUserMessage({ supabase:db, userId })
  ])
  if (!state || !latest?.session_id) throw new Error('缺少 Runtime State 或用户最新会话')

  // Direct SELECT avoids the production getGlobalSettings() auto-insert behavior.
  const [settings, memories, thoughts, threadContext, conversation, milestones] = await Promise.all([
    checkedRows(db.from('settings')
      .select('system_prompt, character_context, timezone')
      .eq('user_id',userId).eq('session_id','global').maybeSingle(), 'settings'),
    checkedRows(db.from('memories').select('summary')
      .eq('user_id',userId).eq('session_id','global')
      .order('timestamp',{ascending:false}).limit(1), 'memories'),
    getRecentThoughts({ supabase:db, userId, agentId, limit:12, now }),
    loadThreadContext({ supabase:db, userId, agentId, now }),
    readCognitionConversation({
      supabase:db, userId, agentId, sessionId: latest.session_id,
      latestUser: latest, metadata: state.metadata || {}, now
    }),
    getMilestoneContext({
      milestoneService, milestoneMemoryBridge, supabase:db,
      userId, agentId, days:30
    })
  ])
  if (!settings) throw new Error('缺少现有 settings；只读工具不会替你新建')
  if (!threadContext?.available) throw new Error('Thread Context 不可用；停止实验')
  if (!conversation?.latestUserAllowed) throw new Error('最近语音会话未通过身份过滤')
  const wakeReasons = ['periodic_autonomous'] // controlled choice; never calls Wake Gate
  const prompt = buildCognitionInput({
    now, state, wakeReasons, messages:conversation.recentMessages,
    settings, memory:(memories || [])[0] || null, milestones,
    recentThoughts: thoughts.slice(0,3), threadContext,
    conversationReviewSummary:conversation.reviewState?.summary || [],
    previousCheckpoint: state.absence_checkpoint ?? 0,
    characterLore:null, storyLore:null // dynamic selectors are server.js-private
  })
  return {
    prompt, context:threadContext, now,
    stats: {
      validThoughts:thoughts.length,
      recentMessages:conversation.recentMessages.length,
      summaryItems:conversation.reviewState?.summary?.length || 0,
      unreadRows:conversation.unreadRows.length,
      hasEligibleThread:threadContext.eligible.length > 0,
      promptLength:prompt.length,
      dynamicLore:'not_replayed'
    }
  }
}

async function main() {
  require('dotenv').config({ path: path.resolve(process.cwd(), '.env') })
  const OpenAI = require('openai')
  const { createClient } = require('@supabase/supabase-js')
  const options = optsFromArgs(process.argv.slice(2))
  for (const key of (options.compare
    ? ['SUPABASE_URL','SUPABASE_SECRET_KEY','AI_API_KEY','COGNITION_USER_ID']
    : ['SUPABASE_URL','SUPABASE_SECRET_KEY','COGNITION_USER_ID'])) {
    if (!process.env[key]) throw new Error('缺少环境变量：' + key)
  }
  const now = new Date()
  const raw = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {
    auth:{persistSession:false, autoRefreshToken:false}
  })
  const db = readonlyDb(raw)
  const snapshot = await loadSnapshot(db, process.env.COGNITION_USER_ID, now)
  const prompts = buildVariants(snapshot.prompt)
  console.log('Thread Decision Matrix | READ ONLY')
  console.log('snapshot:', JSON.stringify(snapshot.stats))
  console.log('groups:', GROUPS.map(x => x + '=' + prompts[x].length).join(' '))
  if (options.inspect) {
    console.log('检查完成；没有调用模型，也没有数据库写入。')
    return
  }
  const client = new OpenAI({
    apiKey:process.env.AI_API_KEY, baseURL:process.env.AI_BASE_URL || undefined,
    maxRetries:0, timeout:90000
  })
  const rows = []
  for (let round=0;round<options.repeat;round++) {
    for (const group of balancedOrder(round)) {
      let result
      try {
        const response = await client.responses.create({
          model:MODEL, input:prompts[group]
        }, { timeout:90000 })
        result = parseResult(group, response?.output_text, now, snapshot.context)
      } catch (err) {
        result = { decision:'model_error', reason:err?.name || 'error', thought:'unknown', valid:false }
      }
      rows.push({ round:round+1, group, decision:result.decision,
        reason:result.reason, thought:result.thought, valid:result.valid })
      console.log(`round=${round+1}; group=${group}; decision=${result.decision}; reason=${result.reason}; thought=${result.thought}; action_valid=${result.valid}`)
      if (options.showCandidates && result.decision === 'create') {
        // Private data may be present; printed ONLY on explicit opt-in.
        console.log('PRIVATE_CANDIDATE:', JSON.stringify(result.action))
      }
    }
  }
  console.log('\nAggregate by group (valid create is syntax/preflight, NOT quality or DB write):')
  for (const group of GROUPS) {
    const groupRows=rows.filter(x=>x.group===group)
    const count=key=>groupRows.filter(x=>x.decision===key).length
    console.log(`${group}: create=${count('create')}/${groupRows.length}; none=${count('none')}; invalid=${count('invalid')}; model_error=${count('model_error')}; thought_store=${groupRows.filter(x=>x.thought==='store').length}`)
  }
  console.log('VALID means parse + preflight only (create uniqueness/persistence NOT verified).')
  console.log('No database writes; no Thought/Thread/Runtime/Diary updates; model API charges apply.')
}

if (require.main === module) {
  main().catch(err => {
    console.error('Experiment halted:', err?.message || String(err))
    process.exitCode=1
  })
}

module.exports = { readonlyDb, buildVariants, parseResult, balancedOrder, optsFromArgs }
