const publicVapidKey = 'BF5J5oCuArj-V05wynt72pgVjrrwRIVHyz7H1UaU35dSlf3F9_tB4DjIypP68fI-lXDETgr53zocSkDiarcgCIo';

// 1. Register Notifications
async function registerNotifications() {
    const user = localStorage.getItem('pulse_user');
    if (!user) return;

    if ('serviceWorker' in navigator) {
        const register = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
        const subscription = await register.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(publicVapidKey)
        });

        await fetch('/subscribe', {
            method: 'POST',
            body: JSON.stringify({ username: user, subscription }),
            headers: { 'content-type': 'application/json' }
        });
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