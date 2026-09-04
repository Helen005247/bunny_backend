const express = require("express");
const cors = require("cors");
const OpenAI = require("openai");
const { createClient } = require("@supabase/supabase-js");


const app = express();

const PORT = process.env.PORT || 3000;


// ========================================
// 中间件
// ========================================

app.use(cors());

app.use(express.json());


// ========================================
// AI 客户端
// ========================================

const client = new OpenAI({
    apiKey: process.env.AI_API_KEY,
    baseURL: process.env.AI_BASE_URL,
});


// ========================================
// Supabase 客户端
// ========================================

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


// ========================================
// 健康检查
// GET /health
// ========================================

app.get("/health", (req, res) => {

    res.status(200).json({
        message: "服务正常",
    });

});


// ========================================
// Supabase 数据库连接测试
// GET /api/db-test
// ========================================

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
            .select(
                "id, session_id, system_prompt, temperature, max_context_rounds, max_context_tokens, compress_threshold, compress_keep_rounds, max_reply_tokens, updated_at"
            )
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


// ========================================
// 创建新会话
// POST /api/sessions
// ========================================

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
            typeof name === "string" && name.trim()
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


// ========================================
// 获取会话列表
// GET /api/sessions
// ========================================

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


// ========================================
// 重命名会话
// PATCH /api/sessions/:id
// ========================================

app.patch("/api/sessions/:id", async (req, res) => {

    try {

        if (!supabase) {
            return res.status(500).json({
                ok: false,
                error: "Supabase 客户端没有初始化",
            });
        }


        const sessionId = Number(req.params.id);

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


// ========================================
// 删除会话
// DELETE /api/sessions/:id
// ========================================

app.delete("/api/sessions/:id", async (req, res) => {

    try {

        if (!supabase) {
            return res.status(500).json({
                ok: false,
                error: "Supabase 客户端没有初始化",
            });
        }


        const sessionId = Number(req.params.id);


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


        const { error: deleteError } = await supabase
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


// ========================================
// 获取指定会话历史消息
// GET /api/sessions/:id/messages
// ========================================

app.get("/api/sessions/:id/messages", async (req, res) => {

    try {

        if (!supabase) {
            return res.status(500).json({
                ok: false,
                error: "Supabase 客户端没有初始化",
            });
        }


        const sessionId = Number(req.params.id);


        if (
            !Number.isInteger(sessionId) ||
            sessionId <= 0
        ) {
            return res.status(400).json({
                ok: false,
                error: "无效的会话 ID",
            });
        }


        // 确认会话存在
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


        // 只返回 visible = true 的消息
        const {
            data: messages,
            error: messagesError
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
            .order(
                "created_at",
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

});


// ========================================
// 核心 AI 对话接口
// POST /api/chat
//
// 请求格式：
//
// {
//     "session_id": 1,
//     "message": "你好"
// }
//
// 为了暂时兼容你现在的前端：
// 如果前端还没有发送 session_id，
// 后端会自动使用最近的一个会话。
// 如果一个会话都没有，则自动创建一个。
// ========================================

app.post("/api/chat", async (req, res) => {

    try {

        // ========================================
        // 1. 基础检查
        // ========================================

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


        const cleanMessage = message.trim();

        let sessionId = null;


        // ========================================
        // 2. 确定当前 session
        // ========================================

        const hasSessionId =
            session_id !== undefined &&
            session_id !== null &&
            session_id !== "";


        // 前端主动传了 session_id
        if (hasSessionId) {

            const parsedSessionId = Number(session_id);


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


            sessionId = session.id;

        } else {

            // ========================================
            // 兼容当前旧前端
            //
            // 没传 session_id 时：
            // 使用最近更新的会话
            // ========================================

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

                sessionId = recentSessions[0].id;

            } else {

                // 一个 session 都没有时自动创建
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


                sessionId = newSession.id;

            }

        }


        // ========================================
        // 3. 把用户的新消息写进 messages
        // ========================================

        const {
            data: userMessage,
            error: userMessageError
        } = await supabase
            .from("messages")
            .insert([
                {
                    session_id: sessionId,
                    role: "user",
                    content: cleanMessage,
                    visible: true,
                },
            ])
            .select(
                "id, session_id, role, content, created_at, visible"
            )
            .single();


        if (userMessageError) {
            throw userMessageError;
        }


        // ========================================
        // 4. 读取全局 settings
        // ========================================

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
            typeof settings?.system_prompt === "string"
                ? settings.system_prompt.trim()
                : "";


        const maxContextRoundsRaw =
            Number(settings?.max_context_rounds);


        const maxContextRounds =
            Number.isFinite(maxContextRoundsRaw) &&
                maxContextRoundsRaw > 0
                ? Math.floor(maxContextRoundsRaw)
                : 20;


        // 一轮通常包含 user + assistant 两条消息
        const maxHistoryMessages =
            Math.max(
                2,
                maxContextRounds * 2
            );


        // ========================================
        // 5. 读取最近一条记忆摘要
        // ========================================

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
            typeof memoryRows[0].summary === "string"
        ) {
            memorySummary =
                memoryRows[0].summary.trim();
        }


        // ========================================
        // 6. 从数据库读取最近的历史消息
        //
        // 注意：
        // 用户刚才的新消息已经写入数据库，
        // 所以这里读取出来时已经包含它。
        // ========================================

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
            .limit(
                maxHistoryMessages
            );


        if (historyError) {
            throw historyError;
        }


        // 数据库刚才是从新到旧查询
        // 这里恢复成从旧到新的正常对话顺序
        const history =
            Array.isArray(historyNewestFirst)
                ? [...historyNewestFirst].reverse()
                : [];


        // ========================================
        // 7. 组装模型上下文
        //
        // 为了继续兼容你现在已经跑通的
        // Aizex Responses API，
        // 仍然使用 model + input 的方式。
        // ========================================

        const historyText = history
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
保持自然的连续对话。
不要复述“系统提示词”“长期记忆摘要”“最近对话”这些标签。`
        );


        const modelInput =
            contextSections.join("\n\n");


        // ========================================
        // 8. 调用主模型
        // ========================================

        const response =
            await client.responses.create({
                model: "gpt-5.6-sol",
                input: modelInput,
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


        // ========================================
        // 9. 把 AI 回复写进 messages
        // ========================================

        const {
            data: assistantMessage,
            error: assistantMessageError
        } = await supabase
            .from("messages")
            .insert([
                {
                    session_id: sessionId,
                    role: "assistant",
                    content: reply,
                    visible: true,
                },
            ])
            .select(
                "id, session_id, role, content, created_at, visible"
            )
            .single();


        if (assistantMessageError) {
            throw assistantMessageError;
        }


        // ========================================
        // 10. 更新 session 的 updated_at
        // ========================================

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


        // 更新时间失败不影响 AI 回复本身
        if (sessionUpdateError) {
            console.error(
                "更新 session 时间失败：",
                sessionUpdateError
            );
        }


        // ========================================
        // 11. 返回给前端
        //
        // reply 字段继续保留，
        // 所以你当前 Chat.jsx 仍然能显示 AI 回复。
        // ========================================

        res.status(200).json({
            ok: true,
            session_id: sessionId,
            reply: reply,
            user_message: userMessage,
            assistant_message: assistantMessage,
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


// ========================================
// 启动服务器
// ========================================

app.listen(
    PORT,
    "0.0.0.0",
    () => {

        console.log(
            `Server is running on port ${PORT}`
        );

    }
);
