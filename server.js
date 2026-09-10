require('dotenv').config()

const express = require('express')
const cors = require('cors')
const OpenAI = require('openai')
const { createClient } = require('@supabase/supabase-js')
const webpush = require('web-push')
const crypto = require('crypto')
const { DateTime } = require('luxon')



const app = express()
const PORT = process.env.PORT || 3000

app.use(cors())
app.use(express.json({ limit: '1mb' }))

const client = new OpenAI({
    apiKey: process.env.AI_API_KEY,
    baseURL: process.env.AI_BASE_URL,
})
// ======================================================
// Web Push / VAPID
// ======================================================

const VAPID_PUBLIC_KEY =
    process.env.VAPID_PUBLIC_KEY || ''

const VAPID_PRIVATE_KEY =
    process.env.VAPID_PRIVATE_KEY || ''

const VAPID_SUBJECT =
    process.env.VAPID_SUBJECT || ''


const pushConfigured =
    Boolean(
        VAPID_PUBLIC_KEY &&
        VAPID_PRIVATE_KEY &&
        VAPID_SUBJECT
    )


if (pushConfigured) {

    webpush.setVapidDetails(
        VAPID_SUBJECT,
        VAPID_PUBLIC_KEY,
        VAPID_PRIVATE_KEY
    )

} else {

    console.warn(
        'Web Push 尚未完整配置：请检查 VAPID_PUBLIC_KEY、VAPID_PRIVATE_KEY、VAPID_SUBJECT'
    )

}

let supabase = null

if (
    process.env.SUPABASE_URL &&
    process.env.SUPABASE_SECRET_KEY
) {
    supabase = createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_SECRET_KEY,
        {
            auth: {
                persistSession: false,
                autoRefreshToken: false,
            },
        }
    )
}


// ======================================================
// 基础工具
// ======================================================

function estimateTokens(text) {

    if (
        typeof text !== 'string' ||
        !text
    ) {
        return 0
    }

    const chineseCharacters =
        text.match(
            /[\u4e00-\u9fff]/g
        ) || []

    const otherText =
        text.replace(
            /[\u4e00-\u9fff]/g,
            ''
        )

    return (
        chineseCharacters.length +
        Math.ceil(
            otherText.length / 4
        )
    )
}


function parsePositiveSessionId(
    value
) {

    const id =
        Number(value)

    if (
        !Number.isInteger(id) ||
        id <= 0
    ) {
        return null
    }

    return id
}


function requireSupabase(res) {

    if (supabase) {
        return true
    }

    res.status(500).json({
        ok: false,
        error:
            'Supabase 客户端没有初始化',
    })

    return false
}


function requireAIConfig(res) {

    if (
        process.env.AI_API_KEY &&
        process.env.AI_BASE_URL
    ) {
        return true
    }

    res.status(500).json({
        ok: false,
        error:
            '服务器没有正确配置 AI_API_KEY 或 AI_BASE_URL',
    })

    return false
}

// ======================================================
// 验证 Supabase 登录 Token
// ======================================================

async function requireAuth(
    req,
    res,
    next
) {

    try {

        if (!supabase) {

            return res
                .status(500)
                .json({
                    ok: false,
                    error:
                        'Supabase 客户端没有初始化',
                })
        }

        const authorization =
            typeof req.headers
                .authorization ===
                'string'
                ? req.headers
                    .authorization
                    .trim()
                : ''

        if (
            !authorization.startsWith(
                'Bearer '
            )
        ) {

            return res
                .status(401)
                .json({
                    ok: false,
                    error:
                        '缺少登录 Token',
                })
        }

        const accessToken =
            authorization
                .slice(7)
                .trim()

        if (!accessToken) {

            return res
                .status(401)
                .json({
                    ok: false,
                    error:
                        '登录 Token 无效',
                })
        }

        const {
            data,
            error,
        } =
            await supabase
                .auth
                .getUser(
                    accessToken
                )

        if (
            error ||
            !data?.user?.id
        ) {

            return res
                .status(401)
                .json({
                    ok: false,
                    error:
                        '登录状态已失效，请重新登录',
                })
        }

        req.user =
            data.user

        req.userId =
            data.user.id

        return next()

    } catch (error) {

        console.error(
            '验证登录 Token 失败：',
            error
        )

        return res
            .status(401)
            .json({
                ok: false,
                error:
                    '登录验证失败',
            })
    }
}

// ======================================================
// 登录后才能访问的接口
// ======================================================

app.use(
    '/api/sessions',
    requireAuth
)

app.use(
    '/api/chat',
    requireAuth
)

app.use(
    '/api/settings',
    requireAuth
)

app.use(
    '/api/push/subscribe',
    requireAuth
)

app.use(
    '/api/push/unsubscribe',
    requireAuth
)

app.use(
    '/api/proactive-message',
    requireAuth
)

app.use(
    '/api/db-test',
    requireAuth
)


// ======================================================
// 模型请求自动重试
// ======================================================

function waitForRetry(ms) {
    return new Promise(
        (resolve) => {
            setTimeout(
                resolve,
                ms
            )
        }
    )
}


function getModelErrorStatus(error) {

    const rawStatus =
        error?.status ??
        error?.statusCode ??
        error?.response?.status ??
        null

    const status =
        Number(rawStatus)

    return Number.isFinite(status)
        ? status
        : null
}


function getModelErrorCode(error) {

    return String(
        error?.code ??
        error?.cause?.code ??
        error?.error?.code ??
        ''
    ).toUpperCase()
}


function isRetryableModelError(error) {

    if (
        error?.retryable ===
        true
    ) {
        return true
    }

    const status =
        getModelErrorStatus(
            error
        )

    if (
        status !== null
    ) {

        if (
            [
                408,
                429,
                500,
                502,
                503,
                504,
            ].includes(
                status
            )
        ) {
            return true
        }

        return status >= 500
    }

    const code =
        getModelErrorCode(
            error
        )

    return [
        'ETIMEDOUT',
        'ECONNRESET',
        'ECONNREFUSED',
        'EAI_AGAIN',
        'ENETUNREACH',
        'UND_ERR_CONNECT_TIMEOUT',
        'UND_ERR_HEADERS_TIMEOUT',
        'UND_ERR_SOCKET',
    ].includes(
        code
    )
}


async function callModelWithRetry(
    request,
    maxAttempts = 3
) {

    let lastError =
        null

    // ==================================================
    // 为当前请求生成唯一的内容指纹
    //
    // 相同输入会得到相同指纹；
    // 完全不同的请求几乎不可能得到同一个指纹。
    // ==================================================

    const originalInput =
        typeof request
            ?.input ===
            'string'
            ? request
                .input
            : null

    const integrityId =
        originalInput
            ? crypto
                .createHash(
                    'sha256'
                )
                .update(
                    originalInput
                )
                .digest(
                    'hex'
                )
                .slice(
                    0,
                    16
                )
            : null

    const integrityMarker =
        integrityId
            ? `<<HERMIT_OK_${integrityId}>>`
            : null


    // ==================================================
    // 在真正发送给模型的请求末尾加入校验标记
    //
    // 模型必须把这个标记原样带回来。
    // 后端确认以后会自动删除，
    // 用户永远看不到它。
    // ==================================================

    const guardedRequest =
        integrityMarker
            ? {
                ...request,

                input:
                    `${originalInput}

【响应完整性校验】
请正常完成上面的任务。
在全部正常输出结束后，另起一行，原样输出下面这段校验标记：
${integrityMarker}

不要解释这段标记，不要改写它，也不要把它放进正文中。服务端会在返回给用户前自动删除。`,
            }
            : request


    for (
        let attempt = 1;
        attempt <= maxAttempts;
        attempt += 1
    ) {

        try {

            const response =
                await client
                    .responses
                    .create(
                        guardedRequest
                    )

            const outputText =
                typeof response
                    ?.output_text ===
                    'string'
                    ? response
                        .output_text
                        .trim()
                    : ''


            // ------------------------------------------
            // 原来的空回复检查
            // ------------------------------------------

            if (!outputText) {

                const emptyError =
                    new Error(
                        '模型返回了空文本'
                    )

                emptyError.retryable =
                    true

                throw emptyError
            }


            // ------------------------------------------
            // 防串台检查
            //
            // 如果发出去的是本次请求，
            // 返回内容却没有本次唯一标记，
            // 就认为响应不可信并自动重试。
            // ------------------------------------------

            if (
                integrityMarker &&
                !outputText.includes(
                    integrityMarker
                )
            ) {

                const integrityError =
                    new Error(
                        `模型响应未通过完整性校验（${integrityId}）`
                    )

                integrityError.retryable =
                    true

                throw integrityError
            }


            // ------------------------------------------
            // 校验成功以后，把标记删除
            // ------------------------------------------

            const cleanedOutputText =
                integrityMarker
                    ? outputText
                        .split(
                            integrityMarker
                        )
                        .join(
                            ''
                        )
                        .trim()
                    : outputText


            if (
                !cleanedOutputText
            ) {

                const emptyAfterCheckError =
                    new Error(
                        '模型响应通过校验后正文为空'
                    )

                emptyAfterCheckError.retryable =
                    true

                throw emptyAfterCheckError
            }


            // ------------------------------------------
            // 返回干净正文
            // ------------------------------------------

            return {
                ...response,

                output_text:
                    cleanedOutputText,
            }


        } catch (error) {

            lastError =
                error

            const canRetry =
                isRetryableModelError(
                    error
                )

            if (
                !canRetry ||
                attempt >=
                maxAttempts
            ) {
                throw error
            }


            const delayMs =
                800 *
                (
                    2 **
                    (
                        attempt - 1
                    )
                )


            console.warn(
                `模型请求失败，${delayMs}ms 后重试（${attempt}/${maxAttempts}）：`,
                error?.message ||
                error
            )


            await waitForRetry(
                delayMs
            )
        }
    }


    throw (
        lastError ||
        new Error(
            '模型请求失败'
        )
    )
}



// ======================================================
// 读取当前用户设置
// ======================================================

async function getGlobalSettings(
    userId
) {

    if (!userId) {
        throw new Error(
            '读取 settings 时缺少 user_id'
        )
    }

    const fields = `
        id,
        user_id,
        session_id,
        system_prompt,
        character_context,
        timezone,
        temperature,
        max_context_rounds,
        max_context_tokens,
        compress_threshold,
        compress_keep_rounds,
        max_reply_tokens,
        hermit_avatar_url,
        user_avatar_url,
        background_url,
        updated_at
    `

    let {
        data,
        error,
    } = await supabase
        .from('settings')
        .select(fields)
        .eq(
            'user_id',
            userId
        )
        .eq(
            'session_id',
            'global'
        )
        .maybeSingle()

    if (error) {
        throw error
    }

    if (data) {
        return data
    }

    // 新用户第一次使用 Hermit 时自动创建一套独立设置。
    const {
        data: createdSettings,
        error: createError,
    } = await supabase
        .from('settings')
        .insert([
            {
                user_id:
                    userId,
                session_id:
                    'global',
            },
        ])
        .select(fields)
        .single()

    if (createError) {

        // 如果两个请求几乎同时初始化同一个用户，
        // 唯一索引可能让其中一个拿到 23505。
        // 这时重新读取即可。
        if (
            String(
                createError.code || ''
            ) === '23505'
        ) {

            const {
                data: existingSettings,
                error: retryError,
            } = await supabase
                .from('settings')
                .select(fields)
                .eq(
                    'user_id',
                    userId
                )
                .eq(
                    'session_id',
                    'global'
                )
                .maybeSingle()

            if (retryError) {
                throw retryError
            }

            if (existingSettings) {
                return existingSettings
            }
        }

        throw createError
    }

    return createdSettings
}


// ======================================================
// 读取当前用户最新长期记忆
// ======================================================

async function getLatestMemory(
    userId
) {

    if (!userId) {
        throw new Error(
            '读取 memories 时缺少 user_id'
        )
    }

    const {
        data,
        error,
    } = await supabase
        .from('memories')
        .select(
            'id, user_id, session_id, summary, timestamp, conversation_id, metadata'
        )
        .eq(
            'user_id',
            userId
        )
        .eq(
            'session_id',
            'global'
        )
        .order(
            'timestamp',
            {
                ascending: false,
            }
        )
        .limit(1)

    if (error) {
        throw error
    }

    if (
        !data ||
        data.length === 0
    ) {
        return null
    }

    return data[0]
}


// ======================================================
// 原作素材库：动态挑选少量 character_lore
//
// 普通聊天：最多 1 条高权重语感样本 + 1 条相关行为模式
// 剧情相关：在上面的基础上，最多再加入 2 条相关 lore
// 数据库读取失败时自动降级，不阻断聊天。
// ======================================================

const CHARACTER_LORE_CACHE_TTL_MS = 2 * 60 * 1000
const characterLoreCache = new Map()

function normalizeLoreText(value) {
    return String(value ?? '')
        .toLowerCase()
        .replace(/\s+/g, '')
}

function clipLoreText(value, maxLength) {
    const text = typeof value === 'string' ? value.trim() : ''

    if (!text || text.length <= maxLength) {
        return text
    }

    return `${text.slice(0, Math.max(1, maxLength - 1))}…`
}

function expandLoreConceptTerms(value) {
    const text = String(value ?? '')
    const terms = new Set()

    const rules = [
        {
            pattern: /吃|饭|饿|早餐|午餐|晚餐|夜宵|火锅|炸鸡|外卖|甜品|零食|做饭|餐厅|食物/,
            terms: ['食物', '吃饭', '生活', '日常'],
        },
        {
            pattern: /吃醋|嫉妒|醋意|前任|别人|比较|更喜欢|选谁|占有欲/,
            terms: ['吃醋', '占有欲', '偏爱', '特殊'],
        },
        {
            pattern: /家里|父母|妈妈|爸爸|逼我|强迫|必须|命令|不想|选择|决定|愿意|自由|想不想/,
            terms: ['自主选择', '尊重', '自由', '选择', '命令', '意愿'],
        },
        {
            pattern: /回家|到家|回来了|同居|靠一会|抱抱|拥抱|想你|陪我|陪着/,
            terms: ['回家', '同居', '自然亲密', '依赖', '长期伴侣'],
        },
        {
            pattern: /维修|修理|坏了|扳手|工具|保养|修东西/,
            terms: ['维修', '搭档', '偏爱', '日常'],
        },
        {
            pattern: /烟花|邻居|最特殊|普通邻居|特殊位置/,
            terms: ['烟花', '亲密', '占有欲', '特殊', '恋爱'],
        },
        {
            pattern: /离开|分别|带我走|跟你走|同行|等我|等你|时空|星球/,
            terms: ['分别', '同行', '耐心', '选择', '信任', '时空', '星球'],
        },
    ]

    for (const rule of rules) {
        if (!rule.pattern.test(text)) {
            continue
        }

        for (const term of rule.terms) {
            terms.add(normalizeLoreText(term))
        }
    }

    return [...terms]
}

function extractLoreTerms(value) {
    const source = String(value ?? '').toLowerCase()
    const terms = new Set(expandLoreConceptTerms(source))

    const ignored = new Set([
        '我们', '你们', '他们', '她们', '这个', '那个',
        '这些', '那些', '什么', '怎么', '可以', '还是',
        '已经', '就是', '真的', '觉得', '一下', '现在',
        '今天', '然后', '因为', '所以', '但是', '如果',
        '一个', '一点', '时候', '自己',
    ])

    for (const word of source.match(/[a-z0-9_-]{3,}/g) || []) {
        terms.add(word)
    }

    for (const chunk of source.match(/[\u4e00-\u9fff]{2,}/g) || []) {
        const clean = normalizeLoreText(chunk)

        if (clean.length >= 2 && clean.length <= 8 && !ignored.has(clean)) {
            terms.add(clean)
        }

        for (const size of [2, 3, 4]) {
            for (let index = 0; index <= clean.length - size; index += 1) {
                const term = clean.slice(index, index + size)

                if (!ignored.has(term)) {
                    terms.add(term)
                }

                if (terms.size >= 80) {
                    return [...terms]
                }
            }
        }
    }

    return [...terms]
}

function getLoreFields(item) {
    return {
        title: normalizeLoreText(item?.title),
        source: normalizeLoreText(item?.source),
        timeline: normalizeLoreText(item?.timeline),
        scene: normalizeLoreText(item?.scene),
        tags: Array.isArray(item?.tags)
            ? item.tags.map((tag) => normalizeLoreText(tag))
            : [],
        summary: normalizeLoreText(item?.summary),
        content: normalizeLoreText(item?.content),
    }
}

function scoreLoreItem(item, terms, multiplier = 1) {
    if (!Array.isArray(terms) || terms.length === 0) {
        return 0
    }

    const fields = getLoreFields(item)
    let score = 0

    for (const rawTerm of terms.slice(0, 80)) {
        const term = normalizeLoreText(rawTerm)

        if (!term || term.length < 2) {
            continue
        }

        let best = 0

        if (fields.source === term || fields.source.includes(term)) {
            best = Math.max(best, 7)
        }

        if (fields.title.includes(term)) {
            best = Math.max(best, 6)
        }

        if (
            fields.tags.some(
                (tag) =>
                    tag === term ||
                    tag.includes(term) ||
                    (term.length >= 3 && term.includes(tag))
            )
        ) {
            best = Math.max(best, 8)
        }

        if (fields.timeline.includes(term)) {
            best = Math.max(best, 5)
        }

        if (fields.scene.includes(term)) {
            best = Math.max(best, 4)
        }

        if (fields.summary.includes(term)) {
            best = Math.max(best, 3)
        }

        if (fields.content.includes(term)) {
            best = Math.max(best, 2)
        }

        score += best * multiplier
    }

    return score
}

function neutralVoiceScore(item) {
    if (item?.type !== 'voice_sample') {
        return -Infinity
    }

    const fields = getLoreFields(item)
    let score = Number(item.priority) || 0

    for (const hint of ['日常', '自然', '偏爱', '长期', '生活', '搭档', '亲密']) {
        const normalizedHint = normalizeLoreText(hint)

        if (
            fields.tags.some((tag) => tag.includes(normalizedHint)) ||
            fields.summary.includes(normalizedHint)
        ) {
            score += 1.5
        }
    }

    for (const hint of ['吃醋', '嫉妒', '占有欲', '愤怒', '争吵']) {
        const normalizedHint = normalizeLoreText(hint)

        if (
            fields.tags.some((tag) => tag.includes(normalizedHint)) ||
            fields.summary.includes(normalizedHint)
        ) {
            score -= 4
        }
    }

    if (item?.metadata && typeof item.metadata === 'object' && item.metadata.emotion) {
        score -= 3
    }

    return score
}

async function getActiveCharacterLore(userId) {
    if (!userId || !supabase) {
        return []
    }

    const cached = characterLoreCache.get(userId)
    const now = Date.now()

    if (cached && now - cached.loadedAt < CHARACTER_LORE_CACHE_TTL_MS) {
        return cached.rows
    }

    const { data, error } = await supabase
        .from('character_lore')
        .select(
            'id, user_id, character_name, title, source, timeline, scene, type, tags, summary, content, priority, active, metadata, updated_at'
        )
        .eq('user_id', userId)
        .eq('active', true)
        .order('priority', { ascending: false })
        .limit(200)

    if (error) {
        throw error
    }

    const rows = Array.isArray(data) ? data : []

    characterLoreCache.set(userId, {
        loadedAt: now,
        rows,
    })

    if (characterLoreCache.size > 100) {
        const oldestKey = characterLoreCache.keys().next().value

        if (oldestKey) {
            characterLoreCache.delete(oldestKey)
        }
    }

    return rows
}

function formatCharacterLoreItem(item) {
    const typeLabel =
        item.type === 'voice_sample'
            ? '语感样本'
            : item.type === 'behavior'
                ? '行为模式'
                : '剧情事实'

    const lines = [
        `【${typeLabel}｜${item.title}】`,
        `来源：${item.source}`,
    ]

    if (item.scene) {
        lines.push(`场景：${item.scene}`)
    }

    if (Array.isArray(item.tags) && item.tags.length > 0) {
        lines.push(`标签：${item.tags.slice(0, 8).join('、')}`)
    }

    const summary = clipLoreText(item.summary, 280)
    const content = clipLoreText(
        item.content,
        item.type === 'lore' ? 560 : 420
    )

    if (summary) {
        lines.push(`提炼：${summary}`)
    }

    if (content) {
        lines.push(`参考：${content}`)
    }

    return lines.join('\n')
}

async function getCharacterLoreContext({
    userId,
    currentMessage = '',
    recentMessages = [],
}) {
    let rows = []

    try {
        rows = await getActiveCharacterLore(userId)
    } catch (error) {
        console.warn(
            '读取 character_lore 失败，本轮继续使用基础上下文：',
            error?.message || error
        )

        return {
            context: '',
            selected: [],
        }
    }

    if (rows.length === 0) {
        return {
            context: '',
            selected: [],
        }
    }

    const recentText = (recentMessages || [])
        .slice(-8)
        .map((item) => String(item?.content || ''))
        .join('\n')

    const currentTerms = extractLoreTerms(currentMessage)
    const recentTerms = extractLoreTerms(recentText)

    const storyIntent =
        /剧情|设定|原作|以前|过去|曾经|当时|那次|那时候|经历|身份|世界观|时间线|为什么会|发生过|还记得|记不记得|王储|女王|师门|师兄|光猎|菲罗斯|异星|时空/
            .test(`${currentMessage}\n${recentText}`)

    const scored = rows
        .map((item) => {
            const relevance =
                scoreLoreItem(item, currentTerms, 1) +
                scoreLoreItem(item, recentTerms, 0.35)

            return {
                item,
                relevance,
                rank: relevance + (Number(item.priority) || 0) * 0.18,
            }
        })
        .sort((left, right) => right.rank - left.rank)

    const selected = []
    const selectedIds = new Set()

    const addItem = (item) => {
        if (!item || selectedIds.has(item.id)) {
            return
        }

        selectedIds.add(item.id)
        selected.push(item)
    }

    const relatedVoice = scored.find(
        (entry) =>
            entry.item.type === 'voice_sample' &&
            entry.relevance >= 4
    )

    if (relatedVoice) {
        addItem(relatedVoice.item)
    } else {
        const neutralVoice = rows
            .filter((item) => item.type === 'voice_sample')
            .sort((left, right) => neutralVoiceScore(right) - neutralVoiceScore(left))[0]

        addItem(neutralVoice)
    }

    const relatedBehavior = scored.find(
        (entry) =>
            entry.item.type === 'behavior' &&
            entry.relevance >= 6
    )

    if (relatedBehavior) {
        addItem(relatedBehavior.item)
    }

    const relatedLore = scored
        .filter(
            (entry) =>
                entry.item.type === 'lore' &&
                (
                    entry.relevance >= 10 ||
                    (storyIntent && entry.relevance >= 4)
                )
        )
        .slice(0, 2)

    for (const entry of relatedLore) {
        addItem(entry.item)
    }

    const budgeted = []
    let usedTokens = 0

    for (const item of selected) {
        const block = formatCharacterLoreItem(item)
        const itemTokens = estimateTokens(block)

        if (budgeted.length > 0 && usedTokens + itemTokens > 1700) {
            continue
        }

        budgeted.push(item)
        usedTokens += itemTokens
    }

    if (budgeted.length === 0) {
        return {
            context: '',
            selected: [],
        }
    }

    const materialText = budgeted
        .map((item) => formatCharacterLoreItem(item))
        .join('\n\n')

    return {
        selected: budgeted,
        context: `【按当前对话动态选取的原作参考素材】
下面只是一小组与当前聊天相关的原作参考，不是要逐句复述的台词库。

使用规则：
1. “语感样本”只学习表达节奏、反应方式和亲密感，不要照抄原句，也不要无缘无故复现场景。
2. “行为模式”只约束相似情境里的选择和反应，不需要主动解释这条规则。
3. “剧情事实”只作为已经发生过的事实或世界观依据；只有当前话题相关时才自然使用。
4. 不要为了证明你记得原作而主动报出卡名、来源、标签或内部分类。
5. 如果素材与当前消息关系很弱，以当前聊天、固定人物设定和长期记忆为准，不要硬套素材。

${materialText}`,
    }
}


// ======================================================
// 获取指定会话
// ======================================================

async function getSessionById(
    sessionId,
    userId = null
) {

    let query =
        supabase
            .from('sessions')
            .select(
                'id, name, created_at, updated_at, user_id'
            )
            .eq(
                'id',
                sessionId
            )

    if (userId) {

        query =
            query.eq(
                'user_id',
                userId
            )
    }

    const {
        data,
        error,
    } =
        await query
            .maybeSingle()

    if (error) {
        throw error
    }

    return data
}


async function getSessionOwnerId(
    sessionId
) {

    const session =
        await getSessionById(
            sessionId
        )

    if (
        !session ||
        !session.user_id
    ) {
        throw new Error(
            `Session ${sessionId} 没有有效的 user_id`
        )
    }

    return session.user_id
}

// ======================================================
// 读取指定 session 的全部可见消息
// ======================================================

async function getVisibleMessages(
    sessionId
) {

    const {
        data,
        error,
    } = await supabase
        .from('messages')
        .select(
            'id, session_id, role, content, created_at, visible'
        )
        .eq(
            'session_id',
            sessionId
        )
        .eq(
            'visible',
            true
        )
        .in(
            'role',
            [
                'user',
                'assistant',
            ]
        )
        .order(
            'created_at',
            {
                ascending: true,
            }
        )
        .order(
            'id',
            {
                ascending: true,
            }
        )

    if (error) {
        throw error
    }

    return data || []
}


// ======================================================
// 消息转换成模型可读文本
// ======================================================

function messagesToText(
    messages
) {

    return (
        messages || []
    )
        .map(
            (item) => {

                const speaker =
                    item.role === 'user'
                        ? '用户'
                        : '助手'

                return (
                    `${speaker}：${item.content}`
                )
            }
        )
        .join('\n')
}


// ======================================================
// 找出要压缩的旧消息
// ======================================================

function splitMessagesForCompression(
    messages,
    keepRounds
) {

    const userIndexes = []

    messages.forEach(
        (
            message,
            index
        ) => {

            if (
                message.role ===
                'user'
            ) {
                userIndexes.push(
                    index
                )
            }

        }
    )

    if (
        userIndexes.length <=
        keepRounds
    ) {

        return {

            compressibleMessages:
                [],

            keptMessages:
                messages,

        }
    }

    const keepStartIndex =
        userIndexes[
        userIndexes.length -
        keepRounds
        ]

    return {

        compressibleMessages:
            messages.slice(
                0,
                keepStartIndex
            ),

        keptMessages:
            messages.slice(
                keepStartIndex
            ),

    }
}


// ======================================================
// 构建普通聊天上下文
// ======================================================

function buildModelContext({
    settings,
    memorySummary,
    messages,
    characterLoreContext = '',
}) {

    const systemPrompt =
        typeof settings
            ?.system_prompt ===
            'string'
            ? settings
                .system_prompt
                .trim()
            : ''

    const characterContext =
        typeof settings
            ?.character_context ===
            'string'
            ? settings
                .character_context
                .trim()
            : ''

    const historyText =
        messagesToText(
            messages
        )

    const sections = []

    if (systemPrompt) {

        sections.push(
            `【最高优先级：角色行为规则】
${systemPrompt}`
        )

    }

    if (characterContext) {

        sections.push(
            `【固定人物设定、关系背景与共同经历】
以下内容属于角色和用户之间已经确定的稳定背景。
请把这些内容视为既有事实，自然地体现在回答中，不要机械复述。

${characterContext}`
        )

    }

    if (
        typeof characterLoreContext ===
            'string' &&
        characterLoreContext.trim()
    ) {

        sections.push(
            characterLoreContext.trim()
        )

    }

    if (memorySummary) {

        sections.push(
            `【聊天过程中形成的长期记忆】
${memorySummary}`
        )

    }

    if (historyText) {

        sections.push(
            `【当前会话最近聊天】
${historyText}`
        )

    }

    sections.push(
        `【当前回复要求】
请直接回复最近一条用户消息。

要求：
要求：
1. 遵守角色行为规则。
2. 与固定人物背景和共同经历保持一致。
3. 在相关时自然运用长期记忆。
4. 保持当前对话自然连贯。
5. 不要向用户暴露这些内部上下文标签。
6. 只处理当前上下文中明确存在的人名、称呼、文件和任务。不要自行假设用户上传了文件、交代了新的身份或称呼，也不要继续一个当前上下文中根本不存在的任务。`

    )

    return sections.join(
        '\n\n'
    )
}


// ======================================================
// 获取最大历史消息数
// ======================================================

function getMaxHistoryMessages(
    settings
) {

    const raw =
        Number(
            settings
                ?.max_context_rounds
        )

    const rounds =
        Number.isFinite(raw) &&
            raw > 0
            ? Math.floor(raw)
            : 20

    return Math.max(
        2,
        rounds * 2
    )
}


// ======================================================
// 读取最近可见消息
// ======================================================

async function getRecentVisibleMessages(
    sessionId,
    settings
) {

    const maxHistoryMessages =
        getMaxHistoryMessages(
            settings
        )

    const {
        data,
        error,
    } = await supabase
        .from('messages')
        .select(
            'id, role, content, created_at'
        )
        .eq(
            'session_id',
            sessionId
        )
        .eq(
            'visible',
            true
        )
        .in(
            'role',
            [
                'user',
                'assistant',
            ]
        )
        .order(
            'created_at',
            {
                ascending: false,
            }
        )
        .order(
            'id',
            {
                ascending: false,
            }
        )
        .limit(
            maxHistoryMessages
        )

    if (error) {
        throw error
    }

    return Array.isArray(
        data
    )
        ? [
            ...data,
        ].reverse()
        : []
}


// ======================================================
// 自动记忆压缩
// ======================================================

async function compressMemoryIfNeeded(
    sessionId,
    settings,
    userId
) {

    if (!userId) {
        throw new Error(
            '记忆压缩缺少 user_id'
        )
    }

    const previousMemory =
        await getLatestMemory(
            userId
        )

    const previousMemorySummary =
        typeof previousMemory
            ?.summary ===
            'string'
            ? previousMemory
                .summary
                .trim()
            : ''

    const visibleMessages =
        await getVisibleMessages(
            sessionId
        )

    const compressThreshold =
        Number(
            settings
                ?.compress_threshold
        ) || 10000

    const keepRounds =
        Math.max(
            1,
            Number(
                settings
                    ?.compress_keep_rounds
            ) || 6
        )

    // ==================================================
    // 先区分：
    //
    // 1. 已经可以进入长期记忆的旧聊天
    // 2. 必须继续保留的最近聊天
    //
    // 只有“旧聊天”参与压缩阈值计算。
    // 系统提示词、人物背景、长期记忆、
    // 最近保留的聊天都不会让压缩反复触发。
    // ==================================================

    const {
        compressibleMessages,
        keptMessages,
    } =
        splitMessagesForCompression(
            visibleMessages,
            keepRounds
        )

    if (
        compressibleMessages
            .length === 0
    ) {

        return {

            triggered:
                false,

            reason:
                'not_enough_old_messages',

            before_tokens:
                0,

            after_tokens:
                0,

            compressed_message_count:
                0,

            memory_id:
                previousMemory
                    ?.id ||
                null,

        }
    }

    // ==================================================
    // 只统计真正准备压缩的旧聊天
    // ==================================================

    const oldConversationText =
        messagesToText(
            compressibleMessages
        )

    const beforeTokens =
        estimateTokens(
            oldConversationText
        )

    if (
        beforeTokens <
        compressThreshold
    ) {

        return {

            triggered:
                false,

            reason:
                'below_threshold',

            before_tokens:
                beforeTokens,

            after_tokens:
                beforeTokens,

            compressed_message_count:
                0,

            memory_id:
                previousMemory
                    ?.id ||
                null,

        }
    }

    // ==================================================
    // 真正达到阈值以后才调用模型整理长期记忆
    // ==================================================

    const compressionInput =
        `你是一个长期记忆整理器。

请把已有长期记忆和旧聊天合并成一份简洁的累计长期记忆。

【已有长期记忆】
${previousMemorySummary ||
        '目前没有已有长期记忆。'
        }

【需要整理的旧聊天】
${oldConversationText}

【规则】

1. 只保留未来聊天真正长期有价值的信息。
2. 保留人物关系、重要经历、偏好、习惯、承诺、长期计划和重要情绪事件。
3. 删除寒暄、重复内容和已经没有意义的临时细节。
4. 技术内容只保留长期项目、最终架构和已经确定的重要结果；不要保存代码、具体行号、报错日志和临时调试过程。
5. 已经解决的一次性问题不要保留。
6. 不要保存 API Key、密码、Token、私钥或其他秘密值。
7. 新信息明确更新旧信息时，以新信息为准。
8. 不要编造不存在的事实。
9. 尽量控制在约 1500～2000 个中文字符以内。
10. 只输出长期记忆正文，不要解释，不要输出 JSON。`



    const compressionResponse =
        await callModelWithRetry({

            model:
                'gpt-5.6-sol',

            input:
                compressionInput,

        })


    const newSummary =
        typeof compressionResponse
            .output_text ===
            'string'
            ? compressionResponse
                .output_text
                .trim()
            : ''

    if (!newSummary) {

        throw new Error(
            '记忆压缩模型没有返回有效摘要'
        )

    }

    const compressedMessageIds =
        compressibleMessages
            .map(
                (
                    message
                ) =>
                    message.id
            )

    const {
        data:
        newMemory,

        error:
        memoryInsertError,
    } =
        await supabase
            .from(
                'memories'
            )
            .insert([
                {

                    user_id:
                        userId,

                    session_id:
                        'global',

                    summary:
                        newSummary,

                    timestamp:
                        new Date()
                            .toISOString(),

                    conversation_id:
                        String(
                            sessionId
                        ),

                    metadata: {

                        type:
                            'conversation_compression',

                        source_session_id:
                            sessionId,

                        previous_memory_id:
                            previousMemory
                                ?.id ||
                            null,

                        compressed_message_ids:
                            compressedMessageIds,

                        compressed_message_count:
                            compressedMessageIds
                                .length,

                    },

                },
            ])
            .select(
                'id, session_id, summary, timestamp, conversation_id, metadata'
            )
            .single()

    if (
        memoryInsertError
    ) {
        throw memoryInsertError
    }

    const {
        error:
        hideMessagesError,
    } =
        await supabase
            .from(
                'messages'
            )
            .update({
                visible:
                    false,
            })
            .in(
                'id',
                compressedMessageIds
            )
            .eq(
                'user_id',
                userId
            )

    if (
        hideMessagesError
    ) {
        throw hideMessagesError
    }

    const keptMessagesText =
        messagesToText(
            keptMessages
        )

    const afterTokens =
        estimateTokens(
            keptMessagesText
        )

    console.log(
        `Session ${sessionId} 已执行记忆压缩：${compressedMessageIds.length} 条消息；待压缩旧消息 Token ${beforeTokens}；保留近期消息 Token ${afterTokens}`
    )

    return {

        triggered:
            true,

        reason:
            'compressed',

        before_tokens:
            beforeTokens,

        after_tokens:
            afterTokens,

        compressed_message_count:
            compressedMessageIds
                .length,

        compressed_message_ids:
            compressedMessageIds,

        memory_id:
            newMemory.id,

    }
}



// ======================================================
// 主动消息：时间与多样性工具
// ======================================================

function getValidTimeZone(
    value
) {

    const timeZone =
        typeof value ===
            'string'
            ? value.trim()
            : ''

    if (!timeZone) {
        return null
    }

    try {

        new Intl.DateTimeFormat(
            'en-US',
            {
                timeZone,
            }
        ).format(
            new Date()
        )

        return timeZone

    } catch (
    error
    ) {

        return null

    }
}


function getDayPart(
    hour
) {

    if (
        hour >= 5 &&
        hour <= 8
    ) {
        return '清晨 / 早上'
    }

    if (
        hour >= 9 &&
        hour <= 11
    ) {
        return '上午'
    }

    if (
        hour >= 12 &&
        hour <= 13
    ) {
        return '中午'
    }

    if (
        hour >= 14 &&
        hour <= 17
    ) {
        return '下午'
    }

    if (
        hour >= 18 &&
        hour <= 21
    ) {
        return '晚上'
    }

    if (
        hour >= 22
    ) {
        return '深夜'
    }

    return '凌晨'
}


// ======================================================
// 构造用户当前本地时间
// ======================================================

function buildUserLocalTimeContext(
    settings
) {

    const timeZone =
        getValidTimeZone(
            settings
                ?.timezone
        )

    if (!timeZone) {

        return [
            '用户时区尚未设置。',
            '本次不要自行判断用户现在是早晨、中午、晚上或凌晨。',
            '也不要编造与当前昼夜相关的活动。',
        ].join('\n')

    }


    const now =
        new Date()


    const hourText =
        new Intl
            .DateTimeFormat(
                'en-US',
                {
                    timeZone,
                    hour:
                        '2-digit',
                    hourCycle:
                        'h23',
                }
            )
            .format(
                now
            )


    const hour =
        Number(
            hourText
        )


    const dateTimeText =
        new Intl
            .DateTimeFormat(
                'zh-CN',
                {
                    timeZone,

                    year:
                        'numeric',

                    month:
                        '2-digit',

                    day:
                        '2-digit',

                    weekday:
                        'long',

                    hour:
                        '2-digit',

                    minute:
                        '2-digit',

                    hourCycle:
                        'h23',
                }
            )
            .format(
                now
            )


    return [
        `用户时区：${timeZone}`,
        `用户当前本地时间：${dateTimeText}`,
        `当前时间段：${getDayPart(hour)}`,
    ].join('\n')
}


// ======================================================
// 提醒功能：判断是否值得调用提醒解析器
//
// 现在支持：
// create      创建提醒
// list        查询待办提醒
// cancel      取消一条提醒
// cancel_all  明确要求时取消全部待办提醒
// update      修改时间 / 提前量 / 内容
// clarify     信息不足时追问
// ======================================================

function shouldAnalyzeReminderIntent(
    cleanMessage,
    recentMessages
) {

    const text =
        typeof cleanMessage ===
            'string'
            ? cleanMessage.trim()
            : ''


    const reminderPattern =
        /提醒|帮我记|记住|记得|叫我|别忘|别让我忘|日程/


    const managementPattern =
        /取消|删掉|删除|清空|还有什么|有哪些|什么提醒|待办|改成|改到|改为|改一下|修改|提前|推迟|延后|延迟|换成|挪到|改时间/


    if (
        reminderPattern.test(
            text
        ) ||
        managementPattern.test(
            text
        )
    ) {
        return true
    }


    const previousMessages =
        (
            recentMessages ||
            []
        )
            .slice(
                0,
                -1
            )
            .slice(
                -8
            )


    const recentReminderContext =
        previousMessages.some(
            (
                item
            ) => {

                const content =
                    String(
                        item.content ||
                        ''
                    )

                return (
                    reminderPattern.test(
                        content
                    ) ||
                    /已提醒|提醒时间|提前提醒|几点|什么时候|具体时间|取消|修改/
                        .test(
                            content
                        )
                )

            }
        )


    if (
        !recentReminderContext
    ) {
        return false
    }


    const timePattern =
        /(?:今天|今晚|明天|后天|大后天|早上|上午|中午|下午|傍晚|晚上|夜里|凌晨|周[一二三四五六日天]|星期[一二三四五六日天]|[0-9一二两三四五六七八九十]{1,3}\s*(?:[:：点时]))/


    if (
        timePattern.test(
            text
        )
    ) {
        return true
    }


    const followUpPattern =
        /^(对|对的|对呀|对啊|是|是的|嗯|嗯嗯|嗯哼|好|好的|没错|没问题|可以|就这样|确认|那个|这个|刚才那个|取消|删掉|改吧|改一下|提前一点|晚一点|推迟一点|ok|okay)[\s，。！？!?、,.]*$/i


    return followUpPattern.test(
        text
    )
}


// ======================================================
// 从模型输出中取 JSON
// ======================================================

function parseReminderJson(
    text
) {

    if (
        typeof text !==
        'string'
    ) {
        return null
    }


    const start =
        text.indexOf(
            '{'
        )

    const end =
        text.lastIndexOf(
            '}'
        )


    if (
        start < 0 ||
        end < start
    ) {
        return null
    }


    try {

        return JSON.parse(
            text.slice(
                start,
                end + 1
            )
        )

    } catch (
    error
    ) {

        return null

    }
}


// ======================================================
// 读取当前用户还没有完成的提醒
// ======================================================

async function getPendingReminders(
    userId,
    limit = 20
) {

    if (!userId) {
        throw new Error(
            '读取 reminders 时缺少 user_id'
        )
    }


    const {
        data,
        error,
    } =
        await supabase
            .from(
                'reminders'
            )
            .select(
                'id, user_id, session_id, source_message_id, content, event_at, remind_at, timezone, status, remind_before_minutes, created_at, sent_at, cancelled_at, metadata'
            )
            .eq(
                'user_id',
                userId
            )
            .eq(
                'status',
                'pending'
            )
            .order(
                'event_at',
                {
                    ascending:
                        true,
                }
            )
            .limit(
                limit
            )


    if (error) {
        throw error
    }


    return Array.isArray(
        data
    )
        ? data
        : []
}


// ======================================================
// 把数据库提醒转换成解析器能安全读取的文本
// ======================================================

function buildPendingReminderParserText(
    reminders,
    defaultTimeZone
) {

    if (
        !Array.isArray(
            reminders
        ) ||
        reminders.length === 0
    ) {
        return '当前没有 pending 提醒。'
    }


    return reminders
        .map(
            (
                reminder
            ) => {

                const timeZone =
                    getValidTimeZone(
                        reminder.timezone
                    ) ||
                    defaultTimeZone ||
                    'UTC'


                const eventLocal =
                    DateTime
                        .fromISO(
                            reminder.event_at,
                            {
                                setZone:
                                    true,
                            }
                        )
                        .setZone(
                            timeZone
                        )


                return [
                    `id=${reminder.id}`,
                    `content=${reminder.content}`,
                    `event_local=${eventLocal.toFormat('yyyy-LL-dd HH:mm')}`,
                    `remind_before_minutes=${reminder.remind_before_minutes}`,
                ].join(' | ')

            }
        )
        .join('\n')
}


// ======================================================
// 用模型理解“创建 / 查询 / 取消 / 修改提醒”
// ======================================================

async function analyzeReminderIntent({
    sessionId,
    userId,
    settings,
    cleanMessage,
    userMessageId,
    recentMessages,
}) {

    if (!userId) {
        throw new Error(
            '处理 reminder 时缺少 user_id'
        )
    }


    const timeZone =
        getValidTimeZone(
            settings
                ?.timezone
        )


    if (!timeZone) {

        return {
            status:
                'clarify',

            clarification:
                '当前还没有可靠的用户时区，因此不能安全地处理提醒时间。',
        }

    }


    const nowLocal =
        DateTime
            .now()
            .setZone(
                timeZone
            )


    const pendingReminders =
        await getPendingReminders(
            userId,
            20
        )


    const pendingReminderText =
        buildPendingReminderParserText(
            pendingReminders,
            timeZone
        )


    const recentText =
        messagesToText(
            (
                recentMessages ||
                []
            ).slice(
                -10
            )
        )


    const parserInput =
        `你是 Hermit 的提醒管理解析器。

你只负责判断用户对提醒系统的真实操作意图，并输出结构化 JSON。
不要聊天，不要扮演角色。

【用户时区】
${timeZone}

【用户当前本地时间】
${nowLocal.toISO()}

【当前待处理提醒】
${pendingReminderText}

【最近聊天】
${recentText || '无'}

【当前用户消息】
${cleanMessage}

只允许输出一个 JSON 对象，不要输出 Markdown，不要解释。

格式必须是：

{
  "action": "none",
  "target_reminder_id": null,
  "content": null,
  "event_local": null,
  "remind_before_minutes": null,
  "clarification": null
}

action 只能是：

"none"
"create"
"list"
"cancel"
"cancel_all"
"update"
"clarify"

【核心规则】

1. create：
只有用户明确要求“提醒我、帮我记一下并提醒、到时候叫我、别让我忘”等未来提醒时才创建。
用户只是说自己未来要做某件事，但没有要求提醒时，action = none。

2. list：
用户问“我还有什么提醒”“有哪些提醒”“帮我看看待办提醒”等时使用。
只查询当前 pending 提醒。

3. cancel：
用户明确要取消、删除某一条提醒时使用。
target_reminder_id 必须从【当前待处理提醒】中选择。
如果无法唯一判断是哪一条，必须 clarify，绝对不要猜。

4. cancel_all：
只有用户非常明确地说“取消全部提醒”“所有提醒都删掉”“清空所有提醒”等时才能使用。
普通的“取消提醒”不能理解成 cancel_all。

5. update：
用户要修改已有提醒的时间、提前提醒分钟数或事情内容时使用。
target_reminder_id 必须从【当前待处理提醒】中选择。
如果无法唯一确定目标提醒，必须 clarify。

6. create 或 update 中，只要要设置一个新的事件时间，event_local 必须是用户时区下完整时间：
YYYY-MM-DDTHH:mm:ss
不要带 Z 或时区偏移。

7. create 时：
content 只写真正要做的事情，不要写“提醒我”。
如果用户没有说明提前多久，remind_before_minutes = 10。
如果用户明确说“到点提醒”“到时候提醒”，remind_before_minutes = 0。
如果用户说“提前一点”但没给具体分钟，使用 10。

8. update 时：
只修改用户明确要求改变的内容。
- 只改事情内容：content 填新内容，其余可以为 null。
- 只改事件时间：event_local 填新完整时间。
- 只改提前量：remind_before_minutes 填新数值，event_local 可以为 null。
- 没说要改的字段保持 null。

9. 如果用户说“把明天下午三点那个改到四点”，必须结合当前提醒的日期和上下文，把 event_local 解析成完整时间。
如果“凌晨/上午/下午”无法唯一判断，不要猜，clarify。

10. 如果用户说“刚才那个提前半小时”，并且根据最近聊天和当前 pending 提醒可以唯一确认目标，则 update：
remind_before_minutes = 30。

11. 当前消息如果只是“对”“是的”“没错”“好”“确认”等，
而上一轮助手正在确认提醒信息，
必须结合最近聊天继续完成操作，不要因为当前消息很短就输出 none。

12. target_reminder_id 只能使用当前待处理提醒里真实存在的 id。
不能编造 id。

13. 新的事件时间必须在当前时间之后。

14. clarification 只简短说明还缺什么，不要聊天。`


    const response =
        await callModelWithRetry({

            model:
                'gpt-5.6-sol',

            input:
                parserInput,

        })


    const parsed =
        parseReminderJson(
            response
                ?.output_text
        )


    if (!parsed) {

        throw new Error(
            '提醒管理解析器没有返回有效 JSON'
        )

    }


    const action =
        typeof parsed.action ===
            'string'
            ? parsed.action
                .trim()
                .toLowerCase()
            : 'none'


    const clarification =
        typeof parsed
            .clarification ===
            'string' &&
            parsed
                .clarification
                .trim()
            ? parsed
                .clarification
                .trim()
            : ''


    if (
        action ===
        'none'
    ) {

        return {
            status:
                'none',
        }

    }


    if (
        action ===
        'clarify'
    ) {

        return {

            status:
                'clarify',

            clarification:
                clarification ||
                '还缺少足够的信息来确定这次提醒操作。',

        }

    }


    if (
        action ===
        'list'
    ) {

        return {

            status:
                'listed',

            reminders:
                pendingReminders,

            timeZone,

        }

    }


    if (
        action ===
        'cancel_all'
    ) {

        if (
            pendingReminders.length ===
            0
        ) {

            return {
                status:
                    'cancelled_all',

                reminders:
                    [],

                cancelledCount:
                    0,

                timeZone,
            }

        }


        const reminderIds =
            pendingReminders.map(
                (
                    reminder
                ) =>
                    reminder.id
            )


        const cancelledAt =
            new Date()
                .toISOString()


        const {
            data:
            cancelledReminders,

            error:
            cancelAllError,
        } =
            await supabase
                .from(
                    'reminders'
                )
                .update({
                    status:
                        'cancelled',

                    cancelled_at:
                        cancelledAt,
                })
                .eq(
                    'user_id',
                    userId
                )
                .eq(
                    'status',
                    'pending'
                )
                .in(
                    'id',
                    reminderIds
                )
                .select(
                    'id, user_id, session_id, content, event_at, remind_at, timezone, status, remind_before_minutes, created_at, cancelled_at, metadata'
                )


        if (cancelAllError) {
            throw cancelAllError
        }


        return {

            status:
                'cancelled_all',

            reminders:
                cancelledReminders ||
                [],

            cancelledCount:
                Array.isArray(
                    cancelledReminders
                )
                    ? cancelledReminders
                        .length
                    : 0,

            timeZone,

        }

    }


    const targetReminderId =
        Number(
            parsed
                .target_reminder_id
        )


    const targetReminder =
        Number.isInteger(
            targetReminderId
        )
            ? pendingReminders
                .find(
                    (
                        reminder
                    ) =>
                        Number(
                            reminder.id
                        ) ===
                        targetReminderId
                )
            : null


    if (
        (
            action ===
            'cancel' ||
            action ===
            'update'
        ) &&
        !targetReminder
    ) {

        return {

            status:
                'clarify',

            clarification:
                clarification ||
                (
                    pendingReminders.length ===
                    0
                        ? '当前没有可以修改或取消的待处理提醒。'
                        : '还不能唯一确定你指的是哪一条提醒。'
                ),

        }

    }


    if (
        action ===
        'cancel'
    ) {

        const cancelledAt =
            new Date()
                .toISOString()


        const {
            data:
            cancelledReminder,

            error:
            cancelError,
        } =
            await supabase
                .from(
                    'reminders'
                )
                .update({
                    status:
                        'cancelled',

                    cancelled_at:
                        cancelledAt,
                })
                .eq(
                    'id',
                    targetReminder.id
                )
                .eq(
                    'user_id',
                    userId
                )
                .eq(
                    'status',
                    'pending'
                )
                .select(
                    'id, user_id, session_id, content, event_at, remind_at, timezone, status, remind_before_minutes, created_at, cancelled_at, metadata'
                )
                .maybeSingle()


        if (cancelError) {
            throw cancelError
        }


        if (!cancelledReminder) {

            return {

                status:
                    'clarify',

                clarification:
                    '这条提醒已经不是待处理状态了，请重新确认。',

            }

        }


        return {

            status:
                'cancelled',

            reminder:
                cancelledReminder,

            timeZone,

        }

    }


    if (
        action ===
        'update'
    ) {

        const oldTimeZone =
            getValidTimeZone(
                targetReminder.timezone
            ) ||
            timeZone


        const oldEventLocal =
            DateTime
                .fromISO(
                    targetReminder.event_at,
                    {
                        setZone:
                            true,
                    }
                )
                .setZone(
                    oldTimeZone
                )


        let newEventLocal =
            oldEventLocal


        const eventLocalText =
            typeof parsed
                .event_local ===
                'string'
                ? parsed
                    .event_local
                    .trim()
                : ''


        if (eventLocalText) {

            newEventLocal =
                DateTime
                    .fromISO(
                        eventLocalText,
                        {
                            zone:
                                timeZone,
                        }
                    )


            if (
                !newEventLocal.isValid
            ) {

                return {

                    status:
                        'clarify',

                    clarification:
                        '新的提醒时间没有解析成功，请重新确认日期和时间。',

                }

            }

        }


        if (
            newEventLocal
                .toMillis() <=
            nowLocal
                .toMillis()
        ) {

            return {

                status:
                    'clarify',

                clarification:
                    '修改后的时间已经过去了，需要确认一个未来的时间。',

            }

        }


        const content =
            typeof parsed.content ===
                'string' &&
                parsed.content.trim()
                ? parsed.content.trim()
                : targetReminder.content


        const beforeRaw =
            parsed
                .remind_before_minutes ===
                null ||
                parsed
                    .remind_before_minutes ===
                undefined
                ? null
                : Number(
                    parsed
                        .remind_before_minutes
                )


        const remindBeforeMinutes =
            beforeRaw ===
                null
                ? Number(
                    targetReminder
                        .remind_before_minutes
                ) || 0
                : Number.isFinite(
                    beforeRaw
                ) &&
                    beforeRaw >= 0
                    ? Math.min(
                        10080,
                        Math.round(
                            beforeRaw
                        )
                    )
                    : null


        if (
            remindBeforeMinutes ===
            null
        ) {

            return {

                status:
                    'clarify',

                clarification:
                    '新的提前提醒时间没有解析成功。',

            }

        }


        const plannedRemindLocal =
            newEventLocal.minus({
                minutes:
                    remindBeforeMinutes,
            })


        const remindLocal =
            plannedRemindLocal
                .toMillis() <
                nowLocal
                    .toMillis()
                ? nowLocal
                : plannedRemindLocal


        const oldSnapshot = {
            content:
                targetReminder.content,

            event_at:
                targetReminder.event_at,

            remind_at:
                targetReminder.remind_at,

            remind_before_minutes:
                targetReminder
                    .remind_before_minutes,
        }


        const oldMetadata =
            targetReminder.metadata &&
                typeof targetReminder
                    .metadata ===
                'object' &&
                !Array.isArray(
                    targetReminder
                        .metadata
                )
                ? targetReminder
                    .metadata
                : {}


        const {
            data:
            updatedReminder,

            error:
            updateError,
        } =
            await supabase
                .from(
                    'reminders'
                )
                .update({
                    content,

                    event_at:
                        newEventLocal
                            .toUTC()
                            .toISO(),

                    remind_at:
                        remindLocal
                            .toUTC()
                            .toISO(),

                    timezone:
                        timeZone,

                    remind_before_minutes:
                        remindBeforeMinutes,

                    metadata: {
                        ...oldMetadata,

                        updated_via:
                            'chat',

                        updated_at:
                            new Date()
                                .toISOString(),

                        event_local:
                            newEventLocal
                                .toFormat(
                                    "yyyy-LL-dd'T'HH:mm:ss"
                                ),
                    },
                })
                .eq(
                    'id',
                    targetReminder.id
                )
                .eq(
                    'user_id',
                    userId
                )
                .eq(
                    'status',
                    'pending'
                )
                .select(
                    'id, user_id, session_id, source_message_id, content, event_at, remind_at, timezone, status, remind_before_minutes, created_at, metadata'
                )
                .maybeSingle()


        if (updateError) {
            throw updateError
        }


        if (!updatedReminder) {

            return {

                status:
                    'clarify',

                clarification:
                    '这条提醒刚刚已经发生变化，请重新确认一次。',

            }

        }


        return {

            status:
                'updated',

            reminder:
                updatedReminder,

            previous:
                oldSnapshot,

            timeZone,

        }

    }


    if (
        action !==
        'create'
    ) {

        return {
            status:
                'none',
        }

    }


    const content =
        typeof parsed.content ===
            'string'
            ? parsed.content
                .trim()
            : ''


    const eventLocalText =
        typeof parsed
            .event_local ===
            'string'
            ? parsed
                .event_local
                .trim()
            : ''


    if (
        !content ||
        !eventLocalText
    ) {

        return {

            status:
                'clarify',

            clarification:
                '还缺少明确的事情内容或具体时间。',

        }

    }


    const eventLocal =
        DateTime.fromISO(
            eventLocalText,
            {
                zone:
                    timeZone,
            }
        )


    if (
        !eventLocal.isValid
    ) {

        return {

            status:
                'clarify',

            clarification:
                '这个时间没有解析成功，请重新确认具体日期和时间。',

        }

    }


    if (
        eventLocal.toMillis() <=
        nowLocal.toMillis()
    ) {

        return {

            status:
                'clarify',

            clarification:
                '这个时间已经过去了，需要重新确认一个未来的时间。',

        }

    }


    const beforeRaw =
        Number(
            parsed
                .remind_before_minutes
        )


    const remindBeforeMinutes =
        Number.isFinite(
            beforeRaw
        ) &&
            beforeRaw >= 0
            ? Math.min(
                10080,
                Math.round(
                    beforeRaw
                )
            )
            : 10


    const plannedRemindLocal =
        eventLocal.minus({
            minutes:
                remindBeforeMinutes,
        })


    const remindLocal =
        plannedRemindLocal.toMillis() <
            nowLocal.toMillis()
            ? nowLocal
            : plannedRemindLocal


    const {
        data:
        reminder,

        error:
        reminderError,
    } =
        await supabase
            .from(
                'reminders'
            )
            .insert([
                {

                    user_id:
                        userId,

                    session_id:
                        sessionId,

                    source_message_id:
                        userMessageId,

                    content,

                    event_at:
                        eventLocal
                            .toUTC()
                            .toISO(),

                    remind_at:
                        remindLocal
                            .toUTC()
                            .toISO(),

                    timezone:
                        timeZone,

                    status:
                        'pending',

                    remind_before_minutes:
                        remindBeforeMinutes,

                    metadata: {

                        created_via:
                            'chat',

                        event_local:
                            eventLocalText,

                    },

                },
            ])
            .select(
                'id, user_id, session_id, source_message_id, content, event_at, remind_at, timezone, status, remind_before_minutes, created_at, metadata'
            )
            .single()


    if (
        reminderError
    ) {
        throw reminderError
    }


    return {

        status:
            'created',

        reminder,

        eventLocalText:
            eventLocal.toFormat(
                'yyyy-LL-dd HH:mm'
            ),

        timeZone,

    }
}


// ======================================================
// 提醒结果交给正常聊天模型，用角色口吻回复
// ======================================================

function buildReminderReplyContext(
    reminderResult
) {

    const status =
        reminderResult
            ?.status


    if (
        status ===
        'created'
    ) {

        const reminder =
            reminderResult
                .reminder


        return `【本次提醒操作结果】

提醒已经真正保存成功。

提醒内容：${reminder.content}
事件时间（用户本地）：${reminderResult.eventLocalText}
提前提醒：${reminder.remind_before_minutes} 分钟

请以沈星回的身份自然确认这件事。
不要提数据库、API、系统、解析器等内部机制。
不要再次询问已经明确的信息。
不要声称做了其他并不存在的操作。`

    }


    if (
        status ===
        'listed'
    ) {

        const reminders =
            reminderResult
                .reminders ||
            []


        if (
            reminders.length ===
            0
        ) {

            return `【本次提醒操作结果】

用户正在查询还没完成的提醒。
当前没有 pending 提醒。

请以沈星回的身份自然告诉用户目前没有待处理提醒。
不要编造不存在的提醒。`

        }


        const lines =
            reminders
                .slice(
                    0,
                    10
                )
                .map(
                    (
                        reminder,
                        index
                    ) => {

                        const timeZone =
                            getValidTimeZone(
                                reminder.timezone
                            ) ||
                            reminderResult
                                .timeZone ||
                            'UTC'


                        const eventLocal =
                            DateTime
                                .fromISO(
                                    reminder.event_at,
                                    {
                                        setZone:
                                            true,
                                    }
                                )
                                .setZone(
                                    timeZone
                                )


                        return (
                            `${index + 1}. ${reminder.content}｜${eventLocal.toFormat('yyyy-LL-dd HH:mm')}｜提前 ${reminder.remind_before_minutes} 分钟`
                        )

                    }
                )
                .join(
                    '\n'
                )


        return `【本次提醒操作结果】

用户正在查询还没完成的提醒。
以下是数据库里真实存在的 pending 提醒：

${lines}

请以沈星回的身份自然告诉用户。
信息必须准确，不要增加不存在的提醒。
如果条目较多，可以简洁列出，不需要长篇解释。`

    }


    if (
        status ===
        'cancelled'
    ) {

        const reminder =
            reminderResult
                .reminder


        return `【本次提醒操作结果】

用户要求取消一条提醒，操作已经真正成功。

已取消：
${reminder.content}

请以沈星回的身份自然确认已经取消。
不要说它仍然会提醒，也不要编造其他变化。`

    }


    if (
        status ===
        'cancelled_all'
    ) {

        const count =
            Number(
                reminderResult
                    .cancelledCount
            ) || 0


        return `【本次提醒操作结果】

用户明确要求取消全部待处理提醒。
这次实际取消数量：${count}。

请以沈星回的身份自然确认结果。
如果数量是 0，就自然告诉用户本来就没有待处理提醒。
不要编造不存在的提醒。`

    }


    if (
        status ===
        'updated'
    ) {

        const reminder =
            reminderResult
                .reminder


        const timeZone =
            getValidTimeZone(
                reminder.timezone
            ) ||
            reminderResult
                .timeZone ||
            'UTC'


        const eventLocal =
            DateTime
                .fromISO(
                    reminder.event_at,
                    {
                        setZone:
                            true,
                    }
                )
                .setZone(
                    timeZone
                )


        return `【本次提醒操作结果】

用户要求修改一条提醒，操作已经真正成功。

现在的提醒：
内容：${reminder.content}
事件时间（用户本地）：${eventLocal.toFormat('yyyy-LL-dd HH:mm')}
提前提醒：${reminder.remind_before_minutes} 分钟

请以沈星回的身份自然确认修改后的结果。
不要再次询问已经确定的信息。
不要提数据库、API、解析器等内部机制。`

    }


    if (
        status ===
        'clarify'
    ) {

        return `【本次提醒操作结果】

用户有提醒相关意图，但当前还不能安全完成操作。

原因：
${reminderResult.clarification}

这次回复请自然地追问真正缺失的信息。
不要说“已经设置好了”“已经取消了”“已经改好了”等暗示操作成功的话。`

    }


    return ''
}


// ======================================================
// 读取最近几次主动消息
//
// 目的：
// 防止连续主动消息都使用同一种开场、
// 同一个话题或同一种“问候型”模板。
// ======================================================

async function getRecentProactiveMessages(
    sessionId,
    limit = 4
) {

    const {
        data,
        error,
    } =
        await supabase
            .from(
                'messages'
            )
            .select(
                'id, content, created_at'
            )
            .eq(
                'session_id',
                sessionId
            )
            .eq(
                'visible',
                true
            )
            .eq(
                'reasoning_content',
                'proactive'
            )
            .order(
                'created_at',
                {
                    ascending:
                        false,
                }
            )
            .order(
                'id',
                {
                    ascending:
                        false,
                }
            )
            .limit(
                limit
            )


    if (error) {
        throw error
    }


    return Array.isArray(
        data
    )
        ? [
            ...data,
        ].reverse()
        : []
}


// ======================================================
// 主动消息上下文
// ======================================================

async function buildProactiveInput(
    sessionId,
    settings,
    userId,
    mode = 'manual'
) {

    const latestMemory =
        await getLatestMemory(
            userId
        )


    const memorySummary =
        typeof latestMemory
            ?.summary ===
            'string'
            ? latestMemory
                .summary
                .trim()
            : ''


    const recentMessages =
        await getRecentVisibleMessages(
            sessionId,
            settings
        )


    const latestUserMessage =
        [
            ...recentMessages,
        ]
            .reverse()
            .find(
                (item) =>
                    item.role ===
                    'user'
            )
            ?.content ||
        ''


    const characterLore =
        await getCharacterLoreContext({

            userId,

            currentMessage:
                latestUserMessage,

            recentMessages,

        })


    const recentProactiveMessages =
        await getRecentProactiveMessages(
            sessionId,
            4
        )


    const systemPrompt =
        typeof settings
            ?.system_prompt ===
            'string'
            ? settings
                .system_prompt
                .trim()
            : ''


    const characterContext =
        typeof settings
            ?.character_context ===
            'string'
            ? settings
                .character_context
                .trim()
            : ''


    const historyText =
        messagesToText(
            recentMessages
        )


    const timeContext =
        buildUserLocalTimeContext(
            settings
        )


    const recentProactiveText =
        recentProactiveMessages
            .map(
                (
                    item,
                    index
                ) =>
                    `主动消息 ${index + 1}：${item.content}`
            )
            .join('\n')


    const sections = []


    if (systemPrompt) {

        sections.push(
            `【最高优先级：角色行为规则】
${systemPrompt}`
        )

    }


    if (characterContext) {

        sections.push(
            `【固定人物设定、关系背景与共同经历】
以下内容属于角色和用户之间已经确定的稳定背景。
请把它们视为既有事实，但不要为了表现记忆而机械复述。

${characterContext}`
        )

    }


    if (
        characterLore
            ?.context
    ) {

        sections.push(
            characterLore.context
        )

    }


    if (memorySummary) {

        sections.push(
            `【长期记忆】
${memorySummary}`
        )

    }


    if (historyText) {

        sections.push(
            `【当前会话最近聊天】
${historyText}`
        )

    }


    sections.push(
        `【用户当前时间信息】
${timeContext}`
    )


    if (
        recentProactiveText
    ) {

        sections.push(
            `【最近已经发过的主动消息】
这些内容只用于避免重复。
不要机械延续，也不要再次使用高度相似的开场、主题、问法或结尾。

${recentProactiveText}`
        )

    }


    const opening =
        mode ===
            'automatic'
            ? '用户已经有一段时间没有继续聊天。现在由你自己决定是否以及怎样自然地主动联系用户。'
            : '现在不是用户刚刚向你提出问题，而是你准备主动联系用户。'


    sections.push(
        `【本次任务：主动发消息】

${opening}

你不是“定时问候机器人”。

主动联系用户时，优先从当前关系、最近聊天、长期记忆和当前时间中寻找真正自然的理由。

【主动消息可以来自很多不同方向】

例如：

- 自然延续之前还留有余味的话题；
- 想起用户刚才或之前说过的一件小事；
- 对用户之前提到的计划产生自然的后续反应；
- 突然想到用户；
- 想逗用户一下；
- 想撒一点娇；
- 分享自己此刻一个很小的念头或生活片段；
- 想起两个人之间某个自然相关的共同经历；
- 根据当前时间产生符合常识的生活化表达；
- 单纯想和用户说一句没什么实际意义的话。

以上只是可能性，不是每次都要全部使用。

【严格规则】

1. 优先观察最近聊天。如果其中存在很自然可以接下去的内容，可以从那个内容出发。

2. 不要默认使用“在干嘛”“吃饭了吗”“睡了吗”“今天过得怎么样”“有没有好好休息”这种问候型开场。

3. 不需要每次都提出问题。
有时一句念头、吐槽、玩笑、撒娇或很短的话就已经足够。

4. 不要为了显得关心而强行提醒用户吃饭、喝水、休息、早点睡。

5. 当前时间必须符合现实常识。
如果当前是晚上或深夜，不要说自己正在晒太阳、刚吃早餐、准备去看日出之类明显不合时宜的话。
如果当前是清晨，也不要无缘无故说自己刚吃完晚饭。

6. 不需要每次主动提到具体时间。
时间信息主要用来约束现实合理性，而不是要求你每次都说“现在几点”。

7. 如果用户时区尚未设置，不要自行编造现在是白天还是晚上。

8. 没有真实天气信息时，不要声称正在下雨、下雪、天气很好、阳光很强等具体天气事实。

9. 描述自己的活动时可以有生活感，但必须符合当前时间与角色设定，不要突然创造与上下文冲突的新职业、新任务、新地点或新身份。

10. 如果最近聊天中用户明确提过某件准备去做的事情，可以在之后自然想起它。
但不要假装已经知道事情的结果。

11. 查看“最近已经发过的主动消息”，避免连续使用相同的开场、相同的话题、相同的关心方式或相同结尾。

12. 不要连续几次都使用“想你了”“宝宝在干嘛”“有没有好好休息”这一类同质内容。

13. 根据角色自身的情绪和关系自然说话。
允许有一点懒、困、吃醋、调侃、撒娇、无聊、想靠近用户，或者只是突然冒出一个没什么用的念头。

14. 不要为了主动联系而编造用户刚刚说过不存在的话。

15. 普通情况下生成 1～3 条简短消息，不要一次写很长。

16. 每条独立消息之间必须使用一个空行分隔。

17. 不要使用编号、项目符号、标题、JSON 或“消息1/消息2”等标记。

18. 不要解释为什么你主动发消息。

19. 不要提“系统”“定时任务”“AI”“主动消息规则”等内部机制。

20. 不要催促、责怪用户，也不要要求用户必须回复。

21. 输出必须能够直接作为沈星回发给用户的即时聊天消息。`
    )


    return sections.join(
        '\n\n'
    )
}


// ======================================================
// 给所有已订阅设备发送 Push
//
// 重要：
// Push payload 不包含星星真正的聊天内容。
// 手机只会知道“有一条新消息”和 session_id。
// 真正正文仍然保存在 messages 表。
// ======================================================

async function sendPushNotification(
    sessionId
) {

    const userId =
        await getSessionOwnerId(
            sessionId
        )

    if (!pushConfigured) {

        console.log(
            'Web Push 未配置，跳过通知'
        )

        return {
            sent: 0,
            failed: 0,
            removed: 0,
            reason:
                'push_not_configured',
        }
    }


    if (!supabase) {

        return {
            sent: 0,
            failed: 0,
            removed: 0,
            reason:
                'supabase_not_configured',
        }
    }


    const {
        data:
        subscriptions,

        error:
        subscriptionsError,
    } =
        await supabase
            .from(
                'push_subscriptions'
            )
            .select(
                'id, endpoint, p256dh, auth, user_id'
            )
            .eq(
                'user_id',
                userId
            )


    if (
        subscriptionsError
    ) {
        throw subscriptionsError
    }


    if (
        !subscriptions ||
        subscriptions.length === 0
    ) {

        console.log(
            '当前没有 Push 订阅设备'
        )

        return {
            sent: 0,
            failed: 0,
            removed: 0,
            reason:
                'no_subscriptions',
        }
    }


    // ----------------------------------------------
    // 这里只传新消息事件和会话 ID。
    // 不传聊天正文。
    // ----------------------------------------------

    const payload =
        JSON.stringify({

            type:
                'new_message',

            session_id:
                sessionId,

        })


    let sent = 0
    let failed = 0
    let removed = 0


    for (
        const subscription
        of subscriptions
    ) {

        try {

            await webpush
                .sendNotification(
                    {
                        endpoint:
                            subscription.endpoint,

                        keys: {
                            p256dh:
                                subscription.p256dh,

                            auth:
                                subscription.auth,
                        },
                    },

                    payload,

                    {
                        TTL:
                            60 * 60,
                    }
                )


            sent += 1


        } catch (error) {

            const statusCode =
                error?.statusCode ||
                    error?.statusCode === 0
                    ? error.statusCode
                    : null


            // --------------------------------------
            // 404 / 410 代表这个设备订阅已经失效。
            // 自动从数据库删除。
            // --------------------------------------

            if (
                statusCode === 404 ||
                statusCode === 410
            ) {

                console.log(
                    `Push 订阅已失效，删除 subscription id=${subscription.id}`
                )


                const {
                    error:
                    deleteError,
                } =
                    await supabase
                        .from(
                            'push_subscriptions'
                        )
                        .delete()
                        .eq(
                            'id',
                            subscription.id
                        )
                        .eq(
                            'user_id',
                            userId
                        )


                if (deleteError) {

                    console.error(
                        '删除失效 Push 订阅失败：',
                        deleteError
                    )

                } else {

                    removed += 1

                }


            } else {

                failed += 1

                console.error(
                    '发送 Web Push 失败：',
                    error
                )

            }

        }

    }


    return {

        sent,

        failed,

        removed,

        reason:
            'finished',

    }
}

// ======================================================
// 生成并保存主动消息
// ======================================================

async function generateAndSaveProactiveMessage(
    sessionId,
    mode = 'manual'
) {

    const userId =
        await getSessionOwnerId(
            sessionId
        )

    const settings =
        await getGlobalSettings(
            userId
        )

    const proactiveInput =
        await buildProactiveInput(
            sessionId,
            settings,
            userId,
            mode
        )

    const response =
        await callModelWithRetry({

            model:
                'gpt-5.6-sol',

            input:
                proactiveInput,

        })


    const reply =
        typeof response
            .output_text ===
            'string'
            ? response
                .output_text
                .trim()
            : ''

    if (!reply) {

        throw new Error(
            '主动消息模型没有返回有效文本'
        )

    }

    const {
        data:
        assistantMessage,

        error:
        assistantMessageError,
    } =
        await supabase
            .from(
                'messages'
            )
            .insert([
                {

                    user_id:
                        userId,

                    session_id:
                        sessionId,

                    role:
                        'assistant',

                    content:
                        reply,

                    visible:
                        true,

                    reasoning_content:
                        'proactive',

                },
            ])
            .select(
                'id, session_id, role, content, created_at, visible, reasoning_content'
            )
            .single()

    if (
        assistantMessageError
    ) {
        throw assistantMessageError
    }


    // ======================================================
    // 主动消息成功写入数据库以后发送 Push
    //
    // 即使 Push 失败，也不能把已经生成的聊天消息判定为失败。
    // ======================================================

    let pushResult = {
        sent: 0,
        failed: 0,
        removed: 0,
        reason:
            'not_attempted',
    }


    try {

        pushResult =
            await sendPushNotification(
                sessionId
            )

    } catch (error) {

        console.error(
            '主动消息已经保存，但 Push 发送失败：',
            error
        )

        pushResult = {
            sent: 0,
            failed: 1,
            removed: 0,
            reason:
                'push_error',
        }

    }


    return {

        reply,

        assistantMessage,

        pushResult,

    }
}

// ======================================================
// 到点提醒：生成并保存提醒消息
// ======================================================

async function generateAndSaveReminderMessage(reminder) {

    const userId =
        await getSessionOwnerId(
            reminder.session_id
        )

    const settings =
        await getGlobalSettings(
            userId
        )

    const latestMemory =
        await getLatestMemory(
            userId
        )

    const memorySummary =
        typeof latestMemory?.summary === 'string'
            ? latestMemory.summary.trim()
            : ''

    const recentMessages =
        await getRecentVisibleMessages(
            reminder.session_id,
            settings
        )


    const characterLore =
        await getCharacterLoreContext({

            userId,

            currentMessage:
                reminder.content,

            recentMessages,

        })


    const recentText =
        messagesToText(
            recentMessages.slice(-8)
        )

    const systemPrompt =
        typeof settings?.system_prompt === 'string'
            ? settings.system_prompt.trim()
            : ''

    const characterContext =
        typeof settings?.character_context === 'string'
            ? settings.character_context.trim()
            : ''

    const timeZone =
        getValidTimeZone(reminder.timezone) ||
        getValidTimeZone(settings?.timezone) ||
        'UTC'

    const eventLocal =
        DateTime
            .fromISO(
                reminder.event_at,
                {
                    setZone: true,
                }
            )
            .setZone(timeZone)

    const nowLocal =
        DateTime
            .now()
            .setZone(timeZone)

    const minutesBefore =
        Math.max(
            0,
            Number(
                reminder.remind_before_minutes
            ) || 0
        )

    const reminderInput =
        `【最高优先级：角色行为规则】
${systemPrompt}

【固定人物设定、关系背景与共同经历】
${characterContext}

${characterLore?.context
        ? `${characterLore.context}

`
        : ''
    }【长期记忆】
${memorySummary || '无'}

【最近聊天】
${recentText || '无'}

【当前任务：到点提醒】

这是用户之前明确设置、现在已经到提醒时间的真实提醒。

提醒内容：${reminder.content}
事情发生时间：${eventLocal.toFormat('yyyy-LL-dd HH:mm')}
当前时间：${nowLocal.toFormat('yyyy-LL-dd HH:mm')}
提前提醒分钟数：${minutesBefore}

请以沈星回的身份自然提醒用户。

要求：
1. 直接提醒这件事，不要假装用户刚刚说了什么。
2. 提前提醒分钟数大于 0 时，可以自然表达“还有多久”；等于 0 时就当作“现在到时间了”。
3. 通常 1～3 条短消息。
4. 可以有角色语气、调侃或关心，但提醒本身必须清楚。
5. 不要提数据库、系统、定时任务、API、AI 等内部机制。
6. 不要编造天气、地点、用户当前行为或事情已经完成。
7. 每条独立消息之间用一个空行分隔。
8. 输出必须能够直接发给用户。`

    const response =
        await callModelWithRetry({
            model:
                'gpt-5.6-sol',

            input:
                reminderInput,
        })

    const reply =
        typeof response?.output_text ===
            'string'
            ? response.output_text.trim()
            : ''

    if (!reply) {

        throw new Error(
            '提醒消息模型没有返回有效文本'
        )

    }


    // ==================================================
    // 领取这条提醒
    //
    // 只有 pending 才能变成 sent。
    // 就算两个检查同时运行，也只有一个能成功，
    // 防止同一条提醒发两遍。
    // ==================================================

    const sentAt =
        new Date()
            .toISOString()

    const {
        data:
        claimedReminder,

        error:
        claimError,
    } =
        await supabase
            .from(
                'reminders'
            )
            .update({

                status:
                    'sent',

                sent_at:
                    sentAt,

            })
            .eq(
                'id',
                reminder.id
            )
            .eq(
                'status',
                'pending'
            )
            .eq(
                'user_id',
                userId
            )
            .select(
                'id, user_id, session_id, content, event_at, remind_at, timezone, status, remind_before_minutes, created_at, sent_at, metadata'
            )
            .maybeSingle()

    if (claimError) {
        throw claimError
    }

    if (!claimedReminder) {

        return {

            sent:
                false,

            reason:
                'already_processed',

            reminder_id:
                reminder.id,

        }

    }


    // ==================================================
    // 写入聊天记录
    // ==================================================

    let assistantMessage =
        null

    try {

        const {
            data,
            error,
        } =
            await supabase
                .from(
                    'messages'
                )
                .insert([
                    {

                        user_id:
                            userId,

                        session_id:
                            claimedReminder
                                .session_id,

                        role:
                            'assistant',

                        content:
                            reply,

                        visible:
                            true,

                        reasoning_content:
                            'reminder',

                    },
                ])
                .select(
                    'id, session_id, role, content, created_at, visible, reasoning_content'
                )
                .single()

        if (error) {
            throw error
        }

        assistantMessage =
            data

    } catch (error) {

        // 如果聊天消息没写进去，
        // 把提醒恢复成 pending，
        // 下一次还能继续重试。

        const {
            error:
            rollbackError,
        } =
            await supabase
                .from(
                    'reminders'
                )
                .update({

                    status:
                        'pending',

                    sent_at:
                        null,

                })
                .eq(
                    'id',
                    claimedReminder.id
                )
                .eq(
                    'status',
                    'sent'
                )
                .eq(
                    'user_id',
                    userId
                )

        if (rollbackError) {

            console.error(
                '恢复提醒 pending 状态失败：',
                rollbackError
            )

        }

        throw error
    }


    // ==================================================
    // 发 Push
    // ==================================================

    let pushResult = {

        sent: 0,
        failed: 0,
        removed: 0,

        reason:
            'not_attempted',

    }

    try {

        pushResult =
            await sendPushNotification(
                claimedReminder
                    .session_id
            )

    } catch (error) {

        console.error(
            '提醒消息已保存，但 Push 发送失败：',
            error
        )

        pushResult = {

            sent: 0,
            failed: 1,
            removed: 0,

            reason:
                'push_error',

        }

    }


    return {

        sent:
            true,

        reminder:
            claimedReminder,

        reply,

        assistantMessage,

        pushResult,

    }
}


// ======================================================
// 获取 VAPID Public Key
// GET /api/push/public-key
//
// Public Key 可以公开。
// Private Key 永远不会通过这个接口返回。
// ======================================================

app.get(
    '/api/push/public-key',
    (
        req,
        res
    ) => {

        if (
            !VAPID_PUBLIC_KEY
        ) {

            return res
                .status(500)
                .json({

                    ok:
                        false,

                    error:
                        '服务器没有配置 VAPID_PUBLIC_KEY',

                })

        }


        return res
            .status(200)
            .json({

                ok:
                    true,

                publicKey:
                    VAPID_PUBLIC_KEY,

            })

    }
)


// ======================================================
// 保存手机 / 浏览器 Push Subscription
// POST /api/push/subscribe
//
// 前端发送：
//
// {
//   "endpoint": "...",
//   "keys": {
//       "p256dh": "...",
//       "auth": "..."
//   }
// }
// ======================================================

app.post(
    '/api/push/subscribe',
    async (
        req,
        res
    ) => {

        try {

            if (
                !requireSupabase(
                    res
                )
            ) {
                return
            }


            const {
                endpoint,
                keys,
            } =
                req.body || {}


            const p256dh =
                keys?.p256dh

            const auth =
                keys?.auth


            if (
                typeof endpoint !==
                'string' ||
                !endpoint.trim() ||

                typeof p256dh !==
                'string' ||
                !p256dh.trim() ||

                typeof auth !==
                'string' ||
                !auth.trim()
            ) {

                return res
                    .status(400)
                    .json({

                        ok:
                            false,

                        error:
                            'Push Subscription 数据不完整',

                    })

            }


            if (
                !endpoint.startsWith(
                    'https://'
                )
            ) {

                return res
                    .status(400)
                    .json({

                        ok:
                            false,

                        error:
                            'Push endpoint 必须使用 HTTPS',

                    })

            }


            const now =
                new Date()
                    .toISOString()


            // endpoint 在表里是 unique，
            // 同一台设备重新订阅时直接更新 keys。
            const {
                error:
                upsertError,
            } =
                await supabase
                    .from(
                        'push_subscriptions'
                    )
                    .upsert(
                        {

                            endpoint:
                                endpoint.trim(),

                            p256dh:
                                p256dh.trim(),

                            auth:
                                auth.trim(),

                            user_id:
                                req.userId,

                            updated_at:
                                now,

                        },
                        {
                            onConflict:
                                'endpoint',
                        }
                    )


            if (
                upsertError
            ) {
                throw upsertError
            }


            return res
                .status(200)
                .json({

                    ok:
                        true,

                    message:
                        'Push Subscription 保存成功',

                })


        } catch (
        error
        ) {

            console.error(
                '保存 Push Subscription 失败：',
                error
            )


            return res
                .status(500)
                .json({

                    ok:
                        false,

                    error:
                        '保存 Push Subscription 失败',

                    detail:
                        error.message,

                })

        }

    }
)


// ======================================================
// 删除当前设备 Push Subscription
// POST /api/push/unsubscribe
//
// Body：
// {
//     "endpoint": "..."
// }
// ======================================================

app.post(
    '/api/push/unsubscribe',
    async (
        req,
        res
    ) => {

        try {

            if (
                !requireSupabase(
                    res
                )
            ) {
                return
            }


            const endpoint =
                req.body
                    ?.endpoint


            if (
                typeof endpoint !==
                'string' ||
                !endpoint.trim()
            ) {

                return res
                    .status(400)
                    .json({

                        ok:
                            false,

                        error:
                            'endpoint 不能为空',

                    })

            }


            const {
                error:
                deleteError,
            } =
                await supabase
                    .from(
                        'push_subscriptions'
                    )
                    .delete()
                    .eq(
                        'endpoint',
                        endpoint.trim()
                    )
                    .eq(
                        'user_id',
                        req.userId
                    )


            if (
                deleteError
            ) {
                throw deleteError
            }


            return res
                .status(200)
                .json({

                    ok:
                        true,

                    message:
                        'Push Subscription 已删除',

                })


        } catch (
        error
        ) {

            console.error(
                '删除 Push Subscription 失败：',
                error
            )


            return res
                .status(500)
                .json({

                    ok:
                        false,

                    error:
                        '删除 Push Subscription 失败',

                    detail:
                        error.message,

                })

        }

    }
)

// ======================================================
// 健康检查
// ======================================================

app.get(
    '/health',
    (
        req,
        res
    ) => {

        res
            .status(200)
            .json({
                message:
                    '服务正常',
            })

    }
)


// ======================================================
// 数据库连接测试
// GET /api/db-test
// ======================================================

app.get(
    '/api/db-test',
    async (
        req,
        res
    ) => {

        try {

            if (
                !process.env
                    .SUPABASE_URL ||
                !process.env
                    .SUPABASE_SECRET_KEY
            ) {

                return res
                    .status(500)
                    .json({

                        ok:
                            false,

                        error:
                            '服务器没有正确配置 SUPABASE_URL 或 SUPABASE_SECRET_KEY',

                    })

            }

            if (
                !requireSupabase(
                    res
                )
            ) {
                return
            }

            const {
                data,
                error,
            } =
                await supabase
                    .from(
                        'settings'
                    )
                    .select(
                        'id, user_id, session_id, updated_at'
                    )
                    .eq(
                        'user_id',
                        req.userId
                    )
                    .limit(1)

            if (error) {
                throw error
            }

            res
                .status(200)
                .json({

                    ok:
                        true,

                    message:
                        'Supabase 数据库连接成功',

                    data,

                })

        } catch (
        error
        ) {

            console.error(
                '数据库连接测试失败：',
                error
            )

            res
                .status(500)
                .json({

                    ok:
                        false,

                    error:
                        'Supabase 数据库连接失败',

                    detail:
                        error.message,

                })

        }

    }
)


// ======================================================
// 创建会话
// POST /api/sessions
// ======================================================

app.post(
    '/api/sessions',
    async (
        req,
        res
    ) => {

        try {

            if (
                !requireSupabase(
                    res
                )
            ) {
                return
            }

            const {
                name,
            } =
                req.body

            const sessionName =
                typeof name ===
                    'string' &&
                    name.trim()
                    ? name.trim()
                    : '新对话'

            const {
                data,
                error,
            } =
                await supabase
                    .from(
                        'sessions'
                    )
                    .insert([
                        {

                            name:
                                sessionName,

                            user_id:
                                req.userId,

                        },
                    ])
                    .select(
                        'id, name, created_at, updated_at'
                    )
                    .single()

            if (error) {
                throw error
            }

            res
                .status(201)
                .json({

                    ok:
                        true,

                    session:
                        data,

                })

        } catch (
        error
        ) {

            console.error(
                '创建会话失败：',
                error
            )

            res
                .status(500)
                .json({

                    ok:
                        false,

                    error:
                        '创建会话失败',

                    detail:
                        error.message,

                })

        }

    }
)


// ======================================================
// 获取会话列表
// GET /api/sessions
// ======================================================

app.get(
    '/api/sessions',
    async (
        req,
        res
    ) => {

        try {

            if (
                !requireSupabase(
                    res
                )
            ) {
                return
            }

            const {
                data,
                error,
            } =
                await supabase
                    .from(
                        'sessions'
                    )
                    .select(
                        'id, name, created_at, updated_at'
                    )
                    .eq(
                        'user_id',
                        req.userId
                    )
                    .order(

                        'updated_at',
                        {
                            ascending:
                                false,
                        }
                    )

            if (error) {
                throw error
            }

            res
                .status(200)
                .json({

                    ok:
                        true,

                    sessions:
                        data,

                })

        } catch (
        error
        ) {

            console.error(
                '获取会话列表失败：',
                error
            )

            res
                .status(500)
                .json({

                    ok:
                        false,

                    error:
                        '获取会话列表失败',

                    detail:
                        error.message,

                })

        }

    }
)


// ======================================================
// 重命名会话
// PATCH /api/sessions/:id
// ======================================================

app.patch(
    '/api/sessions/:id',
    async (
        req,
        res
    ) => {

        try {

            if (
                !requireSupabase(
                    res
                )
            ) {
                return
            }

            const sessionId =
                parsePositiveSessionId(
                    req.params.id
                )

            const {
                name,
            } =
                req.body

            if (!sessionId) {

                return res
                    .status(400)
                    .json({

                        ok:
                            false,

                        error:
                            '无效的会话 ID',

                    })

            }

            if (
                typeof name !==
                'string' ||
                !name.trim()
            ) {

                return res
                    .status(400)
                    .json({

                        ok:
                            false,

                        error:
                            '会话名称不能为空',

                    })

            }

            const {
                data,
                error,
            } =
                await supabase
                    .from(
                        'sessions'
                    )
                    .update({

                        name:
                            name.trim(),

                    })
                    .eq(
                        'id',
                        sessionId
                    )
                    .eq(
                        'user_id',
                        req.userId
                    )
                    .select(

                        'id, name, created_at, updated_at'
                    )
                    .maybeSingle()

            if (error) {
                throw error
            }

            if (!data) {

                return res
                    .status(404)
                    .json({

                        ok:
                            false,

                        error:
                            '会话不存在',

                    })

            }

            res
                .status(200)
                .json({

                    ok:
                        true,

                    session:
                        data,

                })

        } catch (
        error
        ) {

            console.error(
                '重命名会话失败：',
                error
            )

            res
                .status(500)
                .json({

                    ok:
                        false,

                    error:
                        '重命名会话失败',

                    detail:
                        error.message,

                })

        }

    }
)


// ======================================================
// 删除会话
// DELETE /api/sessions/:id
// ======================================================

app.delete(
    '/api/sessions/:id',
    async (
        req,
        res
    ) => {

        try {

            if (
                !requireSupabase(
                    res
                )
            ) {
                return
            }

            const sessionId =
                parsePositiveSessionId(
                    req.params.id
                )

            if (!sessionId) {

                return res
                    .status(400)
                    .json({

                        ok:
                            false,

                        error:
                            '无效的会话 ID',

                    })

            }

            const {
                data:
                existingSession,

                error:
                findError,
            } =
                await supabase
                    .from(
                        'sessions'
                    )
                    .select(
                        'id, name, created_at, updated_at'
                    )
                    .eq(
                        'id',
                        sessionId
                    )
                    .eq(
                        'user_id',
                        req.userId
                    )
                    .maybeSingle()


            if (
                findError
            ) {
                throw findError
            }

            if (
                !existingSession
            ) {

                return res
                    .status(404)
                    .json({

                        ok:
                            false,

                        error:
                            '会话不存在',

                    })

            }

            const {
                error:
                deleteError,
            } =
                await supabase
                    .from(
                        'sessions'
                    )
                    .delete()
                    .eq(
                        'id',
                        sessionId
                    )
                    .eq(
                        'user_id',
                        req.userId
                    )


            if (
                deleteError
            ) {
                throw deleteError
            }

            res
                .status(200)
                .json({

                    ok:
                        true,

                    message:
                        '会话删除成功',

                    deletedSession:
                        existingSession,

                })

        } catch (
        error
        ) {

            console.error(
                '删除会话失败：',
                error
            )

            res
                .status(500)
                .json({

                    ok:
                        false,

                    error:
                        '删除会话失败',

                    detail:
                        error.message,

                })

        }

    }
)


// ======================================================
// 获取历史消息
// GET /api/sessions/:id/messages
// ======================================================

app.get(
    '/api/sessions/:id/messages',
    async (
        req,
        res
    ) => {

        try {

            res.set(
                'Cache-Control',
                'no-store, no-cache, must-revalidate, proxy-revalidate'
            )

            if (
                !requireSupabase(
                    res
                )
            ) {
                return
            }

            const sessionId =
                parsePositiveSessionId(
                    req.params.id
                )

            if (!sessionId) {

                return res
                    .status(400)
                    .json({

                        ok:
                            false,

                        error:
                            '无效的会话 ID',

                    })

            }

            const session =
                await getSessionById(
                    sessionId,
                    req.userId
                )


            if (!session) {

                return res
                    .status(404)
                    .json({

                        ok:
                            false,

                        error:
                            '会话不存在',

                    })

            }

            const {
                data:
                messages,

                error:
                messagesError,
            } =
                await supabase
                    .from(
                        'messages'
                    )
                    .select(
                        'id, session_id, role, content, created_at, visible, reasoning_content'
                    )
                    .eq(
                        'session_id',
                        sessionId
                    )
                    .eq(
                        'visible',
                        true
                    )
                    .order(
                        'created_at',
                        {
                            ascending:
                                true,
                        }
                    )
                    .order(
                        'id',
                        {
                            ascending:
                                true,
                        }
                    )

            if (
                messagesError
            ) {
                throw messagesError
            }

            res
                .status(200)
                .json({

                    ok:
                        true,

                    session,

                    messages:
                        messages || [],

                })

        } catch (
        error
        ) {

            console.error(
                '获取历史消息失败：',
                error
            )

            res
                .status(500)
                .json({

                    ok:
                        false,

                    error:
                        '获取历史消息失败',

                    detail:
                        error.message,

                })

        }

    }
)


// ======================================================
// 获取设置
// GET /api/settings
// ======================================================

app.get(
    '/api/settings',
    async (
        req,
        res
    ) => {

        try {

            if (
                !requireSupabase(
                    res
                )
            ) {
                return
            }

            const settings =
                await getGlobalSettings(
                    req.userId
                )

            res
                .status(200)
                .json({

                    ok:
                        true,

                    settings,

                })

        } catch (
        error
        ) {

            console.error(
                '读取设置失败：',
                error
            )

            res
                .status(500)
                .json({

                    ok:
                        false,

                    error:
                        '读取设置失败',

                    detail:
                        error.message,

                })

        }

    }
)


// ======================================================
// 修改设置
// PATCH /api/settings
// ======================================================

app.patch(
    '/api/settings',
    async (
        req,
        res
    ) => {

        try {

            if (
                !requireSupabase(
                    res
                )
            ) {
                return
            }

            const {

                system_prompt,

                character_context,

                timezone,

                temperature,

                max_context_rounds,

                max_context_tokens,

                compress_threshold,

                compress_keep_rounds,

                max_reply_tokens,

            } =
                req.body


            await getGlobalSettings(
                req.userId
            )


            const updates = {}

            if (
                system_prompt !==
                undefined
            ) {

                if (
                    typeof system_prompt !==
                    'string'
                ) {

                    return res
                        .status(400)
                        .json({

                            ok:
                                false,

                            error:
                                'system_prompt 必须是字符串',

                        })

                }

                updates.system_prompt =
                    system_prompt

            }

            if (
                character_context !==
                undefined
            ) {

                if (
                    typeof character_context !==
                    'string'
                ) {

                    return res
                        .status(400)
                        .json({

                            ok:
                                false,

                            error:
                                'character_context 必须是字符串',

                        })

                }

                updates.character_context =
                    character_context

            }
            if (
                timezone !==
                undefined
            ) {

                if (
                    typeof timezone !==
                    'string'
                ) {

                    return res
                        .status(400)
                        .json({

                            ok:
                                false,

                            error:
                                'timezone 必须是字符串',

                        })

                }


                const normalizedTimezone =
                    timezone.trim()


                if (
                    !normalizedTimezone ||
                    !getValidTimeZone(
                        normalizedTimezone
                    )
                ) {

                    return res
                        .status(400)
                        .json({

                            ok:
                                false,

                            error:
                                'timezone 不是有效的 IANA 时区',

                        })

                }


                updates.timezone =
                    normalizedTimezone

            }

            if (
                temperature !==
                undefined
            ) {

                const value =
                    Number(
                        temperature
                    )

                if (
                    !Number.isFinite(
                        value
                    ) ||
                    value < 0 ||
                    value > 2
                ) {

                    return res
                        .status(400)
                        .json({

                            ok:
                                false,

                            error:
                                'temperature 必须在 0 到 2 之间',

                        })

                }

                updates.temperature =
                    value

            }

            const integerFields = {

                max_context_rounds,

                max_context_tokens,

                compress_threshold,

                compress_keep_rounds,

                max_reply_tokens,

            }

            for (
                const [
                    key,
                    value,
                ]
                of Object.entries(
                    integerFields
                )
            ) {

                if (
                    value ===
                    undefined
                ) {
                    continue
                }

                const numberValue =
                    Number(
                        value
                    )

                if (
                    !Number.isInteger(
                        numberValue
                    ) ||
                    numberValue <= 0
                ) {

                    return res
                        .status(400)
                        .json({

                            ok:
                                false,

                            error:
                                `${key} 必须是大于 0 的整数`,

                        })

                }

                updates[key] =
                    numberValue

            }

            if (
                Object.keys(
                    updates
                ).length === 0
            ) {

                return res
                    .status(400)
                    .json({

                        ok:
                            false,

                        error:
                            '没有提供需要修改的设置',

                    })

            }

            const {
                data,
                error,
            } =
                await supabase
                    .from(
                        'settings'
                    )
                    .update(
                        updates
                    )
                    .eq(
                        'session_id',
                        'global'
                    )
                    .eq(
                        'user_id',
                        req.userId
                    )
                    .select(`
                id,
                user_id,
                session_id,
                system_prompt,
                character_context,
                timezone,
                temperature,
                max_context_rounds,
                max_context_tokens,
                compress_threshold,
                compress_keep_rounds,
                max_reply_tokens,
                hermit_avatar_url,
                user_avatar_url,
                background_url,
                updated_at
            `)

                    .maybeSingle()

            if (error) {
                throw error
            }

            if (!data) {

                return res
                    .status(404)
                    .json({

                        ok:
                            false,

                        error:
                            '没有找到全局设置',

                    })

            }

            res
                .status(200)
                .json({

                    ok:
                        true,

                    settings:
                        data,

                })

        } catch (
        error
        ) {

            console.error(
                '更新设置失败：',
                error
            )

            res
                .status(500)
                .json({

                    ok:
                        false,

                    error:
                        '更新设置失败',

                    detail:
                        error.message,

                })

        }

    }
)


// ======================================================
// 上下文 Token 状态
// GET /api/sessions/:id/context-stats
// ======================================================

app.get(
    '/api/sessions/:id/context-stats',
    async (
        req,
        res
    ) => {

        try {

            if (
                !requireSupabase(
                    res
                )
            ) {
                return
            }

            const sessionId =
                parsePositiveSessionId(
                    req.params.id
                )

            if (!sessionId) {

                return res
                    .status(400)
                    .json({

                        ok:
                            false,

                        error:
                            '无效的会话 ID',

                    })

            }

            const session =
                await getSessionById(
                    sessionId,
                    req.userId
                )


            if (!session) {

                return res
                    .status(404)
                    .json({

                        ok:
                            false,

                        error:
                            '会话不存在',

                    })

            }

            const settings =
                await getGlobalSettings(
                    req.userId
                )

            const memory =
                await getLatestMemory(
                    req.userId
                )

            const memorySummary =
                typeof memory
                    ?.summary ===
                    'string'
                    ? memory
                        .summary
                        .trim()
                    : ''

            const messages =
                await getVisibleMessages(
                    sessionId
                )

            const latestUserMessage =
                [
                    ...messages,
                ]
                    .reverse()
                    .find(
                        (item) =>
                            item.role ===
                            'user'
                    )
                    ?.content ||
                ''


            const characterLore =
                await getCharacterLoreContext({

                    userId:
                        req.userId,

                    currentMessage:
                        latestUserMessage,

                    recentMessages:
                        messages.slice(
                            -8
                        ),

                })


            const fullContext =
                buildModelContext({

                    settings,

                    memorySummary,

                    messages,

                    characterLoreContext:
                        characterLore
                            .context,

                })

            const estimatedTokens =
                estimateTokens(
                    fullContext
                )

            const compressThreshold =
                Number(
                    settings
                        .compress_threshold
                ) || 10000

            const keepRounds =
                Math.max(
                    1,
                    Number(
                        settings
                            .compress_keep_rounds
                    ) || 6
                )

            const {
                compressibleMessages,
            } =
                splitMessagesForCompression(
                    messages,
                    keepRounds
                )

            const thresholdReached =
                estimatedTokens >=
                compressThreshold

            res
                .status(200)
                .json({

                    ok:
                        true,

                    session,

                    session_id:
                        sessionId,

                    message_count:
                        messages.length,

                    estimated_tokens:
                        estimatedTokens,

                    compress_threshold:
                        compressThreshold,

                    max_context_tokens:
                        Number(
                            settings
                                .max_context_tokens
                        ) || 12000,

                    compress_keep_rounds:
                        keepRounds,

                    threshold_reached:
                        thresholdReached,

                    compressible_message_count:
                        compressibleMessages
                            .length,

                    should_compress:
                        thresholdReached &&
                        compressibleMessages
                            .length > 0,

                    latest_memory_id:
                        memory
                            ?.id ||
                        null,

                })

        } catch (
        error
        ) {

            console.error(
                '计算上下文 Token 失败：',
                error
            )

            res
                .status(500)
                .json({

                    ok:
                        false,

                    error:
                        '计算上下文 Token 失败',

                    detail:
                        error.message,

                })

        }

    }
)


// ======================================================
// 核心 AI 对话
// POST /api/chat
// ======================================================

app.post(
    '/api/chat',
    async (
        req,
        res
    ) => {

        try {

            if (
                !requireSupabase(
                    res
                )
            ) {
                return
            }

            if (
                !requireAIConfig(
                    res
                )
            ) {
                return
            }

            const {

                message,

                session_id,

            } =
                req.body

            if (
                typeof message !==
                'string' ||
                !message.trim()
            ) {

                return res
                    .status(400)
                    .json({

                        ok:
                            false,

                        error:
                            'message 不能为空',

                    })

            }

            const cleanMessage =
                message.trim()

            let sessionId =
                null

            const hasSessionId =
                session_id !==
                undefined &&
                session_id !==
                null &&
                session_id !==
                ''

            if (
                hasSessionId
            ) {

                const parsedSessionId =
                    parsePositiveSessionId(
                        session_id
                    )

                if (
                    !parsedSessionId
                ) {

                    return res
                        .status(400)
                        .json({

                            ok:
                                false,

                            error:
                                '无效的 session_id',

                        })

                }

                const session =
                    await getSessionById(
                        parsedSessionId,
                        req.userId
                    )


                if (!session) {

                    return res
                        .status(404)
                        .json({

                            ok:
                                false,

                            error:
                                '会话不存在',

                        })

                }

                sessionId =
                    session.id

            } else {

                const {
                    data:
                    recentSessions,

                    error:
                    recentSessionError,
                } =
                    await supabase
                        .from(
                            'sessions'
                        )
                        .select(
                            'id, name, updated_at'
                        )
                        .eq(
                            'user_id',
                            req.userId
                        )
                        .order(
                            'updated_at',
                            {
                                ascending:
                                    false,
                            }
                        )
                        .limit(1)

                if (
                    recentSessionError
                ) {
                    throw recentSessionError
                }

                if (
                    recentSessions &&
                    recentSessions
                        .length > 0
                ) {

                    sessionId =
                        recentSessions[0]
                            .id

                } else {

                    const {
                        data:
                        newSession,

                        error:
                        newSessionError,
                    } =
                        await supabase
                            .from(
                                'sessions'
                            )
                            .insert([
                                {

                                    name:
                                        '新对话',

                                    user_id:
                                        req.userId,

                                },
                            ])
                            .select(
                                'id'
                            )
                            .single()

                    if (
                        newSessionError
                    ) {
                        throw newSessionError
                    }

                    sessionId =
                        newSession.id

                }

            }


            // ==================================================
            // 保存真正的用户消息
            // ==================================================

            const {
                data:
                userMessage,

                error:
                userMessageError,
            } =
                await supabase
                    .from(
                        'messages'
                    )
                    .insert([
                        {

                            user_id:
                                req.userId,

                            session_id:
                                sessionId,

                            role:
                                'user',

                            content:
                                cleanMessage,

                            visible:
                                true,

                        },
                    ])
                    .select(
                        'id, session_id, role, content, created_at, visible'
                    )
                    .single()

            if (
                userMessageError
            ) {
                throw userMessageError
            }


            const settings =
                await getGlobalSettings(
                    req.userId
                )


            // ==================================================
            // 检查当前消息是否包含提醒创建 / 查询 / 取消 / 修改请求
            // ==================================================

            const reminderRecentMessages =
                await getRecentVisibleMessages(
                    sessionId,
                    settings
                )


            let reminderResult = {
                status:
                    'none',
            }


            if (
                shouldAnalyzeReminderIntent(
                    cleanMessage,
                    reminderRecentMessages
                )
            ) {

                try {

                    reminderResult =
                        await analyzeReminderIntent({

                            sessionId,

                            userId:
                                req.userId,

                            settings,

                            cleanMessage,

                            userMessageId:
                                userMessage.id,

                            recentMessages:
                                reminderRecentMessages,

                        })

                } catch (
                reminderError
                ) {

                    console.error(
                        '提醒识别或保存失败：',
                        reminderError
                    )


                    // 很重要：
                    // 失败时绝对不能让模型假装“提醒已经设置成功”
                    reminderResult = {

                        status:
                            'clarify',

                        clarification:
                            '这次提醒没有成功保存，请让用户重新确认一次具体时间。',

                    }

                }

            }


            const compression =
                await compressMemoryIfNeeded(
                    sessionId,
                    settings,
                    req.userId
                )



            const latestMemory =
                await getLatestMemory(
                    req.userId
                )


            const memorySummary =
                typeof latestMemory
                    ?.summary ===
                    'string'
                    ? latestMemory
                        .summary
                        .trim()
                    : ''


            const history =
                await getRecentVisibleMessages(
                    sessionId,
                    settings
                )


            const characterLore =
                await getCharacterLoreContext({

                    userId:
                        req.userId,

                    currentMessage:
                        cleanMessage,

                    recentMessages:
                        history,

                })


            const baseModelInput =
                buildModelContext({

                    settings,

                    memorySummary,

                    messages:
                        history,

                    characterLoreContext:
                        characterLore
                            .context,

                })


            const reminderReplyContext =
                buildReminderReplyContext(
                    reminderResult
                )


            const modelInput =
                reminderReplyContext
                    ? `${baseModelInput}

${reminderReplyContext}`
                    : baseModelInput


            const finalEstimatedTokens =
                estimateTokens(
                    modelInput
                )


            const response =
                await callModelWithRetry({

                    model:
                        'gpt-5.6-sol',

                    input:
                        modelInput,

                })

            const reply =
                typeof response
                    .output_text ===
                    'string'
                    ? response
                        .output_text
                        .trim()
                    : ''


            if (!reply) {

                throw new Error(
                    'AI 没有返回有效的文本回复'
                )

            }


            const {
                data:
                assistantMessage,

                error:
                assistantMessageError,
            } =
                await supabase
                    .from(
                        'messages'
                    )
                    .insert([
                        {

                            user_id:
                                req.userId,

                            session_id:
                                sessionId,

                            role:
                                'assistant',

                            content:
                                reply,

                            visible:
                                true,

                        },
                    ])
                    .select(
                        'id, session_id, role, content, created_at, visible'
                    )
                    .single()


            if (
                assistantMessageError
            ) {
                throw assistantMessageError
            }


            const {
                error:
                sessionUpdateError,
            } =
                await supabase
                    .from(
                        'sessions'
                    )
                    .update({

                        updated_at:
                            new Date()
                                .toISOString(),

                    })
                    .eq(
                        'id',
                        sessionId
                    )
                    .eq(
                        'user_id',
                        req.userId
                    )


            if (
                sessionUpdateError
            ) {

                console.error(
                    '更新 session 时间失败：',
                    sessionUpdateError
                )

            }


            res
                .status(200)
                .json({

                    ok:
                        true,

                    session_id:
                        sessionId,

                    reply,

                    estimated_tokens:
                        finalEstimatedTokens,

                    compression,

                    user_message:
                        userMessage,

                    assistant_message:
                        assistantMessage,

                    reminder:
                        reminderResult
                            .status ===
                            'created'
                            ? reminderResult
                                .reminder
                            : null,


                })


        } catch (
        error
        ) {

            console.error(
                'AI 对话处理失败：',
                error
            )

            res
                .status(500)
                .json({

                    ok:
                        false,

                    error:
                        'AI 对话处理失败',

                    detail:
                        error.message,

                })

        }

    }
)


// ======================================================
// 手动触发星星主动发消息
// POST /api/proactive-message
//
// Body：
// {
//     "session_id": 1
// }
// ======================================================

app.post(
    '/api/proactive-message',
    async (
        req,
        res
    ) => {

        try {

            if (
                !requireSupabase(
                    res
                )
            ) {
                return
            }

            if (
                !requireAIConfig(
                    res
                )
            ) {
                return
            }

            const sessionId =
                parsePositiveSessionId(
                    req.body
                        ?.session_id
                )

            if (!sessionId) {

                return res
                    .status(400)
                    .json({

                        ok:
                            false,

                        error:
                            '必须提供有效的 session_id',

                    })

            }

            const session =
                await getSessionById(
                    sessionId,
                    req.userId
                )

            if (!session) {

                return res
                    .status(404)
                    .json({

                        ok:
                            false,

                        error:
                            '会话不存在',

                    })

            }

            const {
                reply,
                assistantMessage,
                pushResult,
            } =
                await generateAndSaveProactiveMessage(
                    sessionId,
                    'manual'
                )


            // 主动消息故意不修改 sessions.updated_at，
            // 避免改变会话卡顺序。

            res
                .status(200)
                .json({

                    ok:
                        true,

                    session_id:
                        sessionId,

                    reply,

                    assistant_message:
                        assistantMessage,

                    push_result:
                        pushResult,


                })

        } catch (
        error
        ) {

            console.error(
                '生成主动消息失败：',
                error
            )

            res
                .status(500)
                .json({

                    ok:
                        false,

                    error:
                        '生成主动消息失败',

                    detail:
                        error.message,

                })

        }

    }
)


// ======================================================
// 自动检查是否应该主动联系用户
// POST /api/proactive-check
//
// Render 环境变量：
//
// PROACTIVE_CRON_SECRET=你的随机安全密钥
//
// 测试：
// PROACTIVE_IDLE_MINUTES=1
//
// 正式：
// PROACTIVE_IDLE_MINUTES=360
//
// 360 分钟 = 6 小时
// ======================================================

app.post(
    '/api/proactive-check',
    async (
        req,
        res
    ) => {

        try {

            if (
                !requireSupabase(
                    res
                )
            ) {
                return
            }

            if (
                !requireAIConfig(
                    res
                )
            ) {
                return
            }

            const expectedSecret =
                process.env
                    .PROACTIVE_CRON_SECRET

            if (!expectedSecret) {

                return res
                    .status(500)
                    .json({
                        ok: false,
                        error:
                            '服务器没有配置 PROACTIVE_CRON_SECRET',
                    })
            }

            const receivedSecret =
                req.headers[
                    'x-proactive-secret'
                ]

            if (
                receivedSecret !==
                expectedSecret
            ) {

                return res
                    .status(401)
                    .json({
                        ok: false,
                        error:
                            'Unauthorized',
                    })
            }

            // 找出当前有会话的所有用户。
            const {
                data: sessionOwners,
                error: ownersError,
            } = await supabase
                .from('sessions')
                .select('user_id')
                .not(
                    'user_id',
                    'is',
                    null
                )

            if (ownersError) {
                throw ownersError
            }

            const userIds = [
                ...new Set(
                    (sessionOwners || [])
                        .map(
                            (item) =>
                                item.user_id
                        )
                        .filter(Boolean)
                ),
            ]

            if (
                userIds.length === 0
            ) {

                return res
                    .status(200)
                    .json({
                        ok: true,
                        users_checked: 0,
                        sent: 0,
                        reason:
                            'no_users',
                        results: [],
                    })
            }

            const configuredIdleMinutes =
                Number(
                    process.env
                        .PROACTIVE_IDLE_MINUTES
                )

            const idleMinutesRequired =
                Number.isFinite(
                    configuredIdleMinutes
                ) &&
                    configuredIdleMinutes > 0
                    ? configuredIdleMinutes
                    : 360

            const results = []
            let sentCount = 0

            for (
                const userId
                of userIds
            ) {

                try {

                    const {
                        data: latestUserMessages,
                        error: latestUserMessageError,
                    } = await supabase
                        .from('messages')
                        .select(
                            'id, session_id, created_at'
                        )
                        .eq(
                            'user_id',
                            userId
                        )
                        .eq(
                            'role',
                            'user'
                        )
                        .eq(
                            'visible',
                            true
                        )
                        .order(
                            'created_at',
                            {
                                ascending: false,
                            }
                        )
                        .order(
                            'id',
                            {
                                ascending: false,
                            }
                        )
                        .limit(1)

                    if (
                        latestUserMessageError
                    ) {
                        throw latestUserMessageError
                    }

                    if (
                        !latestUserMessages ||
                        latestUserMessages
                            .length === 0
                    ) {

                        results.push({
                            user_id:
                                userId,
                            sent: false,
                            reason:
                                'no_user_messages',
                        })
                        continue
                    }

                    const sessionId =
                        latestUserMessages[0]
                            .session_id

                    const session =
                        await getSessionById(
                            sessionId,
                            userId
                        )

                    if (!session) {

                        results.push({
                            user_id:
                                userId,
                            sent: false,
                            reason:
                                'session_not_found',
                        })
                        continue
                    }

                    const {
                        data: latestMessages,
                        error: latestMessageError,
                    } = await supabase
                        .from('messages')
                        .select(
                            'id, role, content, created_at, reasoning_content'
                        )
                        .eq(
                            'user_id',
                            userId
                        )
                        .eq(
                            'session_id',
                            sessionId
                        )
                        .eq(
                            'visible',
                            true
                        )
                        .in(
                            'role',
                            [
                                'user',
                                'assistant',
                            ]
                        )
                        .order(
                            'created_at',
                            {
                                ascending: false,
                            }
                        )
                        .order(
                            'id',
                            {
                                ascending: false,
                            }
                        )
                        .limit(1)

                    if (latestMessageError) {
                        throw latestMessageError
                    }

                    if (
                        !latestMessages ||
                        latestMessages
                            .length === 0
                    ) {

                        results.push({
                            user_id:
                                userId,
                            session_id:
                                sessionId,
                            sent: false,
                            reason:
                                'no_messages',
                        })
                        continue
                    }

                    const latestMessage =
                        latestMessages[0]

                    if (
                        latestMessage
                            .reasoning_content ===
                        'proactive'
                    ) {

                        results.push({
                            user_id:
                                userId,
                            session_id:
                                sessionId,
                            sent: false,
                            reason:
                                'waiting_for_user_reply',
                        })
                        continue
                    }

                    const lastMessageTime =
                        new Date(
                            latestMessage
                                .created_at
                        ).getTime()

                    if (
                        !Number.isFinite(
                            lastMessageTime
                        )
                    ) {
                        throw new Error(
                            '最后一条消息的 created_at 无效'
                        )
                    }

                    const idleMinutes =
                        Math.floor(
                            (
                                Date.now() -
                                lastMessageTime
                            ) /
                            60000
                        )

                    if (
                        idleMinutes <
                        idleMinutesRequired
                    ) {

                        results.push({
                            user_id:
                                userId,
                            session_id:
                                sessionId,
                            sent: false,
                            reason:
                                'not_idle_long_enough',
                            idle_minutes:
                                idleMinutes,
                            required_idle_minutes:
                                idleMinutesRequired,
                        })
                        continue
                    }

                    const {
                        reply,
                        assistantMessage,
                        pushResult,
                    } =
                        await generateAndSaveProactiveMessage(
                            sessionId,
                            'automatic'
                        )

                    sentCount += 1

                    results.push({
                        user_id:
                            userId,
                        session_id:
                            sessionId,
                        sent: true,
                        idle_minutes:
                            idleMinutes,
                        required_idle_minutes:
                            idleMinutesRequired,
                        reply,
                        assistant_message:
                            assistantMessage,
                        push_result:
                            pushResult,
                    })

                } catch (userError) {

                    console.error(
                        `用户 ${userId} 的主动消息检查失败：`,
                        userError
                    )

                    results.push({
                        user_id:
                            userId,
                        sent: false,
                        reason:
                            'error',
                        error:
                            userError.message,
                    })
                }
            }

            return res
                .status(200)
                .json({
                    ok: true,
                    users_checked:
                        userIds.length,
                    sent:
                        sentCount,
                    results,
                })

        } catch (error) {

            console.error(
                '自动主动消息检查失败：',
                error
            )

            return res
                .status(500)
                .json({
                    ok: false,
                    error:
                        '自动主动消息检查失败',
                    detail:
                        error.message,
                })
        }
    }
)


// ======================================================
// 自动检查到期提醒
// POST /api/reminder-check
// ======================================================

app.post(
    '/api/reminder-check',
    async (
        req,
        res
    ) => {

        try {

            if (
                !requireSupabase(
                    res
                )
            ) {
                return
            }

            if (
                !requireAIConfig(
                    res
                )
            ) {
                return
            }


            // ==================================================
            // 安全密钥
            //
            // 暂时复用主动消息已有的
            // PROACTIVE_CRON_SECRET
            // ==================================================

            const expectedSecret =
                process.env
                    .PROACTIVE_CRON_SECRET

            if (!expectedSecret) {

                return res
                    .status(500)
                    .json({

                        ok:
                            false,

                        error:
                            '服务器没有配置 PROACTIVE_CRON_SECRET',

                    })

            }

            const receivedSecret =
                req.headers[
                'x-proactive-secret'
                ]

            if (
                receivedSecret !==
                expectedSecret
            ) {

                return res
                    .status(401)
                    .json({

                        ok:
                            false,

                        error:
                            'Unauthorized',

                    })

            }


            // ==================================================
            // 找已经到 remind_at 的 pending 提醒
            // ==================================================

            const nowIso =
                new Date()
                    .toISOString()

            const {
                data:
                dueReminders,

                error:
                remindersError,
            } =
                await supabase
                    .from(
                        'reminders'
                    )
                    .select(
                        'id, user_id, session_id, source_message_id, content, event_at, remind_at, timezone, status, remind_before_minutes, created_at, sent_at, metadata'
                    )
                    .eq(
                        'status',
                        'pending'
                    )
                    .lte(
                        'remind_at',
                        nowIso
                    )
                    .order(
                        'remind_at',
                        {
                            ascending:
                                true,
                        }
                    )
                    .limit(
                        20
                    )

            if (
                remindersError
            ) {
                throw remindersError
            }


            // 没有到期提醒

            if (
                !dueReminders ||
                dueReminders.length === 0
            ) {

                return res
                    .status(200)
                    .json({

                        ok:
                            true,

                        processed:
                            0,

                        sent:
                            0,

                        failed:
                            0,

                        reason:
                            'no_due_reminders',

                    })

            }


            const results = []

            let sentCount = 0
            let failedCount = 0


            // ==================================================
            // 一条一条发送
            // ==================================================

            for (
                const reminder
                of dueReminders
            ) {

                try {

                    const result =
                        await generateAndSaveReminderMessage(
                            reminder
                        )

                    if (
                        result.sent
                    ) {
                        sentCount += 1
                    }

                    results.push({

                        reminder_id:
                            reminder.id,

                        ok:
                            true,

                        sent:
                            Boolean(
                                result.sent
                            ),

                        reason:
                            result.reason ||
                            'sent',

                        assistant_message_id:
                            result
                                .assistantMessage
                                ?.id ||
                            null,

                        push_result:
                            result
                                .pushResult ||
                            null,

                    })

                } catch (
                reminderError
                ) {

                    failedCount += 1

                    console.error(
                        `处理 reminder id=${reminder.id} 失败：`,
                        reminderError
                    )

                    results.push({

                        reminder_id:
                            reminder.id,

                        ok:
                            false,

                        sent:
                            false,

                        error:
                            reminderError
                                .message,

                    })

                }

            }


            return res
                .status(200)
                .json({

                    ok:
                        true,

                    processed:
                        dueReminders.length,

                    sent:
                        sentCount,

                    failed:
                        failedCount,

                    results,

                })


        } catch (error) {

            console.error(
                '自动提醒检查失败：',
                error
            )

            return res
                .status(500)
                .json({

                    ok:
                        false,

                    error:
                        '自动提醒检查失败',

                    detail:
                        error.message,

                })

        }

    }
)

// ======================================================
// 启动服务器
// ======================================================

app.listen(
    PORT,
    '0.0.0.0',
    () => {

        console.log(
            `Server is running on port ${PORT}`
        )

    }
)
