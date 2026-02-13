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
        // 1. Permission Check
        const permission = await Notification.requestPermission();
        if (permission !== 'granted') return;

        // 2. Register SW
        const register = await navigator.serviceWorker.register('/sw.js', { scope: '/' });

        let subscription;

        // 3. Try to Subscribe
        try {
            subscription = await register.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: urlBase64ToUint8Array(publicVapidKey)
            });
        } catch (err) {
            // ⚠️ FIX: If Key Mismatch Error, Unsubscribe and Retry
            if (err.message.includes('applicationServerKey') || err.message.includes('gcm_sender_id')) {
                console.warn("Old key detected. Resetting subscription...");
                
                // A. Get the old broken subscription
                const oldSub = await register.pushManager.getSubscription();
                if (oldSub) { 
                    await oldSub.unsubscribe(); 
                }

                // B. Try subscribing again with new key
                subscription = await register.pushManager.subscribe({
                    userVisibleOnly: true,
                    applicationServerKey: urlBase64ToUint8Array(publicVapidKey)
                });
            } else {
                throw err; // If it's a different error, stop here
            }
        }

        // 4. Send to Server
        await fetch('/subscribe', {
            method: 'POST',
            body: JSON.stringify({ username: user, subscription }),
            headers: { 'content-type': 'application/json' }
        });

        console.log("✅ Notifications Active");

    } catch (err) {
        console.error("❌ Notification Error:", err);
        alert("Push Setup Failed: " + err.message); // Debug Alert
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