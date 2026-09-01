const express = require("express");

const app = express();

const PORT = process.env.PORT || 3000;

app.get("/health", (req, res) => {
    res.status(200).json({
        message: "服务正常"
    });
});

app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server is running on port ${PORT}`);
});
