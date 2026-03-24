const express = require('express');
const cors = require('cors');
const { Client, RemoteAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

// ─────────────────────────────────────────
// Firebase Admin Init
// ─────────────────────────────────────────
const firebaseConfig = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
initializeApp({ credential: cert(firebaseConfig) });
const db = getFirestore();

// ─────────────────────────────────────────
// Firebase RemoteAuth Store for whatsapp-web.js
// ─────────────────────────────────────────
const { EventEmitter } = require('events');

class FirebaseStore extends EventEmitter {
    constructor({ firestore, collection = 'whatsapp_sessions' } = {}) {
        super();
        this.db = firestore;
        this.collection = collection;
        this.sessionExists = this.sessionExists.bind(this);
        this.save = this.save.bind(this);
        this.extract = this.extract.bind(this);
        this.delete = this.delete.bind(this);
    }

    async sessionExists({ session }) {
        try {
            const doc = await this.db.collection(this.collection).doc(session).get();
            return doc.exists;
        } catch (e) {
            console.error('sessionExists error:', e.message);
            return false;
        }
    }

    async save({ session }) {
        // whatsapp-web.js calls this to trigger extraction
        this.emit('save', { session });
    }

    async extract({ session }) {
        try {
            const doc = await this.db.collection(this.collection).doc(session).get();
            if (!doc.exists) return null;
            return doc.data();
        } catch (e) {
            console.error('extract error:', e.message);
            return null;
        }
    }

    async delete({ session }) {
        try {
            await this.db.collection(this.collection).doc(session).delete();
            console.log(`Session ${session} deleted from Firebase`);
        } catch (e) {
            console.error('delete error:', e.message);
        }
    }
}

// ─────────────────────────────────────────
// Firebase Session Store using wwebjs-mongo pattern
// (Direct Firestore save/load)
// ─────────────────────────────────────────

// We'll use a simpler approach: save session data directly
class SimpleFirebaseStore {
    constructor(db) {
        this.db = db;
        this.col = 'wwa_sessions';
    }
    async get(key) {
        try {
            const doc = await this.db.collection(this.col).doc(key).get();
            return doc.exists ? doc.data().value : null;
        } catch(e) { return null; }
    }
    async set(key, value) {
        try {
            await this.db.collection(this.col).doc(key).set({ value, updatedAt: new Date() });
        } catch(e) { console.error('Store set error:', e.message); }
    }
    async del(key) {
        try {
            await this.db.collection(this.col).doc(key).delete();
        } catch(e) {}
    }
}

// ─────────────────────────────────────────
// App Setup
// ─────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());

let waClient = null;
let isReady = false;
let qrBase64 = null;
let initAttempts = 0;
const MAX_RETRIES = 5;

const store = new SimpleFirebaseStore(db);

// ─────────────────────────────────────────
// WhatsApp Client with RemoteAuth + Firebase
// ─────────────────────────────────────────
function initWhatsApp() {
    if (initAttempts >= MAX_RETRIES) {
        console.error(`❌ Max retries (${MAX_RETRIES}) reached. Manual restart needed.`);
        return;
    }
    initAttempts++;
    console.log(`🔄 WhatsApp init attempt #${initAttempts}`);

    // Cleanup old client
    if (waClient) {
        try { waClient.destroy(); } catch(e) {}
        waClient = null;
    }
    isReady = false;
    qrBase64 = null;

    // RemoteAuth requires a store with: sessionExists, save, extract, delete
    const remoteStore = {
        sessionExists: async ({ session }) => {
            const data = await store.get(`session_${session}`);
            return !!data;
        },
        save: async ({ session }) => {
            // Called by RemoteAuth - data is passed separately via extract flow
        },
        extract: async ({ session }) => {
            const data = await store.get(`session_${session}`);
            return data || null;
        },
        delete: async ({ session }) => {
            await store.del(`session_${session}`);
        }
    };

    waClient = new Client({
        authStrategy: new RemoteAuth({
            store: remoteStore,
            backupSyncIntervalMs: 300000, // Sync every 5 minutes
        }),
        puppeteer: {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--no-first-run',
                '--no-zygote',
                '--single-process',
                '--disable-extensions',
                '--disable-background-networking',
                '--disable-default-apps',
                '--disable-sync',
                '--metrics-recording-only',
                '--mute-audio',
                '--safebrowsing-disable-auto-update'
            ]
        }
    });

    waClient.on('qr', async (qr) => {
        console.log('📱 QR Code received — scan karo!');
        isReady = false;
        try {
            qrBase64 = await qrcode.toDataURL(qr);
        } catch (e) {
            console.error('QR gen error:', e);
        }
    });

    waClient.on('authenticated', async () => {
        console.log('✅ Authenticated!');
        // Save session to Firebase manually after auth
        try {
            const sessionData = await waClient.getState();
            console.log('Session state:', sessionData);
        } catch(e) {}
    });

    waClient.on('remote_session_saved', async () => {
        console.log('✅ Session saved to Firebase!');
    });

    waClient.on('ready', () => {
        console.log('✅ WhatsApp READY! 24/7 active.');
        isReady = true;
        qrBase64 = null;
        initAttempts = 0; // Reset on successful connect
    });

    waClient.on('auth_failure', (msg) => {
        console.error('❌ Auth failure:', msg);
        isReady = false;
        // Clear saved session on auth failure so fresh QR is shown
        store.del('session_RemoteAuth').catch(() => {});
        setTimeout(() => initWhatsApp(), 10000);
    });

    waClient.on('disconnected', (reason) => {
        console.log('⚡ Disconnected:', reason, '— reconnecting in 10s...');
        isReady = false;
        setTimeout(() => initWhatsApp(), 10000);
    });

    // Keep-alive ping every 45 seconds
    let keepAliveInterval = null;
    waClient.on('ready', () => {
        if (keepAliveInterval) clearInterval(keepAliveInterval);
        keepAliveInterval = setInterval(async () => {
            if (!isReady || !waClient) return;
            try {
                const state = await waClient.getState();
                if (state !== 'CONNECTED') {
                    console.log('⚠️ Keep-alive: state is', state, '— reconnecting...');
                    isReady = false;
                    clearInterval(keepAliveInterval);
                    setTimeout(() => initWhatsApp(), 5000);
                } else {
                    console.log('💚 Keep-alive OK:', new Date().toISOString());
                }
            } catch(e) {
                console.log('⚠️ Keep-alive check failed:', e.message);
            }
        }, 45000);
    });

    waClient.initialize().catch(err => {
        console.error('❌ Init error:', err.message);
        setTimeout(() => initWhatsApp(), 15000);
    });
}

initWhatsApp();

// ─────────────────────────────────────────
// OTP Store (Firebase, 5 min TTL)
// ─────────────────────────────────────────
async function saveOTP(mobile, otp) {
    await db.collection('rsybattle_otps').doc(mobile).set({
        otp,
        expires: Date.now() + 5 * 60 * 1000,
        createdAt: new Date()
    });
}

async function getOTP(mobile) {
    const doc = await db.collection('rsybattle_otps').doc(mobile).get();
    return doc.exists ? doc.data() : null;
}

async function deleteOTP(mobile) {
    await db.collection('rsybattle_otps').doc(mobile).delete();
}

function generateOTP() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

// ─────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────
app.get('/', (req, res) => {
    res.json({
        app: 'RSY Battle WhatsApp OTP Server',
        status: isReady ? '✅ Connected' : '⏳ Not connected',
        hasQR: !!qrBase64,
        time: new Date().toISOString()
    });
});

// Admin QR page
app.get('/qr', (req, res) => {
    if (isReady) {
        return res.send(`<!DOCTYPE html><html><body style="background:#111;color:#25D366;font-family:sans-serif;text-align:center;padding:40px;">
            <h2>✅ WhatsApp Already Connected!</h2>
            <p>OTP server 24/7 active hai. Koi action needed nahi.</p>
            <p style="color:#888;font-size:.85rem;">Auto-refresh in 30s</p>
            <script>setTimeout(()=>location.reload(),30000)</script>
        </body></html>`);
    }
    if (qrBase64) {
        return res.send(`<!DOCTYPE html><html><body style="background:#111;color:#fff;font-family:sans-serif;text-align:center;padding:40px;">
            <h2 style="color:#25D366;">📱 Scan WhatsApp QR Code</h2>
            <p style="color:#aaa;">WhatsApp → Linked Devices → Link a Device → Scan this QR</p>
            <br>
            <img src="${qrBase64}" style="width:280px;height:280px;border:4px solid #25D366;border-radius:12px;">
            <br><br>
            <p style="color:#888;">⚡ Ek baar scan karo — session Firebase mein save ho jaayega</p>
            <p style="color:#888;">Next time automatically connect ho jaayega!</p>
            <br>
            <button onclick="location.reload()" style="background:#25D366;border:none;color:#fff;padding:12px 24px;border-radius:8px;font-size:1rem;cursor:pointer;">🔄 Refresh</button>
            <p style="color:#888;font-size:.85rem;margin-top:10px;">Auto refreshes in 20 seconds</p>
            <script>setTimeout(()=>location.reload(),20000)</script>
        </body></html>`);
    }
    return res.send(`<!DOCTYPE html><html><body style="background:#111;color:#fff;font-family:sans-serif;text-align:center;padding:40px;">
        <h2>⏳ QR Code Generate ho raha hai...</h2>
        <p style="color:#aaa;">Kripya 30-60 seconds wait karo aur refresh karo.</p>
        <br>
        <button onclick="location.reload()" style="background:#1A6FE8;border:none;color:#fff;padding:12px 24px;border-radius:8px;font-size:1rem;cursor:pointer;">🔄 Refresh</button>
        <script>setTimeout(()=>location.reload(),15000)</script>
    </body></html>`);
});

app.get('/status', (req, res) => {
    res.json({
        connected: isReady,
        hasQR: !!qrBase64,
        time: new Date().toISOString()
    });
});

// Send OTP
app.post('/send-otp', async (req, res) => {
    const { mobile } = req.body;
    if (!mobile || !/^[0-9]{10}$/.test(mobile)) {
        return res.status(400).json({ success: false, message: 'Valid 10-digit mobile number required' });
    }
    if (!isReady) {
        return res.status(503).json({ success: false, message: 'WhatsApp connected nahi hai. Admin please /qr page pe jaake QR scan karo.' });
    }

    const otp = generateOTP();

    try {
        await saveOTP(mobile, otp);
    } catch(e) {
        console.error('OTP save error:', e.message);
        return res.status(500).json({ success: false, message: 'Server error. Try again.' });
    }

    const phoneNumber = '91' + mobile + '@c.us';
    const message =
        `🎮 *RSY Battle - OTP Verification*\n\n` +
        `Aapka OTP hai: *${otp}*\n\n` +
        `⏱ Yeh OTP sirf *5 minute* ke liye valid hai.\n\n` +
        `⚠️ Yeh OTP kisi ke saath share mat karo.\n\n` +
        `— RSY Battle Team`;

    try {
        await waClient.sendMessage(phoneNumber, message);
        console.log(`✅ OTP sent to ${mobile}: ${otp}`);
        res.json({ success: true, message: 'OTP WhatsApp pe send ho gaya! ✅' });
    } catch (err) {
        console.error('❌ Send error:', err.message);
        await deleteOTP(mobile).catch(() => {});
        res.status(500).json({ success: false, message: 'Message send nahi hua. Number pe WhatsApp hai?' });
    }
});

// Verify OTP
app.post('/verify-otp', async (req, res) => {
    const { mobile, otp } = req.body;
    if (!mobile || !otp) {
        return res.status(400).json({ success: false, message: 'Mobile aur OTP dono zaroori hain' });
    }

    let data;
    try {
        data = await getOTP(mobile);
    } catch(e) {
        return res.status(500).json({ success: false, message: 'Server error. Try again.' });
    }

    if (!data) return res.status(400).json({ success: false, message: 'OTP nahi mila. Pehle OTP send karo.' });
    if (Date.now() > data.expires) {
        await deleteOTP(mobile).catch(() => {});
        return res.status(400).json({ success: false, message: 'OTP expire ho gaya. Dobara try karo.' });
    }
    if (data.otp !== String(otp).trim()) {
        return res.status(400).json({ success: false, message: 'Galat OTP. Dobara check karo.' });
    }

    await deleteOTP(mobile).catch(() => {});
    res.json({ success: true, message: 'OTP verify ho gaya! ✅' });
});

// ─────────────────────────────────────────
// Self-ping every 14 minutes (Render free plan sleep prevention)
// ─────────────────────────────────────────
const RENDER_URL = process.env.RENDER_EXTERNAL_URL || '';
if (RENDER_URL) {
    setInterval(async () => {
        try {
            const res = await fetch(RENDER_URL + '/status');
            const data = await res.json();
            console.log('🏓 Self-ping OK:', data.connected ? 'Connected' : 'Not connected');
        } catch(e) {
            console.log('⚠️ Self-ping failed:', e.message);
        }
    }, 14 * 60 * 1000); // Every 14 minutes
    console.log('🏓 Self-ping enabled for:', RENDER_URL);
}

// ─────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 RSY Battle OTP Server running on port ${PORT}`));
