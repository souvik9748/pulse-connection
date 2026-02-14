require('dotenv').config();
const express = require('express');
const webpush = require('web-push');
const bodyParser = require('body-parser');
const path = require('path');
const cookieParser = require('cookie-parser');
const mongoose = require('mongoose');
const cors = require('cors');
const nodemailer = require('nodemailer');
const ExcelJS = require('exceljs');

// EMAIL CONFIGURATION
const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 587,
    secure: false, // false for 587 (uses STARTTLS)
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    },
    // ⚠️ CRITICAL NETWORK SETTINGS ⚠️
    family: 4,              // Force IPv4 (Fixes ENETUNREACH)
    
    // ⚠️ TLS COMPATIBILITY (Fixes Handshake Hangs)
    tls: {
        ciphers: 'SSLv3'    // Helps compatibility with strict firewalls
    },

    // ⚠️ DEBUGGING (This prints the exact conversation to logs)
    logger: true,
    debug: true,

    // ⚠️ EXTENDED TIMEOUTS
    connectionTimeout: 30000, // 30 seconds
    greetingTimeout: 30000,
    socketTimeout: 30000
});

const app = express();
const port = process.env.PORT || 3000;

// --- 1. MONGODB CONNECTION ---
const mongoURI = process.env.MONGO_URI;

if (!mongoURI) {
    console.error("❌ FATAL ERROR: No MONGO_URI found.");
    process.exit(1);
}

mongoose.connect(mongoURI)
    .then(() => console.log("✅ MongoDB Connected"))
    .catch(err => console.log("❌ DB Error:", err));

// --- 2. DATABASE SCHEMAS ---
const UserSchema = new mongoose.Schema({
    fullName: String,
    username: { type: String, lowercase: true, unique: true },
    password: String,
    gender: String,
    partnerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
});

const HistorySchema = new mongoose.Schema({
    sender: String,
    receiver: String,
    message: String,
    location: Object,
    timestamp: { type: Date, default: Date.now }
});

// [CHANGED] Hybrid Schema: Supports both Old (Single) and New (Array)
const SubSchema = new mongoose.Schema({
    username: String,
    subscriptions: [Object], // New Way (List)
    subscription: Object     // Old Way (Legacy field for migration)
});

const User = mongoose.model('User', UserSchema);
const History = mongoose.model('History', HistorySchema);
const Subscription = mongoose.model('Subscription', SubSchema);

// --- 3. NOTIFICATIONS CONFIG ---
const publicVapidKey = process.env.PUBLIC_VAPID_KEY;
const privateVapidKey = process.env.PRIVATE_VAPID_KEY;

if (!publicVapidKey || !privateVapidKey) {
    console.error("❌ ERROR: VAPID keys missing.");
    process.exit(1);
}

webpush.setVapidDetails('mailto:test@test.com', publicVapidKey, privateVapidKey);

// --- 4. MIDDLEWARE ---
app.use(cors());
app.use(bodyParser.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public'), { index: false, extensions: ['js', 'css', 'png', 'jpg', 'mp4'] }));

// --- 5. AUTH ROUTES (Register, Login, Pair) ---
// ... (Keep your existing Auth Routes exactly as they are) ...
app.post('/register', async (req, res) => {
    const { fullName, username, password, gender } = req.body;
    try {
        const lowerUser = username.toLowerCase();
        const exists = await User.findOne({ username: lowerUser });
        if (exists) return res.json({ success: false, message: "Username taken." });
        const newUser = new User({ fullName, username: lowerUser, password, gender });
        await newUser.save();
        res.json({ success: true });
    } catch (e) { res.json({ success: false }); }
});

app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    const lowerUser = username.toLowerCase();
    
    // Admin check...
    if(lowerUser === 'admin' && password === (process.env.ADMIN_PASSWORD)) {
        res.cookie('pulse_user', 'admin', { httpOnly: true });
        return res.json({ success: true, redirect: '/admin.html' });
    }

    const user = await User.findOne({ username: lowerUser, password });
    if (user) {
        res.cookie('pulse_user', user.username, { httpOnly: true });
        if (!user.partnerId) return res.json({ success: true, redirect: '/setup.html' });

        const partner = await User.findById(user.partnerId);
        if (partner && partner.partnerId && partner.partnerId.equals(user._id)) {
            const page = user.gender === 'male' ? '/male.html' : '/female.html';
            // [FIX] Added userId: user._id
            return res.json({ success: true, redirect: page, userId: user._id, username: user.username });
        } else {
            // [FIX] Added userId: user._id
            return res.json({ success: true, redirect: '/setup.html', status: 'waiting', userId: user._id, username: user.username });
        }
    } else {
        res.json({ success: false, message: "Invalid credentials" });
    }
});

// QUICK LOGIN (Remember Me)
app.post('/quick-login', async (req, res) => {
    const { username, userId } = req.body;

    try {
        // Verify the user exists with this specific ID
        const user = await User.findOne({ username: username, _id: userId });

        if (user) {
            // Refresh the session cookie
            res.cookie('pulse_user', user.username, { 
                maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
                httpOnly: true,
                sameSite: 'strict'
            });
            
            // Redirect based on Gender
            const page = user.gender === 'male' ? '/male.html' : '/female.html';
            return res.json({ success: true, redirect: page });
        } else {
            return res.json({ success: false, message: "Invalid saved login." });
        }
    } catch (err) {
        console.error(err);
        res.json({ success: false });
    }
});

app.post('/pair', async (req, res) => {
    const { myUsername, partnerUsername } = req.body;

    // 1. Input Validation
    if (!myUsername || !partnerUsername) {
        return res.json({ success: false, message: "Missing username." });
    }

    const me = await User.findOne({ username: myUsername.toLowerCase() });
    const partner = await User.findOne({ username: partnerUsername.toLowerCase() });

    // --- CRASH FIX: Check if 'me' exists before using it ---
    if (!me) {
        // This handles the error you saw.
        // It likely means your database was cleared but your browser is still logged in.
        return res.json({ success: false, message: "Your account was not found. Please Register again." });
    }

    if (!partner) {
        return res.json({ success: false, message: "Partner username not found." });
    }

    if (me.username === partner.username) {
        return res.json({ success: false, message: "Cannot pair with yourself." });
    }
    
    // Update My Partner ID
    me.partnerId = partner._id;
    await me.save();

    // Check Mutual Connection
    if (partner.partnerId && partner.partnerId.equals(me._id)) {
        const page = me.gender === 'male' ? '/male.html' : '/female.html';
        res.json({ success: true, status: 'connected', redirect: page });
    } else {
        res.json({ success: true, status: 'waiting' });
    }
});

// --- 6. NOTIFICATION ROUTES (THE FIX) ---

// [FIXED] SUBSCRIBE: Auto-Migrates Old Data -> New Data
app.post('/subscribe', async (req, res) => {
    const { username, subscription } = req.body;
    
    // Find user
    let userSub = await Subscription.findOne({ username });
    
    if (!userSub) {
        // New user? Create fresh list.
        userSub = new Subscription({ username, subscriptions: [subscription] });
    } else {
        // --- MIGRATION LOGIC START ---
        
        // 1. Ensure the array exists
        if (!userSub.subscriptions) {
            userSub.subscriptions = [];
        }

        // 2. Check if they have the OLD format
        if (userSub.subscription) {
            console.log(`Migrating ${username} to multi-device format...`);
            // Move the old device into the new list
            userSub.subscriptions.push(userSub.subscription);
            // Delete the old field so we don't do this again
            userSub.subscription = undefined; 
        }
        
        // --- MIGRATION LOGIC END ---

        // 3. Add the CURRENT device (if it's not already in the list)
        const exists = userSub.subscriptions.find(s => s.endpoint === subscription.endpoint);
        if (!exists) {
            userSub.subscriptions.push(subscription);
        }
    }
    
    await userSub.save();
    res.status(201).json({});
});

// [FIXED] SEND LOVE: Supports Old & New Users
app.post('/send-love', async (req, res) => {
    const { senderUsername, location } = req.body;
    const sender = await User.findOne({ username: senderUsername });
    
    if(!sender || !sender.partnerId) return res.json({ success: false });

    const partner = await User.findById(sender.partnerId);
    
    // Save History
    const message = `${sender.fullName} is thinking of you!`;
    const newLog = new History({ 
        sender: sender.username, receiver: partner.username,
        message, location 
    });
    await newLog.save();

    // GET PARTNER SUBSCRIPTIONS
    const partnerData = await Subscription.findOne({ username: partner.username });
    
    // SAFETY NET: Create a list of targets
    let targets = [];

    if (partnerData) {
        // 1. Add all NEW devices (Array)
        if (partnerData.subscriptions && partnerData.subscriptions.length > 0) {
            targets = [...partnerData.subscriptions];
        }
        
        // 2. Add OLD device (Single Object) - Fallback
        // Only if we found no new devices, check if an old one exists
        if (targets.length === 0 && partnerData.subscription) {
            targets.push(partnerData.subscription);
        }
    }

    if (targets.length === 0) {
        return res.json({ success: true, message: "Sent (Partner has no active devices)" });
    }

    const payload = JSON.stringify({ title: 'Pulse', body: message });
    
    // MULTI-DEVICE SEND LOOP
    const promises = targets.map(async (sub) => {
        try {
            await webpush.sendNotification(sub, payload);
            return { status: 'success', sub };
        } catch (error) {
            if (error.statusCode === 410 || error.statusCode === 404) {
                return { status: 'dead', sub };
            }
            return { status: 'error', sub };
        }
    });

    const results = await Promise.all(promises);

    // CLEANUP (Only runs if user is already migrated to Array format)
    if (partnerData.subscriptions && partnerData.subscriptions.length > 0) {
        const activeSubs = results
            .filter(r => r.status !== 'dead')
            .map(r => r.sub);

        if (activeSubs.length !== partnerData.subscriptions.length) {
            partnerData.subscriptions = activeSubs;
            await partnerData.save();
        }
    }

    res.json({ success: true });
});

// --- MISSING HELPER ROUTES ---

// 1. STATUS CHECK (For Setup Page Auto-Redirect)
app.post('/status', async (req, res) => {
    const user = await User.findOne({ username: req.body.username.toLowerCase() });
    
    if (user && user.partnerId) {
        const partner = await User.findById(user.partnerId);
        // Check if partner has connected back
        if (partner && partner.partnerId && partner.partnerId.equals(user._id)) {
            const page = user.gender === 'male' ? '/male.html' : '/female.html';
            return res.json({ status: 'connected', redirect: page });
        }
    }
    res.json({ status: 'waiting' });
});

// 2. WIDGET API (For iOS Scriptable Widget)
app.get('/api/widget/:username', async (req, res) => {
    const username = req.params.username.toLowerCase();
    
    const user = await User.findOne({ username });
    if (!user || !user.partnerId) return res.json({ text: "No Link" });

    const partner = await User.findById(user.partnerId);
    if (!partner) return res.json({ text: "No Partner" });

    const lastLog = await History.findOne({ 
        sender: partner.username, 
        receiver: user.username 
    }).sort({ timestamp: -1 });

    if (!lastLog) return res.json({ text: "Waiting..." });

    const now = new Date();
    const diff = Math.floor((now - lastLog.timestamp) / 60000); 
    
    let timeText = `${diff}m ago`;
    if (diff > 60) timeText = `${Math.floor(diff/60)}h ago`;
    if (diff > 1440) timeText = `${Math.floor(diff/1440)}d ago`;

    res.json({ 
        text: `❤️ from ${partner.fullName || partner.username}`, 
        time: timeText 
    });
});

// 3. ADMIN DATA (For Admin Dashboard)
app.get('/admin/users', async (req, res) => {
    const users = await User.find({ username: { $ne: 'admin' } });
    res.json(users);
});

app.get('/admin/history', async (req, res) => {
    const { user, date } = req.query;
    let query = {};
    if (user) { query.$or = [{ sender: user }, { receiver: user }]; }
    if (date) {
        const start = new Date(date);
        const end = new Date(date);
        end.setDate(end.getDate() + 1);
        query.timestamp = { $gte: start, $lt: end };
    }
    const logs = await History.find(query).sort({ timestamp: -1 });
    res.json(logs);
});

app.get('/admin/db', async (req, res) => {
    const users = await User.find({});
    const subs = await Subscription.find({});
    const history = await History.find({});
    res.json({ users, subs, history });
});

// EXPORT & EMAIL ROUTE
app.post('/admin/export', async (req, res) => {
    const { email, user, startDate, endDate } = req.body;

    if (!email) return res.json({ success: false, message: "Target email required" });

    try {
        // 1. Build Query
        let query = {};
        
        // Date Range
        if (startDate || endDate) {
            query.timestamp = {};
            if (startDate) query.timestamp.$gte = new Date(startDate);
            if (endDate) {
                const end = new Date(endDate);
                end.setDate(end.getDate() + 1); // Include the full end day
                query.timestamp.$lt = end;
            }
        }

        // User/Couple Filter
        if (user) {
            // Find the user and their partner to get the full "Couple" conversation
            const targetUser = await User.findOne({ username: user });
            let partners = [user];
            
            if (targetUser && targetUser.partnerId) {
                const partner = await User.findById(targetUser.partnerId);
                if (partner) partners.push(partner.username);
            }

            // Get logs where EITHER person in the couple is the sender or receiver
            query.$or = [
                { sender: { $in: partners } },
                { receiver: { $in: partners } }
            ];
        }

        // 2. Fetch Data (Exclude Location)
        const logs = await History.find(query).select('-location').sort({ timestamp: -1 });

        if (logs.length === 0) return res.json({ success: false, message: "No data found for these filters." });

        // 3. Generate Excel
        const workbook = new ExcelJS.Workbook();
        const sheet = workbook.addWorksheet('History Logs');

        sheet.columns = [
            { header: 'Time', key: 'timestamp', width: 25 },
            { header: 'Sender', key: 'sender', width: 15 },
            { header: 'Receiver', key: 'receiver', width: 15 },
            { header: 'Message', key: 'message', width: 40 }
        ];

        logs.forEach(log => {
            sheet.addRow({
                timestamp: log.timestamp.toLocaleString(),
                sender: log.sender,
                receiver: log.receiver,
                message: log.message
            });
        });

        // 4. Write to Buffer
        const buffer = await workbook.xlsx.writeBuffer();

        // 5. Send Email
        await transporter.sendMail({
            from: '"Pulse Admin" <' + process.env.EMAIL_USER + '>',
            to: email,
            subject: 'Pulse History Export',
            text: `Attached is the requested history data.\n\nFilters:\nUser: ${user || 'All'}\nRange: ${startDate || 'Start'} to ${endDate || 'Now'}`,
            attachments: [
                {
                    filename: 'Pulse_History_Export.xlsx',
                    content: buffer
                }
            ]
        });

        res.json({ success: true, message: "Email sent successfully!" });

    } catch (error) {
        console.error("Export Error:", error);
        res.json({ success: false, message: "Failed to export email." });
    }
});

// --- 7. OTHER ROUTES ---
app.get('/me', async (req, res) => {
    if (!req.cookies.pulse_user) return res.status(401).json({ user: null });
    const user = await User.findOne({ username: req.cookies.pulse_user });
    let partnerName = "them";
    if (user && user.partnerId) {
        const partner = await User.findById(user.partnerId);
        if (partner) partnerName = partner.fullName;
    }
    res.json({ user: user ? user.username : null, partnerName });
});

// --- LOGOUT ROUTE ---
app.get('/logout', (req, res) => {
    res.clearCookie('pulse_user');
    res.redirect('/');
});

// HTML Serving (Keep manual auth guard)
const requireAuth = (req, res, next) => {
    if (req.cookies && req.cookies.pulse_user) next();
    else res.redirect('/');
};

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public/index.html')));
app.get('/male.html', requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'public/male.html')));
app.get('/female.html', requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'public/female.html')));
app.get('/setup.html', requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'public/setup.html')));
// Add this line so the Admin HTML file can actually load
app.get('/admin.html', (req, res) => {
    if(req.cookies.pulse_user === 'admin') res.sendFile(path.join(__dirname, 'public/admin.html'));
    else res.status(403).send("Unauthorized");
});

app.listen(port, () => console.log(`Pulse running on ${port}`));