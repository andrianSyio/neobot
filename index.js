// =================================================================
//                         MODUL & INISIALISASI
// =================================================================
const qrcode = require('qrcode');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const fs = require('fs');
const express = require('express');
const { exec } = require('child_process'); // Diperlukan untuk FFmpeg
const badWords = require('./profanity-list.js');

const client = new Client({
    authStrategy: new LocalAuth({ dataPath: '.' }),
    puppeteer: { args: ['--no-sandbox', '--disable-setuid-sandbox'] }
});
const app = express();
const port = process.env.PORT || 3000;

// =================================================================
//                       PENGATURAN & VARIABEL GLOBAL
// =================================================================
const DB_FILE = './database.json';
const VIOLATIONS_FILE = './violations.json';
const LOG_DIR = './chat_logs';
const TEMP_DIR = './temp'; // Folder untuk file sementara

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
//                             FUNGSI HELPER
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
        } else {
            fs.writeFileSync(DB_FILE, JSON.stringify({}));
            db = {};
        }
    } catch (error) { customLog(`Gagal memuat database: ${error.message}`); db = {}; }
}

function saveDatabase() {
    try {
        fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
    } catch (error) { customLog(`Gagal menyimpan database: ${error.message}`); }
}

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

function saveViolations() {
    try {
        fs.writeFileSync(VIOLATIONS_FILE, JSON.stringify(violations, null, 2));
    } catch (error) { customLog(`Gagal menyimpan violations: ${error.message}`); }
}

function getUser(userId) {
    if (!db[userId]) {
        db[userId] = {
            nickname: userId.split('@')[0],
            role: 'user',
            isBanned: false,
            hasSeenRules: false
        };
        saveDatabase();
    }
    return db[userId];
}

function generateRoomId() {
    return `wafa${Math.floor(100000 + Math.random() * 900000)}`;
}

function checkProfanity(message) {
    const words = message.toLowerCase().split(/\s+/);
    return badWords.some(word => words.includes(word));
}

function logChatMessage(roomId, userId, message, mediaType = 'text') {
    const logPath = `${LOG_DIR}/${roomId}.json`;
    const user = getUser(userId);
    const timestamp = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
    const logEntry = {
        timestamp,
        userId,
        nickname: user.nickname,
        message: mediaType === 'text' ? message : `[Media: ${mediaType}]`
    };
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
//                       PENGATURAN WEB SERVER & RUTE
// =================================================================
app.set('view engine', 'ejs');
app.get('/', (req, res) => res.redirect('/dashboard'));
app.get('/dashboard', (req, res) => res.render('dashboard'));

app.get('/api/status', (req, res) => {
    loadDatabase();
    loadViolations();
    const usersArray = Object.keys(db).map(key => ({
        id: key,
        ...db[key]
    }));
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

app.get('/api/broadcast-status', (req, res) => {
    res.json(broadcastStatus);
});

app.get('/api/chatlog/:roomId', (req, res) => {
    const roomId = req.params.roomId.replace(/[^a-zA-Z0-9]/g, '');
    const logPath = `${LOG_DIR}/${roomId}.json`;
    try {
        if (fs.existsSync(logPath)) {
            const data = fs.readFileSync(logPath, 'utf-8');
            res.json(JSON.parse(data));
        } else {
            res.status(404).json({
                error: 'Log tidak ditemukan'
            });
        }
    } catch (error) {
        res.status(500).json({
            error: 'Gagal membaca log'
        });
    }
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

app.post('/broadcast', (req, res) => {
    const { message } = req.body;
    if (!message) {
        return res.status(400).send("Pesan tidak boleh kosong.");
    }
    if (broadcastStatus.isRunning) {
        return res.status(400).send("Broadcast lain sedang berjalan.");
    }
    loadDatabase();
    const allUserIds = Object.keys(db).filter(id => {
        const user = db[id];
        return user && !user.isBanned && user.role !== 'admin';
    });
    broadcastStatus = {
        isRunning: true,
        progress: 0,
        total: allUserIds.length,
        currentUser: ''
    };
    res.status(200).send("Broadcast dimulai! Pantau progres di dashboard.");
    (async () => {
        for (let i = 0; i < allUserIds.length; i++) {
            const userId = allUserIds[i];
            const user = getUser(userId);
            broadcastStatus.currentUser = user.nickname;
            broadcastStatus.progress = i + 1;
            try {
                await client.sendMessage(userId, message);
            } catch (error) {
                customLog(`[BROADCAST] Gagal mengirim ke ${userId}: ${error.message}`);
            }
            const randomDelay = Math.floor(Math.random() * 8000) + 3000;
            await new Promise(resolve => setTimeout(resolve, randomDelay));
        }
        broadcastStatus.isRunning = false;
        broadcastStatus.currentUser = 'Selesai';
    })();
});


// =================================================================
//                       LOGIKA UTAMA BOT WHATSAPP
// =================================================================
client.on('message', async (message) => {
    const text = message.body.trim();
    const lowerCaseText = text.toLowerCase();
    const user_id = message.from;
    const user = getUser(user_id);

    if (user.isBanned) {
        const bannedMessage = `Waduh, ${user.nickname}. Sepertinya akunmu sedang ditangguhkan (di-banned) karena melanggar peraturan.\n\nUntuk diskusi lebih lanjut mengenai pembukaan blokir, silakan hubungi admin di nomor 0895322080063 ya.`;
        return message.reply(bannedMessage);
    }

    if (activeChats[user_id]) {
        const { partner: partner_id, roomId } = activeChats[user_id];
        
        if (lowerCaseText === '!stop' || lowerCaseText === '!skip') {
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
            } catch (error) {
                customLog(`Gagal membaca log untuk laporan: ${error.message}`);
            }
            violations.push({
                timestamp, type: 'Laporan Pengguna', roomId,
                reporter: { id: user_id, nickname: reporter.nickname },
                reported: { id: partner_id, nickname: reported.nickname },
                chatHistory
            });
            saveViolations();
            delete activeChats[user_id];
            delete activeChats[partner_id];
            await message.reply('Laporanmu telah diterima dan akan ditinjau oleh admin. Sesi chat ini telah dihentikan.');
            await client.sendMessage(partner_id, 'Sesi chat telah dihentikan oleh sistem karena adanya laporan dari partner.');
            return;
        }
        
        if (message.hasMedia && (message.type === 'image' || message.type === 'sticker')) {
            await message.reply('⏳ _Sedang meneruskan media ke partner..._');
            try {
                const media = await message.downloadMedia();
                logChatMessage(roomId, user_id, '', message.type);
                const sendOptions = {};
                if (message.type === 'sticker') {
                    sendOptions.sendMediaAsSticker = true;
                } else if (message.type === 'image') {
                    sendOptions.caption = text;
                }
                await client.sendMessage(partner_id, media, sendOptions);
            } catch (error) {
                message.reply('Duh, maaf, gagal meneruskan media.');
                customLog(`Gagal meneruskan media: ${error.message}`);
            }
            return;
        }

        if (checkProfanity(text)) {
            const timestamp = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
            violations.push({
                timestamp, type: 'Kata Kasar', userId: user_id,
                nickname: user.nickname, roomId, message: text
            });
            saveViolations();
            return message.reply('Eits, bahasanya dijaga ya. Pesanmu nggak aku kirim dan aku catat sebagai pelanggaran.');
        }

        if (text) {
            logChatMessage(roomId, user_id, text);
            setTimeout(() => {
                client.sendMessage(partner_id, text);
            }, 1500);
        }
        return;
    }

    const command = lowerCaseText.split(' ')[0];
    if (['halo', 'p', 'salam', '!menu'].includes(command)) {
        if (!user.hasSeenRules) {
            const rulesText = `*Selamat Datang di AnonyChat Bot!* 👋\n\nSebelum mulai, harap baca dan patuhi peraturan berikut:\n\n1.  *Dilarang Keras* berkata kasar, menghina SARA, atau menyebarkan ujaran kebencian.\n2.  *Dilarang Spamming* atau mengirim pesan berlebihan (flood).\n3.  *Jaga Privasi!* Jangan membagikan informasi pribadi (nomor HP, medsos, dll).\n4.  Gunakan bot dengan bijak. Admin dapat mem-banned pengguna yang melanggar aturan.\n\nSelamat bersenang-senang!`;
            await message.reply(rulesText);
            user.hasSeenRules = true;
            saveDatabase();
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
        const menuText = `Hai *${user.nickname}*! 👋 Selamat datang di bot AnonyChat & Stiker.\n\n*Fitur yang tersedia:*\n\n- *!chat*\n    _Mencari partner ngobrol acak._\n\n- *!stop* / *!skip*\n    _Menghentikan sesi chat atau pencarian._\n\n- *!lapor*\n    _Melaporkan partner chat Anda saat ini._\n\n- *!stiker*\n    _Kirim gambar dengan caption ini untuk jadi stiker._\n\n- *!stikergif*\n    _Kirim video/GIF dengan caption ini untuk jadi stiker gerak (Max 7 detik)._`;
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
                await client.sendMessage(user_id, `Asiik, partner ditemukan! Selamat ngobrol ya!\n\nKalau sudah selesai, jangan lupa ketik *!stop* atau *!lapor*.`);
                await client.sendMessage(partner_id, `Asiik, partner ditemukan! Selamat ngobrol ya!\n\nKalau sudah selesai, jangan lupa ketik *!stop* atau *!lapor*.`);
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
                    await client.sendMessage(message.from, media, {
                        sendMediaAsSticker: true,
                        stickerAuthor: "AnonyChat Bot",
                        stickerName: `Stiker by ${user.nickname}`
                    });
                } catch (error) {
                    message.reply('Duh, maaf, sepertinya ada masalah saat membuat stiker.');
                }
            } else {
                message.reply('Kirim gambarnya dulu dengan caption *!stiker* untuk dibuatkan stiker ya.');
            }
            break;

        case '!stikergif':
            if (message.hasMedia && message.type === 'video') {
                message.reply('🎥 Oke, stiker geraknya lagi diproses! Mohon tunggu sebentar, ini butuh waktu beberapa saat...');
                const tempInputPath = `${TEMP_DIR}/input_${Date.now()}.mp4`;
                const tempOutputPath = `${TEMP_DIR}/output_${Date.now()}.webp`;
                try {
                    const media = await message.downloadMedia();
                    fs.writeFileSync(tempInputPath, Buffer.from(media.data, 'base64'));
                    const ffmpegCommand = `ffmpeg -i ${tempInputPath} -vcodec libwebp -vf "scale=512:512:force_original_aspect_ratio=decrease,fps=15,pad=512:512:-1:-1:color=white@0.0" -an -ss 00:00:00.0 -t 00:00:07.0 -loop 0 ${tempOutputPath}`;
                    exec(ffmpegCommand, async (error) => {
                        if (error) {
                            console.error('FFMPEG Error:', error);
                            message.reply('Duh, maaf, gagal membuat stiker gerak. Coba video lain yang lebih pendek ya.');
                        } else {
                            await client.sendMessage(message.from, MessageMedia.fromFilePath(tempOutputPath), {
                                sendMediaAsSticker: true,
                                stickerAuthor: "AnonyChat Bot",
                                stickerName: `Animasi by ${user.nickname}`
                            });
                        }
                        if (fs.existsSync(tempInputPath)) fs.unlinkSync(tempInputPath);
                        if (fs.existsSync(tempOutputPath)) fs.unlinkSync(tempOutputPath);
                    });
                } catch (err) {
                    console.error('Sticker GIF Error:', err);
                    message.reply('Waduh, ada masalah saat memproses videomu.');
                    if (fs.existsSync(tempInputPath)) fs.unlinkSync(tempInputPath);
                    if (fs.existsSync(tempOutputPath)) fs.unlinkSync(tempOutputPath);
                }
            } else {
                message.reply('Kirim video dengan caption *!stikergif* untuk dibuatkan stiker ya (durasi maks 7 detik).');
            }
            break;
    }
});


// =================================================================
//                       MENJALANKAN SERVER & BOT
// =================================================================
customLog('Bot sedang dijalankan...');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR);
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR); // Pastikan folder temp ada
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
