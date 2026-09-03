const express = require("express");
const cors = require("cors");
const OpenAI = require("openai");

const app = express();

const PORT = process.env.PORT || 3000;

// 暂时允许前端跨域访问
// 等前后端完全跑通以后，再限制成你的前端域名
app.use(cors());

// 让后端能够读取前端发来的 JSON
app.use(express.json());

// 创建 AI 客户端
const client = new OpenAI({
    apiKey: process.env.AI_API_KEY,
    baseURL: process.env.AI_BASE_URL,
});


// 原来的健康检查，保留
app.get("/health", (req, res) => {
    res.status(200).json({
        message: "服务正常",
    });
});


// AI 对话接口
app.post("/api/chat", async (req, res) => {
    try {
        const { message } = req.body;

        if (!message) {
            return res.status(400).json({
                error: "message 不能为空",
            });
        }

        if (!process.env.AI_API_KEY || !process.env.AI_BASE_URL) {
            return res.status(500).json({
                error: "服务器没有正确配置 AI_API_KEY 或 AI_BASE_URL",
            });
        }

        const response = await client.responses.create({
            model: "gpt-5.6-sol",
            input: message,
        });

        res.status(200).json({
            reply: response.output_text,
        });

    } catch (error) {
        console.error("AI API 调用失败：", error);

        res.status(500).json({
            error: "AI API 调用失败",
            detail: error.message,
        });
    }
});


app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server is running on port ${PORT}`);
});
