// REPLACE THIS with your actual Render URL if needed (e.g. https://pulse-app.onrender.com)
// If deployed, using relative paths like '/subscribe' is fine.
const publicVapidKey = 'BF5J5oCuArj-V05wynt72pgVjrrwRIVHyz7H1UaU35dSlf3F9_tB4DjIypP68fI-lXDETgr53zocSkDiarcgCIo';

// 1. Register Notifications (Updated for iOS)
async function registerNotifications() {
    const user = localStorage.getItem('pulse_user');
    if (!user) return;

    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
        console.log("Push messaging is not supported");
        return;
    }

    try {
        // STEP A: Ask for permission explicitly
        // iOS requires this to happen inside a click event (which we do in send())
        const permission = await Notification.requestPermission();
        
        if (permission !== 'granted') {
            // Optional: Alert user if they blocked it previously
            // alert("Notifications blocked. Please reset permissions for this app.");
            return;
        }

        // STEP B: Register Service Worker
        const register = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
        
        // STEP C: Subscribe
        const subscription = await register.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(publicVapidKey)
        });

        // STEP D: Send to Server
        await fetch('/subscribe', {
            method: 'POST',
            body: JSON.stringify({ username: user, subscription }),
            headers: { 'content-type': 'application/json' }
        });

        console.log("✅ Notifications Active");

    } catch (err) {
        console.error("❌ Notification Error:", err);
        // This alert helps debugging on iPhone. Remove it later.
        alert("Push Error: " + err.message);
    }
}

// 2. Strict Location Guard
function enforceLocation(onSuccess, onError) {
    if (!navigator.geolocation) { onError("Browser Not Supported"); return; }
    navigator.geolocation.getCurrentPosition(
        (pos) => onSuccess({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
        (err) => onError("Location Access Required"),
        { timeout: 10000, enableHighAccuracy: true }
    );
}

// 3. Send Logic
async function sendLove(locationData) {
    const user = localStorage.getItem('pulse_user');
    if(!locationData) return alert("Location missing. Refresh.");

    // Trigger Notification Setup on every send (just in case it failed before)
    await registerNotifications();

    await fetch('/send-love', {
        method: 'POST',
        body: JSON.stringify({ senderUsername: user, location: locationData }),
        headers: { 'content-type': 'application/json' }
    });
}

// Helper
function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding).replace(/\-/g, '+').replace(/_/g, '/');
    const rawData = window.atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; ++i) { outputArray[i] = rawData.charCodeAt(i); }
    return outputArray;
}