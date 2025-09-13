// File: test-gemini.js
require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');

async function runTest() {
    console.log("Memulai tes koneksi ke Google AI...");

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        console.error("GAGAL! GEMINI_API_KEY tidak ditemukan di file .env Anda.");
        return;
    }

    try {
        console.log("Menginisialisasi Google AI Client...");
        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({ model: "gemini-pro" });
        
        console.log("Mencoba mengirim permintaan sederhana ke model 'gemini-pro'...");
        const result = await model.generateContent("Halo, apakah kamu aktif?");
        const response = await result.response;
        
        console.log("\n========================================");
        console.log("      ✅ BERHASIL! KONEKSI STABIL ✅");
        console.log("========================================");
        console.log("Respons dari Gemini:", response.text());

    } catch (error) {
        console.error("\n================================================");
        console.error("      ❌ GAGAL! TERJADI ERROR SAAT TES ❌");
        console.error("================================================");
        console.error("Detail Error:", error.message);
    }
}

runTest();