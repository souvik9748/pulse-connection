// CONFIGURATION
// If building for mobile (Capacitor), change this to your full Render URL (e.g. 'https://yourapp.onrender.com')
// For Web/PWA, leave it empty to use relative paths.
const BASE_URL = ''; 

const publicVapidKey = 'BF5J5oCuArj-V05wynt72pgVjrrwRIVHyz7H1UaU35dSlf3F9_tB4DjIypP68fI-lXDETgr53zocSkDiarcgCIo';

// --- 1. NOTIFICATIONS (Robust iOS/Android Logic) ---
async function registerNotifications() {
    const user = localStorage.getItem('pulse_user');
    if (!user) return;

    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
        console.log("Push messaging is not supported");
        return;
    }

    try {
        // A. Permission Check
        const permission = await Notification.requestPermission();
        if (permission !== 'granted') return;

        // B. Register SW
        const register = await navigator.serviceWorker.register('/sw.js', { scope: '/' });

        let subscription;

        // C. Try to Subscribe
        try {
            subscription = await register.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: urlBase64ToUint8Array(publicVapidKey)
            });
        } catch (err) {
            // ⚠️ FIX: If Key Mismatch (Old vs New), Unsubscribe and Retry
            if (err.message.includes('applicationServerKey') || err.message.includes('gcm_sender_id')) {
                console.warn("Old key detected. Resetting subscription...");
                
                const oldSub = await register.pushManager.getSubscription();
                if (oldSub) { await oldSub.unsubscribe(); }

                subscription = await register.pushManager.subscribe({
                    userVisibleOnly: true,
                    applicationServerKey: urlBase64ToUint8Array(publicVapidKey)
                });
            } else {
                throw err; 
            }
        }

        // D. Send to Server
        await fetch(`${BASE_URL}/subscribe`, {
            method: 'POST',
            body: JSON.stringify({ username: user, subscription }),
            headers: { 'content-type': 'application/json' }
        });

        console.log("✅ Notifications Active");

    } catch (err) {
        console.error("❌ Notification Error:", err);
        // Alert only for debugging, you can comment this out in production
        // alert("Push Setup Failed: " + err.message); 
    }
}

// --- 2. LOCATION GUARD ---
function enforceLocation(onSuccess, onError) {
    if (!navigator.geolocation) { onError("Browser Not Supported"); return; }
    navigator.geolocation.getCurrentPosition(
        (pos) => onSuccess({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
        (err) => onError("Location Access Required"),
        { timeout: 10000, enableHighAccuracy: true }
    );
}

// --- 3. SEND LOVE ---
async function sendLove(locationData) {
    const user = localStorage.getItem('pulse_user');
    if(!locationData) return alert("Location missing. Refresh.");

    // Trigger Notification Setup on every send (ensures iOS permission)
    await registerNotifications();

    await fetch(`${BASE_URL}/send-love`, {
        method: 'POST',
        body: JSON.stringify({ senderUsername: user, location: locationData }),
        headers: { 'content-type': 'application/json' }
    });
}

// --- 4. QUICK LOGIN / REMEMBER ME ---

// Save a successful login to the device
function saveLoginToDevice(username, userId) {
    let accounts = JSON.parse(localStorage.getItem('pulse_accounts') || '[]');
    
    // Remove if already exists (avoid duplicates)
    accounts = accounts.filter(a => a.username !== username);
    
    // Add to top of list
    accounts.unshift({ username, userId, lastLogin: Date.now() });
    
    localStorage.setItem('pulse_accounts', JSON.stringify(accounts));
}

// Get list of saved accounts
function getSavedAccounts() {
    return JSON.parse(localStorage.getItem('pulse_accounts') || '[]');
}

// Perform the Quick Login
async function quickLogin(username, userId) {
    try {
        const res = await fetch(`${BASE_URL}/quick-login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, userId })
        });
        const data = await res.json();
        
        if (data.success) {
            window.location.href = data.redirect;
        } else {
            alert("Session expired. Please log in again.");
            removeAccount(username);
        }
    } catch (err) {
        console.error("Quick login error", err);
    }
}

// Remove an account from the list
function removeAccount(username) {
    let accounts = getSavedAccounts().filter(a => a.username !== username);
    localStorage.setItem('pulse_accounts', JSON.stringify(accounts));
    location.reload(); 
}

// --- HELPER ---
function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding).replace(/\-/g, '+').replace(/_/g, '/');
    const rawData = window.atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; ++i) { outputArray[i] = rawData.charCodeAt(i); }
    return outputArray;
}