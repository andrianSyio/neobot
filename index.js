// =================================================================
//                          MODUL & INISIALISASI
// =================================================================
const qrcode = require('qrcode-terminal');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const fs = require('fs');
const express = require('express');
const badWords = require('./profanity-list.js');

// Inisialisasi Klien WhatsApp dan Web Server
// Ganti blok 'new Client' Anda dengan yang ini
const client = new Client({
    authStrategy: new LocalAuth({ dataPath: '.' }), // Menggunakan titik '.' agar folder default .wwebjs_auth yang dibuat
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

// Middleware untuk membaca form data dari dashboard
app.use(express.urlencoded({ extended: true }));


// =================================================================
//                          FUNGSI HELPER
// =================================================================

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
    } catch (error) { console.error('Gagal memuat database:', error); db = {}; }
}

/** Menyimpan state database saat ini ke file database.json */
function saveDatabase() {
    try {
        fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
    } catch (error) { console.error('Gagal menyimpan database:', error); }
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
    } catch (error) { console.error('Gagal memuat violations:', error); violations = []; }
}

/** Menyimpan data pelanggaran ke violations.json */
function saveViolations() {
    try {
        fs.writeFileSync(VIOLATIONS_FILE, JSON.stringify(violations, null, 2));
    } catch (error) { console.error('Gagal menyimpan violations:', error); }
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
    return words.some(word => badWords.includes(word));
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
        console.error(`Gagal menulis log chat untuk room ${roomId}:`, error);
    }
}


// =================================================================
//                      PENGATURAN WEB SERVER & RUTE
// =================================================================
app.set('view engine', 'ejs');
app.get('/dashboard', (req, res) => res.render('dashboard'));

// --- API Endpoints untuk Data Real-time ---
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
    res.json({ users: usersArray, waiting: waitingUsers, active: activePairs, violations });
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

// --- Rute untuk Aksi dari Form Dashboard ---
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


// =================================================================
//                      LOGIKA UTAMA BOT WHATSAPP
// =================================================================
client.on('message', async (message) => {
    const text = message.body.trim();
    const lowerCaseText = text.toLowerCase();
    const user_id = message.from;
    const user = getUser(user_id);

    if (user.isBanned) {
        return message.reply('Mohon maaf, aksesmu telah dibatasi karena melanggar aturan. Silakan hubungi admin.');
    }

    if (activeChats[user_id]) {
        const { partner: partner_id, roomId } = activeChats[user_id];
        if (lowerCaseText === '!stop') {
            delete activeChats[user_id];
            delete activeChats[partner_id];
            await message.reply('Sesi chat diakhiri. Semoga obrolannya menyenangkan! Ketik *!chat* untuk mencari partner baru.');
            await client.sendMessage(partner_id, 'Yah, partnermu telah mengakhiri sesi. Jangan sedih, yuk cari lagi dengan ketik *!chat*! 😊');
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
            } catch (error) { console.error("Gagal membaca log chat untuk laporan:", error); }
            violations.push({ timestamp, type: 'Laporan Pengguna', roomId, reporter: { id: user_id, nickname: reporter.nickname }, reported: { id: partner_id, nickname: reported.nickname }, chatHistory });
            saveViolations();
            delete activeChats[user_id];
            delete activeChats[partner_id];
            await message.reply('Laporanmu telah diterima dan akan ditinjau oleh admin. Sesi chat ini telah dihentikan.');
            await client.sendMessage(partner_id, 'Sesi chat telah dihentikan oleh sistem karena adanya laporan dari partner.');
            return;
        }
        if (checkProfanity(text)) {
            const timestamp = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
            violations.push({ timestamp, type: 'Kata Kasar', userId: user_id, nickname: user.nickname, roomId, message: text });
            saveViolations();
            return message.reply('Eits, bahasanya dijaga ya. Pesanmu nggak aku kirim dan aku catat sebagai pelanggaran.');
        }
        logChatMessage(roomId, user_id, text);
        await client.sendMessage(partner_id, text);
        return;
    }

    const command = lowerCaseText.split(' ')[0];
    if (['halo', 'p', 'salam', '!menu'].includes(command)) {
        const menuText = `Hai *${user.nickname}*! 👋 Selamat datang di bot AnonyChat & Stiker.\n\n*Fitur yang tersedia:*\n\n1.  *!chat*\n    _Mencari partner ngobrol acak._\n\n2.  *!stop*\n    _Menghentikan sesi chat atau pencarian._\n\n3.  *!lapor*\n    _Melaporkan partner chat Anda saat ini._\n\n4.  *!stiker*\n    _Kirim gambar dengan caption ini untuk jadi stiker._`;
        return message.reply(menuText);
    }
    
    switch (command) {
        case '!chat':
            if (waitingQueue.includes(user_id)) return message.reply('Tenang, kamu sudah dalam antrian kok. Aku lagi cariin partner yang pas, sabar ya!');
            if (waitingQueue.length > 0) {
                const partner_id = waitingQueue.shift();
                if (partner_id === user_id) {
                    waitingQueue.push(user_id);
                    return message.reply('Ups, hampir dapat diri sendiri. Mencari partner lain...');
                }
                const roomId = generateRoomId();
                activeChats[user_id] = { partner: partner_id, roomId };
                activeChats[partner_id] = { partner: user_id, roomId };
                fs.writeFileSync(`${LOG_DIR}/${roomId}.json`, '[]');
                await client.sendMessage(user_id, `Asiik, partner ditemukan! Room ID: *${roomId}*. Selamat ngobrol ya!\n\nKalau sudah selesai, jangan lupa ketik *!stop* atau *!lapor*.`);
                await client.sendMessage(partner_id, `Asiik, partner ditemukan! Room ID: *${roomId}*. Selamat ngobrol ya!\n\nKalau sudah selesai, jangan lupa ketik *!stop* atau *!lapor*.`);
            } else {
                waitingQueue.push(user_id);
                await message.reply('Oke, kamu masuk antrian ya. Aku lagi cariin partner yang pas buatmu, sabar sebentar...');
            }
            break;
        case '!stop':
            if (waitingQueue.includes(user_id)) {
                waitingQueue = waitingQueue.filter(id => id !== user_id);
                await message.reply('Pencarian dibatalkan. Kalau berubah pikiran, panggil aku lagi dengan *!chat* ya!');
            } else {
                await message.reply('Hmm, sepertinya kamu sedang tidak dalam sesi chat atau antrian.');
            }
            break;
        case '!stiker':
             if (message.hasMedia) {
                message.reply('Sip, stikernya lagi dibikin nih...');
                try {
                    const media = await message.downloadMedia();
                    await client.sendMessage(message.from, media, { sendMediaAsSticker: true, stickerAuthor: "AnonyChat Bot", stickerName: `Stiker by ${user.nickname}` });
                } catch (error) {
                    message.reply('Duh, maaf, sepertinya ada masalah saat membuat stiker. Coba kirim gambar lain ya.');
                }
            } else {
                message.reply('Kirim gambarnya dulu dengan caption *!stiker* untuk dibuatkan stiker ya.');
            }
            break;
    }
});


// =================================================================
//                      MENJALANKAN SERVER & BOT
// =================================================================
console.log('Bot sedang dijalankan...');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR);
loadDatabase();
loadViolations();

app.listen(port, () => {
    console.log(`🚀 Dashboard web berjalan di http://localhost:${port}/dashboard`);
});

client.on('qr', qr => { console.log('[CLIENT] QR Code diterima, silakan scan!'); qrcode.generate(qr, { small: true }); });
client.on('ready', () => { console.log('🚀 Bot WhatsApp sudah siap dan terhubung!'); });
client.on('disconnected', (reason) => { console.log('[CLIENT DISCONNECTED]', reason); client.initialize(); });

client.initialize();
