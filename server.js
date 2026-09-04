const express = require("express");
const cors = require("cors");
const OpenAI = require("openai");
const { createClient } = require("@supabase/supabase-js");


const app = express();

const PORT = process.env.PORT || 3000;


// ========================================
// 中间件
// ========================================

// 暂时允许前端跨域访问
// 等项目完全稳定后，再限制成你的 Vercel 前端域名
app.use(cors());

// 让后端能够读取前端发来的 JSON
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

// 这里不要填写真实 URL 和 Secret Key
// 它们已经保存在 Render Environment Variables 中
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
// ========================================

app.get("/health", (req, res) => {
    res.status(200).json({
        message: "服务正常",
    });
});


// ========================================
// Supabase 数据库连接测试
// ========================================

app.get("/api/db-test", async (req, res) => {
    try {

        // 检查 Render 中是否配置了 Supabase 环境变量
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


        // 从 settings 表读取一条数据
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
// AI 对话接口
// ========================================

app.post("/api/chat", async (req, res) => {
    try {

        const { message } = req.body;


        // 检查消息
        if (!message) {
            return res.status(400).json({
                error: "message 不能为空",
            });
        }


        // 检查 AI 环境变量
        if (
            !process.env.AI_API_KEY ||
            !process.env.AI_BASE_URL
        ) {
            return res.status(500).json({
                error: "服务器没有正确配置 AI_API_KEY 或 AI_BASE_URL",
            });
        }


        // 调用 AI
        const response = await client.responses.create({
            model: "gpt-5.6-sol",
            input: message,
        });


        // 返回 AI 回复
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
