const express = require("express");
const cors = require("cors");
const OpenAI = require("openai");
const { createClient } = require("@supabase/supabase-js");


const app = express();

const PORT = process.env.PORT || 3000;


// ======================================================
// 中间件
// ======================================================

app.use(cors());

app.use(
    express.json({
        limit: "1mb",
    })
);


// ======================================================
// AI 客户端
// ======================================================

const client = new OpenAI({
    apiKey: process.env.AI_API_KEY,
    baseURL: process.env.AI_BASE_URL,
});


// ======================================================
// Supabase 客户端
// ======================================================

let supabase = null;

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
    );
}


// ======================================================
// Token 粗略估算
// ======================================================

function estimateTokens(text) {

    if (
        typeof text !== "string" ||
        !text
    ) {
        return 0;
    }


    // 中文粗略按 1 个字符 ≈ 1 token
    const chineseCharacters =
        text.match(/[\u4e00-\u9fff]/g) || [];


    const chineseCount =
        chineseCharacters.length;


    // 英文、数字、符号粗略按 4 字符 ≈ 1 token
    const otherText =
        text.replace(
            /[\u4e00-\u9fff]/g,
            ""
        );


    const otherTokens =
        Math.ceil(
            otherText.length / 4
        );


    return chineseCount + otherTokens;
}


// ======================================================
// 读取全局设置
// ======================================================

async function getGlobalSettings() {

    const {
        data,
        error
    } = await supabase
        .from("settings")
        .select(
            `
            id,
            session_id,
            system_prompt,
            character_context,
            temperature,
            max_context_rounds,
            max_context_tokens,
            compress_threshold,
            compress_keep_rounds,
            max_reply_tokens,
            updated_at
            `
        )
        .eq(
            "session_id",
            "global"
        )
        .maybeSingle();


    if (error) {
        throw error;
    }


    if (!data) {
        throw new Error(
            "没有找到 global settings"
        );
    }


    return data;
}


// ======================================================
// 读取最新一条长期记忆
// ======================================================

async function getLatestMemory() {

    const {
        data,
        error
    } = await supabase
        .from("memories")
        .select(
            "id, session_id, summary, timestamp, conversation_id, metadata"
        )
        .eq(
            "session_id",
            "global"
        )
        .order(
            "timestamp",
            {
                ascending: false,
            }
        )
        .limit(1);


    if (error) {
        throw error;
    }


    if (
        !data ||
        data.length === 0
    ) {
        return null;
    }


    return data[0];
}


// ======================================================
// 确认指定 session 存在
// ======================================================

async function getSessionById(sessionId) {

    const {
        data,
        error
    } = await supabase
        .from("sessions")
        .select(
            "id, name, created_at, updated_at"
        )
        .eq(
            "id",
            sessionId
        )
        .maybeSingle();


    if (error) {
        throw error;
    }


    return data;
}


// ======================================================
// 读取指定 session 的全部可见对话消息
// ======================================================

async function getVisibleMessages(sessionId) {

    const {
        data,
        error
    } = await supabase
        .from("messages")
        .select(
            "id, session_id, role, content, created_at, visible"
        )
        .eq(
            "session_id",
            sessionId
        )
        .eq(
            "visible",
            true
        )
        .in(
            "role",
            [
                "user",
                "assistant",
            ]
        )
        .order(
            "created_at",
            {
                ascending: true,
            }
        )
        .order(
            "id",
            {
                ascending: true,
            }
        );


    if (error) {
        throw error;
    }


    return data || [];
}


// ======================================================
// 将消息转换为可读文本
// ======================================================

function messagesToText(messages) {

    return (messages || [])
        .map((item) => {

            const speaker =
                item.role === "user"
                    ? "用户"
                    : "助手";


            return `${speaker}：${item.content}`;

        })
        .join("\n");
}


// ======================================================
// 找出应该压缩的旧消息
//
// compress_keep_rounds = 6
// 意味着保留最近 6 个 user 回合以及它们之后的 assistant 回复
// ======================================================

function splitMessagesForCompression(
    messages,
    keepRounds
) {

    const userIndexes = [];


    messages.forEach(
        (message, index) => {

            if (
                message.role === "user"
            ) {
                userIndexes.push(index);
            }

        }
    );


    // 总轮数还没有超过保留轮数
    // 没有东西可以压缩
    if (
        userIndexes.length <= keepRounds
    ) {
        return {
            compressibleMessages: [],
            keptMessages: messages,
        };
    }


    // 找到最近 keepRounds 个 user 中
    // 最早那个 user 的位置
    const keepStartIndex =
        userIndexes[
        userIndexes.length -
        keepRounds
        ];


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

    };
}


// ======================================================
// 构建完整上下文
// ======================================================

function buildModelContext({
    settings,
    memorySummary,
    messages,
}) {

    const systemPrompt =
        typeof settings?.system_prompt === "string"
            ? settings.system_prompt.trim()
            : "";


    const characterContext =
        typeof settings?.character_context === "string"
            ? settings.character_context.trim()
            : "";


    const historyText =
        messagesToText(messages);


    const sections = [];


    if (systemPrompt) {

        sections.push(
            `【最高优先级：角色行为规则】
${systemPrompt}`
        );

    }


    if (characterContext) {

        sections.push(
            `【固定人物设定、关系背景与共同经历】
以下内容属于角色和用户之间已经确定的稳定背景。
请把这些内容视为既有事实，自然地体现在回答中，不要机械复述。

${characterContext}`
        );

    }


    if (memorySummary) {

        sections.push(
            `【聊天过程中形成的长期记忆】
${memorySummary}`
        );

    }


    if (historyText) {

        sections.push(
            `【当前会话最近聊天】
${historyText}`
        );

    }


    sections.push(
        `【当前回复要求】
请直接回复最近一条用户消息。

要求：
1. 遵守角色行为规则。
2. 与固定人物背景和共同经历保持一致。
3. 在相关时自然运用长期记忆。
4. 保持当前对话自然连贯。
5. 不要向用户暴露这些内部上下文标签。`
    );


    return sections.join("\n\n");
}


// ======================================================
// 自动记忆压缩
//
// 返回：
// {
//   triggered,
//   before_tokens,
//   after_tokens,
//   compressed_message_count,
//   memory_id,
//   reason
// }
// ======================================================

async function compressMemoryIfNeeded(
    sessionId,
    settings
) {

    // --------------------------------------------------
    // 1. 读取当前 memory
    // --------------------------------------------------

    const previousMemory =
        await getLatestMemory();


    const previousMemorySummary =
        typeof previousMemory?.summary === "string"
            ? previousMemory.summary.trim()
            : "";


    // --------------------------------------------------
    // 2. 读取所有 visible 消息
    // --------------------------------------------------

    const visibleMessages =
        await getVisibleMessages(
            sessionId
        );


    // --------------------------------------------------
    // 3. 计算当前完整上下文 Token
    // --------------------------------------------------

    const fullContextBefore =
        buildModelContext({
            settings,
            memorySummary:
                previousMemorySummary,
            messages:
                visibleMessages,
        });


    const beforeTokens =
        estimateTokens(
            fullContextBefore
        );


    const compressThreshold =
        Number(
            settings?.compress_threshold
        ) || 10000;


    const keepRounds =
        Math.max(
            1,
            Number(
                settings?.compress_keep_rounds
            ) || 6
        );


    // --------------------------------------------------
    // 4. 未达到阈值
    // --------------------------------------------------

    if (
        beforeTokens <
        compressThreshold
    ) {

        return {
            triggered: false,
            reason: "below_threshold",
            before_tokens: beforeTokens,
            after_tokens: beforeTokens,
            compressed_message_count: 0,
            memory_id:
                previousMemory?.id || null,
        };

    }


    // --------------------------------------------------
    // 5. 找出旧消息和需要保留的最近消息
    // --------------------------------------------------

    const {
        compressibleMessages,
        keptMessages
    } = splitMessagesForCompression(
        visibleMessages,
        keepRounds
    );


    // 达到阈值，但聊天轮数还太少
    // 没有旧消息可以压缩
    if (
        compressibleMessages.length === 0
    ) {

        return {
            triggered: false,
            reason: "not_enough_old_messages",
            before_tokens: beforeTokens,
            after_tokens: beforeTokens,
            compressed_message_count: 0,
            memory_id:
                previousMemory?.id || null,
        };

    }


    // --------------------------------------------------
    // 6. 把需要压缩的旧消息转换成文本
    // --------------------------------------------------

    const oldConversationText =
        messagesToText(
            compressibleMessages
        );


    // --------------------------------------------------
    // 7. 让 AI 生成新的累计长期记忆
    //
    // 注意：
    // 旧 memory 也一起交进去，
    // 防止第二次压缩时丢失第一次压缩的记忆。
    // --------------------------------------------------

    const compressionInput =
        `你是一个长期记忆整理器。

你的任务是把“已有长期记忆”和“新的一批旧聊天记录”
合并成一份新的、完整的累计长期记忆。

【已有长期记忆】
${previousMemorySummary ||
        "目前没有已有长期记忆。"
        }

【本次需要压缩的旧聊天】
${oldConversationText}

【整理规则】

1. 保留对未来聊天真正有价值的信息。
2. 保留人物身份、性格、偏好、习惯和重要事实。
3. 准确保留“谁喜欢什么、谁说了什么”，不要弄错主语。
4. 保留用户和角色之间的重要共同经历、承诺、关系变化和情绪事件。
5. 保留尚未完成的计划、约定和重要话题。
6. 删除寒暄、重复表达和没有长期价值的闲聊。
7. 不要编造聊天中没有出现过的事实。
8. 如果新聊天与已有长期记忆存在更新，以较新的明确事实为准。
9. 输出的是给另一个 AI 使用的内部长期记忆，不要写成给用户看的回复。
10. 请保持信息密度高、结构清楚，尽量控制在约 2000 个中文字符以内。
11. 只输出整理后的长期记忆正文，不要输出解释、标题说明或 JSON。`;


    const compressionResponse =
        await client.responses.create({
            model: "gpt-5.6-sol",
            input: compressionInput,
        });


    const newSummary =
        typeof compressionResponse.output_text === "string"
            ? compressionResponse.output_text.trim()
            : "";


    if (!newSummary) {
        throw new Error(
            "记忆压缩模型没有返回有效摘要"
        );
    }


    // --------------------------------------------------
    // 8. 保存新 memory
    // --------------------------------------------------

    const compressedMessageIds =
        compressibleMessages.map(
            (message) => message.id
        );


    const {
        data: newMemory,
        error: memoryInsertError
    } = await supabase
        .from("memories")
        .insert([
            {
                session_id: "global",

                summary: newSummary,

                timestamp:
                    new Date().toISOString(),

                conversation_id:
                    String(sessionId),

                metadata: {
                    type:
                        "conversation_compression",

                    source_session_id:
                        sessionId,

                    previous_memory_id:
                        previousMemory?.id || null,

                    compressed_message_ids:
                        compressedMessageIds,

                    compressed_message_count:
                        compressedMessageIds.length,
                },
            },
        ])
        .select(
            "id, session_id, summary, timestamp, conversation_id, metadata"
        )
        .single();


    if (memoryInsertError) {
        throw memoryInsertError;
    }


    // --------------------------------------------------
    // 9. 把已经压缩的旧消息隐藏
    //
    // 不删除。
    // 数据仍然永久保存在 messages 表。
    // --------------------------------------------------

    const {
        error: hideMessagesError
    } = await supabase
        .from("messages")
        .update({
            visible: false,
        })
        .in(
            "id",
            compressedMessageIds
        );


    if (hideMessagesError) {
        throw hideMessagesError;
    }


    // --------------------------------------------------
    // 10. 重新计算压缩后的 Token
    // --------------------------------------------------

    const fullContextAfter =
        buildModelContext({
            settings,
            memorySummary:
                newSummary,
            messages:
                keptMessages,
        });


    const afterTokens =
        estimateTokens(
            fullContextAfter
        );


    console.log(
        `Session ${sessionId} 已执行记忆压缩：${compressedMessageIds.length} 条消息，Token ${beforeTokens} → ${afterTokens}`
    );


    return {

        triggered: true,

        reason: "compressed",

        before_tokens:
            beforeTokens,

        after_tokens:
            afterTokens,

        compressed_message_count:
            compressedMessageIds.length,

        compressed_message_ids:
            compressedMessageIds,

        memory_id:
            newMemory.id,

    };
}


// ======================================================
// 健康检查
// GET /health
// ======================================================

app.get("/health", (req, res) => {

    res.status(200).json({
        message: "服务正常",
    });

});


// ======================================================
// 数据库连接测试
// GET /api/db-test
// ======================================================

app.get(
    "/api/db-test",
    async (req, res) => {

        try {

            if (
                !process.env.SUPABASE_URL ||
                !process.env.SUPABASE_SECRET_KEY
            ) {

                return res
                    .status(500)
                    .json({
                        ok: false,
                        error:
                            "服务器没有正确配置 SUPABASE_URL 或 SUPABASE_SECRET_KEY",
                    });

            }


            if (!supabase) {

                return res
                    .status(500)
                    .json({
                        ok: false,
                        error:
                            "Supabase 客户端初始化失败",
                    });

            }


            const { data, error } =
                await supabase
                    .from("settings")
                    .select("*")
                    .limit(1);


            if (error) {
                throw error;
            }


            res.status(200).json({
                ok: true,
                message:
                    "Supabase 数据库连接成功",
                data,
            });


        } catch (error) {

            console.error(
                "数据库连接测试失败：",
                error
            );


            res.status(500).json({
                ok: false,
                error:
                    "Supabase 数据库连接失败",
                detail:
                    error.message,
            });

        }

    }
);


// ======================================================
// 创建会话
// POST /api/sessions
// ======================================================

app.post(
    "/api/sessions",
    async (req, res) => {

        try {

            if (!supabase) {

                return res
                    .status(500)
                    .json({
                        ok: false,
                        error:
                            "Supabase 客户端没有初始化",
                    });

            }


            const { name } =
                req.body;


            const sessionName =
                typeof name === "string" &&
                    name.trim()
                    ? name.trim()
                    : "新对话";


            const {
                data,
                error
            } = await supabase
                .from("sessions")
                .insert([
                    {
                        name:
                            sessionName,
                    },
                ])
                .select(
                    "id, name, created_at, updated_at"
                )
                .single();


            if (error) {
                throw error;
            }


            res.status(201).json({
                ok: true,
                session: data,
            });


        } catch (error) {

            console.error(
                "创建会话失败：",
                error
            );


            res.status(500).json({
                ok: false,
                error:
                    "创建会话失败",
                detail:
                    error.message,
            });

        }

    }
);


// ======================================================
// 获取会话列表
// GET /api/sessions
// ======================================================

app.get(
    "/api/sessions",
    async (req, res) => {

        try {

            if (!supabase) {

                return res
                    .status(500)
                    .json({
                        ok: false,
                        error:
                            "Supabase 客户端没有初始化",
                    });

            }


            const {
                data,
                error
            } = await supabase
                .from("sessions")
                .select(
                    "id, name, created_at, updated_at"
                )
                .order(
                    "updated_at",
                    {
                        ascending:
                            false,
                    }
                );


            if (error) {
                throw error;
            }


            res.status(200).json({
                ok: true,
                sessions: data,
            });


        } catch (error) {

            console.error(
                "获取会话列表失败：",
                error
            );


            res.status(500).json({
                ok: false,
                error:
                    "获取会话列表失败",
                detail:
                    error.message,
            });

        }

    }
);


// ======================================================
// 重命名会话
// PATCH /api/sessions/:id
// ======================================================

app.patch(
    "/api/sessions/:id",
    async (req, res) => {

        try {

            if (!supabase) {

                return res
                    .status(500)
                    .json({
                        ok: false,
                        error:
                            "Supabase 客户端没有初始化",
                    });

            }


            const sessionId =
                Number(
                    req.params.id
                );


            const { name } =
                req.body;


            if (
                !Number.isInteger(
                    sessionId
                ) ||
                sessionId <= 0
            ) {

                return res
                    .status(400)
                    .json({
                        ok: false,
                        error:
                            "无效的会话 ID",
                    });

            }


            if (
                typeof name !==
                "string" ||
                !name.trim()
            ) {

                return res
                    .status(400)
                    .json({
                        ok: false,
                        error:
                            "会话名称不能为空",
                    });

            }


            const {
                data,
                error
            } = await supabase
                .from("sessions")
                .update({
                    name:
                        name.trim(),
                })
                .eq(
                    "id",
                    sessionId
                )
                .select(
                    "id, name, created_at, updated_at"
                )
                .maybeSingle();


            if (error) {
                throw error;
            }


            if (!data) {

                return res
                    .status(404)
                    .json({
                        ok: false,
                        error:
                            "会话不存在",
                    });

            }


            res.status(200).json({
                ok: true,
                session: data,
            });


        } catch (error) {

            console.error(
                "重命名会话失败：",
                error
            );


            res.status(500).json({
                ok: false,
                error:
                    "重命名会话失败",
                detail:
                    error.message,
            });

        }

    }
);


// ======================================================
// 删除会话
// DELETE /api/sessions/:id
// ======================================================

app.delete(
    "/api/sessions/:id",
    async (req, res) => {

        try {

            if (!supabase) {

                return res
                    .status(500)
                    .json({
                        ok: false,
                        error:
                            "Supabase 客户端没有初始化",
                    });

            }


            const sessionId =
                Number(
                    req.params.id
                );


            if (
                !Number.isInteger(
                    sessionId
                ) ||
                sessionId <= 0
            ) {

                return res
                    .status(400)
                    .json({
                        ok: false,
                        error:
                            "无效的会话 ID",
                    });

            }


            const {
                data:
                existingSession,
                error:
                findError
            } = await supabase
                .from("sessions")
                .select(
                    "id, name, created_at, updated_at"
                )
                .eq(
                    "id",
                    sessionId
                )
                .maybeSingle();


            if (findError) {
                throw findError;
            }


            if (!existingSession) {

                return res
                    .status(404)
                    .json({
                        ok: false,
                        error:
                            "会话不存在",
                    });

            }


            const {
                error:
                deleteError
            } = await supabase
                .from("sessions")
                .delete()
                .eq(
                    "id",
                    sessionId
                );


            if (deleteError) {
                throw deleteError;
            }


            res.status(200).json({
                ok: true,
                message:
                    "会话删除成功",
                deletedSession:
                    existingSession,
            });


        } catch (error) {

            console.error(
                "删除会话失败：",
                error
            );


            res.status(500).json({
                ok: false,
                error:
                    "删除会话失败",
                detail:
                    error.message,
            });

        }

    }
);


// ======================================================
// 获取历史消息
// GET /api/sessions/:id/messages
// ======================================================

app.get(
    "/api/sessions/:id/messages",
    async (req, res) => {

        try {

            if (!supabase) {

                return res
                    .status(500)
                    .json({
                        ok: false,
                        error:
                            "Supabase 客户端没有初始化",
                    });

            }


            const sessionId =
                Number(
                    req.params.id
                );


            if (
                !Number.isInteger(
                    sessionId
                ) ||
                sessionId <= 0
            ) {

                return res
                    .status(400)
                    .json({
                        ok: false,
                        error:
                            "无效的会话 ID",
                    });

            }


            const session =
                await getSessionById(
                    sessionId
                );


            if (!session) {

                return res
                    .status(404)
                    .json({
                        ok: false,
                        error:
                            "会话不存在",
                    });

            }


            const {
                data: messages,
                error:
                messagesError
            } = await supabase
                .from("messages")
                .select(
                    "id, session_id, role, content, created_at, visible, reasoning_content"
                )
                .eq(
                    "session_id",
                    sessionId
                )
                .eq(
                    "visible",
                    true
                )
                .order(
                    "created_at",
                    {
                        ascending:
                            true,
                    }
                )
                .order(
                    "id",
                    {
                        ascending:
                            true,
                    }
                );


            if (messagesError) {
                throw messagesError;
            }


            res.status(200).json({
                ok: true,
                session,
                messages:
                    messages || [],
            });


        } catch (error) {

            console.error(
                "获取历史消息失败：",
                error
            );


            res.status(500).json({
                ok: false,
                error:
                    "获取历史消息失败",
                detail:
                    error.message,
            });

        }

    }
);


// ======================================================
// 获取设置
// GET /api/settings
// ======================================================

app.get(
    "/api/settings",
    async (req, res) => {

        try {

            if (!supabase) {

                return res
                    .status(500)
                    .json({
                        ok: false,
                        error:
                            "Supabase 客户端没有初始化",
                    });

            }


            const settings =
                await getGlobalSettings();


            res.status(200).json({
                ok: true,
                settings,
            });


        } catch (error) {

            console.error(
                "读取设置失败：",
                error
            );


            res.status(500).json({
                ok: false,
                error:
                    "读取设置失败",
                detail:
                    error.message,
            });

        }

    }
);


// ======================================================
// 修改设置
// PATCH /api/settings
// ======================================================

app.patch(
    "/api/settings",
    async (req, res) => {

        try {

            if (!supabase) {

                return res
                    .status(500)
                    .json({
                        ok: false,
                        error:
                            "Supabase 客户端没有初始化",
                    });

            }


            const {
                system_prompt,
                character_context,
                temperature,
                max_context_rounds,
                max_context_tokens,
                compress_threshold,
                compress_keep_rounds,
                max_reply_tokens,
            } = req.body;


            const updates = {};


            // system_prompt
            if (
                system_prompt !==
                undefined
            ) {

                if (
                    typeof system_prompt !==
                    "string"
                ) {

                    return res
                        .status(400)
                        .json({
                            ok: false,
                            error:
                                "system_prompt 必须是字符串",
                        });

                }


                updates.system_prompt =
                    system_prompt;

            }


            // character_context
            if (
                character_context !==
                undefined
            ) {

                if (
                    typeof character_context !==
                    "string"
                ) {

                    return res
                        .status(400)
                        .json({
                            ok: false,
                            error:
                                "character_context 必须是字符串",
                        });

                }


                updates.character_context =
                    character_context;

            }


            // temperature
            if (
                temperature !==
                undefined
            ) {

                const value =
                    Number(
                        temperature
                    );


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
                            ok: false,
                            error:
                                "temperature 必须在 0 到 2 之间",
                        });

                }


                updates.temperature =
                    value;

            }


            const integerFields = {
                max_context_rounds,
                max_context_tokens,
                compress_threshold,
                compress_keep_rounds,
                max_reply_tokens,
            };


            for (
                const [
                    key,
                    value
                ]
                of Object.entries(
                    integerFields
                )
            ) {

                if (
                    value ===
                    undefined
                ) {
                    continue;
                }


                const numberValue =
                    Number(
                        value
                    );


                if (
                    !Number.isInteger(
                        numberValue
                    ) ||
                    numberValue <= 0
                ) {

                    return res
                        .status(400)
                        .json({
                            ok: false,
                            error:
                                `${key} 必须是大于 0 的整数`,
                        });

                }


                updates[key] =
                    numberValue;

            }


            if (
                Object.keys(
                    updates
                ).length === 0
            ) {

                return res
                    .status(400)
                    .json({
                        ok: false,
                        error:
                            "没有提供需要修改的设置",
                    });

            }


            const {
                data,
                error
            } = await supabase
                .from("settings")
                .update(
                    updates
                )
                .eq(
                    "session_id",
                    "global"
                )
                .select(
                    `
                    id,
                    session_id,
                    system_prompt,
                    character_context,
                    temperature,
                    max_context_rounds,
                    max_context_tokens,
                    compress_threshold,
                    compress_keep_rounds,
                    max_reply_tokens,
                    updated_at
                    `
                )
                .maybeSingle();


            if (error) {
                throw error;
            }


            if (!data) {

                return res
                    .status(404)
                    .json({
                        ok: false,
                        error:
                            "没有找到全局设置",
                    });

            }


            res.status(200).json({
                ok: true,
                settings:
                    data,
            });


        } catch (error) {

            console.error(
                "更新设置失败：",
                error
            );


            res.status(500).json({
                ok: false,
                error:
                    "更新设置失败",
                detail:
                    error.message,
            });

        }

    }
);


// ======================================================
// 上下文 Token 状态
// GET /api/sessions/:id/context-stats
// ======================================================

app.get(
    "/api/sessions/:id/context-stats",
    async (req, res) => {

        try {

            if (!supabase) {

                return res
                    .status(500)
                    .json({
                        ok: false,
                        error:
                            "Supabase 客户端没有初始化",
                    });

            }


            const sessionId =
                Number(
                    req.params.id
                );


            if (
                !Number.isInteger(
                    sessionId
                ) ||
                sessionId <= 0
            ) {

                return res
                    .status(400)
                    .json({
                        ok: false,
                        error:
                            "无效的会话 ID",
                    });

            }


            const session =
                await getSessionById(
                    sessionId
                );


            if (!session) {

                return res
                    .status(404)
                    .json({
                        ok: false,
                        error:
                            "会话不存在",
                    });

            }


            const settings =
                await getGlobalSettings();


            const memory =
                await getLatestMemory();


            const memorySummary =
                typeof memory?.summary ===
                    "string"
                    ? memory.summary.trim()
                    : "";


            const messages =
                await getVisibleMessages(
                    sessionId
                );


            const fullContext =
                buildModelContext({
                    settings,
                    memorySummary,
                    messages,
                });


            const estimatedTokens =
                estimateTokens(
                    fullContext
                );


            const compressThreshold =
                Number(
                    settings
                        .compress_threshold
                ) || 10000;


            const keepRounds =
                Math.max(
                    1,
                    Number(
                        settings
                            .compress_keep_rounds
                    ) || 6
                );


            const {
                compressibleMessages
            } =
                splitMessagesForCompression(
                    messages,
                    keepRounds
                );


            const thresholdReached =
                estimatedTokens >=
                compressThreshold;


            res.status(200).json({

                ok: true,

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
                    memory?.id || null,

            });


        } catch (error) {

            console.error(
                "计算上下文 Token 失败：",
                error
            );


            res.status(500).json({
                ok: false,
                error:
                    "计算上下文 Token 失败",
                detail:
                    error.message,
            });

        }

    }
);


// ======================================================
// 核心 AI 对话
// POST /api/chat
// ======================================================

app.post(
    "/api/chat",
    async (req, res) => {

        try {

            // --------------------------------------------------
            // 基础检查
            // --------------------------------------------------

            if (!supabase) {

                return res
                    .status(500)
                    .json({
                        ok: false,
                        error:
                            "Supabase 客户端没有初始化",
                    });

            }


            if (
                !process.env
                    .AI_API_KEY ||
                !process.env
                    .AI_BASE_URL
            ) {

                return res
                    .status(500)
                    .json({
                        ok: false,
                        error:
                            "服务器没有正确配置 AI_API_KEY 或 AI_BASE_URL",
                    });

            }


            const {
                message,
                session_id
            } = req.body;


            if (
                typeof message !==
                "string" ||
                !message.trim()
            ) {

                return res
                    .status(400)
                    .json({
                        ok: false,
                        error:
                            "message 不能为空",
                    });

            }


            const cleanMessage =
                message.trim();


            let sessionId = null;


            // ======================================================
            // 1. 确定当前 session
            // ======================================================

            const hasSessionId =
                session_id !==
                undefined &&
                session_id !==
                null &&
                session_id !==
                "";


            if (hasSessionId) {

                const parsedSessionId =
                    Number(
                        session_id
                    );


                if (
                    !Number.isInteger(
                        parsedSessionId
                    ) ||
                    parsedSessionId <= 0
                ) {

                    return res
                        .status(400)
                        .json({
                            ok: false,
                            error:
                                "无效的 session_id",
                        });

                }


                const session =
                    await getSessionById(
                        parsedSessionId
                    );


                if (!session) {

                    return res
                        .status(404)
                        .json({
                            ok: false,
                            error:
                                "会话不存在",
                        });

                }


                sessionId =
                    session.id;

            } else {

                // 兼容目前前端
                // 未传 session_id 时使用最近会话

                const {
                    data:
                    recentSessions,
                    error:
                    recentSessionError
                } = await supabase
                    .from("sessions")
                    .select(
                        "id, name, updated_at"
                    )
                    .order(
                        "updated_at",
                        {
                            ascending:
                                false,
                        }
                    )
                    .limit(1);


                if (
                    recentSessionError
                ) {
                    throw recentSessionError;
                }


                if (
                    recentSessions &&
                    recentSessions.length >
                    0
                ) {

                    sessionId =
                        recentSessions[0]
                            .id;

                } else {

                    const {
                        data:
                        newSession,
                        error:
                        newSessionError
                    } = await supabase
                        .from(
                            "sessions"
                        )
                        .insert([
                            {
                                name:
                                    "新对话",
                            },
                        ])
                        .select(
                            "id"
                        )
                        .single();


                    if (
                        newSessionError
                    ) {
                        throw newSessionError;
                    }


                    sessionId =
                        newSession.id;

                }

            }


            // ======================================================
            // 2. 保存用户新消息
            // ======================================================

            const {
                data:
                userMessage,
                error:
                userMessageError
            } = await supabase
                .from("messages")
                .insert([
                    {
                        session_id:
                            sessionId,

                        role:
                            "user",

                        content:
                            cleanMessage,

                        visible:
                            true,
                    },
                ])
                .select(
                    "id, session_id, role, content, created_at, visible"
                )
                .single();


            if (
                userMessageError
            ) {
                throw userMessageError;
            }


            // ======================================================
            // 3. 读取 settings
            // ======================================================

            const settings =
                await getGlobalSettings();


            // ======================================================
            // 4. 检查并自动执行记忆压缩
            //
            // character_context 和 system_prompt
            // 永远不会被这里修改。
            // ======================================================

            const compression =
                await compressMemoryIfNeeded(
                    sessionId,
                    settings
                );


            // ======================================================
            // 5. 压缩完成以后重新读取最新 memory
            // ======================================================

            const latestMemory =
                await getLatestMemory();


            const memorySummary =
                typeof latestMemory?.summary ===
                    "string"
                    ? latestMemory
                        .summary
                        .trim()
                    : "";


            // ======================================================
            // 6. 重新读取当前 visible 历史
            //
            // 如果刚刚执行了压缩，
            // 此时旧消息已经 visible=false。
            // ======================================================

            const maxContextRoundsRaw =
                Number(
                    settings
                        .max_context_rounds
                );


            const maxContextRounds =
                Number.isFinite(
                    maxContextRoundsRaw
                ) &&
                    maxContextRoundsRaw > 0
                    ? Math.floor(
                        maxContextRoundsRaw
                    )
                    : 20;


            const maxHistoryMessages =
                Math.max(
                    2,
                    maxContextRounds *
                    2
                );


            const {
                data:
                newestHistory,
                error:
                historyError
            } = await supabase
                .from("messages")
                .select(
                    "id, role, content, created_at"
                )
                .eq(
                    "session_id",
                    sessionId
                )
                .eq(
                    "visible",
                    true
                )
                .in(
                    "role",
                    [
                        "user",
                        "assistant",
                    ]
                )
                .order(
                    "created_at",
                    {
                        ascending:
                            false,
                    }
                )
                .order(
                    "id",
                    {
                        ascending:
                            false,
                    }
                )
                .limit(
                    maxHistoryMessages
                );


            if (historyError) {
                throw historyError;
            }


            const history =
                Array.isArray(
                    newestHistory
                )
                    ? [
                        ...newestHistory
                    ].reverse()
                    : [];


            // ======================================================
            // 7. 组装最终上下文
            // ======================================================

            const modelInput =
                buildModelContext({
                    settings,
                    memorySummary,
                    messages:
                        history,
                });


            const finalEstimatedTokens =
                estimateTokens(
                    modelInput
                );


            // ======================================================
            // 8. 调用主模型
            // ======================================================

            const response =
                await client
                    .responses
                    .create({
                        model:
                            "gpt-5.6-sol",

                        input:
                            modelInput,
                    });


            const reply =
                typeof response
                    .output_text ===
                    "string"
                    ? response
                        .output_text
                        .trim()
                    : "";


            if (!reply) {

                throw new Error(
                    "AI 没有返回有效的文本回复"
                );

            }


            // ======================================================
            // 9. 保存 AI 回复
            // ======================================================

            const {
                data:
                assistantMessage,
                error:
                assistantMessageError
            } = await supabase
                .from("messages")
                .insert([
                    {
                        session_id:
                            sessionId,

                        role:
                            "assistant",

                        content:
                            reply,

                        visible:
                            true,
                    },
                ])
                .select(
                    "id, session_id, role, content, created_at, visible"
                )
                .single();


            if (
                assistantMessageError
            ) {
                throw assistantMessageError;
            }


            // ======================================================
            // 10. 更新会话时间
            // ======================================================

            const {
                error:
                sessionUpdateError
            } = await supabase
                .from("sessions")
                .update({
                    updated_at:
                        new Date()
                            .toISOString(),
                })
                .eq(
                    "id",
                    sessionId
                );


            if (
                sessionUpdateError
            ) {

                console.error(
                    "更新 session 时间失败：",
                    sessionUpdateError
                );

            }


            // ======================================================
            // 11. 返回前端
            // ======================================================

            res.status(200).json({

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

            });


        } catch (error) {

            console.error(
                "AI 对话处理失败：",
                error
            );


            res.status(500).json({
                ok: false,
                error:
                    "AI 对话处理失败",
                detail:
                    error.message,
            });

        }

    }
);


// ======================================================
// 启动服务器
// ======================================================

app.listen(
    PORT,
    "0.0.0.0",
    () => {

        console.log(
            `Server is running on port ${PORT}`
        );

    }
);
