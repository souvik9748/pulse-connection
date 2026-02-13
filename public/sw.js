self.addEventListener('push', e => {
    const data = e.data.json();
    console.log('Push Received...');
    
    self.registration.showNotification(data.title, {
        body: data.body,
        icon: 'https://cdn-icons-png.flaticon.com/512/833/833472.png', // Heart Icon
        vibrate: [200, 100, 200]
    });
});

// NEW: Open the app when user clicks the notification
self.addEventListener('notificationclick', function(event) {
    event.notification.close();
    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(clientList) {
            // If app is already open, focus it
            if (clientList.length > 0) {
                let client = clientList[0];
                if ('focus' in client) {
                    return client.focus();
                }
            }
            // If app is closed, open it
            if (clients.openWindow) {
                return clients.openWindow('/');
            }
        })
    );
});