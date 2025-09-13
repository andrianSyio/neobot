// =================================================================
//                          MODUL & INISIALISASI
// =================================================================
require('dotenv').config();
const qrcode = require('qrcode-terminal');
const { Client, LocalAuth } = require('whatsapp-web.js');
const fs = require('fs');
const express = require('express');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const badWords = require('./profanity-list.js');

// Inisialisasi Klien WhatsApp, Web Server, dan AI
const client = new Client({
    authStrategy: new LocalAuth({ dataPath: '.' }),
    puppeteer: { args: ['--no-sandbox', '--disable-setuid-sandbox'] }
});
const app = express();
const port = process.env.PORT || 3000;
let genAI, model;

// =================================================================
//                      PENGATURAN & VARIABEL GLOBAL
// =================================================================
const CONFIG_FILE = './config.json';
const DB_FILE = './database.json';
const VIOLATIONS_FILE = './violations.json';
const LOG_DIR = './chat_logs';

let config = {};
let db = {};
let violations = [];
let waitingQueue = [];
let activeChats = {};
let activeModes = {};
let queueTimers = {};
const XP_PER_TIER = 500;
const TIERS = ["Newbie", "Bronze", "Silver", "Gold", "Platinum", "Diamond", "Master", "Grandmaster", "Legend"];

// Middleware untuk membaca form data dari dashboard
app.use(express.urlencoded({ extended: true }));


// =================================================================
//                          FUNGSI HELPER
// =================================================================

/** Memuat konfigurasi dari file config.json dan menginisialisasi Gemini */
function loadConfig() {
    try {
        if (fs.existsSync(CONFIG_FILE)) {
            const data = fs.readFileSync(CONFIG_FILE, 'utf-8');
            config = JSON.parse(data);
            if (config.geminiApiKey) {
                genAI = new GoogleGenerativeAI(config.geminiApiKey);
                model = genAI.getGenerativeModel({ model: "gemini-1.5-flash-latest" });
            }
            console.log('[CONFIG] Konfigurasi berhasil dimuat.');
        } else {
            console.error("[FATAL] File config.json tidak ditemukan! Bot tidak bisa berjalan.");
            process.exit(1);
        }
    } catch (error) {
        console.error('[FATAL] Gagal memuat atau mem-parse config.json:', error);
        process.exit(1);
    }
}

/** Menyimpan state konfigurasi saat ini ke file config.json */
function saveConfig() {
    try {
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
        loadConfig(); // Muat ulang konfigurasi setelah menyimpan
    } catch (error) { console.error('Gagal menyimpan config.json:', error); }
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

/** Mendapatkan profil user, membuat profil baru jika belum ada, dan memperbaiki profil lama */
function getUser(userId) {
    if (!db[userId]) {
        db[userId] = {
            nickname: userId.split('@')[0],
            xp: 0,
            tier: 'Newbie',
            role: 'user',
            isBanned: false
        };
        saveDatabase();
    } else {
        let needsSave = false;
        if (db[userId].xp === undefined) { db[userId].xp = 0; needsSave = true; }
        if (db[userId].tier === undefined) { db[userId].tier = getTier(db[userId].xp); needsSave = true; }
        if (needsSave) { saveDatabase(); }
    }
    return db[userId];
}

/** Menghitung tier berdasarkan jumlah XP */
function getTier(xp) {
    const tierIndex = Math.floor(xp / XP_PER_TIER);
    return TIERS[tierIndex] || TIERS[TIERS.length - 1];
}

/** Menambah XP ke user dan memeriksa kenaikan tier */
function addXp(userId, amount) {
    const user = getUser(userId);
    user.xp += amount;
    const newTier = getTier(user.xp);
    let tierChanged = false;
    if (user.tier !== newTier) {
        user.tier = newTier;
        tierChanged = true;
    }
    saveDatabase();
    return tierChanged;
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

/** Memulai sesi game baru untuk user */
async function startNewGame(message, gameType) {
    const user_id = message.from;
    try {
        if (activeModes[user_id] && activeModes[user_id].timerId) {
            clearTimeout(activeModes[user_id].timerId);
        }
        await message.reply(`_Oke, aku lagi siapin soal *${gameType}* berikutnya... 🧐_`);
        let prompt = '';
        switch (gameType) {
            case 'Kuis Hewan': prompt = 'Buatkan satu soal tebak hewan yang unik dari deskripsinya. Format JSON: {"soal": "deskripsi", "jawaban": "jawaban"}'; break;
            case 'Kuis Umum': prompt = 'Buatkan satu kuis pengetahuan umum yang menarik. Format JSON: {"soal": "pertanyaan", "jawaban": "jawaban"}'; break;
            case 'Kuis Budaya Indonesia': prompt = 'Buatkan satu pertanyaan menarik tentang budaya/pulau/sejarah Indonesia. Format JSON: {"soal": "pertanyaan", "jawaban": "jawaban"}'; break;
            case 'MTK': prompt = 'Buatkan satu soal matematika dasar level SMP. Format JSON: {"soal": "soal", "jawaban": "jawaban"}'; break;
        }
        const result = await model.generateContent(prompt);
        const rawText = result.response.text();
        const cleanedText = rawText.replace(/```json\n|```/g, "").trim();
        const jsonResponse = JSON.parse(cleanedText);

        const timerId = setTimeout(async () => {
            if (activeModes[user_id] && activeModes[user_id].mode === gameType) {
                await client.sendMessage(user_id, `⌛ *Waktu Habis!* ⌛\n\nJawaban yang benar adalah *${activeModes[user_id].jawaban}*.`);
                await startNewGame(message, gameType);
            }
        }, 20000);

        activeModes[user_id] = { mode: gameType, jawaban: jsonResponse.jawaban, timerId: timerId };
        await message.reply(`*${gameType.toUpperCase()} DIMULAI!* 🚀 (Waktu 20 detik)\n\n${jsonResponse.soal}\n\nKetik jawabanmu, atau ketik *stop* untuk berhenti.`);
    } catch (error) {
        console.error(`Error saat memulai game ${gameType}:`, error);
        await message.reply(`Aduh, maaf, bank soal untuk *${gameType}* lagi error. Coba lagi nanti, ya!`);
        delete activeModes[user_id];
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
app.get('/api/config', (req, res) => res.json(config));
app.get('/api/chatlog/:roomId', (req, res) => {
    const roomId = req.params.roomId.replace(/[^a-zA-Z0-9]/g, '');
    const logPath = `${LOG_DIR}/${roomId}.json`;
    try {
        if (fs.existsSync(logPath)) {
            const data = fs.readFileSync(logPath, 'utf-8');
            res.json(JSON.parse(data));
        } else {
            res.status(404).json({ error: 'Log tidak ditemukan' });
        }
    } catch (error) {
        res.status(500).json({ error: 'Gagal membaca log' });
    }
});

// --- Rute untuk Aksi dari Form Dashboard ---
app.post('/update-user', (req, res) => {
    loadDatabase();
    const { userId, xp } = req.body;
    const user = getUser(userId);
    if (user) {
        user.xp = parseInt(xp, 10) || 0;
        user.tier = getTier(user.xp);
        saveDatabase();
    }
    res.redirect('/dashboard');
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
// ... (setelah rute app.post('/toggle-ban', ...))

// RUTE BARU UNTUK MENGIRIM BROADCAST
app.post('/broadcast', async (req, res) => {
    const { message } = req.body;
    if (!message) {
        return res.status(400).send("Pesan tidak boleh kosong.");
    }

    loadDatabase();
    const allUserIds = Object.keys(db);
    
    // Kirim respons ke admin terlebih dahulu agar browser tidak hang
    res.send(`Broadcast dimulai! Mengirim pesan ke ${allUserIds.length} pengguna. Ini akan memakan waktu...`);

    console.log(`[BROADCAST] Memulai pengiriman ke ${allUserIds.length} pengguna.`);

    // Kirim pesan satu per satu dengan jeda acak
    for (const userId of allUserIds) {
        try {
            // Jangan kirim ke pengguna yang dibanned atau admin
            const user = getUser(userId);
            if (user && !user.isBanned && user.role !== 'admin') {
                await client.sendMessage(userId, message);
                console.log(`[BROADCAST] Pesan terkirim ke ${user.nickname}`);
            }
        } catch (error) {
            console.error(`[BROADCAST] Gagal mengirim ke ${userId}:`, error.message);
        }

        // Jeda acak antara 5 sampai 15 detik
        const randomDelay = Math.floor(Math.random() * 10000) + 5000;
        await new Promise(resolve => setTimeout(resolve, randomDelay));
    }

    console.log('[BROADCAST] Selesai.');
});
app.post('/update-config', (req, res) => {
    const { botName, geminiApiKey, bannedMessage, menuReply, gameMenuReply } = req.body;
    config.botName = botName;
    config.geminiApiKey = geminiApiKey;
    config.bannedMessage = bannedMessage;
    config.replies.menu = menuReply;
    config.replies.gameMenu = gameMenuReply;
    saveConfig();
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

    // Prioritas #1: Cek Banned
    if (user.isBanned) {
        let bannedMessage = config.bannedMessage || "Kamu di Banned. Hubungi admin.";
        bannedMessage = bannedMessage.replace(/{nickname}/g, user.nickname);
        return message.reply(bannedMessage);
    }
    
    // Prioritas #2: Cek Sesi Anonymous Chat
    if (activeChats[user_id]) {
        const { partner: partner_id, roomId } = activeChats[user_id];
        if (lowerCaseText === '!stop') {
            delete activeChats[user_id];
            delete activeChats[partner_id];
            await message.reply('Kamu telah mengakhiri sesi chat. Ketik *!chat* untuk mencari partner baru.');
            await client.sendMessage(partner_id, '💔 dia pergi meninggalkanmu, ketik *!chat* untuk mencari lagi.');
            return;
        }
        if (checkProfanity(text)) {
            const timestamp = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
            violations.push({ timestamp, type: 'Kata Kasar', userId: user_id, nickname: user.nickname, roomId, message: text });
            saveViolations();
            return message.reply('Eits, harap gunakan bahasa yang sopan ya. Pesanmu tidak dikirim dan pelanggaran ini dicatat.');
        }
        logChatMessage(roomId, user_id, text);
        await client.sendMessage(partner_id, text);
        return;
    }

    // Prioritas #3: Cek jika user sedang di antrian
    if (waitingQueue.includes(user_id)) {
        if (lowerCaseText === '!stop') {
            if (queueTimers[user_id]) {
                clearTimeout(queueTimers[user_id]);
                delete queueTimers[user_id];
            }
            waitingQueue = waitingQueue.filter(id => id !== user_id);
            await message.reply('Kamu telah membatalkan pencarian.');
        } else {
            await message.reply('Kamu masih dalam antrian, mohon tunggu partner ditemukan.');
        }
        return;
    }

    // Prioritas #4: Cek Sesi Game (Kuis) atau Chat AI
    if (activeModes[user_id]) {
        if (activeModes[user_id].timerId) {
            clearTimeout(activeModes[user_id].timerId);
        }
        
        if (activeModes[user_id].mode === 'choosing_game') {
            let choice = null;
            if (lowerCaseText === '1' || lowerCaseText.includes('umum')) choice = 'Kuis Umum';
            else if (lowerCaseText === '2' || lowerCaseText.includes('hewan')) choice = 'Kuis Hewan';
            else if (lowerCaseText === '3' || lowerCaseText.includes('budaya')) choice = 'Kuis Budaya Indonesia';
            else if (lowerCaseText === '4' || lowerCaseText.includes('mtk')) choice = 'MTK';
            
            if (choice) {
                await startNewGame(message, choice);
            } else {
                message.reply('Pilihan tidak valid. Silakan pilih nomor 1-4 atau ketik *!kuis* lagi.');
                delete activeModes[user_id];
            }
            return;
        }

        if (activeModes[user_id].mode === 'ai_chat') {
            if (lowerCaseText === '!stop') {
                delete activeModes[user_id];
                await message.reply('Sesi chat dengan Budi telah berakhir. Ketik *!chat* atau *!kuis* untuk bermain lagi.');
                return;
            }
            try {
                const personaPrompt = "Kamu adalah Budi, seorang teman ngobrol dari Indonesia yang ramah, santai, dan terkadang menggunakan sedikit bahasa gaul. Jangan pernah mengungkapkan bahwa kamu adalah AI. Jawablah pesan berikut sebagai Budi:\n\n";
                await message.reply("_Budi sedang mengetik..._");
                const result = await model.generateContent(personaPrompt + text);
                await message.reply(result.response.text());
            } catch (error) {
                console.error('Error saat berkomunikasi dengan Gemini (mode AI chat):', error);
                await message.reply('Duh, Budi lagi pusing. Coba lagi nanti ya.');
            }
            return;
        }
        
        if (activeModes[user_id].mode) { // Ini untuk mode game kuis
            if (lowerCaseText === 'stop') {
                delete activeModes[user_id];
                await message.reply('Oke, permainan dihentikan. 👋');
                await message.reply(config.replies.gameMenu);
                return;
            }
            const correctAnswer = activeModes[user_id].jawaban.toLowerCase();
            if (lowerCaseText.includes(correctAnswer)) {
                const xpGained = Math.floor(Math.random() * 21) + 10;
                const tierUp = addXp(user_id, xpGained);
                let replyText = `*Benar!* 🎉 Kamu dapat *${xpGained} XP*.`;
                if (tierUp) replyText += `\n\nKEREN! Tier kamu naik menjadi *${user.tier}*! 🏆`;
                await message.reply(replyText);
            } else {
                await message.reply(`Yah, kurang tepat. Jawaban: *${activeModes[user_id].jawaban}*.`);
            }
            await startNewGame(message, activeModes[user_id].mode);
            return;
        }
    }
    
    // Prioritas #5: Proses Perintah & Sapaan
    if (['halo', 'p', 'salam', '!menu'].includes(lowerCaseText)) {
        let menuText = config.replies.menu;
        menuText = menuText.replace(/{nickname}/g, user.nickname).replace(/{tier}/g, user.tier).replace(/{xp}/g, user.xp).replace(/{botName}/g, config.botName);
        return message.reply(menuText);
    }
    
    const command = lowerCaseText.split(' ')[0];
    const knownCommands = ['!kuis', '!rank', '!profil', '!setnickname', '!chat', '!stop'];
    
    if (knownCommands.includes(command)) {
        switch (command) {
            case '!kuis':
                activeModes[user_id] = { mode: 'choosing_game' };
                message.reply(config.replies.gameMenu);
                break;
            case '!rank':
                loadDatabase();
                const usersArray = Object.values(db).filter(u => u.role !== 'admin' && !u.isBanned);
                usersArray.sort((a, b) => b.xp - a.xp);
                let rankMessage = '🏆 *Peringkat Top 10 Pemain* 🏆\n\n';
                usersArray.slice(0, 10).forEach((p, index) => {
                    let medal = '';
                    if (index === 0) medal = '🥇'; else if (index === 1) medal = '🥈'; else if (index === 2) medal = '🥉'; else medal = `${index + 1}.`;
                    rankMessage += `${medal} *${p.nickname}* - ${p.xp} XP (Tier: ${p.tier})\n`;
                });
                const userRankIndex = usersArray.findIndex(p => p.nickname === user.nickname);
                if (userRankIndex !== -1) {
                    rankMessage += `\n--------------------\nPosisi Kamu:\n#${userRankIndex + 1} *${user.nickname}* - ${user.xp} XP (Tier: ${user.tier})`;
                }
                message.reply(rankMessage);
                break;
            case '!profil':
                message.reply(`*Profil Pengguna*\n- Nama: *${user.nickname}*\n- XP: *${user.xp}*\n- Tier: *${user.tier}*\n- Status: *${user.isBanned ? 'Banned' : 'Aktif'}*`);
                break;
            case '!setnickname':
                const newNickname = message.body.split(' ').slice(1).join(' ');
                if (!newNickname) return message.reply('Contoh: *!setnickname Raja Kuis*');
                user.nickname = newNickname;
                saveDatabase();
                message.reply(`Siap! Nama panggilanmu diganti menjadi *${newNickname}*`);
                break;
            case '!chat':
                if (waitingQueue.length > 0) {
                    const partner_id = waitingQueue.shift();
                    if (queueTimers[partner_id]) { clearTimeout(queueTimers[partner_id]); delete queueTimers[partner_id]; }
                    const roomId = generateRoomId();
                    activeChats[user_id] = { partner: partner_id, roomId };
                    activeChats[partner_id] = { partner: user_id, roomId };
                    fs.writeFileSync(`${LOG_DIR}/${roomId}.json`, '[]');
                    await client.sendMessage(user_id, `Partner ditemukan! Selamat chatting!`);
                    await client.sendMessage(partner_id, `Partner ditemukan! Selamat chatting!`);
                } else {
                    waitingQueue.push(user_id);
                    await message.reply('Sedang mencari partner... ⌛');
                    const timerId = setTimeout(() => {
                        const stillWaiting = waitingQueue.includes(user_id);
                        if (stillWaiting) {
                            waitingQueue = waitingQueue.filter(id => id !== user_id);
                            activeModes[user_id] = { mode: 'ai_chat' };
                            client.sendMessage(user_id, 'Tidak ada partner yang ditemukan, tapi jangan khawatir! Kamu akan dihubungkan dengan AI teman ngobrol kita, *Budi*.\n\nSapa dia! (Ketik *!stop* untuk mengakhiri)');
                        }
                        delete queueTimers[user_id];
                    }, 20000);
                    queueTimers[user_id] = timerId;
                }
                break;
            case '!stop':
                // Perintah stop ini hanya untuk membatalkan antrian, karena stop di dalam chat/game sudah ditangani di atas.
                if (waitingQueue.includes(user_id)) {
                    if (queueTimers[user_id]) { clearTimeout(queueTimers[user_id]); delete queueTimers[user_id]; }
                    waitingQueue = waitingQueue.filter(id => id !== user_id);
                    await message.reply('Kamu telah membatalkan pencarian.');
                } else { await message.reply('Kamu tidak sedang dalam sesi chat atau antrian.'); }
                break;
        }
    }
});

// =================================================================
//                      MENJALANKAN SERVER & BOT
// =================================================================
console.log('Bot sedang dijalankan...');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR);
loadConfig();
loadDatabase();
loadViolations();

app.listen(port, () => {
    console.log(`🚀 Dashboard web berjalan di http://localhost:${port}/dashboard`);
});

client.on('qr', qr => { console.log('[CLIENT] QR Code diterima, silakan scan!'); qrcode.generate(qr, { small: true }); });
client.on('ready', () => { console.log('🚀 Bot WhatsApp sudah siap dan terhubung!'); });
client.on('disconnected', (reason) => { console.log('[CLIENT DISCONNECTED]', reason); client.initialize(); });

client.initialize();