// =================================================================
//                          MODUL & INISIALISASI
// =================================================================
require('dotenv').config();
const qrcode = require('qrcode');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const fs = require('fs');
const express = require('express');
const badWords = require('./profanity-list.js');

// Inisialisasi Klien WhatsApp dan Web Server
const client = new Client({
    authStrategy: new LocalAuth({ dataPath: '.' }),
    puppeteer: { args: ['--no-sandbox', '--disable-setuid-sandbox'] }
});
const app = express();
const port = process.env.PORT || 3000;

// =================================================================
//                      PENGATURAN & VARIABEL GLOBAL
// =================================================================
const DB_FILE = './database.json';
const VIOLATIONS_FILE = './violations.json';
const LOG_DIR = './chat_logs';
const CONFIG_FILE = './config.json'; // Diasumsikan ada file ini

let db = {};
let violations = [];
let waitingQueue = [];
let activeChats = {};
let config = {}; // Untuk menyimpan konfigurasi

// Variabel Baru untuk Status & Log Real-time
let botStatus = 'INITIALIZING';
let qrCodeDataUrl = '';
let serverLogs = [];

app.use(express.urlencoded({ extended: true }));


// =================================================================
//                          FUNGSI HELPER
// =================================================================

/** Fungsi logging baru yang juga menyimpan log ke memori */
function customLog(message) {
    console.log(message);
    const timestamp = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
    serverLogs.push({ timestamp, message });
    if (serverLogs.length > 100) {
        serverLogs.shift();
    }
}

/** Memuat database dari file database.json */
function loadDatabase() {
    try {
        if (fs.existsSync(DB_FILE)) {
            const data = fs.readFileSync(DB_FILE, 'utf-8');
            db = data.length > 0 ? JSON.parse(data) : {};
        } else {
            fs.writeFileSync(DB_FILE, JSON.stringify({}));
            db = {};
        }
    } catch (error) { customLog(`Gagal memuat database: ${error.message}`); db = {}; }
}

/** Menyimpan state database saat ini ke file database.json */
function saveDatabase() {
    try {
        fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
    } catch (error) { customLog(`Gagal menyimpan database: ${error.message}`); }
}

/** Memuat data pelanggaran dari violations.json */
function loadViolations() {
    try {
        if (fs.existsSync(VIOLATIONS_FILE)) {
            const data = fs.readFileSync(VIOLATIONS_FILE, 'utf-8');
            violations = data.length > 0 ? JSON.parse(data) : [];
        } else {
            fs.writeFileSync(VIOLATIONS_FILE, '[]');
            violations = [];
        }
    } catch (error) { customLog(`Gagal memuat violations: ${error.message}`); violations = []; }
}

/** Menyimpan data pelanggaran ke violations.json */
function saveViolations() {
    try {
        fs.writeFileSync(VIOLATIONS_FILE, JSON.stringify(violations, null, 2));
    } catch (error) { customLog(`Gagal menyimpan violations: ${error.message}`); }
}

/** Mendapatkan profil user, atau membuat profil baru jika belum ada */
function getUser(userId) {
    if (!db[userId]) {
        db[userId] = { nickname: userId.split('@')[0], role: 'user', isBanned: false };
        saveDatabase();
    }
    return db[userId];
}

/** Membuat ID unik untuk room chat */
function generateRoomId() {
    return `wafa${Math.floor(100000 + Math.random() * 900000)}`;
}

/** Memeriksa pesan apakah mengandung kata kasar */
function checkProfanity(message) {
    const words = message.toLowerCase().split(/\s+/);
    return badWords.some(word => words.includes(word));
}

/** Mencatat pesan dalam sebuah room chat ke file lognya sendiri */
function logChatMessage(roomId, userId, message) {
    const logPath = `${LOG_DIR}/${roomId}.json`;
    const user = getUser(userId);
    const timestamp = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
    const logEntry = { timestamp, userId, nickname: user.nickname, message };
    try {
        let logs = [];
        if (fs.existsSync(logPath)) {
            logs = JSON.parse(fs.readFileSync(logPath, 'utf-8'));
        }
        logs.push(logEntry);
        fs.writeFileSync(logPath, JSON.stringify(logs, null, 2));
    } catch (error) {
        customLog(`Gagal menulis log chat untuk room ${roomId}: ${error.message}`);
    }
}

// =================================================================
//                      PENGATURAN WEB SERVER & RUTE
// =================================================================
app.set('view engine', 'ejs');
app.get('/', (req, res) => res.redirect('/dashboard'));
app.get('/dashboard', (req, res) => res.render('dashboard'));

app.get('/api/status', (req, res) => {
    loadDatabase();
    loadViolations();
    const usersArray = Object.keys(db).map(key => ({ id: key, ...db[key] }));
    const waitingUsers = waitingQueue.map(id => getUser(id));
    const activePairs = [];
    const processed = new Set();
    Object.keys(activeChats).forEach(userId => {
        if (!processed.has(userId)) {
            const partnerId = activeChats[userId].partner;
            activePairs.push({
                roomId: activeChats[userId].roomId,
                user1: getUser(userId)?.nickname,
                user2: getUser(partnerId)?.nickname
            });
            processed.add(userId);
            processed.add(partnerId);
        }
    });
    res.json({
        users: usersArray,
        waiting: waitingUsers,
        active: activePairs,
        violations,
        botStatus: botStatus,
        qrCode: qrCodeDataUrl,
        serverLogs: serverLogs
    });
});
app.get('/api/chatlog/:roomId', (req, res) => {
    const roomId = req.params.roomId.replace(/[^a-zA-Z0-9]/g, '');
    const logPath = `${LOG_DIR}/${roomId}.json`;
    try {
        if (fs.existsSync(logPath)) {
            const data = fs.readFileSync(logPath, 'utf-8');
            res.json(JSON.parse(data));
        } else { res.status(404).json({ error: 'Log tidak ditemukan' }); }
    } catch (error) { res.status(500).json({ error: 'Gagal membaca log' }); }
});
app.post('/toggle-ban', (req, res) => {
    loadDatabase();
    const { userId } = req.body;
    const user = getUser(userId);
    if (user) {
        user.isBanned = !user.isBanned;
        saveDatabase();
    }
    res.redirect('/dashboard');
});
app.post('/broadcast', async (req, res) => {
    const { message } = req.body;
    if (!message) {
        return res.status(400).send("Pesan tidak boleh kosong.");
    }
    loadDatabase();
    const allUserIds = Object.keys(db);
    res.send(`Broadcast dimulai! Mengirim pesan ke ${allUserIds.length} pengguna. Ini akan memakan waktu...`);
    customLog(`[BROADCAST] Memulai pengiriman ke ${allUserIds.length} pengguna.`);
    for (const userId of allUserIds) {
        try {
            const user = getUser(userId);
            if (user && !user.isBanned && user.role !== 'admin') {
                await client.sendMessage(userId, message);
                customLog(`[BROADCAST] Pesan terkirim ke ${user.nickname}`);
            }
        } catch (error) {
            customLog(`[BROADCAST] Gagal mengirim ke ${userId}: ${error.message}`);
        }
        const randomDelay = Math.floor(Math.random() * 10000) + 5000;
        await new Promise(resolve => setTimeout(resolve, randomDelay));
    }
    customLog('[BROADCAST] Selesai.');
});


// =================================================================
//                      LOGIKA UTAMA BOT WHATSAPP
// =================================================================
client.on('message', async (message) => {
    const text = message.body.trim();
    const lowerCaseText = text.toLowerCase();
    const user_id = message.from;
    const user = getUser(user_id);

    if (user.isBanned) return;

    if (activeChats[user_id]) {
        const { partner: partner_id, roomId } = activeChats[user_id];
        if (lowerCaseText === '!stop') {
            delete activeChats[user_id];
            delete activeChats[partner_id];
            await message.reply('Kamu telah mengakhiri sesi chat.');
            await client.sendMessage(partner_id, 'Partner telah mengakhiri sesi chat.');
            return;
        }
        if (lowerCaseText === '!lapor') {
            const reporter = getUser(user_id);
            const reported = getUser(partner_id);
            const timestamp = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
            let chatHistory = [];
            const logPath = `${LOG_DIR}/${roomId}.json`;
            try {
                if (fs.existsSync(logPath)) {
                    const logContent = fs.readFileSync(logPath, 'utf-8');
                    chatHistory = JSON.parse(logContent).slice(-10);
                }
            } catch (error) { customLog(`Gagal membaca log untuk laporan: ${error.message}`); }
            violations.push({ timestamp, type: 'Laporan Pengguna', roomId, reporter: { id: user_id, nickname: reporter.nickname }, reported: { id: partner_id, nickname: reported.nickname }, chatHistory });
            saveViolations();
            delete activeChats[user_id];
            delete activeChats[partner_id];
            await message.reply('Laporanmu telah diterima. Sesi chat dihentikan.');
            await client.sendMessage(partner_id, 'Sesi chat dihentikan oleh sistem karena ada laporan.');
            return;
        }
        if (checkProfanity(text)) {
            const timestamp = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
            violations.push({ timestamp, type: 'Kata Kasar', userId: user_id, nickname: user.nickname, roomId, message: text });
            saveViolations();
            return message.reply('Pesanmu mengandung kata kasar dan tidak dikirim. Pelanggaran dicatat.');
        }
        logChatMessage(roomId, user_id, text);
        setTimeout(() => {
            client.sendMessage(partner_id, text);
        }, 1500);
        return;
    }

    if (['halo', 'p', 'salam', '!menu'].includes(lowerCaseText)) {
        const menuText = `Hai *${user.nickname}*! 👋 Selamat datang di bot AnonyChat & Stiker.\n\n*Fitur yang tersedia:*\n\n1.  *!chat*\n    _Mencari partner ngobrol acak._\n\n2.  *!stop*\n    _Menghentikan sesi chat atau pencarian._\n\n3.  *!lapor*\n    _Melaporkan partner chat Anda saat ini._\n\n4.  *!stiker*\n    _Kirim gambar dengan caption ini untuk jadi stiker._`;
        return message.reply(menuText);
    }
    
    const command = lowerCaseText.split(' ')[0];
    switch (command) {
        case '!chat':
            if (waitingQueue.includes(user_id)) return message.reply('Kamu sudah dalam antrian.');
            if (waitingQueue.length > 0) {
                const partner_id = waitingQueue.shift();
                if (partner_id === user_id) {
                    waitingQueue.push(user_id);
                    return message.reply('Mencoba mencari partner lain...');
                }
                const roomId = generateRoomId();
                activeChats[user_id] = { partner: partner_id, roomId };
                activeChats[partner_id] = { partner: user_id, roomId };
                fs.writeFileSync(`${LOG_DIR}/${roomId}.json`, '[]');
                await client.sendMessage(user_id, `Asiik, partner ditemukan!. !stop untuk skip`);
                await client.sendMessage(partner_id, `Asiik, partner ditemukan!. !stop untuk skip`);
            } else {
                waitingQueue.push(user_id);
                await message.reply('Oke, kamu masuk antrian ya. Aku lagi cariin partner...');
            }
            break;
        case '!stop':
            if (waitingQueue.includes(user_id)) {
                waitingQueue = waitingQueue.filter(id => id !== user_id);
                await message.reply('Pencarian dibatalkan.');
            } else {
                await message.reply('Kamu tidak sedang dalam sesi chat atau antrian.');
            }
            break;
        case '!stiker':
             if (message.hasMedia) {
                message.reply('Sip, stikernya lagi dibikin...');
                try {
                    const media = await message.downloadMedia();
                    await client.sendMessage(message.from, media, { sendMediaAsSticker: true, stickerAuthor: "AnonyChat Bot", stickerName: `Stiker by ${user.nickname}` });
                } catch (error) {
                    message.reply('Duh, maaf, ada masalah saat membuat stiker.');
                }
            } else {
                message.reply('Kirim gambarnya dulu dengan caption *!stiker* ya.');
            }
            break;
    }
});


// =================================================================
//                      MENJALANKAN SERVER & BOT
// =================================================================
customLog('Bot sedang dijalankan...');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR);
loadDatabase();
loadViolations();
// Load config jika ada
if (fs.existsSync(CONFIG_FILE)) { loadConfig(); }


app.listen(port, () => {
    customLog(`🚀 Dashboard web berjalan di http://localhost:${port}/dashboard`);
});

client.on('qr', async (qr) => {
    botStatus = 'WAITING_FOR_QR_SCAN';
    qrCodeDataUrl = await qrcode.toDataURL(qr);
    customLog('[CLIENT] QR Code diterima. Tampilkan di dashboard.');
});

client.on('ready', () => {
    botStatus = 'CONNECTED';
    qrCodeDataUrl = '';
    customLog('🚀 Bot WhatsApp sudah siap dan terhubung!');
    if (config.adminNumber) {
        client.sendMessage(config.adminNumber, `✅ Bot berhasil terhubung dan siap digunakan.`);
    }
});

client.on('disconnected', (reason) => {
    botStatus = 'DISCONNECTED';
    customLog(`[CLIENT DISCONNECTED] ${reason}.`);
});

client.initialize();
