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

// character_context 以后可能比较长
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


    // 中文字符粗略按 1 个字符 ≈ 1 token
    const chineseCharacters =
        text.match(/[\u4e00-\u9fff]/g) || [];


    const chineseCount =
        chineseCharacters.length;


    // 英文、数字和符号粗略按 4 字符 ≈ 1 token
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
// 获取全局 settings
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


    return data;
}


// ======================================================
// 获取最新一条长期记忆
// ======================================================

async function getLatestMemorySummary() {

    const {
        data,
        error
    } = await supabase
        .from("memories")
        .select(
            "id, summary, timestamp"
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
        return "";
    }


    return typeof data[0].summary === "string"
        ? data[0].summary.trim()
        : "";
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

app.get("/api/db-test", async (req, res) => {

    try {

        if (
            !process.env.SUPABASE_URL ||
            !process.env.SUPABASE_SECRET_KEY
        ) {
            return res.status(500).json({
                ok: false,
                error: "服务器没有正确配置 SUPABASE_URL 或 SUPABASE_SECRET_KEY",
            });
        }


        if (!supabase) {
            return res.status(500).json({
                ok: false,
                error: "Supabase 客户端初始化失败",
            });
        }


        const { data, error } = await supabase
            .from("settings")
            .select("*")
            .limit(1);


        if (error) {
            throw error;
        }


        res.status(200).json({
            ok: true,
            message: "Supabase 数据库连接成功",
            data: data,
        });


    } catch (error) {

        console.error(
            "数据库连接测试失败：",
            error
        );


        res.status(500).json({
            ok: false,
            error: "Supabase 数据库连接失败",
            detail: error.message,
        });

    }

});


// ======================================================
// 创建会话
// POST /api/sessions
// ======================================================

app.post("/api/sessions", async (req, res) => {

    try {

        if (!supabase) {
            return res.status(500).json({
                ok: false,
                error: "Supabase 客户端没有初始化",
            });
        }


        const { name } = req.body;


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
                    name: sessionName,
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
            error: "创建会话失败",
            detail: error.message,
        });

    }

});


// ======================================================
// 获取会话列表
// GET /api/sessions
// ======================================================

app.get("/api/sessions", async (req, res) => {

    try {

        if (!supabase) {
            return res.status(500).json({
                ok: false,
                error: "Supabase 客户端没有初始化",
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
                    ascending: false,
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
            error: "获取会话列表失败",
            detail: error.message,
        });

    }

});


// ======================================================
// 重命名会话
// PATCH /api/sessions/:id
// ======================================================

app.patch("/api/sessions/:id", async (req, res) => {

    try {

        if (!supabase) {
            return res.status(500).json({
                ok: false,
                error: "Supabase 客户端没有初始化",
            });
        }


        const sessionId =
            Number(req.params.id);


        const { name } = req.body;


        if (
            !Number.isInteger(sessionId) ||
            sessionId <= 0
        ) {
            return res.status(400).json({
                ok: false,
                error: "无效的会话 ID",
            });
        }


        if (
            typeof name !== "string" ||
            !name.trim()
        ) {
            return res.status(400).json({
                ok: false,
                error: "会话名称不能为空",
            });
        }


        const {
            data,
            error
        } = await supabase
            .from("sessions")
            .update({
                name: name.trim(),
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
            return res.status(404).json({
                ok: false,
                error: "会话不存在",
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
            error: "重命名会话失败",
            detail: error.message,
        });

    }

});


// ======================================================
// 删除会话
// DELETE /api/sessions/:id
// ======================================================

app.delete("/api/sessions/:id", async (req, res) => {

    try {

        if (!supabase) {
            return res.status(500).json({
                ok: false,
                error: "Supabase 客户端没有初始化",
            });
        }


        const sessionId =
            Number(req.params.id);


        if (
            !Number.isInteger(sessionId) ||
            sessionId <= 0
        ) {
            return res.status(400).json({
                ok: false,
                error: "无效的会话 ID",
            });
        }


        const {
            data: existingSession,
            error: findError
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
            return res.status(404).json({
                ok: false,
                error: "会话不存在",
            });
        }


        const {
            error: deleteError
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
            message: "会话删除成功",
            deletedSession: existingSession,
        });


    } catch (error) {

        console.error(
            "删除会话失败：",
            error
        );


        res.status(500).json({
            ok: false,
            error: "删除会话失败",
            detail: error.message,
        });

    }

});


// ======================================================
// 获取历史消息
// GET /api/sessions/:id/messages
// ======================================================

app.get(
    "/api/sessions/:id/messages",
    async (req, res) => {

        try {

            if (!supabase) {
                return res.status(500).json({
                    ok: false,
                    error: "Supabase 客户端没有初始化",
                });
            }


            const sessionId =
                Number(req.params.id);


            if (
                !Number.isInteger(sessionId) ||
                sessionId <= 0
            ) {
                return res.status(400).json({
                    ok: false,
                    error: "无效的会话 ID",
                });
            }


            const {
                data: session,
                error: sessionError
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


            if (sessionError) {
                throw sessionError;
            }


            if (!session) {
                return res.status(404).json({
                    ok: false,
                    error: "会话不存在",
                });
            }


            const {
                data: messages,
                error: messagesError
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
                        ascending: true,
                    }
                )
                .order(
                    "id",
                    {
                        ascending: true,
                    }
                );


            if (messagesError) {
                throw messagesError;
            }


            res.status(200).json({
                ok: true,
                session: session,
                messages: messages,
            });


        } catch (error) {

            console.error(
                "获取历史消息失败：",
                error
            );


            res.status(500).json({
                ok: false,
                error: "获取历史消息失败",
                detail: error.message,
            });

        }

    }
);


// ======================================================
// 获取全局设置
// GET /api/settings
// ======================================================

app.get("/api/settings", async (req, res) => {

    try {

        if (!supabase) {
            return res.status(500).json({
                ok: false,
                error: "Supabase 客户端没有初始化",
            });
        }


        const settings =
            await getGlobalSettings();


        if (!settings) {
            return res.status(404).json({
                ok: false,
                error: "没有找到全局设置",
            });
        }


        res.status(200).json({
            ok: true,
            settings: settings,
        });


    } catch (error) {

        console.error(
            "读取设置失败：",
            error
        );


        res.status(500).json({
            ok: false,
            error: "读取设置失败",
            detail: error.message,
        });

    }

});


// ======================================================
// 修改全局设置
// PATCH /api/settings
// ======================================================

app.patch("/api/settings", async (req, res) => {

    try {

        if (!supabase) {
            return res.status(500).json({
                ok: false,
                error: "Supabase 客户端没有初始化",
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


        // ------------------------------------------------------
        // system_prompt
        // ------------------------------------------------------

        if (
            system_prompt !== undefined
        ) {

            if (
                typeof system_prompt !== "string"
            ) {
                return res.status(400).json({
                    ok: false,
                    error: "system_prompt 必须是字符串",
                });
            }


            updates.system_prompt =
                system_prompt;

        }


        // ------------------------------------------------------
        // character_context
        // ------------------------------------------------------

        if (
            character_context !== undefined
        ) {

            if (
                typeof character_context !== "string"
            ) {
                return res.status(400).json({
                    ok: false,
                    error: "character_context 必须是字符串",
                });
            }


            updates.character_context =
                character_context;

        }


        // ------------------------------------------------------
        // temperature
        // ------------------------------------------------------

        if (
            temperature !== undefined
        ) {

            const value =
                Number(temperature);


            if (
                !Number.isFinite(value) ||
                value < 0 ||
                value > 2
            ) {
                return res.status(400).json({
                    ok: false,
                    error: "temperature 必须在 0 到 2 之间",
                });
            }


            updates.temperature =
                value;

        }


        // ------------------------------------------------------
        // 整数参数
        // ------------------------------------------------------

        const integerFields = {
            max_context_rounds,
            max_context_tokens,
            compress_threshold,
            compress_keep_rounds,
            max_reply_tokens,
        };


        for (
            const [key, value]
            of Object.entries(integerFields)
        ) {

            if (
                value === undefined
            ) {
                continue;
            }


            const numberValue =
                Number(value);


            if (
                !Number.isInteger(numberValue) ||
                numberValue <= 0
            ) {
                return res.status(400).json({
                    ok: false,
                    error: `${key} 必须是大于 0 的整数`,
                });
            }


            updates[key] =
                numberValue;

        }


        if (
            Object.keys(updates).length === 0
        ) {
            return res.status(400).json({
                ok: false,
                error: "没有提供需要修改的设置",
            });
        }


        const {
            data,
            error
        } = await supabase
            .from("settings")
            .update(updates)
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
            return res.status(404).json({
                ok: false,
                error: "没有找到全局设置",
            });
        }


        res.status(200).json({
            ok: true,
            settings: data,
        });


    } catch (error) {

        console.error(
            "更新设置失败：",
            error
        );


        res.status(500).json({
            ok: false,
            error: "更新设置失败",
            detail: error.message,
        });

    }

});


// ======================================================
// 上下文 Token 状态
// GET /api/sessions/:id/context-stats
// ======================================================

app.get(
    "/api/sessions/:id/context-stats",
    async (req, res) => {

        try {

            if (!supabase) {
                return res.status(500).json({
                    ok: false,
                    error: "Supabase 客户端没有初始化",
                });
            }


            const sessionId =
                Number(req.params.id);


            if (
                !Number.isInteger(sessionId) ||
                sessionId <= 0
            ) {
                return res.status(400).json({
                    ok: false,
                    error: "无效的会话 ID",
                });
            }


            const {
                data: session,
                error: sessionError
            } = await supabase
                .from("sessions")
                .select(
                    "id, name"
                )
                .eq(
                    "id",
                    sessionId
                )
                .maybeSingle();


            if (sessionError) {
                throw sessionError;
            }


            if (!session) {
                return res.status(404).json({
                    ok: false,
                    error: "会话不存在",
                });
            }


            const settings =
                await getGlobalSettings();


            const memorySummary =
                await getLatestMemorySummary();


            const {
                data: messages,
                error: messagesError
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


            if (messagesError) {
                throw messagesError;
            }


            const systemPrompt =
                settings?.system_prompt || "";


            const characterContext =
                settings?.character_context || "";


            const historyText =
                (messages || [])
                    .map((item) => {

                        const speaker =
                            item.role === "user"
                                ? "用户"
                                : "助手";


                        return `${speaker}：${item.content}`;

                    })
                    .join("\n");


            const fixedContext = [
                systemPrompt,
                characterContext,
            ].join("\n\n");


            const conversationContext = [
                memorySummary,
                historyText,
            ].join("\n\n");


            const fullContext = [
                fixedContext,
                conversationContext,
            ].join("\n\n");


            const fixedContextTokens =
                estimateTokens(
                    fixedContext
                );


            const conversationTokens =
                estimateTokens(
                    conversationContext
                );


            const estimatedTokens =
                estimateTokens(
                    fullContext
                );


            const compressThreshold =
                Number(
                    settings?.compress_threshold
                ) || 10000;


            const maxContextTokens =
                Number(
                    settings?.max_context_tokens
                ) || 12000;


            const compressKeepRounds =
                Number(
                    settings?.compress_keep_rounds
                ) || 6;


            res.status(200).json({

                ok: true,

                session: session,

                session_id:
                    sessionId,

                message_count:
                    messages?.length || 0,

                fixed_context_tokens:
                    fixedContextTokens,

                conversation_tokens:
                    conversationTokens,

                estimated_tokens:
                    estimatedTokens,

                compress_threshold:
                    compressThreshold,

                max_context_tokens:
                    maxContextTokens,

                compress_keep_rounds:
                    compressKeepRounds,

                should_compress:
                    estimatedTokens >=
                    compressThreshold,

            });


        } catch (error) {

            console.error(
                "计算上下文 Token 失败：",
                error
            );


            res.status(500).json({
                ok: false,
                error: "计算上下文 Token 失败",
                detail: error.message,
            });

        }

    }
);


// ======================================================
// 核心 AI 对话
// POST /api/chat
// ======================================================

app.post("/api/chat", async (req, res) => {

    try {

        // --------------------------------------------------
        // 基础检查
        // --------------------------------------------------

        if (!supabase) {
            return res.status(500).json({
                ok: false,
                error: "Supabase 客户端没有初始化",
            });
        }


        if (
            !process.env.AI_API_KEY ||
            !process.env.AI_BASE_URL
        ) {
            return res.status(500).json({
                ok: false,
                error: "服务器没有正确配置 AI_API_KEY 或 AI_BASE_URL",
            });
        }


        const {
            message,
            session_id
        } = req.body;


        if (
            typeof message !== "string" ||
            !message.trim()
        ) {
            return res.status(400).json({
                ok: false,
                error: "message 不能为空",
            });
        }


        const cleanMessage =
            message.trim();


        let sessionId = null;


        // ======================================================
        // 1. 确定当前 session
        // ======================================================

        const hasSessionId =
            session_id !== undefined &&
            session_id !== null &&
            session_id !== "";


        if (hasSessionId) {

            const parsedSessionId =
                Number(session_id);


            if (
                !Number.isInteger(parsedSessionId) ||
                parsedSessionId <= 0
            ) {
                return res.status(400).json({
                    ok: false,
                    error: "无效的 session_id",
                });
            }


            const {
                data: session,
                error: sessionError
            } = await supabase
                .from("sessions")
                .select(
                    "id, name"
                )
                .eq(
                    "id",
                    parsedSessionId
                )
                .maybeSingle();


            if (sessionError) {
                throw sessionError;
            }


            if (!session) {
                return res.status(404).json({
                    ok: false,
                    error: "会话不存在",
                });
            }


            sessionId =
                session.id;

        } else {

            const {
                data: recentSessions,
                error: recentSessionError
            } = await supabase
                .from("sessions")
                .select(
                    "id, name, updated_at"
                )
                .order(
                    "updated_at",
                    {
                        ascending: false,
                    }
                )
                .limit(1);


            if (recentSessionError) {
                throw recentSessionError;
            }


            if (
                recentSessions &&
                recentSessions.length > 0
            ) {

                sessionId =
                    recentSessions[0].id;

            } else {

                const {
                    data: newSession,
                    error: newSessionError
                } = await supabase
                    .from("sessions")
                    .insert([
                        {
                            name: "新对话",
                        },
                    ])
                    .select(
                        "id"
                    )
                    .single();


                if (newSessionError) {
                    throw newSessionError;
                }


                sessionId =
                    newSession.id;

            }

        }


        // ======================================================
        // 2. 保存用户消息
        // ======================================================

        const {
            data: userMessage,
            error: userMessageError
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


        if (userMessageError) {
            throw userMessageError;
        }


        // ======================================================
        // 3. 读取 settings
        // ======================================================

        const settings =
            await getGlobalSettings();


        const systemPrompt =
            typeof settings?.system_prompt === "string"
                ? settings.system_prompt.trim()
                : "";


        const characterContext =
            typeof settings?.character_context === "string"
                ? settings.character_context.trim()
                : "";


        const maxContextRoundsRaw =
            Number(
                settings?.max_context_rounds
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
                maxContextRounds * 2
            );


        // ======================================================
        // 4. 读取长期记忆
        // ======================================================

        const memorySummary =
            await getLatestMemorySummary();


        // ======================================================
        // 5. 读取最近历史消息
        // ======================================================

        const {
            data: historyNewestFirst,
            error: historyError
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
                    ascending: false,
                }
            )
            .order(
                "id",
                {
                    ascending: false,
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
                historyNewestFirst
            )
                ? [
                    ...historyNewestFirst
                ].reverse()
                : [];


        // ======================================================
        // 6. 组装近期聊天
        // ======================================================

        const historyText =
            history
                .map((item) => {

                    const speaker =
                        item.role === "user"
                            ? "用户"
                            : "助手";


                    return `${speaker}：${item.content}`;

                })
                .join("\n");


        // ======================================================
        // 7. 组装完整上下文
        //
        // 顺序：
        // 系统规则
        // ↓
        // 固定人物与共同故事
        // ↓
        // 动态长期记忆
        // ↓
        // 最近聊天
        // ======================================================

        const contextSections = [];


        if (systemPrompt) {

            contextSections.push(
                `【最高优先级：角色行为规则】
${systemPrompt}`
            );

        }


        if (characterContext) {

            contextSections.push(
                `【固定人物设定、关系背景与共同经历】
以下内容属于角色和用户之间已经确定的背景事实与共同经历。
请把这些内容视为真实且稳定的既有背景，在回复时自然体现，但不要生硬复述。

${characterContext}`
            );

        }


        if (memorySummary) {

            contextSections.push(
                `【聊天过程中形成的长期记忆】
${memorySummary}`
            );

        }


        if (historyText) {

            contextSections.push(
                `【当前会话的最近聊天】
${historyText}`
            );

        }


        contextSections.push(
            `【当前回复要求】
请直接回复最近一条用户消息。

回答时：
1. 遵守角色行为规则。
2. 与固定人物背景和共同经历保持一致。
3. 在相关时自然运用长期记忆，不要无缘无故主动罗列记忆。
4. 保持当前对话连贯自然。
5. 不要向用户复述或暴露这些内部上下文标签。`
        );


        const modelInput =
            contextSections.join(
                "\n\n"
            );


        // ======================================================
        // 8. Token 状态
        // ======================================================

        const estimatedTokens =
            estimateTokens(
                modelInput
            );


        const compressThreshold =
            Number(
                settings?.compress_threshold
            ) || 10000;


        const shouldCompress =
            estimatedTokens >=
            compressThreshold;


        console.log(
            `Session ${sessionId} 上下文估算 Token: ${estimatedTokens}, 压缩阈值: ${compressThreshold}, 是否需要压缩: ${shouldCompress}`
        );


        // ======================================================
        // 9. 调用 AI
        //
        // 暂时继续使用已经验证成功的参数。
        // 下一步做记忆压缩时再继续扩展。
        // ======================================================

        const response =
            await client.responses.create({
                model:
                    "gpt-5.6-sol",

                input:
                    modelInput,
            });


        const reply =
            typeof response.output_text === "string"
                ? response.output_text.trim()
                : "";


        if (!reply) {
            throw new Error(
                "AI 没有返回有效的文本回复"
            );
        }


        // ======================================================
        // 10. 保存 AI 回复
        // ======================================================

        const {
            data: assistantMessage,
            error: assistantMessageError
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


        if (assistantMessageError) {
            throw assistantMessageError;
        }


        // ======================================================
        // 11. 更新会话时间
        // ======================================================

        const {
            error: sessionUpdateError
        } = await supabase
            .from("sessions")
            .update({
                updated_at:
                    new Date().toISOString(),
            })
            .eq(
                "id",
                sessionId
            );


        if (sessionUpdateError) {

            console.error(
                "更新 session 时间失败：",
                sessionUpdateError
            );

        }


        // ======================================================
        // 12. 返回前端
        // ======================================================

        res.status(200).json({

            ok:
                true,

            session_id:
                sessionId,

            reply:
                reply,

            estimated_tokens:
                estimatedTokens,

            compress_threshold:
                compressThreshold,

            should_compress:
                shouldCompress,

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
            error: "AI 对话处理失败",
            detail: error.message,
        });

    }

});


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
