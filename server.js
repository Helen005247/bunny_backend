const express = require("express");
const cors = require("cors");
const OpenAI = require("openai");
const { createClient } = require("@supabase/supabase-js");


const app = express();

const PORT = process.env.PORT || 3000;


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


    // 去掉中文以后，
    // 其它英文、数字、符号粗略按 4 个字符 ≈ 1 token
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
// 中间件
// ======================================================

app.use(cors());

app.use(express.json());


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
            "Supabase 数据库连接测试失败：",
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
// 创建新会话
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


        const { data, error } = await supabase
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


        const { data, error } = await supabase
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


        const { data, error } = await supabase
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


        const { error: deleteError } =
            await supabase
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
// 获取指定会话历史消息
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


        const { data, error } = await supabase
            .from("settings")
            .select(
                "id, session_id, system_prompt, temperature, max_context_rounds, max_context_tokens, compress_threshold, compress_keep_rounds, max_reply_tokens, updated_at"
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
// 更新全局设置
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
            temperature,
            max_context_rounds,
            max_context_tokens,
            compress_threshold,
            compress_keep_rounds,
            max_reply_tokens,
        } = req.body;


        const updates = {};


        // system_prompt
        if (system_prompt !== undefined) {

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


        // temperature
        if (temperature !== undefined) {

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


        // 整数类型设置
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


        const { data, error } = await supabase
            .from("settings")
            .update(updates)
            .eq(
                "session_id",
                "global"
            )
            .select(
                "id, session_id, system_prompt, temperature, max_context_rounds, max_context_tokens, compress_threshold, compress_keep_rounds, max_reply_tokens, updated_at"
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
// 查看某个会话当前上下文 Token 状态
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


            // ==========================================
            // 确认会话存在
            // ==========================================

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


            // ==========================================
            // 读取 settings
            // ==========================================

            const {
                data: settings,
                error: settingsError
            } = await supabase
                .from("settings")
                .select(
                    "system_prompt, max_context_tokens, compress_threshold, compress_keep_rounds"
                )
                .eq(
                    "session_id",
                    "global"
                )
                .maybeSingle();


            if (settingsError) {
                throw settingsError;
            }


            // ==========================================
            // 读取最新长期记忆
            // ==========================================

            const {
                data: memories,
                error: memoryError
            } = await supabase
                .from("memories")
                .select(
                    "summary"
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


            if (memoryError) {
                throw memoryError;
            }


            const memorySummary =
                memories &&
                    memories.length > 0
                    ? memories[0].summary || ""
                    : "";


            // ==========================================
            // 读取当前会话全部可见消息
            // ==========================================

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


            // ==========================================
            // 组装用于估算的上下文
            // ==========================================

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


            const fullContext = [
                settings?.system_prompt || "",
                memorySummary,
                historyText,
            ].join("\n\n");


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


            // ==========================================
            // 返回统计结果
            // ==========================================

            res.status(200).json({

                ok: true,

                session: session,

                session_id:
                    sessionId,

                message_count:
                    messages?.length || 0,

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
// 核心 AI 对话接口
// POST /api/chat
//
// 请求：
// {
//     "session_id": 1,
//     "message": "你好"
// }
// ======================================================

app.post("/api/chat", async (req, res) => {

    try {

        // ==================================================
        // 1. 基础检查
        // ==================================================

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


        // ==================================================
        // 2. 确定当前 session
        // ==================================================

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
                    "id, name, created_at, updated_at"
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

            // 当前前端未传 session_id 时
            // 使用最近更新的会话

            const {
                data: recentSessions,
                error: recentSessionError
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
                        "id, name, created_at, updated_at"
                    )
                    .single();


                if (newSessionError) {
                    throw newSessionError;
                }


                sessionId =
                    newSession.id;

            }

        }


        // ==================================================
        // 3. 保存用户消息
        // ==================================================

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


        // ==================================================
        // 4. 读取全局 settings
        // ==================================================

        const {
            data: settings,
            error: settingsError
        } = await supabase
            .from("settings")
            .select(
                "system_prompt, temperature, max_context_rounds, max_context_tokens, compress_threshold, compress_keep_rounds, max_reply_tokens"
            )
            .eq(
                "session_id",
                "global"
            )
            .maybeSingle();


        if (settingsError) {
            throw settingsError;
        }


        const systemPrompt =
            typeof settings?.system_prompt ===
                "string"
                ? settings.system_prompt.trim()
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


        // ==================================================
        // 5. 读取最近长期记忆
        // ==================================================

        const {
            data: memoryRows,
            error: memoryError
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


        if (memoryError) {
            throw memoryError;
        }


        let memorySummary = "";


        if (
            memoryRows &&
            memoryRows.length > 0 &&
            typeof memoryRows[0].summary ===
            "string"
        ) {

            memorySummary =
                memoryRows[0].summary.trim();

        }


        // ==================================================
        // 6. 读取最近历史消息
        // ==================================================

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


        // ==================================================
        // 7. 组装上下文
        // ==================================================

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


        const contextSections = [];


        if (systemPrompt) {

            contextSections.push(
                `【系统提示词】
${systemPrompt}`
            );

        }


        if (memorySummary) {

            contextSections.push(
                `【长期记忆摘要】
${memorySummary}`
            );

        }


        if (historyText) {

            contextSections.push(
                `【最近对话】
${historyText}`
            );

        }


        contextSections.push(
            `【回复要求】
请根据以上信息直接回复最近一条用户消息。
保持自然、连贯的连续对话。
不要复述“系统提示词”“长期记忆摘要”“最近对话”等内部标签。`
        );


        const modelInput =
            contextSections.join(
                "\n\n"
            );


        // ==================================================
        // 8. 计算本次上下文 Token
        //
        // 目前只计算并记录，
        // 暂时还不自动压缩。
        // ==================================================

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


        // ==================================================
        // 9. 调用 AI
        // ==================================================

        const response =
            await client.responses.create({
                model:
                    "gpt-5.6-sol",

                input:
                    modelInput,
            });


        const reply =
            typeof response.output_text ===
                "string"
                ? response.output_text.trim()
                : "";


        if (!reply) {

            throw new Error(
                "AI 没有返回有效的文本回复"
            );

        }


        // ==================================================
        // 10. 保存 AI 回复
        // ==================================================

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


        // ==================================================
        // 11. 更新会话时间
        // ==================================================

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


        // ==================================================
        // 12. 返回结果
        // ==================================================

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
