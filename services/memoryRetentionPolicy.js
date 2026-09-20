// ======================================================
// 长期记忆保留策略
//
// 目标：
// - 普通学习 / 做题 / 翻译 / 查知识 / 临时代码调试：
//   可以留在聊天记录与近期上下文里，但在旧消息压缩时不写入长期记忆。
// - 长期学习目标、稳定学习偏好、明确“请记住”的信息：
//   仍然允许进入长期记忆。
//
// 这里只做“压缩前过滤”，不改变聊天回复，也不需要数据库迁移。
// ======================================================

const MEMORY_FILTER_VERSION =
    'learning-ephemeral-v1'


function normalizeMemoryText(value) {

    return String(
        value ?? ''
    )
        .replace(/\s+/g, ' ')
        .trim()
}


function hasExplicitMemoryIntent(text) {

    return (
        /(?:请|帮我|给我)?\s*(?:记住|记一下|长期记住|以后记得|别忘了)/i
            .test(text) ||
        /(?:以后|从今以后|今后).{0,28}(?:都|请|要|希望|别|不要|记得)/i
            .test(text)
    )
}


function hasDurableLearningProfile(text) {

    const patterns = [
        /(?:我|本人).{0,12}(?:正在|一直在|长期|接下来|这学期|这个学期|今年|最近一段时间).{0,18}(?:学习|备考|复习|准备).{0,22}(?:考研|考公|考试|雅思|托福|四六级|语言|数学|高数|微积分|线代|物理|化学|编程|课程|专业课)/i,
        /(?:我|本人).{0,10}(?:准备|计划|打算).{0,18}(?:考研|考公|考证|考试|雅思|托福|四六级|学|学习|复习)/i,
        /(?:我的|我).{0,14}(?:学习目标|备考目标|长期目标|这个学期的目标)/i,
        /(?:我|本人).{0,18}(?:英语|日语|韩语|法语|德语|数学|高数|微积分|线代|物理|化学|编程|阅读|写作).{0,16}(?:薄弱|不擅长|比较差|很差|基础弱|容易卡住)/i,
        /(?:讲题|解释知识|解释概念|辅导|学习|复习|做题).{0,20}(?:时|的时候).{0,28}(?:先|不要|别|希望|喜欢|更喜欢|一步一步|举例|提示|直接给答案|先给提示)/i,
        /(?:我|本人).{0,16}(?:喜欢|更喜欢|希望).{0,26}(?:一步一步|先提示|举例|类比|先讲思路|不要直接给答案|先让我想|再给答案)/i,
    ]

    return patterns.some(
        (pattern) =>
            pattern.test(text)
    )
}


function looksLikeEphemeralLearningOrKnowledgeTask(
    text
) {

    if (!text) {
        return false
    }

    const directPatterns = [
        /(?:这道|这一个|这一道|这|第\s*\d+\s*)(?:题|题目|习题)/i,
        /(?:作业|习题|选择题|填空题|判断题|证明题|计算题|应用题|阅读题|完形填空|听力题|题库)/i,
        /(?:答案|解题|求解|解方程|列方程|算一下|怎么算|怎么做|为什么选\s*[A-D]|选哪个)/i,
        /(?:公式|定理|知识点|概念|推导|证明|极限|导数|积分|矩阵|概率|方差|函数|方程).{0,30}(?:是什么|什么意思|怎么|为什么|如何|解释|求|算|证明|推导)/i,
        /(?:这个|这几个|这个英语|这个日语|这个韩语|这个法语|这个德语)?\s*(?:单词|词组|短语|句子|语法|时态).{0,26}(?:什么意思|怎么读|怎么念|翻译|解释|用法|怎么用)/i,
        /(?:帮我|请|能不能|可以不可以|麻烦).{0,14}(?:翻译|校对|改语法|改作文|改论文|润色|解题|做题|算|计算|证明|推导|总结这篇|解释这个概念|查资料)/i,
        /(?:翻译|校对|改语法|改作文|解题|做题|求解|计算|证明|推导)\s*(?:一下|下|这段|这个|这题|这道题|这句话|这篇)?/i,
        /(?:代码|报错|错误信息|bug|debug|leetcode|算法|sql|正则|函数|接口|命令|npm|node|react|vue|python|java|javascript|typescript).{0,36}(?:怎么|为什么|报错|修|改|写|实现|解释|调试|运行不了|不工作)/i,
        /(?:怎么|如何).{0,18}(?:写代码|改代码|修代码|调试|运行|解这道题|做这道题|算这道题|证明|翻译这段)/i,
    ]

    if (
        directPatterns.some(
            (pattern) =>
                pattern.test(text)
        )
    ) {
        return true
    }

    const subjectPattern =
        /(?:数学|高数|微积分|线性代数|线代|概率论|统计|物理|化学|生物|历史|地理|政治|英语|日语|韩语|法语|德语|语文|计算机|编程|算法|数据库|经济学|会计|专业课|课程|考试|考研|雅思|托福|四六级|论文|文献)/i

    const taskPattern =
        /(?:是什么|什么意思|怎么|为什么|如何|请解释|帮我|能不能|答案|讲一下|讲讲|总结|翻译|分析|计算|求|证明|推导|改一下|检查一下)/i

    return (
        subjectPattern.test(text) &&
        taskPattern.test(text)
    )
}


function classifyUserTurnForMemory(
    rawText
) {

    const text =
        normalizeMemoryText(
            rawText
        )

    if (!text) {
        return {
            keep: true,
            reason: 'empty_or_unknown',
        }
    }

    // 用户明确要求记住时，优先尊重明确意图。
    if (
        hasExplicitMemoryIntent(
            text
        )
    ) {
        return {
            keep: true,
            reason: 'explicit_memory_intent',
        }
    }

    // “我正在长期学习什么 / 我希望以后怎么给我讲题”
    // 属于用户画像与稳定偏好，应该保留。
    if (
        hasDurableLearningProfile(
            text
        )
    ) {
        return {
            keep: true,
            reason: 'durable_learning_profile',
        }
    }

    if (
        looksLikeEphemeralLearningOrKnowledgeTask(
            text
        )
    ) {
        return {
            keep: false,
            reason: 'ephemeral_learning_or_knowledge',
        }
    }

    return {
        keep: true,
        reason: 'normal_conversation',
    }
}


function groupMessagesIntoTurns(
    messages
) {

    const turns = []
    let currentTurn = null

    for (
        const message of
        Array.isArray(messages)
            ? messages
            : []
    ) {

        if (
            message?.role ===
            'user'
        ) {

            currentTurn = {
                userText:
                    String(
                        message?.content ?? ''
                    ),
                messages: [
                    message,
                ],
            }

            turns.push(
                currentTurn
            )

            continue
        }

        if (
            currentTurn
        ) {
            currentTurn
                .messages
                .push(
                    message
                )
            continue
        }

        // 极少数情况下旧记录可能以 assistant 开头。
        // 没有对应用户问题时，不擅自丢弃。
        currentTurn = {
            userText: '',
            messages: [
                message,
            ],
        }

        turns.push(
            currentTurn
        )
    }

    return turns
}


function buildMemoryCompressionPlan(
    messages
) {

    const memoryMessages = []
    const excludedMessages = []
    const decisions = []

    const turns =
        groupMessagesIntoTurns(
            messages
        )

    for (
        const turn of turns
    ) {

        const decision =
            classifyUserTurnForMemory(
                turn.userText
            )

        const target =
            decision.keep
                ? memoryMessages
                : excludedMessages

        target.push(
            ...turn.messages
        )

        decisions.push({
            keep:
                decision.keep,
            reason:
                decision.reason,
            message_ids:
                turn.messages
                    .map(
                        (message) =>
                            message?.id
                    )
                    .filter(
                        (id) =>
                            id !== undefined &&
                            id !== null
                    ),
        })
    }

    return {
        version:
            MEMORY_FILTER_VERSION,
        memoryMessages,
        excludedMessages,
        decisions,
        memoryMessageIds:
            memoryMessages
                .map(
                    (message) =>
                        message?.id
                )
                .filter(
                    (id) =>
                        id !== undefined &&
                        id !== null
                ),
        excludedMessageIds:
            excludedMessages
                .map(
                    (message) =>
                        message?.id
                )
                .filter(
                    (id) =>
                        id !== undefined &&
                        id !== null
                ),
    }
}


module.exports = {
    MEMORY_FILTER_VERSION,
    classifyUserTurnForMemory,
    buildMemoryCompressionPlan,
}
