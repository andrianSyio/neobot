// =================================================================
//                      MODUL & INISIALISASI
// =================================================================
require('dotenv').config();
const qrcode = require('qrcode');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const fs = require('fs');
const express = require('express');
const { exec } = require('child_process');
const cors = require('cors');
const path = require('path'); // Modul path untuk menangani file path dengan aman

// Inisialisasi Klien, dan Web Server
const client = new Client({
    authStrategy: new LocalAuth({ dataPath: '.' }),
    puppeteer: { args: ['--no-sandbox', '--disable-setuid-sandbox'] }
});
const app = express();
const port = process.env.PORT || 3000;

// =================================================================
//                   PENGATURAN & VARIABEL GLOBAL
// =================================================================
const DB_FILE = './database.json';
const VIOLATIONS_FILE = './violations.json';
const SETTINGS_FILE = './settings.json';
const LOG_DIR = './chat_logs';
const TEMP_DIR = './temp';

let db = {};
let violations = [];
let waitingQueue = [];
let activeChats = {};

// --- Variabel untuk Dashboard Real-time ---
let botStatus = 'INITIALIZING';
let qrCodeDataUrl = '';
let serverLogs = [];
let settings = {};

// Middleware untuk membaca JSON dan form data dari dashboard
app.use(cors());
app.use(express.json());
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

function loadData(filePath, defaultValue) {
    try {
        if (fs.existsSync(filePath)) {
            const data = fs.readFileSync(filePath, 'utf-8');
            return data.length > 0 ? JSON.parse(data) : defaultValue;
        } else {
            fs.writeFileSync(filePath, JSON.stringify(defaultValue, null, 2));
            return defaultValue;
        }
    } catch (error) {
        customLog(`Gagal memuat ${filePath}: ${error.message}`);
        return defaultValue;
    }
}

function saveData(filePath, data) {
    try {
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    } catch (error) {
        customLog(`Gagal menyimpan ${filePath}: ${error.message}`);
    }
}

function loadAllData() {
    db = loadData(DB_FILE, {});
    violations = loadData(VIOLATIONS_FILE, []);
    settings = loadData(SETTINGS_FILE, {
        maintenanceMode: false,
        messages: {
            welcome: `*Selamat Datang di ANONYCHAT!* 👋\n\nSebelum mulai, yuk kita sepakati beberapa aturan mainnya:\n\n1.  *No SARA & No Toxic!* Jaga obrolan tetap asik dan saling menghargai.\n2.  *Dilarang Spamming* atau kirim pesan aneh-aneh ya.\n3.  *Privasi itu penting!* Jangan sebarin info pribadi kamu atau orang lain.\n4.  Admin berhak negur atau nge-banned kalau ada yang melanggar.\n\nUdah siap? Yuk cari teman ngobrol baru!`,
            menu: `Hai *{nickname}*! ✨ Mau ngapain kita hari ini?\n\n*Pilih Aksi Kamu:*\n\n- *!chat*\n  ✨ _Yuk, cari teman ngobrol random!_\n\n- *!stop* / *!skip*\n  👋 _Udahan atau ganti partner chat._\n\n- *!lapor*\n  🚨 _Laporkan pengguna yang nakal._\n\n- *!stiker*\n  🖼️ _Ubah gambar jadi stiker kece._\n\n- *!stikergif*\n  🎬 _Bikin stiker gerak dari video/GIF (Maks 7 dtk)._`,
        },
        badwords: ["anjing", "babi", "kontol", "memek", "bangsat", "asu", "bajingan"]
    });
}

function getUser(userId) {
    if (!db[userId]) {
        db[userId] = {
            nickname: userId.split('@')[0],
            joinDate: new Date().toISOString(),
            lastActive: new Date().toISOString(),
            chatCount: 0,
            warnings: 0,
            isBanned: false,
            hasSeenRules: false
        };
        saveData(DB_FILE, db);
    }
    db[userId].lastActive = new Date().toISOString(); // Selalu update last active
    return db[userId];
}

function generateRoomId() {
    return `wafa${Math.floor(100000 + Math.random() * 900000)}`;
}

function checkProfanity(message) {
    const words = message.toLowerCase().split(/\s+/);
    return settings.badwords.some(word => words.includes(word));
}

function logChatMessage(roomId, userId, message, mediaType = 'text') {
    const logPath = path.join(LOG_DIR, `${roomId}.json`);
    const user = getUser(userId);
    const isSender1 = activeChats[userId]?.user1 === userId;
    
    const timestamp = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
    const logEntry = {
        timestamp,
        senderId: userId,
        senderNickname: user.nickname,
        message: mediaType === 'text' ? message : `[Media: ${mediaType}]`,
        isSender1 // Menandai siapa pengirimnya untuk alignment di UI
    };
    try {
        let logs = fs.existsSync(logPath) ? JSON.parse(fs.readFileSync(logPath, 'utf-8')) : [];
        logs.push(logEntry);
        fs.writeFileSync(logPath, JSON.stringify(logs, null, 2));
    } catch (error) {
        customLog(`Gagal menulis log chat untuk room ${roomId}: ${error.message}`);
    }
}

// =================================================================
//                   PENGATURAN WEB SERVER & RUTE
// =================================================================
app.set('view engine', 'ejs');
app.get('/', (req, res) => res.redirect('/dashboard'));
app.get('/dashboard', (req, res) => res.render('dashboard'));

// --- RUTE API UTAMA ---

app.get('/api/status', (req, res) => {
    const metrics = {
        totalUsers: Object.keys(db).length,
        activeToday: Object.values(db).filter(u => new Date(u.lastActive).toDateString() === new Date().toDateString()).length,
        totalChats24h: violations.filter(v => new Date(v.timestamp.split(',')[0].split('/').reverse().join('-')) > new Date(Date.now() - 24 * 60 * 60 * 1000)).length,
        banned: Object.values(db).filter(u => u.isBanned).length
    };
    const analytics = {
        userGrowth: { labels: ['Day 1', 'Day 2'], data: [10, 15] }, // Data dummy
        peakHours: { labels: ['00:00', '03:00'], data: [5, 12] }, // Data dummy
        violationTypes: { labels: ['Kata Kasar', 'Laporan'], data: [violations.filter(v=>v.type === 'Kata Kasar').length, violations.filter(v=>v.type !== 'Kata Kasar').length] }
    };

    const usersArray = Object.keys(db).map(key => ({ id: key, ...db[key] }));
    const waitingUsers = waitingQueue.map(id => getUser(id));
    const activePairs = [];
    Object.values(activeChats).forEach(chat => {
        if (!activePairs.some(p => p.roomId === chat.roomId)) {
            activePairs.push({ roomId: chat.roomId, user1: getUser(chat.user1)?.nickname, user2: getUser(chat.user2)?.nickname });
        }
    });

    res.json({
        botStatus,
        qrCode: qrCodeDataUrl,
        serverLogs,
        metrics,
        anonChat: { waiting: waitingUsers, active: activePairs },
        users: usersArray,
        violations,
        analytics,
        settings
    });
});

// PERBAIKAN: Endpoint diubah menjadi /api/chat-log/ dan mengirim response JSON
app.get('/api/chat-log/:roomId', (req, res) => {
    const roomId = req.params.roomId.replace(/[^a-zA-Z0-9]/g, '');
    const logPath = path.join(__dirname, LOG_DIR, `${roomId}.json`);
    if (fs.existsSync(logPath)) {
        const logData = JSON.parse(fs.readFileSync(logPath, 'utf-8'));
        res.json(logData);
    } else {
        res.status(404).json({ error: 'Log tidak ditemukan' });
    }
});

app.post('/toggle-ban', (req, res) => {
    const { userId } = req.body;
    if (db[userId]) {
        db[userId].isBanned = !db[userId].isBanned;
        saveData(DB_FILE, db);
    }
    res.redirect('/dashboard');
});

app.post('/api/broadcast', async (req, res) => {
    const { message } = req.body;
    if (!message) return res.status(400).json({ success: false, message: "Pesan tidak boleh kosong." });
    
    res.json({ success: true, message: "Broadcast dimulai!" });

    (async () => {
        const allUserIds = Object.keys(db).filter(id => db[id] && !db[id].isBanned);
        customLog(`Memulai broadcast ke ${allUserIds.length} pengguna...`);
        for (let i = 0; i < allUserIds.length; i++) {
            const userId = allUserIds[i];
            try {
                await client.sendMessage(userId, message);
            } catch (error) {
                customLog(`[BROADCAST] Gagal mengirim ke ${userId}: ${error.message}`);
            }
            const randomDelay = Math.floor(Math.random() * 5000) + 2000;
            await new Promise(resolve => setTimeout(resolve, randomDelay));
        }
        customLog('Broadcast selesai.');
    })();
});

// --- API BARU UNTUK FITUR PENGATURAN & USER DETAIL ---

app.post('/api/settings/maintenance', (req, res) => {
    const { enabled } = req.body;
    settings.maintenanceMode = enabled;
    saveData(SETTINGS_FILE, settings);
    res.json({ success: true, message: `Mode perbaikan ${enabled ? 'diaktifkan' : 'dinonaktifkan'}.` });
});

// PERBAIKAN: Mengubah 'rules' menjadi 'menu' agar sesuai dengan data yang dipakai
app.post('/api/settings/messages', (req, res) => {
    const { welcome, menu } = req.body;
    if(welcome) settings.messages.welcome = welcome;
    if(menu) settings.messages.menu = menu; // Menggunakan 'menu'
    saveData(SETTINGS_FILE, settings);
    res.json({ success: true, message: "Pesan berhasil disimpan." });
});

// PERBAIKAN: Endpoint POST disederhanakan untuk menambah kata
app.post('/api/settings/badwords', (req, res) => {
    const { word } = req.body;
    if (word && !settings.badwords.includes(word.toLowerCase())) {
        settings.badwords.push(word.toLowerCase());
        saveData(SETTINGS_FILE, settings);
    }
    res.json({ success: true, badwords: settings.badwords });
});

// PERBAIKAN: Endpoint DELETE dibuat khusus untuk menghapus kata
app.delete('/api/settings/badwords', (req, res) => {
    const { word } = req.body;
    if (word) {
        settings.badwords = settings.badwords.filter(bw => bw !== word.toLowerCase());
        saveData(SETTINGS_FILE, settings);
    }
    res.json({ success: true, badwords: settings.badwords });
});

// PERBAIKAN: Endpoint diubah menjadi /api/user-detail/
app.get('/api/user-detail/:userId', (req, res) => {
    const userId = req.params.userId;
    const user = db[userId];
    if (!user) return res.status(404).json({ error: "User tidak ditemukan" });
    
    const userWithId = { id: userId, ...user };
    
    const userViolations = violations.filter(v => (v.reported && v.reported.id === userId) || (v.reporter && v.reporter.id === userId));
    res.json({ user: userWithId, violations: userViolations });
});

// PERBAIKAN: Endpoint diubah menjadi /api/warn-user
app.post('/api/warn-user', (req, res) => {
    const { userId } = req.body;
    if (db[userId]) {
        db[userId].warnings = (db[userId].warnings || 0) + 1;
        saveData(DB_FILE, db);
        client.sendMessage(userId, "🚨 Anda menerima peringatan dari admin karena perilaku yang tidak pantas. Pelanggaran selanjutnya dapat menyebabkan pemblokiran.");
        res.json({ success: true, message: "Peringatan terkirim." });
    } else {
        res.status(404).json({ success: false, message: "User tidak ditemukan." });
    }
});

// =================================================================
//                     LOGIKA UTAMA BOT WHATSAPP
// =================================================================
client.on('message', async (message) => {
    if (message.from === 'status@broadcast') return; // Abaikan update status
    // PERBAIKAN: Admin bisa pakai bot walau mode perbaikan aktif
    if (settings.maintenanceMode && message.from !== process.env.ADMIN_NUMBER) {
        return message.reply("🙏 Maaf, bot sedang dalam mode perbaikan. Coba lagi beberapa saat ya!");
    }

    const text = message.body.trim();
    const lowerCaseText = text.toLowerCase();
    const user_id = message.from;
    const user = getUser(user_id);

    if (user.isBanned) {
        const bannedMessage = `Waduh, ${user.nickname}.. Akunmu sepertinya harus istirahat dulu karena ter-banned. 😬\n\nKalau kamu merasa ini sebuah kesalahan, coba deh ngobrol baik-baik sama admin di nomor ${process.env.ADMIN_NUMBER || 'owner'} ya.`;
        return message.reply(bannedMessage);
    }

    if (activeChats[user_id]) {
        const { roomId, user1, user2 } = activeChats[user_id];
        const partnerId = (user_id === user1) ? user2 : user1;
        
        if (lowerCaseText === '!stop' || lowerCaseText === '!skip') {
            delete activeChats[user_id];
            delete activeChats[partnerId];
            await message.reply('Kamu memilih untuk udahan. Sampai jumpa di obrolan lainnya! Ketik *!chat* lagi yuk! 👋');
            await client.sendMessage(partnerId, 'Partner kamu pamit duluan. Jangan sedih, yuk cari teman baru dengan ketik *!chat*! ✨');
            return;
        }

        if (lowerCaseText === '!lapor') {
            const reporter = getUser(user_id);
            const reported = getUser(partnerId);
            const timestamp = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
            let chatHistory = [];
            const logPath = path.join(LOG_DIR, `${roomId}.json`);
            try {
                if (fs.existsSync(logPath)) {
                    chatHistory = JSON.parse(fs.readFileSync(logPath, 'utf-8')).slice(-10);
                }
            } catch (error) { customLog(`Gagal membaca log untuk laporan: ${error.message}`); }

            violations.push({
                timestamp, type: 'Laporan Pengguna', roomId,
                reporter: { id: user_id, nickname: reporter.nickname },
                reported: { id: partnerId, nickname: reported.nickname },
                chatHistory
            });
            saveData(VIOLATIONS_FILE, violations);

            delete activeChats[user_id];
            delete activeChats[partnerId];
            await message.reply('🚨 Laporanmu sudah kami terima dan akan segera dicek sama admin. Terima kasih sudah membantu menjaga komunitas kita tetap aman! Sesi chat ini dihentikan.');
            await client.sendMessage(partnerId, 'Sesi chat dihentikan oleh sistem karena ada laporan. Tim admin akan meninjaunya.');
            return;
        }

        if (message.hasMedia && (message.type === 'image' || message.type === 'sticker' || message.type === 'video')) {
            await message.reply('⏳ _Sabar ya, medianya lagi OTW ke partner kamu..._');
            try {
                const media = await message.downloadMedia();
                logChatMessage(roomId, user_id, '', message.type);
                await client.sendMessage(partnerId, media, {
                    caption: message.body,
                    sendMediaAsSticker: message.type === 'sticker'
                });
            } catch (error) {
                message.reply('Yah, maaf banget, medianya gagal terkirim. 😥 Coba lagi deh.');
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
            saveData(VIOLATIONS_FILE, violations);
            return message.reply('Pssst... jaga ucapannya ya. Yuk, kita ngobrol yang asik-asik aja! 😉');
        }

        if (text) {
            logChatMessage(roomId, user_id, text);
            await client.sendMessage(partnerId, text);
        }
        return;
    }

    const command = lowerCaseText.split(' ')[0];
    if (['halo', 'p', 'assalamualaikum', '!menu', 'hai'].includes(command)) {
        if (!user.hasSeenRules) {
            await message.reply(settings.messages.welcome);
            user.hasSeenRules = true;
            saveData(DB_FILE, db);
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
        const menuText = settings.messages.menu.replace('{nickname}', user.nickname);
        return message.reply(menuText);
    }

    switch (command) {
        case '!chat':
            if (waitingQueue.includes(user_id)) {
                return message.reply('Sabar yaa, kamu udah masuk antrian kok. Aku lagi cariin teman ngobrol yang paling pas buatmu! 🕵️‍♀️');
            }
            if (waitingQueue.length > 0) {
                const partner_id = waitingQueue.shift();
                if (partner_id === user_id) { // Mencegah chat dengan diri sendiri jika ada race condition
                    waitingQueue.push(user_id);
                    return message.reply('Waduh, hampir aja kamu ngobrol sama diri sendiri! Aku cariin yang lain ya. 😄');
                }
                const roomId = generateRoomId();
                activeChats[user_id] = { roomId, user1: user_id, user2: partner_id };
                activeChats[partner_id] = { roomId, user1: user_id, user2: partner_id };
                
                db[user_id].chatCount = (db[user_id].chatCount || 0) + 1;
                db[partner_id].chatCount = (db[partner_id].chatCount || 0) + 1;
                saveData(DB_FILE, db);

                fs.writeFileSync(path.join(LOG_DIR, `${roomId}.json`), '[]');
                await client.sendMessage(user_id, `Asiiik, dapet temen baru! 🎉 Selamat ngobrol ya! Kalau mau udahan, ketik *!stop*.`);
                await client.sendMessage(partner_id, `Yeay, ada yang mau ngobrol sama kamu nih! 🎉 Selamat bersenang-senang! Kalau mau udahan, ketik *!stop*.`);
            } else {
                waitingQueue.push(user_id);
                await message.reply('Oke, kamu masuk antrian pertama! Aku lagi putar-putar cariin partner buatmu. Ditunggu ya! 🚀');
            }
            break;

        case '!stop':
            if (waitingQueue.includes(user_id)) {
                waitingQueue = waitingQueue.filter(id => id !== user_id);
                await message.reply('Oke, pencarian dibatalkan. Kalau kangen, panggil aku lagi dengan *!chat* ya!');
            } else {
                await message.reply('Hmm, kamu kan lagi nggak di dalam obrolan atau antrian. Mau coba cari teman dengan *!chat*? 😉');
            }
            break;

        case '!stiker':
            if (message.hasMedia) {
                message.reply('Siap! Stikernya lagi dibikin, tunggu bentar ya...');
                try {
                    const media = await message.downloadMedia();
                    await client.sendMessage(message.from, media, {
                        sendMediaAsSticker: true,
                        stickerAuthor: "AnonyChat Bot",
                        stickerName: `Stiker by ${user.nickname}`
                    });
                } catch (error) {
                    message.reply('Aduh, maaf, ada sedikit gangguan teknis pas bikin stiker. Coba lagi ya?');
                }
            } else {
                message.reply('Eits, kirim gambarnya dulu dong baru kasih caption *!stiker* biar jadi stiker. ✨');
            }
            break;

        case '!stikergif':
            if (message.hasMedia && (message.type === 'video' || message.mimetype.includes('gif'))) {
                message.reply('🎥 Wow, stiker gerak! Oke, aku proses dulu ya, ini butuh waktu sedikit lebih lama...');
                const tempInputPath = path.join(TEMP_DIR, `input_${Date.now()}.mp4`);
                const tempOutputPath = path.join(TEMP_DIR, `output_${Date.now()}.webp`);
                try {
                    const media = await message.downloadMedia();
                    fs.writeFileSync(tempInputPath, Buffer.from(media.data, 'base64'));
                    const ffmpegCommand = `ffmpeg -i ${tempInputPath} -vcodec libwebp -vf "scale=512:512:force_original_aspect_ratio=decrease,fps=15,pad=512:512:-1:-1:color=white@0.0" -an -ss 00:00:00.0 -t 00:00:07.0 -loop 0 ${tempOutputPath}`;
                    
                    exec(ffmpegCommand, async (error) => {
                        if (error) {
                            console.error('FFMPEG Error:', error);
                            message.reply('Yah, gagal nih bikin stiker geraknya. Coba pake video lain yang lebih pendek (maks 7 detik) ya.');
                        } else {
                            await client.sendMessage(message.from, MessageMedia.fromFilePath(tempOutputPath), {
                                sendMediaAsSticker: true,
                                stickerAuthor: "AnonyChat Bot",
                                stickerName: `Animasi by ${user.nickname}`
                            });
                        }
                        // Selalu hapus file temporary setelah selesai
                        if (fs.existsSync(tempInputPath)) fs.unlinkSync(tempInputPath);
                        if (fs.existsSync(tempOutputPath)) fs.unlinkSync(tempOutputPath);
                    });
                } catch (err) {
                    console.error('Sticker GIF Error:', err);
                    message.reply('Waduh, ada masalah nih pas aku proses videonya. Coba lagi ya.');
                     // Pastikan file temporary dihapus bahkan jika ada error
                    if (fs.existsSync(tempInputPath)) fs.unlinkSync(tempInputPath);
                    if (fs.existsSync(tempOutputPath)) fs.unlinkSync(tempOutputPath);
                }
            } else {
                message.reply('Kirim video/GIF (maks 7 detik) dengan caption *!stikergif* ya buat bikin stiker gerak.');
            }
            break;
    }
});


// =================================================================
//                      MENJALANKAN SERVER & BOT
// =================================================================
customLog('Bot sedang dijalankan...');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR);
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR);
loadAllData();

app.listen(port, () => {
    customLog(`🚀 Dashboard web berjalan di port: ${port}`);
});

client.on('qr', async (qr) => {
    botStatus = 'WAITING_FOR_QR_SCAN';
    qrCodeDataUrl = await qrcode.toDataURL(qr);
    customLog('[CLIENT] Butuh scan QR Code nih. Cek dashboard ya!');
});

client.on('ready', () => {
    botStatus = 'CONNECTED';
    qrCodeDataUrl = '';
    customLog('🚀 Bot WhatsApp sudah siap dan terhubung! Mari kita mulai!');
});

client.on('disconnected', (reason) => {
    botStatus = 'DISCONNECTED';
    customLog(`[CLIENT DISCONNECTED] Koneksi terputus: ${reason}. Mencoba menyambungkan kembali...`);
});

client.initialize();
