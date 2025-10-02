// =================================================================
//                          MODUL & INISIALISASI
// =================================================================
const qrcode = require('qrcode');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const fs = require('fs');
const express = require('express');
const badWords = require('./profanity-list.js');

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

let db = {};
let violations = [];
let waitingQueue = [];
let activeChats = {};

let botStatus = 'INITIALIZING';
let qrCodeDataUrl = '';
let serverLogs = [];
let broadcastStatus = { isRunning: false, progress: 0, total: 0, currentUser: '' };

app.use(express.urlencoded({ extended: true }));

// =================================================================
//                          FUNGSI HELPER
// =================================================================

function customLog(message) {
    console.log(message);
    const timestamp = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
    serverLogs.push({ timestamp, message });
    if (serverLogs.length > 100) serverLogs.shift();
}

function loadDatabase() {
    try {
        if (fs.existsSync(DB_FILE)) {
            const data = fs.readFileSync(DB_FILE, 'utf-8');
            db = data.length > 0 ? JSON.parse(data) : {};
        } else { fs.writeFileSync(DB_FILE, JSON.stringify({})); db = {}; }
    } catch (error) { customLog(`Gagal memuat database: ${error.message}`); db = {}; }
}

function saveDatabase() {
    try { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); } catch (error) { customLog(`Gagal menyimpan database: ${error.message}`); }
}

function loadViolations() {
    try {
        if (fs.existsSync(VIOLATIONS_FILE)) {
            const data = fs.readFileSync(VIOLATIONS_FILE, 'utf-8');
            violations = data.length > 0 ? JSON.parse(data) : [];
        } else { fs.writeFileSync(VIOLATIONS_FILE, '[]'); violations = []; }
    } catch (error) { customLog(`Gagal memuat violations: ${error.message}`); violations = []; }
}

function saveViolations() {
    try { fs.writeFileSync(VIOLATIONS_FILE, JSON.stringify(violations, null, 2)); } catch (error) { customLog(`Gagal menyimpan violations: ${error.message}`); }
}

function getUser(userId) {
    if (!db[userId]) {
        db[userId] = { nickname: userId.split('@')[0], role: 'user', isBanned: false };
        saveDatabase();
    }
    return db[userId];
}

function generateRoomId() { return `wafa${Math.floor(100000 + Math.random() * 900000)}`; }

function checkProfanity(message) {
    const words = message.toLowerCase().split(/\s+/);
    return badWords.some(word => words.includes(word));
}

function logChatMessage(roomId, userId, message, mediaType = 'text') {
    const logPath = `${LOG_DIR}/${roomId}.json`;
    const user = getUser(userId);
    const timestamp = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
    const logEntry = { timestamp, nickname: user.nickname, message: mediaType === 'text' ? message : `[Media: ${mediaType}]` };
    try {
        let logs = [];
        if (fs.existsSync(logPath)) { logs = JSON.parse(fs.readFileSync(logPath, 'utf-8')); }
        logs.push(logEntry);
        fs.writeFileSync(logPath, JSON.stringify(logs, null, 2));
    } catch (error) { customLog(`Gagal menulis log chat untuk room ${roomId}: ${error.message}`); }
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
            activePairs.push({ roomId: activeChats[userId].roomId, user1: getUser(userId)?.nickname, user2: getUser(partnerId)?.nickname });
            processed.add(userId); processed.add(partnerId);
        }
    });
    res.json({ users: usersArray, waiting: waitingUsers, active: activePairs, violations, botStatus: botStatus, qrCode: qrCodeDataUrl, serverLogs: serverLogs });
});

app.get('/api/broadcast-status', (req, res) => { res.json(broadcastStatus); });

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
    if (user) { user.isBanned = !user.isBanned; saveDatabase(); }
    res.redirect('/dashboard');
});

app.post('/broadcast', (req, res) => {
    const { message } = req.body;
    if (!message) { return res.status(400).send("Pesan tidak boleh kosong."); }
    if (broadcastStatus.isRunning) { return res.status(400).send("Broadcast lain sedang berjalan."); }
    loadDatabase();
    const allUserIds = Object.keys(db).filter(id => { const user = db[id]; return user && !user.isBanned && user.role !== 'admin'; });
    broadcastStatus = { isRunning: true, progress: 0, total: allUserIds.length, currentUser: '' };
    res.status(200).send("Broadcast dimulai! Pantau progres di dashboard.");
    (async () => {
        for (let i = 0; i < allUserIds.length; i++) {
            const userId = allUserIds[i];
            const user = getUser(userId);
            broadcastStatus.currentUser = user.nickname;
            broadcastStatus.progress = i + 1;
            try { await client.sendMessage(userId, message); } catch (error) { customLog(`[BROADCAST] Gagal mengirim ke ${userId}: ${error.message}`); }
            const randomDelay = Math.floor(Math.random() * 8000) + 3000;
            await new Promise(resolve => setTimeout(resolve, randomDelay));
        }
        broadcastStatus.isRunning = false;
        broadcastStatus.currentUser = 'Selesai';
    })();
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
        if (lowerCaseText === '!stop' || lowerCaseText === '!skip') {
            delete activeChats[user_id]; delete activeChats[partner_id];
            await message.reply('Sesi chat diakhiri. Ketik *!chat* untuk mencari partner baru.');
            await client.sendMessage(partner_id, 'Yah, partnermu telah mengakhiri sesi. Jangan sedih, yuk cari lagi dengan ketik *!chat*! 😊');
            return;
        }
        if (lowerCaseText === '!lapor') {
            const reporter = getUser(user_id); const reported = getUser(partner_id); const timestamp = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
            let chatHistory = [];
            const logPath = `${LOG_DIR}/${roomId}.json`;
            try {
                if (fs.existsSync(logPath)) { const logContent = fs.readFileSync(logPath, 'utf-8'); chatHistory = JSON.parse(logContent).slice(-10); }
            } catch (error) { customLog(`Gagal membaca log untuk laporan: ${error.message}`); }
            violations.push({ timestamp, type: 'Laporan Pengguna', roomId, reporter: { id: user_id, nickname: reporter.nickname }, reported: { id: partner_id, nickname: reported.nickname }, chatHistory });
            saveViolations();
            delete activeChats[user_id]; delete activeChats[partner_id];
            await message.reply('Laporanmu telah diterima dan akan ditinjau oleh admin. Sesi chat ini telah dihentikan.');
            await client.sendMessage(partner_id, 'Sesi chat telah dihentikan oleh sistem karena adanya laporan dari partner.');
            return;
        }
        if (message.hasMedia && (message.type === 'image' || message.type === 'sticker')) {
            await message.reply('⏳ _Sedang meneruskan media ke partner..._');
            try {
                const media = await message.downloadMedia();
                logChatMessage(roomId, user_id, '', message.type);
                await client.sendMessage(partner_id, media, { caption: message.type === 'image' ? text : undefined });
            } catch (error) { message.reply('Duh, maaf, gagal meneruskan media.'); }
            return;
        }
        if (checkProfanity(text)) {
            const timestamp = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
            violations.push({ timestamp, type: 'Kata Kasar', userId: user_id, nickname: user.nickname, roomId, message: text });
            saveViolations();
            return message.reply('Eits, bahasanya dijaga ya. Pesanmu nggak aku kirim dan aku catat sebagai pelanggaran.');
        }
        logChatMessage(roomId, user_id, text);
        setTimeout(() => { client.sendMessage(partner_id, text); }, 1500);
        return;
    }

    const command = lowerCaseText.split(' ')[0];
    if (['halo', 'p', 'salam', '!menu'].includes(command)) {
        const menuText = `Hai *${user.nickname}*! 👋 Selamat datang di bot AnonyChat & Stiker.\n\n*Fitur yang tersedia:*\n\n1.  *!chat*\n    _Mencari partner ngobrol acak._\n\n2.  *!stop* / *!skip*\n    _Menghentikan sesi chat atau pencarian._\n\n3.  *!lapor*\n    _Melaporkan partner chat Anda saat ini._\n\n4.  *!stiker*\n    _Kirim gambar dengan caption ini untuk jadi stiker._`;
        return message.reply(menuText);
    }
    
    switch (command) {
        case '!chat':
            if (waitingQueue.includes(user_id)) return message.reply('Tenang, kamu sudah dalam antrian kok. Aku lagi cariin partner yang pas, sabar ya!');
            await findPartner(message);
            break;
        case '!stop':
            if (waitingQueue.includes(user_id)) {
                waitingQueue = waitingQueue.filter(id => id !== user_id);
                await message.reply('Pencarian dibatalkan. Kalau berubah pikiran, panggil aku lagi dengan *!chat* ya!');
            } else { await message.reply('Hmm, sepertinya kamu sedang tidak dalam sesi chat atau antrian.'); }
            break;
        case '!stiker':
             if (message.hasMedia) {
                message.reply('Sip, stikernya lagi dibikin nih...');
                try {
                    const media = await message.downloadMedia();
                    await client.sendMessage(message.from, media, { sendMediaAsSticker: true, stickerAuthor: "AnonyChat Bot", stickerName: `Stiker by ${user.nickname}` });
                } catch (error) { message.reply('Duh, maaf, sepertinya ada masalah saat membuat stiker.'); }
            } else { message.reply('Kirim gambarnya dulu dengan caption *!stiker* untuk dibuatkan stiker ya.'); }
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

app.listen(port, () => {
    customLog(`🚀 Dashboard web berjalan di http://localhost:${port}/dashboard`);
});

client.on('qr', async (qr) => {
    botStatus = 'WAITING_FOR_QR_SCAN';
    qrCodeDataUrl = await qrcode.toDataURL(qr);
    customLog('[CLIENT] QR Code perlu di-scan. Tampilkan di dashboard.');
});
client.on('ready', () => {
    botStatus = 'CONNECTED';
    qrCodeDataUrl = '';
    customLog('🚀 Bot WhatsApp sudah siap dan terhubung!');
});
client.on('disconnected', (reason) => {
    botStatus = 'DISCONNECTED';
    customLog(`[CLIENT DISCONNECTED] ${reason}.`);
});

client.initialize();
