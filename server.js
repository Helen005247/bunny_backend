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


        // 检查会话 ID
        if (
            !Number.isInteger(sessionId) ||
            sessionId <= 0
        ) {
            return res.status(400).json({
                ok: false,
                error: "无效的会话 ID",
            });
        }


        // 检查新名称
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


        // 检查会话 ID
        if (
            !Number.isInteger(sessionId) ||
            sessionId <= 0
        ) {
            return res.status(400).json({
                ok: false,
                error: "无效的会话 ID",
            });
        }


        // 先检查会话是否存在
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


        // 删除会话
        // messages 表使用 ON DELETE CASCADE，
        // 所以属于该会话的消息会一起删除
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
// AI 对话接口
// POST /api/chat
// ========================================

app.post("/api/chat", async (req, res) => {

    try {

        const { message } = req.body;


        if (
            typeof message !== "string" ||
            !message.trim()
        ) {
            return res.status(400).json({
                error: "message 不能为空",
            });
        }


        if (
            !process.env.AI_API_KEY ||
            !process.env.AI_BASE_URL
        ) {
            return res.status(500).json({
                error: "服务器没有正确配置 AI_API_KEY 或 AI_BASE_URL",
            });
        }


        const response = await client.responses.create({
            model: "gpt-5.6-sol",
            input: message.trim(),
        });


        res.status(200).json({
            reply: response.output_text,
        });


    } catch (error) {

        console.error(
            "AI API 调用失败：",
            error
        );


        res.status(500).json({
            error: "AI API 调用失败",
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
