const express = require('express');
const cors = require('cors');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');

const app = express();
app.use(cors());
app.use(express.json());

// ─────────────────────────────────────────
// WhatsApp Client
// ─────────────────────────────────────────
let waClient = null;
let isReady = false;
let qrBase64 = null;

function initWhatsApp() {
    waClient = new Client({
        authStrategy: new LocalAuth({ dataPath: '/tmp/wwebjs_auth' }),
        puppeteer: {
            headless: true,
            args: [
                '--no-sandbox', '--disable-setuid-sandbox',
                '--disable-dev-shm-usage', '--disable-gpu',
                '--no-first-run', '--no-zygote',
                '--single-process', '--disable-extensions'
            ]
        }
    });

    waClient.on('qr', async (qr) => {
        console.log('QR Code received!');
        isReady = false;
        try { qrBase64 = await qrcode.toDataURL(qr); }
        catch (e) { console.error('QR gen error:', e); }
    });

    waClient.on('ready', () => {
        console.log('✅ WhatsApp READY!');
        isReady = true;
        qrBase64 = null;
    });

    waClient.on('authenticated', () => { console.log('✅ Authenticated!'); });

    waClient.on('auth_failure', () => { isReady = false; });

    waClient.on('disconnected', () => {
        console.log('Disconnected - reconnecting in 5s...');
        isReady = false;
        setTimeout(initWhatsApp, 5000);
    });

    waClient.initialize().catch(err => console.error('Init error:', err));
}

initWhatsApp();

// ─────────────────────────────────────────
// OTP Store (in-memory, 5 min)
// ─────────────────────────────────────────
const otpStore = new Map();

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
        hasQR: !!qrBase64
    });
});

// Admin QR page (open in browser to scan)
app.get('/qr', (req, res) => {
    if (isReady) {
        return res.send(`<html><body style="background:#111;color:#25D366;font-family:sans-serif;text-align:center;padding:40px;">
            <h2>✅ WhatsApp Already Connected!</h2>
            <p>OTP server is ready to send messages.</p>
        </body></html>`);
    }
    if (qrBase64) {
        return res.send(`<html><body style="background:#111;color:#fff;font-family:sans-serif;text-align:center;padding:40px;">
            <h2 style="color:#25D366;">📱 Scan WhatsApp QR Code</h2>
            <p>WhatsApp → Linked Devices → Link a Device → Scan this QR</p>
            <img src="${qrBase64}" style="width:280px;height:280px;border:4px solid #25D366;border-radius:12px;">
            <br><br>
            <button onclick="location.reload()" style="background:#25D366;border:none;color:#fff;padding:12px 24px;border-radius:8px;font-size:1rem;cursor:pointer;">🔄 Refresh</button>
            <p style="color:#888;font-size:.85rem;">Auto refreshes in 30 seconds</p>
            <script>setTimeout(()=>location.reload(),30000)</script>
        </body></html>`);
    }
    return res.send(`<html><body style="background:#111;color:#fff;font-family:sans-serif;text-align:center;padding:40px;">
        <h2>⏳ Generating QR Code...</h2>
        <p>Please wait 30-60 seconds and refresh.</p>
        <button onclick="location.reload()" style="background:#1A6FE8;border:none;color:#fff;padding:12px 24px;border-radius:8px;font-size:1rem;cursor:pointer;">🔄 Refresh</button>
        <script>setTimeout(()=>location.reload(),15000)</script>
    </body></html>`);
});

app.get('/status', (req, res) => {
    res.json({ connected: isReady });
});

// Send OTP
app.post('/send-otp', async (req, res) => {
    const { mobile } = req.body;
    if (!mobile || !/^[0-9]{10}$/.test(mobile)) {
        return res.status(400).json({ success: false, message: 'Valid 10-digit mobile number required' });
    }
    if (!isReady) {
        return res.status(503).json({ success: false, message: 'WhatsApp not connected. Admin please scan QR at /qr' });
    }

    const otp = generateOTP();
    otpStore.set(mobile, { otp, expires: Date.now() + 5 * 60 * 1000 });

    const phoneNumber = '91' + mobile + '@c.us';
    const message = `🎮 *RSY Battle - OTP Verification*\n\n` +
        `Aapka OTP hai: *${otp}*\n\n` +
        `⏱ Yeh OTP sirf *5 minute* ke liye valid hai.\n\n` +
        `⚠️ Yeh OTP kisi ke saath share mat karo.\n\n` +
        `— RSY Battle Team`;

    try {
        await waClient.sendMessage(phoneNumber, message);
        console.log(`OTP sent to ${mobile}: ${otp}`);
        res.json({ success: true, message: 'OTP WhatsApp pe send ho gaya!' });
    } catch (err) {
        console.error('Send error:', err.message);
        res.status(500).json({ success: false, message: 'Message send failed. Number pe WhatsApp hai?' });
    }
});

// Verify OTP
app.post('/verify-otp', (req, res) => {
    const { mobile, otp } = req.body;
    if (!mobile || !otp) {
        return res.status(400).json({ success: false, message: 'Mobile aur OTP dono zaroori hain' });
    }
    const data = otpStore.get(mobile);
    if (!data) return res.status(400).json({ success: false, message: 'OTP nahi mila. Dobara Verify karo.' });
    if (Date.now() > data.expires) {
        otpStore.delete(mobile);
        return res.status(400).json({ success: false, message: 'OTP expire ho gaya. Dobara Verify karo.' });
    }
    if (data.otp !== String(otp)) {
        return res.status(400).json({ success: false, message: 'Galat OTP. Dobara try karo.' });
    }
    otpStore.delete(mobile);
    res.json({ success: true, message: 'OTP verify ho gaya!' });
});

// ─────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 RSY Battle OTP Server on port ${PORT}`));
