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

const AI_REQUEST_TIMEOUT_MS =
    Math.min(
        120000,
        Math.max(
            15000,
            Number(
                process.env.AI_REQUEST_TIMEOUT_MS
            ) || 45000
        )
    )

const client = new OpenAI({
    apiKey: process.env.AI_API_KEY,
    baseURL: process.env.AI_BASE_URL,

    // 第三方兼容线路繁忙时，SDK 自己重试会把一次请求拖成几分钟。
    // 这里关闭 SDK 隐藏重试，统一交给下面的 callModelWithRetry 控制。
    maxRetries: 0,

    // 默认 45 秒。Render 无需新增环境变量；
    // 如果以后确实要调整，可选配置 AI_REQUEST_TIMEOUT_MS。
    timeout: AI_REQUEST_TIMEOUT_MS,
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


function isModelTimeoutError(error) {

    const name =
        String(
            error?.name || ''
        ).toUpperCase()

    const code =
        getModelErrorCode(
            error
        )

    const message =
        String(
            error?.message || ''
        ).toLowerCase()

    return (
        name.includes(
            'TIMEOUT'
        ) ||
        code.includes(
            'TIMEOUT'
        ) ||
        message.includes(
            'timed out'
        ) ||
        message.includes(
            'timeout'
        )
    )
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
    maxAttempts = 2
) {

    let lastError =
        null

    // ==================================================
    // 保留原来的请求指纹，但改成“软校验”
    //
    // Aizex / 第三方兼容线路没有回显标记时：
    // - 记录 warning
    // - 接受正常正文
    // - 不再因为缺少 HERMIT_OK 自动重试
    //
    // 这样不会再把一个正常回答放大成多轮长等待。
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

    const guardedRequest =
        integrityMarker
            ? {
                ...request,

                input:
                    `${originalInput}

【响应完整性校验】
请正常完成上面的任务。
在全部正常输出结束后，如果当前线路支持，请另起一行原样输出下面这段校验标记：
${integrityMarker}

不要解释这段标记，不要改写它，也不要把它放进正文中。服务端会在返回给用户前自动删除。`,
            }
            : request


    for (
        let attempt = 1;
        attempt <= maxAttempts;
        attempt += 1
    ) {

        const attemptStartedAt =
            Date.now()

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
            // HERMIT_OK 改为软校验：
            // 没有回显时只记录日志，不把正常回答判死。
            // ------------------------------------------

            if (
                integrityMarker &&
                !outputText.includes(
                    integrityMarker
                )
            ) {

                console.warn(
                    `模型响应未回显完整性校验标记（${integrityId}），本次接受正文，不因此重试`
                )
            }


            // 如果有标记则删除；没有标记就原样使用正文。
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
                        '模型正文为空'
                    )

                emptyAfterCheckError.retryable =
                    true

                throw emptyAfterCheckError
            }


            const elapsedMs =
                Date.now() -
                attemptStartedAt

            if (
                elapsedMs >=
                10000
            ) {

                console.log(
                    `模型请求成功，耗时 ${elapsedMs}ms（第 ${attempt} 次尝试）`
                )
            }


            return {
                ...response,

                output_text:
                    cleanedOutputText,
            }


        } catch (error) {

            lastError =
                error

            const elapsedMs =
                Date.now() -
                attemptStartedAt


            // ------------------------------------------
            // 超时后不再从头等第二遍。
            // SDK 内部重试已经关闭，所以单次最长由
            // AI_REQUEST_TIMEOUT_MS 控制（默认 45 秒）。
            // ------------------------------------------

            if (
                isModelTimeoutError(
                    error
                )
            ) {

                console.warn(
                    `模型请求超时，已等待 ${elapsedMs}ms；为避免拖成几分钟，本轮不再重试：`,
                    error?.message ||
                    error
                )

                throw error
            }


            const canRetry =
                isRetryableModelError(
                    error
                )


            // 如果一个 503 / 5xx 本身已经让我们等了很久，
            // 再从头请求一次通常只会继续拖慢。
            // 只有 8 秒内“快速失败”的临时错误才值得重试一次。
            const failedQuickly =
                elapsedMs <
                8000


            if (
                !canRetry ||
                attempt >=
                maxAttempts ||
                !failedQuickly
            ) {

                if (
                    canRetry &&
                    !failedQuickly
                ) {

                    console.warn(
                        `模型请求在 ${elapsedMs}ms 后失败；为避免继续拖延，本轮不再重试：`,
                        error?.message ||
                        error
                    )
                }

                throw error
            }


            const delayMs =
                800


            console.warn(
                `模型请求快速失败，${delayMs}ms 后只重试一次（${attempt}/${maxAttempts}）：`,
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
// 原始完整剧情库：按需检索 lore_chunks
//
// 设计目标：
// 1. 普通日常聊天完全不读取完整剧情。
// 2. 只有用户明确回忆过去、提到原作设定/卡面，或命中
//    骑士学校、剑穗、王储、菲罗斯等明确剧情词时才检索。
// 3. 最多选 3 个片段，并控制额外上下文 Token。
// 4. 数据库读取失败时自动降级，不阻断聊天。
// 5. lore_chunks 是共享原始素材；只有当前用户已经启用
//    “沈星回” character_lore 时才允许注入，避免多用户串素材。
// ======================================================

const LORE_CHUNKS_CACHE_TTL_MS =
    2 * 60 * 1000

let loreChunksCache = {
    loadedAt: 0,
    rows: [],
}

const STORY_CANON_TERMS = [
    '国王卡',
    '婚卡',
    '师兄卡',
    '烟火来处',
    '细琢辰光',
    '粲然须臾',
    '问剑观花',
    '洄光颂',
    '越夜携心',
    '光猎',
    '两心同',
    '漫航悸遇',
    '池光温陷',
    '二十一日',

    '菲罗斯',
    '王子',
    '王储',
    '国王',
    '女王',
    '疯王',
    '骑士',
    '骑士团',
    '首席骑士',
    '圣剑骑士',
    '师兄',
    '师妹',
    '骑士学校',
    '学校',
    '学院',
    '剑穗',
    '星星剑穗',
    '星辰花',
    '光剑',
    '星球之心',
    '流浪体',
    '回溯',
    '烬城',
    '巴别会',
    '异象空间',
    '星泊地',
    '远航',
    '旅伴',
]

const STORY_TRIGGER_TERMS = [
    '国王卡',
    '婚卡',
    '师兄卡',
    '烟火来处',
    '细琢辰光',
    '粲然须臾',
    '问剑观花',
    '洄光颂',
    '越夜携心',
    '光猎',
    '两心同',
    '漫航悸遇',
    '池光温陷',
    '二十一日',

    '菲罗斯',
    '王储',
    '疯王',
    '骑士学校',
    '首席骑士',
    '圣剑骑士',
    '师兄',
    '师妹',
    '剑穗',
    '星星剑穗',
    '星球之心',
    '流浪体',
    '烬城',
    '巴别会',
    '异象空间',
    '星泊地',
]

const STORY_STOP_TERMS =
    new Set([
        '我们',
        '你们',
        '他们',
        '她们',
        '这个',
        '那个',
        '这些',
        '那些',
        '什么',
        '怎么',
        '为什么',
        '可以',
        '还是',
        '已经',
        '就是',
        '真的',
        '觉得',
        '一下',
        '现在',
        '今天',
        '然后',
        '后来',
        '因为',
        '所以',
        '但是',
        '如果',
        '一个',
        '一点',
        '时候',
        '自己',
        '记得',
        '还记',
        '以前',
        '过去',
        '当时',
        '那次',
        '曾经',
        '事情',
        '发生',
        '知道',
        '不是',
        '没有',
        '还有',
        '之后',
        '那个时候',
    ])

function normalizeStorySearchText(
    value
) {

    return String(
        value ?? ''
    )
        .toLowerCase()
        .replace(
            /\s+/g,
            ''
        )
}

function hasStoryRecallSignal(
    value
) {

    const text =
        String(
            value ?? ''
        )
            .trim()

    if (!text) {
        return false
    }

    const explicitRecall =
        /还记得|记不记得|记得吗|原作|剧情|卡面|卡里|设定|世界观|时间线|我们.*(?:以前|过去|曾经|当时|那次|第一次)|(?:以前|过去|曾经|当时|那次).*我们|以前.*你|过去.*你|曾经.*你|当时.*你|那次.*你/

    if (
        explicitRecall.test(
            text
        )
    ) {
        return true
    }

    const normalized =
        normalizeStorySearchText(
            text
        )

    return STORY_TRIGGER_TERMS.some(
        (term) =>
            normalized.includes(
                normalizeStorySearchText(
                    term
                )
            )
    )
}

function isStoryClarificationFollowUp(
    value
) {

    const text =
        String(
            value ?? ''
        )
            .trim()

    if (!text) {
        return false
    }

    // 允许用户在上一轮问旧剧情后，用更自然的方式补充线索，
    // 不再只允许“然后呢”这种很短的追问。
    //
    // 例如：
    // “就是你说要她抱抱、专门来让我误会的那只大肥兔容姬”
    //
    // 这种句子本身未必含“还记得”，但显然是在澄清上一轮旧剧情。
    return /就是|我是说|我说的是|说的是|指的是|那个|那只|那位|那件|这件|当时|后来|然后|她|他|它|名字|叫做|叫|兔|谁|怎么|为什么|不是|对了|我记得|你说过|你当时/
        .test(
            text
        )
}

function getPreviousUserMessage(
    recentMessages = []
) {

    const userMessages =
        (recentMessages || [])
            .filter(
                (item) =>
                    item?.role ===
                    'user'
            )
            .map(
                (item) =>
                    String(
                        item?.content ||
                        ''
                    )
            )
            .filter(
                Boolean
            )

    if (
        userMessages.length < 2
    ) {
        return ''
    }

    // getRecentVisibleMessages() 在普通聊天里已经包含当前刚保存的用户消息，
    // 所以倒数第二条 user 才是“上一轮用户消息”。
    return userMessages[
        userMessages.length -
        2
    ] || ''
}

function shouldRetrieveLoreChunks({
    currentMessage = '',
    recentMessages = [],
}) {

    if (
        hasStoryRecallSignal(
            currentMessage
        )
    ) {
        return true
    }

    const previousUserMessage =
        getPreviousUserMessage(
            recentMessages
        )

    // 只承接“紧邻上一轮”的旧剧情澄清，
    // 避免用户已经转回普通聊天后仍不断翻剧情库。
    return (
        Boolean(
            previousUserMessage
        ) &&
        hasStoryRecallSignal(
            previousUserMessage
        ) &&
        isStoryClarificationFollowUp(
            currentMessage
        )
    )
}

function extractStorySearchTerms(
    value
) {

    const source =
        String(
            value ?? ''
        )
            .toLowerCase()

    const normalizedSource =
        normalizeStorySearchText(
            source
        )

    const terms =
        new Set()

    // 先放明确的世界观 / 卡名 / 专有名词，
    // 避免长句 n-gram 达到上限以后把关键名词截掉。
    for (
        const canonTerm
        of STORY_CANON_TERMS
    ) {

        const normalizedCanon =
            normalizeStorySearchText(
                canonTerm
            )

        if (
            normalizedCanon &&
            normalizedSource.includes(
                normalizedCanon
            )
        ) {

            terms.add(
                normalizedCanon
            )
        }
    }

    // 再补充当前句里的普通关键词。
    // 这里沿用 character_lore 已有的分词逻辑，
    // 但过滤掉回忆提示词、代词等高噪声词。
    const genericTerms =
        extractLoreTerms(
            source
        )

    for (
        const rawTerm
        of genericTerms
    ) {

        const term =
            normalizeStorySearchText(
                rawTerm
            )

        if (
            !term ||
            STORY_STOP_TERMS.has(
                term
            )
        ) {
            continue
        }

        if (
            term.length < 2
        ) {
            continue
        }

        terms.add(
            term
        )

        if (
            terms.size >= 70
        ) {
            break
        }
    }

    return [
        ...terms,
    ]
}


// ======================================================
// 从“你还记得 X 吗”一类句子中提取真正的检索焦点。
//
// 之前的问题：
// “你还记得容姬吗”虽然含有“容姬”，但普通 n-gram 得分只有几分，
// 最近对话里大量旧词反而可能把别的卡顶到前面。
//
// 现在：
// 如果能明确提取到 X，就给正文中精确出现 X 的片段一个非常高的优先级。
// 这不是人工维护关键词，所以以后遇到别的人名 / 物件名也能生效。
// ======================================================

function extractStoryFocusTerms(
    value
) {

    let text =
        String(
            value ?? ''
        )
            .trim()

    if (!text) {
        return []
    }

    // 去掉 emoji / 标点，只保留中英文、数字和常见连接符。
    text =
        text.replace(
            /[^\u4e00-\u9fffA-Za-z0-9_-]+/g,
            ''
        )

    // 去掉常见称呼。
    text =
        text.replace(
            /^(?:星星|宝宝|沈星回)+/,
            ''
        )

    // 去掉回忆提问外壳。
    text =
        text.replace(
            /^(?:你)?(?:还)?(?:记不记得|记得|记不记得|还记不记得)/,
            ''
        )

    // 去掉句尾语气。
    text =
        text.replace(
            /(?:吗|嘛|么|呢|来着|呀|啊)+$/,
            ''
        )

    const normalized =
        normalizeStorySearchText(
            text
        )

    if (
        normalized.length >= 2 &&
        normalized.length <= 12 &&
        !STORY_STOP_TERMS.has(
            normalized
        )
    ) {
        return [
            normalized,
        ]
    }

    return []
}

function scoreLoreChunkFocus(
    item,
    focusTerms
) {

    if (
        !Array.isArray(
            focusTerms
        ) ||
        focusTerms.length === 0
    ) {
        return 0
    }

    const fields =
        getLoreChunkFields(
            item
        )

    let score = 0

    for (
        const rawTerm
        of focusTerms
    ) {

        const term =
            normalizeStorySearchText(
                rawTerm
            )

        if (
            !term ||
            term.length < 2
        ) {
            continue
        }

        // 精确名字/物件名命中正文时必须压过最近聊天噪声。
        if (
            fields.content.includes(
                term
            )
        ) {
            score +=
                120 +
                Math.min(
                    30,
                    term.length * 5
                )
        }

        if (
            fields.keywords.some(
                (keyword) =>
                    keyword === term ||
                    keyword.includes(
                        term
                    )
            )
        ) {
            score += 150
        }

        if (
            fields.sourceTitle ===
                term ||
            fields.sourceTitle.includes(
                term
            )
        ) {
            score += 170
        }

        if (
            fields.sectionTitle &&
            fields.sectionTitle.includes(
                term
            )
        ) {
            score += 140
        }
    }

    return score
}

function getLoreChunkFields(
    item
) {

    return {
        sourceFile:
            normalizeStorySearchText(
                item?.source_file
            ),

        sourceTitle:
            normalizeStorySearchText(
                item?.source_title
            ),

        sectionTitle:
            normalizeStorySearchText(
                item?.section_title
            ),

        keywords:
            Array.isArray(
                item?.keywords
            )
                ? item.keywords
                    .map(
                        (keyword) =>
                            normalizeStorySearchText(
                                keyword
                            )
                    )
                    .filter(
                        Boolean
                    )
                : [],

        content:
            normalizeStorySearchText(
                item?.content
            ),
    }
}

function scoreLoreChunk(
    item,
    terms,
    multiplier = 1
) {

    if (
        !Array.isArray(
            terms
        ) ||
        terms.length === 0
    ) {
        return 0
    }

    const fields =
        getLoreChunkFields(
            item
        )

    let score = 0

    for (
        const rawTerm
        of terms.slice(
            0,
            70
        )
    ) {

        const term =
            normalizeStorySearchText(
                rawTerm
            )

        if (
            !term ||
            term.length < 2 ||
            STORY_STOP_TERMS.has(
                term
            )
        ) {
            continue
        }

        let best = 0

        if (
            fields.sourceTitle ===
                term ||
            fields.sourceTitle.includes(
                term
            )
        ) {
            best =
                Math.max(
                    best,
                    14
                )
        }

        if (
            fields.keywords.some(
                (keyword) =>
                    keyword ===
                        term ||
                    keyword.includes(
                        term
                    ) ||
                    (
                        term.length >=
                            3 &&
                        term.includes(
                            keyword
                        )
                    )
            )
        ) {
            best =
                Math.max(
                    best,
                    16
                )
        }

        if (
            fields.sectionTitle &&
            fields.sectionTitle.includes(
                term
            )
        ) {
            best =
                Math.max(
                    best,
                    10
                )
        }

        if (
            fields.sourceFile &&
            fields.sourceFile.includes(
                term
            )
        ) {
            best =
                Math.max(
                    best,
                    8
                )
        }

        if (
            fields.content.includes(
                term
            )
        ) {

            best =
                Math.max(
                    best,
                    term.length >= 4
                        ? 7
                        : 5
                )
        }

        score +=
            best *
            multiplier
    }

    return score
}

async function getCachedLoreChunks() {

    if (!supabase) {
        return []
    }

    const now =
        Date.now()

    if (
        loreChunksCache
            .rows
            .length > 0 &&
        now -
            loreChunksCache
                .loadedAt <
            LORE_CHUNKS_CACHE_TTL_MS
    ) {
        return loreChunksCache.rows
    }

    const rows = []
    const pageSize = 1000
    const maxRows = 5000

    for (
        let from = 0;
        from < maxRows;
        from += pageSize
    ) {

        const {
            data,
            error,
        } =
            await supabase
                .from(
                    'lore_chunks'
                )
                .select(
                    'id, source_file, source_title, chunk_index, section_title, content, keywords, metadata, created_at'
                )
                .order(
                    'source_title',
                    {
                        ascending:
                            true,
                    }
                )
                .order(
                    'chunk_index',
                    {
                        ascending:
                            true,
                    }
                )
                .range(
                    from,
                    from +
                        pageSize -
                        1
                )

        if (error) {
            throw error
        }

        const page =
            Array.isArray(
                data
            )
                ? data
                : []

        rows.push(
            ...page
        )

        if (
            page.length <
            pageSize
        ) {
            break
        }
    }

    loreChunksCache = {
        loadedAt:
            now,
        rows,
    }

    return rows
}

function findBestStoryMatchIndex(
    content,
    terms
) {

    const searchableContent =
        String(
            content ?? ''
        )
            .toLowerCase()

    if (
        !searchableContent
    ) {
        return -1
    }

    let bestIndex = -1
    let bestTermLength = -1

    for (
        const rawTerm
        of terms || []
    ) {

        const term =
            normalizeStorySearchText(
                rawTerm
            )

        if (
            !term ||
            term.length < 2 ||
            STORY_STOP_TERMS.has(
                term
            )
        ) {
            continue
        }

        const index =
            searchableContent.indexOf(
                term
            )

        if (
            index >= 0 &&
            term.length >
                bestTermLength
        ) {
            bestIndex =
                index
            bestTermLength =
                term.length
        }
    }

    return bestIndex
}

function clipLoreChunkAroundTerms(
    content,
    terms,
    maxLength = 1150
) {

    const text =
        typeof content ===
            'string'
            ? content.trim()
            : ''

    if (
        !text ||
        text.length <=
            maxLength
    ) {
        return text
    }

    const matchIndex =
        findBestStoryMatchIndex(
            text,
            terms
        )

    if (
        matchIndex < 0
    ) {
        return `${text.slice(
            0,
            Math.max(
                1,
                maxLength -
                    1
            )
        )}…`
    }

    const half =
        Math.floor(
            maxLength /
            2
        )

    let start =
        Math.max(
            0,
            matchIndex -
                half
        )

    let end =
        Math.min(
            text.length,
            start +
                maxLength
        )

    if (
        end -
            start <
        maxLength
    ) {
        start =
            Math.max(
                0,
                end -
                    maxLength
            )
    }

    const prefix =
        start > 0
            ? '…'
            : ''

    const suffix =
        end <
            text.length
            ? '…'
            : ''

    return (
        prefix +
        text
            .slice(
                start,
                end
            )
            .trim() +
        suffix
    )
}

function formatLoreChunk(
    item,
    terms
) {

    const lines = [
        `【原始剧情片段｜${item.source_title || '未命名来源'}｜片段 ${Number(item.chunk_index) + 1}】`,
    ]

    if (
        item.section_title
    ) {
        lines.push(
            `小节：${item.section_title}`
        )
    }

    if (
        Array.isArray(
            item.keywords
        ) &&
        item.keywords
            .length > 0
    ) {
        lines.push(
            `关键词：${item.keywords.slice(
                0,
                10
            ).join(
                '、'
            )}`
        )
    }

    const content =
        clipLoreChunkAroundTerms(
            item.content,
            terms,
            1150
        )

    if (content) {
        lines.push(
            content
        )
    }

    return lines.join(
        '\n'
    )
}

function userHasLumiereLore(
    characterLore
) {

    const selected =
        Array.isArray(
            characterLore?.selected
        )
            ? characterLore.selected
            : []

    return selected.some(
        (item) =>
            normalizeStorySearchText(
                item?.character_name
            ) ===
            normalizeStorySearchText(
                '沈星回'
            )
    )
}

async function getLoreChunksContext({
    currentMessage = '',
    recentMessages = [],
    enabled = true,
}) {

    if (
        !enabled ||
        !shouldRetrieveLoreChunks({
            currentMessage,
            recentMessages,
        })
    ) {
        return {
            triggered:
                false,
            context:
                '',
            selected:
                [],
        }
    }

    let rows = []

    try {

        rows =
            await getCachedLoreChunks()

    } catch (error) {

        console.warn(
            '读取 lore_chunks 失败，本轮跳过完整剧情检索：',
            error?.message ||
            error
        )

        return {
            triggered:
                true,
            context:
                '',
            selected:
                [],
        }
    }

    if (
        rows.length === 0
    ) {
        return {
            triggered:
                true,
            context:
                '',
            selected:
                [],
        }
    }

    const recentText =
        (recentMessages || [])
            .slice(
                -6
            )
            .map(
                (item) =>
                    String(
                        item?.content ||
                        ''
                    )
            )
            .join(
                '\n'
            )

    const currentTerms =
        extractStorySearchTerms(
            currentMessage
        )

    const focusTerms =
        extractStoryFocusTerms(
            currentMessage
        )

    const recentTerms =
        extractStorySearchTerms(
            recentText
        )

    const directRecall =
        hasStoryRecallSignal(
            currentMessage
        )

    // 当前消息必须占绝对主导。
    // 直接“还记得 X 吗”时，最近聊天只给极小辅助分；
    // 澄清上一轮剧情时才略微提高，但依然不能压过当前线索。
    const recentMultiplier =
        directRecall
            ? 0.02
            : 0.08

    const scored =
        rows
            .map(
                (item) => {

                    const currentScore =
                        scoreLoreChunk(
                            item,
                            currentTerms,
                            1
                        )

                    const focusScore =
                        scoreLoreChunkFocus(
                            item,
                            focusTerms
                        )

                    const recentScore =
                        scoreLoreChunk(
                            item,
                            recentTerms,
                            recentMultiplier
                        )

                    const relevance =
                        currentScore +
                        focusScore +
                        recentScore

                    return {
                        item,
                        relevance,
                        currentScore,
                        focusScore,
                        recentScore,
                    }
                }
            )
            .filter(
                (entry) =>
                    entry.relevance >=
                    5
            )
            .sort(
                (
                    left,
                    right
                ) =>
                    right.relevance -
                    left.relevance
            )

    if (
        scored.length === 0
    ) {
        return {
            triggered:
                true,
            context:
                '',
            selected:
                [],
        }
    }

    const selected = []
    const selectedIds =
        new Set()

    for (
        const entry
        of scored
    ) {

        const item =
            entry.item

        if (
            selectedIds.has(
                item.id
            )
        ) {
            continue
        }

        selectedIds.add(
            item.id
        )

        selected.push({
            ...item,
            relevance:
                entry.relevance,
        })

        if (
            selected.length >=
            3
        ) {
            break
        }
    }

    const allTerms =
        [
            ...new Set([
                ...currentTerms,
                ...recentTerms,
            ]),
        ]

    const budgeted = []
    let usedTokens = 0
    const maxStoryTokens = 3000

    for (
        const item
        of selected
    ) {

        const block =
            formatLoreChunk(
                item,
                allTerms
            )

        const blockTokens =
            estimateTokens(
                block
            )

        if (
            budgeted.length >
                0 &&
            usedTokens +
                blockTokens >
                maxStoryTokens
        ) {
            continue
        }

        budgeted.push({
            item,
            block,
        })

        usedTokens +=
            blockTokens
    }

    if (
        budgeted.length === 0
    ) {
        return {
            triggered:
                true,
            context:
                '',
            selected:
                [],
        }
    }

    const materialText =
        budgeted
            .map(
                (entry) =>
                    entry.block
            )
            .join(
                '\n\n'
            )

    const selectedItems =
        budgeted
            .map(
                (entry) =>
                    entry.item
            )

    console.log(
        'lore_chunks 检索：',
        `模式=${directRecall ? '直接回忆' : '剧情澄清'}`,
        `焦点=${focusTerms.length ? focusTerms.join('/') : '无明确短焦点'}`
    )

    console.log(
        'lore_chunks 本轮召回：',
        selectedItems
            .map(
                (item) =>
                    `${item.source_title || '未命名'}#${item.chunk_index}(${Number(item.relevance).toFixed(1)})`
            )
            .join(
                ', '
            )
    )

    return {
        triggered:
            true,

        selected:
            selectedItems,

        context:
            `【按需召回的原始剧情记忆】
以下内容来自完整原作剧情切片，只在当前话题明确涉及过去经历、原作设定或具体旧事时临时加入。

使用规则：
1. 把这些片段当作已经真实发生过的共同经历或世界观事实，自然地“想起来”，不要说“根据资料”“数据库显示”或“我检索到”。
2. 不要为了证明记得而大段背诵原文；只使用回答当前问题真正需要的细节。
3. 不要主动报出内部的来源名、片段编号、关键词或数据库结构，除非用户明确询问卡名/来源。
4. 如果这里的具体剧情细节与提炼后的 character_lore 摘要有出入，具体事件细节优先参考这里的原始剧情；但最高优先级角色行为规则和用户当前明确陈述仍然优先。
5. 如果片段不足以确定答案，就保持自然的不确定，不要补造不存在的剧情。

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
    storyLoreContext = '',
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

    if (
        typeof storyLoreContext ===
            'string' &&
        storyLoreContext.trim()
    ) {

        sections.push(
            storyLoreContext.trim()
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

        }, 1)


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
// 后台记忆压缩调度
//
// 普通聊天不再等待记忆压缩。
// 每次成功回复以后，等用户空闲 30 秒再尝试整理长期记忆。
// 如果用户继续聊天，计时会重新开始。
// ======================================================

const MEMORY_COMPRESSION_IDLE_DELAY_MS =
    30 * 1000

const memoryCompressionTimers =
    new Map()

const memoryCompressionRunning =
    new Set()


function scheduleMemoryCompression(
    sessionId,
    settings,
    userId
) {

    if (
        !sessionId ||
        !userId
    ) {
        return
    }


    const key =
        `${userId}:${sessionId}`


    const previousTimer =
        memoryCompressionTimers
            .get(
                key
            )


    if (previousTimer) {

        clearTimeout(
            previousTimer
        )
    }


    const timer =
        setTimeout(
            async () => {

                memoryCompressionTimers
                    .delete(
                        key
                    )


                if (
                    memoryCompressionRunning
                        .has(
                            key
                        )
                ) {

                    return
                }


                memoryCompressionRunning
                    .add(
                        key
                    )


                try {

                    const result =
                        await compressMemoryIfNeeded(
                            sessionId,
                            settings,
                            userId
                        )


                    if (
                        result
                            ?.triggered
                    ) {

                        console.log(
                            `Session ${sessionId} 后台记忆压缩完成`
                        )
                    }


                } catch (error) {

                    // 后台压缩失败不能影响已经完成的聊天回复。
                    console.error(
                        `Session ${sessionId} 后台记忆压缩失败，本次跳过：`,
                        error
                    )


                } finally {

                    memoryCompressionRunning
                        .delete(
                            key
                        )
                }

            },
            MEMORY_COMPRESSION_IDLE_DELAY_MS
        )


    // 这个计时器本身不应该阻止 Node 进程正常退出。
    if (
        typeof timer
            .unref ===
        'function'
    ) {

        timer.unref()
    }


    memoryCompressionTimers
        .set(
            key,
            timer
        )
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


    // 当前这句话自己就明确要求提醒
    if (
        reminderPattern.test(
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
                -6
            )


    // 最近几句话里是否存在明确的提醒请求
    const hasRecentReminderRequest =
        previousMessages.some(
            (
                item
            ) => {

                if (
                    item.role !==
                    'user'
                ) {
                    return false
                }


                return reminderPattern.test(
                    String(
                        item.content ||
                        ''
                    )
                )

            }
        )


    if (
        !hasRecentReminderRequest
    ) {
        return false
    }


    // --------------------------------------------------
    // 情况 1：
    //
    // 用户：明天提醒我拿快递
    // 星星：几点？
    // 用户：下午三点
    // --------------------------------------------------

    const timePattern =
        /(?:今天|今晚|明天|后天|大后天|早上|上午|中午|下午|傍晚|晚上|夜里|凌晨|周[一二三四五六日天]|星期[一二三四五六日天]|[0-9一二两三四五六七八九十]{1,3}\s*(?:[:：点时]))/


    if (
        timePattern.test(
            text
        )
    ) {
        return true
    }


    // --------------------------------------------------
    // 情况 2：
    //
    // 用户：今晚六点十二分提醒我拿外卖
    // 星星：确认是今晚六点十二分，对吗？
    // 用户：对
    //
    // “对”本身没有时间，
    // 但它是在确认前面的提醒。
    // --------------------------------------------------

    const compactText =
        text
            .replace(
                /[\s，。！？!?、,.]/g,
                ''
            )
            .toLowerCase()


    const confirmationPattern =
        /^(对|对的|对呀|对啊|是|是的|嗯|嗯嗯|嗯哼|好|好的|没错|没问题|可以|就这样|确认|ok|okay)$/i


    if (
        !confirmationPattern.test(
            compactText
        )
    ) {
        return false
    }


    // 最后一条旧消息最好是星星在确认提醒信息，
    // 防止普通聊天中的“对”误触发提醒。
    const previousMessage =
        previousMessages[
        previousMessages.length - 1
        ]


    if (
        !previousMessage ||
        previousMessage.role !==
        'assistant'
    ) {
        return false
    }


    const assistantText =
        String(
            previousMessage.content ||
            ''
        )


    const clarificationPattern =
        /提醒|确认|对吗|是吗|几点|什么时候|具体时间|上午|下午|晚上|今晚|早上|中午|凌晨|今天|明天/


    return clarificationPattern.test(
        assistantText
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
// 用模型理解自然语言提醒
// ======================================================

async function analyzeAndCreateReminder({
    sessionId,
    userId,
    settings,
    cleanMessage,
    userMessageId,
    recentMessages,
}) {

    if (!userId) {
        throw new Error(
            '创建 reminder 时缺少 user_id'
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
                '当前还没有可靠的用户时区，因此不能安全地确定提醒时间。',
        }

    }


    const nowLocal =
        DateTime
            .now()
            .setZone(
                timeZone
            )


    const recentText =
        messagesToText(
            (
                recentMessages ||
                []
            ).slice(
                -8
            )
        )


    const parserInput =
        `你是 Hermit 的提醒意图解析器。

你只负责判断用户是否明确要求创建“未来某个时间的提醒”，以及把时间解析成结构化数据。
不要聊天，不要扮演角色。

【用户时区】
${timeZone}

【用户当前本地时间】
${nowLocal.toISO()}

【最近聊天】
${recentText || '无'}

【当前用户消息】
${cleanMessage}

只允许输出一个 JSON 对象，不要输出 Markdown，不要解释。

格式必须是：

{
  "action": "none",
  "content": null,
  "event_local": null,
  "remind_before_minutes": 10,
  "clarification": null
}

action 只能是：

"none"
"create"
"clarify"

规则：

1. 只有用户明确要求“提醒我、帮我记一下并提醒、到时候叫我、别让我忘”等未来提醒时，才使用 create。

2. 用户只是说“我明天下午三点要去医院”，但没有要求提醒，使用 none。

3. 如果当前消息只是补充上一轮明确提醒请求缺少的时间，也可以使用 create。
如果当前用户消息只是“对”“是的”“没错”“好”“确认”等简短确认，
并且上一条助手消息正在确认一个明确的提醒时间，
必须结合前面的用户提醒请求和这次确认来判断。

例如：

用户：今晚六点十二分提醒我下去拿外卖和水果
助手：确认一下，是今天晚上六点十二分，对吗？
用户：对

这种情况应该输出 create。

content = “下去拿外卖和水果”
event_local = 今天的 18:12:00

不要因为当前用户这一句只有“对”就输出 none。


4. create 时 content 只写用户真正要做的事情，例如“去拿快递”，不要写“提醒我”。

5. event_local 必须转换成用户时区下的完整本地时间，格式严格为：
YYYY-MM-DDTHH:mm:ss

6. 不要在 event_local 中加入 Z 或时区偏移。

7. 如果用户没有说明提前多久，默认 remind_before_minutes = 10。

8. 如果用户说“到点提醒”“到时候提醒”，而明显表示事情发生时再提醒，则 remind_before_minutes = 0。

9. “提前一点”但没有具体分钟数时，使用默认 10 分钟。

10. 如果日期或具体时间不足以唯一确定，使用 clarify。

11. 像“明天三点”这种无法确定上午还是下午的表达，不要猜，使用 clarify。

12. clarification 只简短说明还缺什么，例如“需要确认是上午三点还是下午三点”。

13. 不能编造用户没有说过的日程。

14. 解析出的事件时间必须在当前时间之后。`


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
            '提醒解析器没有返回有效 JSON'
        )

    }


    const action =
        typeof parsed.action ===
            'string'
            ? parsed.action
                .trim()
                .toLowerCase()
            : 'none'


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
                typeof parsed
                    .clarification ===
                    'string' &&
                    parsed
                        .clarification
                        .trim()
                    ? parsed
                        .clarification
                        .trim()
                    : '还缺少一个明确的提醒时间。',

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


    // 如果事情已经很近，
    // “提前十分钟”已经来不及，
    // 那么提醒时间就设成现在。
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
                'id, session_id, source_message_id, content, event_at, remind_at, timezone, status, remind_before_minutes, created_at, metadata'
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

    }
}


// ======================================================
// 告诉“正常聊天模型”提醒到底有没有创建成功
// ======================================================

function buildReminderReplyContext(
    reminderResult
) {

    if (
        reminderResult
            ?.status ===
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
        reminderResult
            ?.status ===
        'clarify'
    ) {

        return `【本次提醒操作结果】

用户有设置提醒的意图，但当前还没有成功创建提醒。

原因：
${reminderResult.clarification}

这次回复请自然地追问缺失的信息。
不要说“已经记住了”“已经设置好了”或其他暗示提醒已经创建成功的话。`

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

【长期记忆】
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


            const storyLore =
                await getLoreChunksContext({

                    currentMessage:
                        latestUserMessage,

                    recentMessages:
                        messages.slice(
                            -8
                        ),

                    enabled:
                        userHasLumiereLore(
                            characterLore
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

                    storyLoreContext:
                        storyLore
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
            // 检查当前消息是否包含提醒请求
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
                        await analyzeAndCreateReminder({

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


            // ==================================================
            // 不再让当前聊天等待长期记忆压缩。
            //
            // 先使用现有长期记忆完成这次回复；
            // 回复保存并返回给前端以后，再在后台空闲期压缩。
            // ==================================================

            const compression = {
                triggered:
                    false,

                reason:
                    'deferred_until_idle',

                before_tokens:
                    null,

                after_tokens:
                    null,

                compressed_message_count:
                    0,

                memory_id:
                    null,
            }



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


            const storyLore =
                await getLoreChunksContext({

                    currentMessage:
                        cleanMessage,

                    recentMessages:
                        history,

                    enabled:
                        userHasLumiereLore(
                            characterLore
                        ),

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

                    storyLoreContext:
                        storyLore
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


            // 当前聊天响应已经发给前端。
            // 长期记忆整理延后到空闲期，不再挡住用户看到回复。
            scheduleMemoryCompression(
                sessionId,
                settings,
                req.userId
            )


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
