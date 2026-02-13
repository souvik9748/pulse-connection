require('dotenv').config(); // Load environment variables
const express = require('express');
const webpush = require('web-push');
const bodyParser = require('body-parser');
const path = require('path');
const cookieParser = require('cookie-parser');
const mongoose = require('mongoose');

const app = express();
const port = process.env.PORT || 3000;

// --- 1. MONGODB CONNECTION ---
// On Render, we set this variable in the dashboard.
// On Localhost, you can replace this string with your Atlas URL for testing.
const mongoURI = process.env.MONGO_URI;

if (!mongoURI) {
    console.error("❌ FATAL ERROR: No MONGO_URI found. Check .env file or Render dashboard.");
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

const SubSchema = new mongoose.Schema({
    username: String,
    subscription: Object
});

const User = mongoose.model('User', UserSchema);
const History = mongoose.model('History', HistorySchema);
const Subscription = mongoose.model('Subscription', SubSchema);

// --- 3. NOTIFICATIONS ---
const publicVapidKey = process.env.PUBLIC_VAPID_KEY;
const privateVapidKey = process.env.PRIVATE_VAPID_KEY;

webpush.setVapidDetails('mailto:test@test.com', publicVapidKey, privateVapidKey);

// --- 4. MIDDLEWARE ---
app.use(bodyParser.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public'), { index: false, extensions: ['js', 'css', 'png', 'jpg', 'mp4'] }));

// --- 5. AUTH ROUTES ---

// REGISTER
app.post('/register', async (req, res) => {
    const { fullName, username, password, gender } = req.body;
    try {
        const lowerUser = username.toLowerCase();
        const exists = await User.findOne({ username: lowerUser });
        if (exists) return res.json({ success: false, message: "Username taken." });

        const newUser = new User({ fullName, username: lowerUser, password, gender });
        await newUser.save();
        res.json({ success: true });
    } catch (e) { res.json({ success: false, message: "Error creating user" }); }
});

// LOGIN
app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    const lowerUser = username.toLowerCase();

    // Admin Backdoor
    if(lowerUser === 'admin' && password === 'admin') {
        res.cookie('pulse_user', 'admin', { httpOnly: true });
        return res.json({ success: true, redirect: '/admin.html' });
    }

    const user = await User.findOne({ username: lowerUser, password });
    
    if (user) {
        res.cookie('pulse_user', user.username, { httpOnly: true });

        if (!user.partnerId) {
            return res.json({ success: true, redirect: '/setup.html', status: 'new', username: user.username });
        }

        const partner = await User.findById(user.partnerId);
        
        if (partner && partner.partnerId && partner.partnerId.equals(user._id)) {
            const page = user.gender === 'male' ? '/male.html' : '/female.html';
            return res.json({ success: true, redirect: page, username: user.username });
        } else {
            return res.json({ success: true, redirect: '/setup.html', status: 'waiting', partnerName: partner ? partner.username : '', username: user.username });
        }
    } else {
        res.json({ success: false, message: "Invalid credentials" });
    }
});

// PAIRING
app.post('/pair', async (req, res) => {
    const { myUsername, partnerUsername } = req.body;
    const me = await User.findOne({ username: myUsername.toLowerCase() });
    const partner = await User.findOne({ username: partnerUsername.toLowerCase() });

    if (!partner) return res.json({ success: false, message: "User not found" });
    if (me.username === partner.username) return res.json({ success: false, message: "Cannot pair with self" });

    // Update My Partner ID
    me.partnerId = partner._id;
    await me.save();

    // Check Mutual
    if (partner.partnerId && partner.partnerId.equals(me._id)) {
        const page = me.gender === 'male' ? '/male.html' : '/female.html';
        res.json({ success: true, status: 'connected', redirect: page });
    } else {
        res.json({ success: true, status: 'waiting' });
    }
});

// STATUS CHECK
app.post('/status', async (req, res) => {
    const user = await User.findOne({ username: req.body.username.toLowerCase() });
    
    if (user && user.partnerId) {
        const partner = await User.findById(user.partnerId);
        if (partner && partner.partnerId && partner.partnerId.equals(user._id)) {
            const page = user.gender === 'male' ? '/male.html' : '/female.html';
            return res.json({ status: 'connected', redirect: page });
        }
    }
    res.json({ status: 'waiting' });
});

// --- FEATURES ---

// SUBSCRIBE
app.post('/subscribe', async (req, res) => {
    const { username, subscription } = req.body;
    await Subscription.findOneAndUpdate({ username }, { username, subscription }, { upsert: true });
    res.status(201).json({});
});

// SEND LOVE
app.post('/send-love', async (req, res) => {
    const { senderUsername, location } = req.body;
    const sender = await User.findOne({ username: senderUsername });
    
    if(!sender || !sender.partnerId) return res.json({ success: false, message: "Not paired" });

    const partner = await User.findById(sender.partnerId);
    if (!partner.partnerId || !partner.partnerId.equals(sender._id)) return res.json({ success: false, message: "Partner hasn't connected back" });

    const message = `${sender.fullName} is thinking of you!`;

    // Save History
    const newLog = new History({ 
        sender: sender.username, receiver: partner.username,
        message, location 
    });
    await newLog.save();

    // Send Push
    const partnerSub = await Subscription.findOne({ username: partner.username });
    if (partnerSub) {
        try {
            await webpush.sendNotification(partnerSub.subscription, JSON.stringify({ title: 'Pulse', body: message }));
            res.json({ success: true });
        } catch (err) { res.status(500).json({}); }
    } else {
        res.json({ success: false, message: "Partner offline" });
    }
});

// --- CLIENT & ADMIN HELPERS ---

// Auth Check Helper for Client JS
app.get('/me', async (req, res) => {
    if (!req.cookies.pulse_user) return res.status(401).json({ user: null });

    // Find the current user
    const user = await User.findOne({ username: req.cookies.pulse_user });
    if (!user) return res.status(401).json({ user: null });

    // Find their partner
    let partnerName = "them";
    if (user.partnerId) {
        const partner = await User.findById(user.partnerId);
        // Use Full Name if available, otherwise username
        if (partner) partnerName = partner.fullName || partner.username;
    }

    res.json({ user: user.username, partnerName });
});

app.get('/logout', (req, res) => {
    res.clearCookie('pulse_user');
    res.redirect('/');
});

// Admin Data
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

// --- HTML ROUTES (MANUAL GUARD) ---
// Note: We use the same 'requireAuth' check as before
const requireAuth = (req, res, next) => {
    if (req.cookies && req.cookies.pulse_user) next();
    else res.redirect('/');
};

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public/index.html')));
app.get('/index.html', (req, res) => res.sendFile(path.join(__dirname, 'public/index.html')));
app.get('/register.html', (req, res) => res.sendFile(path.join(__dirname, 'public/register.html')));

app.get('/setup.html', requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'public/setup.html')));
app.get('/male.html', requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'public/male.html')));
app.get('/female.html', requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'public/female.html')));
app.get('/admin.html', (req, res) => {
    if(req.cookies.pulse_user === 'admin') res.sendFile(path.join(__dirname, 'public/admin.html'));
    else res.status(403).send("Unauthorized");
});

app.listen(port, () => console.log(`Pulse running on ${port}`));