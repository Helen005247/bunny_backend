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

app.use('/api/sessions', requireAuth)
app.use('/api/chat', requireAuth)
app.use('/api/settings', requireAuth)
app.use('/api/push/subscribe', requireAuth)
app.use('/api/push/unsubscribe', requireAuth)
app.use('/api/proactive-message', requireAuth)
app.use('/api/db-test', requireAuth)


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
// 读取全局设置
// ======================================================
async function getGlobalSettings(
    userId
) {

    if (!userId) {
        throw new Error(
            '读取 settings 时缺少 userId'
        )
    }

    const {
        data,
        error,
    } = await supabase
        .from('settings')
        .select(`
            id,
            session_id,
            user_id,
            system_prompt,
            character_context,
            timezone,
            temperature,
            max_context_rounds,
            max_context_tokens,
            compress_threshold,
            compress_keep_rounds,
            max_reply_tokens,
            updated_at
        `)
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

    if (!data) {
        throw new Error(
            '没有找到当前用户的 settings'
        )
    }

    return data
}



// ======================================================
// 读取最新长期记忆
// ======================================================
async function getLatestMemory(
    userId
) {

    if (!userId) {
        throw new Error(
            '读取长期记忆时缺少 userId'
        )
    }

    const {
        data,
        error,
    } = await supabase
        .from('memories')
        .select(
            'id, session_id, user_id, summary, timestamp, conversation_id, metadata'
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
        query = query.eq(
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


// ======================================================
// 读取指定 session 的全部可见消息
// ======================================================
async function getVisibleMessages(
    sessionId,
    userId = null
) {

    let query =
        supabase
            .from('messages')
            .select(
                'id, session_id, user_id, role, content, created_at, visible'
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

    if (userId) {
        query = query.eq(
            'user_id',
            userId
        )
    }

    const {
        data,
        error,
    } =
        await query
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
    settings,
    userId = null
) {

    const maxHistoryMessages =
        getMaxHistoryMessages(
            settings
        )

    let query =
        supabase
            .from('messages')
            .select(
                'id, user_id, role, content, created_at'
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

    if (userId) {
        query = query.eq(
            'user_id',
            userId
        )
    }

    const {
        data,
        error,
    } =
        await query
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

    return Array.isArray(data)
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
            '压缩长期记忆时缺少 userId'
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
            sessionId,
            userId
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

                    session_id:
                        'global',

                    user_id:
                        userId,

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
                'id, session_id, user_id, summary, timestamp, conversation_id, metadata'
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
    settings,
    cleanMessage,
    userMessageId,
    recentMessages,
    userId,
}) {

    if (!userId) {

        throw new Error(
            '创建提醒时缺少 userId'
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

                    session_id:
                        sessionId,

                    user_id:
                        userId,

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
                'id, session_id, user_id, source_message_id, content, event_at, remind_at, timezone, status, remind_before_minutes, created_at, metadata'
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
    limit = 4,
    userId = null
) {

    let query =
        supabase
            .from('messages')
            .select(
                'id, user_id, content, created_at'
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

    if (userId) {
        query = query.eq(
            'user_id',
            userId
        )
    }

    const {
        data,
        error,
    } =
        await query
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
                limit
            )

    if (error) {
        throw error
    }

    return Array.isArray(data)
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
    mode = 'manual',
    userId
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
            settings,
            userId
        )


    const recentProactiveMessages =
        await getRecentProactiveMessages(
            sessionId,
            4,
            userId
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
    sessionId,
    userId = null
) {

    if (!pushConfigured) {
        console.log(
            'Web Push 未配置，跳过通知'
        )

        return {
            sent: 0,
            failed: 0,
            removed: 0,
            reason: 'push_not_configured',
        }
    }

    if (!supabase) {
        return {
            sent: 0,
            failed: 0,
            removed: 0,
            reason: 'supabase_not_configured',
        }
    }

    let ownerUserId = userId

    if (!ownerUserId) {
        const session =
            await getSessionById(
                sessionId
            )

        ownerUserId =
            session?.user_id || null
    }

    if (!ownerUserId) {
        console.warn(
            `Session ${sessionId} 没有 user_id，跳过 Push`
        )

        return {
            sent: 0,
            failed: 0,
            removed: 0,
            reason: 'session_has_no_user',
        }
    }

    const {
        data: subscriptions,
        error: subscriptionsError,
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
                ownerUserId
            )

    if (subscriptionsError) {
        throw subscriptionsError
    }

    if (
        !subscriptions ||
        subscriptions.length === 0
    ) {
        console.log(
            `用户 ${ownerUserId} 当前没有 Push 订阅设备`
        )

        return {
            sent: 0,
            failed: 0,
            removed: 0,
            reason: 'no_subscriptions',
        }
    }

    const payload =
        JSON.stringify({
            type: 'new_message',
            session_id: sessionId,
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
                        TTL: 60 * 60,
                    }
                )

            sent += 1

        } catch (error) {
            const statusCode =
                error?.statusCode ?? null

            if (
                statusCode === 404 ||
                statusCode === 410
            ) {
                console.log(
                    `Push 订阅已失效，删除 subscription id=${subscription.id}`
                )

                const {
                    error: deleteError,
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
                            ownerUserId
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
        reason: 'finished',
    }
}


// ======================================================
// 生成并保存主动消息
// ======================================================
async function generateAndSaveProactiveMessage(
    sessionId,
    mode = 'manual',
    userId = null
) {

    const session =
        await getSessionById(
            sessionId,
            userId || null
        )

    if (!session) {
        throw new Error(
            '主动消息对应的会话不存在或不属于当前用户'
        )
    }

    const ownerUserId =
        userId ||
        session.user_id

    if (!ownerUserId) {
        throw new Error(
            '主动消息会话没有 user_id'
        )
    }

    const settings =
        await getGlobalSettings(
            ownerUserId
        )

    const proactiveInput =
        await buildProactiveInput(
            sessionId,
            settings,
            mode,
            ownerUserId
        )

    const response =
        await callModelWithRetry({
            model: 'gpt-5.6-sol',
            input: proactiveInput,
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
        data: assistantMessage,
        error: assistantMessageError,
    } =
        await supabase
            .from(
                'messages'
            )
            .insert([
                {
                    session_id:
                        sessionId,
                    user_id:
                        ownerUserId,
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
                'id, session_id, user_id, role, content, created_at, visible, reasoning_content'
            )
            .single()

    if (assistantMessageError) {
        throw assistantMessageError
    }

    let pushResult = {
        sent: 0,
        failed: 0,
        removed: 0,
        reason: 'not_attempted',
    }

    try {
        pushResult =
            await sendPushNotification(
                sessionId,
                ownerUserId
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
            reason: 'push_error',
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
            if (!requireSupabase(res)) {
                return
            }

            const {
                endpoint,
                keys,
            } = req.body || {}

            const p256dh =
                keys?.p256dh
            const auth =
                keys?.auth

            if (
                typeof endpoint !== 'string' ||
                !endpoint.trim() ||
                typeof p256dh !== 'string' ||
                !p256dh.trim() ||
                typeof auth !== 'string' ||
                !auth.trim()
            ) {
                return res
                    .status(400)
                    .json({
                        ok: false,
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
                        ok: false,
                        error:
                            'Push endpoint 必须使用 HTTPS',
                    })
            }

            const now =
                new Date()
                    .toISOString()

            const {
                error: upsertError,
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

            if (upsertError) {
                throw upsertError
            }

            return res
                .status(200)
                .json({
                    ok: true,
                    message:
                        'Push Subscription 保存成功',
                })

        } catch (error) {
            console.error(
                '保存 Push Subscription 失败：',
                error
            )

            return res
                .status(500)
                .json({
                    ok: false,
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
            if (!requireSupabase(res)) {
                return
            }

            const endpoint =
                req.body
                    ?.endpoint

            if (
                typeof endpoint !== 'string' ||
                !endpoint.trim()
            ) {
                return res
                    .status(400)
                    .json({
                        ok: false,
                        error:
                            'endpoint 不能为空',
                    })
            }

            const {
                error: deleteError,
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

            if (deleteError) {
                throw deleteError
            }

            return res
                .status(200)
                .json({
                    ok: true,
                    message:
                        'Push Subscription 已删除',
                })

        } catch (error) {
            console.error(
                '删除 Push Subscription 失败：',
                error
            )

            return res
                .status(500)
                .json({
                    ok: false,
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
                    .select('*')
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
                        'user_id',
                        req.userId
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
            if (!requireSupabase(res)) {
                return
            }

            const settings =
                await getGlobalSettings(
                    req.userId
                )

            res
                .status(200)
                .json({
                    ok: true,
                    settings,
                })

        } catch (error) {
            console.error(
                '读取设置失败：',
                error
            )

            res
                .status(500)
                .json({
                    ok: false,
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
                session_id,
                user_id,
                system_prompt,
                character_context,
                timezone,
                temperature,
                max_context_rounds,
                max_context_tokens,
                compress_threshold,
                compress_keep_rounds,
                max_reply_tokens,
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
                    sessionId,
                    req.userId
                )

            const fullContext =
                buildModelContext({

                    settings,

                    memorySummary,

                    messages,

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
            if (!requireSupabase(res)) {
                return
            }

            if (!requireAIConfig(res)) {
                return
            }

            const {
                message,
                session_id,
            } = req.body

            if (
                typeof message !== 'string' ||
                !message.trim()
            ) {
                return res
                    .status(400)
                    .json({
                        ok: false,
                        error: 'message 不能为空',
                    })
            }

            const cleanMessage =
                message.trim()

            let sessionId = null

            const hasSessionId =
                session_id !== undefined &&
                session_id !== null &&
                session_id !== ''

            if (hasSessionId) {
                const parsedSessionId =
                    parsePositiveSessionId(
                        session_id
                    )

                if (!parsedSessionId) {
                    return res
                        .status(400)
                        .json({
                            ok: false,
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
                            ok: false,
                            error:
                                '会话不存在',
                        })
                }

                sessionId =
                    session.id

            } else {
                const {
                    data: recentSessions,
                    error: recentSessionError,
                } =
                    await supabase
                        .from(
                            'sessions'
                        )
                        .select(
                            'id, name, updated_at, user_id'
                        )
                        .eq(
                            'user_id',
                            req.userId
                        )
                        .order(
                            'updated_at',
                            {
                                ascending: false,
                            }
                        )
                        .limit(1)

                if (recentSessionError) {
                    throw recentSessionError
                }

                if (
                    recentSessions &&
                    recentSessions.length > 0
                ) {
                    sessionId =
                        recentSessions[0].id

                } else {
                    const {
                        data: newSession,
                        error: newSessionError,
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
                                'id, user_id'
                            )
                            .single()

                    if (newSessionError) {
                        throw newSessionError
                    }

                    sessionId =
                        newSession.id
                }
            }

            const {
                data: userMessage,
                error: userMessageError,
            } =
                await supabase
                    .from(
                        'messages'
                    )
                    .insert([
                        {
                            session_id:
                                sessionId,
                            user_id:
                                req.userId,
                            role:
                                'user',
                            content:
                                cleanMessage,
                            visible:
                                true,
                        },
                    ])
                    .select(
                        'id, session_id, user_id, role, content, created_at, visible'
                    )
                    .single()

            if (userMessageError) {
                throw userMessageError
            }

            const settings =
                await getGlobalSettings(
                    req.userId
                )

            const reminderRecentMessages =
                await getRecentVisibleMessages(
                    sessionId,
                    settings,
                    req.userId
                )

            let reminderResult = {
                status: 'none',
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
                            settings,
                            cleanMessage,
                            userMessageId:
                                userMessage.id,
                            recentMessages:
                                reminderRecentMessages,
                            userId:
                                req.userId,
                        })

                } catch (reminderError) {
                    console.error(
                        '提醒识别或保存失败：',
                        reminderError
                    )

                    reminderResult = {
                        status: 'clarify',
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
                    settings,
                    req.userId
                )

            const baseModelInput =
                buildModelContext({
                    settings,
                    memorySummary,
                    messages: history,
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
                    model: 'gpt-5.6-sol',
                    input: modelInput,
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
                data: assistantMessage,
                error: assistantMessageError,
            } =
                await supabase
                    .from(
                        'messages'
                    )
                    .insert([
                        {
                            session_id:
                                sessionId,
                            user_id:
                                req.userId,
                            role:
                                'assistant',
                            content:
                                reply,
                            visible:
                                true,
                        },
                    ])
                    .select(
                        'id, session_id, user_id, role, content, created_at, visible'
                    )
                    .single()

            if (assistantMessageError) {
                throw assistantMessageError
            }

            const {
                error: sessionUpdateError,
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

            if (sessionUpdateError) {
                console.error(
                    '更新 session 时间失败：',
                    sessionUpdateError
                )
            }

            res
                .status(200)
                .json({
                    ok: true,
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
                        reminderResult.status ===
                            'created'
                            ? reminderResult
                                .reminder
                            : null,
                })

        } catch (error) {
            console.error(
                'AI 对话处理失败：',
                error
            )

            res
                .status(500)
                .json({
                    ok: false,
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
            if (!requireSupabase(res)) {
                return
            }

            if (!requireAIConfig(res)) {
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
                        ok: false,
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
                        ok: false,
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
                    'manual',
                    req.userId
                )

            res
                .status(200)
                .json({
                    ok: true,
                    session_id:
                        sessionId,
                    reply,
                    assistant_message:
                        assistantMessage,
                    push_result:
                        pushResult,
                })

        } catch (error) {
            console.error(
                '生成主动消息失败：',
                error
            )

            res
                .status(500)
                .json({
                    ok: false,
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
            if (!requireSupabase(res)) {
                return
            }

            if (!requireAIConfig(res)) {
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
                        error: 'Unauthorized',
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
                    ? Math.floor(
                        configuredIdleMinutes
                    )
                    : 360

            const {
                data: sessionOwners,
                error: ownersError,
            } =
                await supabase
                    .from(
                        'sessions'
                    )
                    .select(
                        'user_id'
                    )
                    .not(
                        'user_id',
                        'is',
                        null
                    )

            if (ownersError) {
                throw ownersError
            }

            const userIds =
                [
                    ...new Set(
                        (sessionOwners || [])
                            .map(
                                (item) =>
                                    item.user_id
                            )
                            .filter(Boolean)
                    ),
                ]

            const results = []
            let sentCount = 0

            for (const userId of userIds) {
                try {
                    const {
                        data: latestUserMessages,
                        error: latestUserMessageError,
                    } =
                        await supabase
                            .from(
                                'messages'
                            )
                            .select(
                                'id, session_id, created_at, user_id'
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

                    if (latestUserMessageError) {
                        throw latestUserMessageError
                    }

                    if (
                        !latestUserMessages ||
                        latestUserMessages.length === 0
                    ) {
                        results.push({
                            user_id: userId,
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
                            user_id: userId,
                            session_id: sessionId,
                            sent: false,
                            reason:
                                'session_not_owned',
                        })
                        continue
                    }

                    const {
                        data: latestMessages,
                        error: latestMessageError,
                    } =
                        await supabase
                            .from(
                                'messages'
                            )
                            .select(
                                'id, role, content, created_at, reasoning_content, user_id'
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
                        latestMessages.length === 0
                    ) {
                        results.push({
                            user_id: userId,
                            session_id: sessionId,
                            sent: false,
                            reason: 'no_messages',
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
                            user_id: userId,
                            session_id: sessionId,
                            sent: false,
                            reason:
                                'waiting_for_user_reply',
                        })
                        continue
                    }

                    const lastMessageTime =
                        new Date(
                            latestMessage.created_at
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
                            ) / 60000
                        )

                    if (
                        idleMinutes <
                        idleMinutesRequired
                    ) {
                        results.push({
                            user_id: userId,
                            session_id: sessionId,
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
                            'automatic',
                            userId
                        )

                    sentCount += 1

                    results.push({
                        user_id: userId,
                        session_id: sessionId,
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
                        user_id: userId,
                        sent: false,
                        reason:
                            'user_check_failed',
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
                    sent_count:
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



// ======================================================
// 构建真正的到点提醒消息
// ======================================================



// ======================================================
// 真正发送一个已经被锁定的提醒
// ======================================================



// ======================================================
// 检查已经到时间的 reminders
//
// POST /api/reminder-check
// ======================================================


// ======================================================
// 构建真正的到点提醒消息
// ======================================================



// ======================================================
// 真正发送一个已经被锁定的提醒
// ======================================================



// ======================================================
// 检查已经到时间的 reminders
//
// POST /api/reminder-check
// ======================================================



// ======================================================
// 构建真正的到点提醒消息
// ======================================================



// ======================================================
// 真正发送一个已经被锁定的提醒
// ======================================================



// ======================================================
// 检查已经到时间的 reminders
//
// POST /api/reminder-check
// ======================================================




// ======================================================
// 构建真正的到点提醒消息（按 user_id 隔离）
// ======================================================

async function buildDueReminderInput(
    reminder
) {

    let userId =
        reminder?.user_id ||
        null

    if (!userId) {
        const session =
            await getSessionById(
                reminder.session_id
            )

        userId =
            session?.user_id ||
            null
    }

    if (!userId) {
        throw new Error(
            '提醒没有可识别的 user_id'
        )
    }

    const settings =
        await getGlobalSettings(
            userId
        )

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
            reminder.session_id,
            settings,
            userId
        )

    const historyText =
        messagesToText(
            recentMessages
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

    const timeZone =
        getValidTimeZone(
            reminder.timezone
        ) ||
        getValidTimeZone(
            settings?.timezone
        )

    if (!timeZone) {
        throw new Error(
            '提醒没有有效时区'
        )
    }

    const nowLocal =
        DateTime
            .now()
            .setZone(
                timeZone
            )

    const eventLocal =
        DateTime
            .fromISO(
                reminder.event_at,
                {
                    setZone: true,
                }
            )
            .setZone(
                timeZone
            )

    if (!eventLocal.isValid) {
        throw new Error(
            '提醒事件时间无效'
        )
    }

    const minutesUntilEvent =
        Math.round(
            eventLocal
                .diff(
                    nowLocal,
                    'minutes'
                )
                .minutes
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
${characterContext}`
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
        `【本次任务：真正执行一个已经到时间的提醒】

用户之前已经明确要求你提醒下面这件事。

提醒内容：
${reminder.content}

用户时区：
${timeZone}

用户当前本地时间：
${nowLocal.toFormat('yyyy-LL-dd HH:mm')}

事情发生时间：
${eventLocal.toFormat('yyyy-LL-dd HH:mm')}

距离事情发生约：
${minutesUntilEvent} 分钟

原本设置的提前提醒时间：
${reminder.remind_before_minutes} 分钟

现在请以沈星回的身份真正把这条提醒发给用户。

严格遵守：

1. 这是已经真实存在并到时间的提醒，不要怀疑它，也不要再次询问用户是否需要提醒。
2. 一定要让用户清楚知道该做什么。
3. 如果事情还没发生，可以自然表达“还有十分钟”“差不多该准备了”等，但必须依据上面的实际时间。
4. 如果定时检查稍有延迟，事情已经到点甚至刚刚过去，不要再错误地说“还有十分钟”，直接自然提醒该去做了。
5. 可以结合人物关系和说话方式，让提醒像沈星回本人来叫用户，而不是手机系统通知。
6. 不要说“系统提醒”“日程提醒”“数据库”“定时任务”“AI”等内部机制。
7. 不要为了提醒而编造新的事实。
8. 不需要额外讲大道理，也不要变成客服式提醒。
9. 普通情况下 1～3 条短消息即可。
10. 每条独立消息之间用一个空行隔开。
11. 不要使用编号、标题、项目符号或 JSON。
12. 输出必须能够直接作为沈星回发给用户的聊天消息。`
    )

    return {
        input:
            sections.join(
                '\n\n'
            ),
        userId,
    }
}


// ======================================================
// 真正发送一个已经被锁定的提醒
// ======================================================

async function deliverClaimedReminder(
    reminder
) {

    const dueContext =
        await buildDueReminderInput(
            reminder
        )

    const userId =
        dueContext.userId

    const response =
        await callModelWithRetry({
            model: 'gpt-5.6-sol',
            input: dueContext.input,
        })

    const reply =
        typeof response
            ?.output_text ===
            'string'
            ? response
                .output_text
                .trim()
            : ''

    if (!reply) {
        throw new Error(
            '提醒消息模型没有返回有效文本'
        )
    }

    const {
        data: assistantMessage,
        error: messageError,
    } =
        await supabase
            .from(
                'messages'
            )
            .insert([
                {
                    session_id:
                        reminder.session_id,
                    user_id:
                        userId,
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
                'id, session_id, user_id, role, content, created_at, visible, reasoning_content'
            )
            .single()

    if (messageError) {
        throw messageError
    }

    const sentAt =
        new Date()
            .toISOString()

    const {
        error: reminderUpdateError,
    } =
        await supabase
            .from(
                'reminders'
            )
            .update({
                status: 'sent',
                sent_at: sentAt,
                processing_at: null,
                last_error: null,
            })
            .eq(
                'id',
                reminder.id
            )
            .eq(
                'user_id',
                userId
            )

    if (reminderUpdateError) {
        throw reminderUpdateError
    }

    let pushResult = {
        sent: 0,
        failed: 0,
        removed: 0,
        reason: 'not_attempted',
    }

    try {
        pushResult =
            await sendPushNotification(
                reminder.session_id,
                userId
            )
    } catch (pushError) {
        console.error(
            '提醒已经写入聊天，但 Push 发送失败：',
            pushError
        )

        pushResult = {
            sent: 0,
            failed: 1,
            removed: 0,
            reason: 'push_error',
        }
    }

    return {
        reminder,
        reply,
        assistantMessage,
        pushResult,
    }
}


// ======================================================
// 检查已经到时间的 reminders
// POST /api/reminder-check
// ======================================================

app.post(
    '/api/reminder-check',
    async (
        req,
        res
    ) => {

        try {
            if (!requireSupabase(res)) {
                return
            }

            if (!requireAIConfig(res)) {
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
                        error: 'Unauthorized',
                    })
            }

            const now =
                new Date()
            const nowIso =
                now.toISOString()

            const staleProcessingIso =
                new Date(
                    now.getTime() -
                    15 * 60 * 1000
                )
                    .toISOString()

            const {
                error: recoveryError,
            } =
                await supabase
                    .from(
                        'reminders'
                    )
                    .update({
                        status: 'pending',
                        processing_at: null,
                    })
                    .eq(
                        'status',
                        'processing'
                    )
                    .lt(
                        'processing_at',
                        staleProcessingIso
                    )

            if (recoveryError) {
                console.error(
                    '恢复卡住的提醒失败：',
                    recoveryError
                )
            }

            const {
                data: dueReminders,
                error: remindersError,
            } =
                await supabase
                    .from(
                        'reminders'
                    )
                    .select(
                        'id, session_id, user_id, source_message_id, content, event_at, remind_at, timezone, status, remind_before_minutes, created_at, processing_at, last_error, metadata'
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
                            ascending: true,
                        }
                    )
                    .limit(10)

            if (remindersError) {
                throw remindersError
            }

            if (
                !dueReminders ||
                dueReminders.length === 0
            ) {
                return res
                    .status(200)
                    .json({
                        ok: true,
                        checked_at: nowIso,
                        due: 0,
                        processed: 0,
                        failed: 0,
                    })
            }

            const results = []
            let processed = 0
            let failed = 0

            for (
                const reminder
                of dueReminders
            ) {
                const claimTime =
                    new Date()
                        .toISOString()

                let claimQuery =
                    supabase
                        .from(
                            'reminders'
                        )
                        .update({
                            status: 'processing',
                            processing_at: claimTime,
                            last_error: null,
                        })
                        .eq(
                            'id',
                            reminder.id
                        )
                        .eq(
                            'status',
                            'pending'
                        )

                if (reminder.user_id) {
                    claimQuery =
                        claimQuery.eq(
                            'user_id',
                            reminder.user_id
                        )
                }

                const {
                    data: claimedReminder,
                    error: claimError,
                } =
                    await claimQuery
                        .select(
                            'id, session_id, user_id, source_message_id, content, event_at, remind_at, timezone, status, remind_before_minutes, created_at, processing_at, last_error, metadata'
                        )
                        .maybeSingle()

                if (claimError) {
                    failed += 1
                    results.push({
                        id: reminder.id,
                        ok: false,
                        error:
                            claimError.message,
                    })
                    continue
                }

                if (!claimedReminder) {
                    continue
                }

                try {
                    const delivery =
                        await deliverClaimedReminder(
                            claimedReminder
                        )

                    processed += 1

                    results.push({
                        id: reminder.id,
                        user_id:
                            claimedReminder.user_id,
                        ok: true,
                        reply:
                            delivery.reply,
                        push_result:
                            delivery.pushResult,
                    })

                } catch (reminderError) {
                    failed += 1

                    console.error(
                        `提醒 ${reminder.id} 执行失败：`,
                        reminderError
                    )

                    const errorText =
                        String(
                            reminderError
                                ?.message ||
                            reminderError
                        )
                            .slice(
                                0,
                                500
                            )

                    let resetQuery =
                        supabase
                            .from(
                                'reminders'
                            )
                            .update({
                                status: 'pending',
                                processing_at: null,
                                last_error: errorText,
                            })
                            .eq(
                                'id',
                                reminder.id
                            )

                    if (claimedReminder.user_id) {
                        resetQuery =
                            resetQuery.eq(
                                'user_id',
                                claimedReminder.user_id
                            )
                    }

                    const {
                        error: resetError,
                    } =
                        await resetQuery

                    if (resetError) {
                        console.error(
                            `提醒 ${reminder.id} 恢复 pending 失败：`,
                            resetError
                        )
                    }

                    results.push({
                        id: reminder.id,
                        user_id:
                            claimedReminder.user_id,
                        ok: false,
                        error: errorText,
                    })
                }
            }

            return res
                .status(200)
                .json({
                    ok: true,
                    checked_at: nowIso,
                    due:
                        dueReminders.length,
                    processed,
                    failed,
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
                    ok: false,
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
