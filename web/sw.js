'use strict';
// Lets the phone install the site as an app. Pages always come from the network (the controls must be live);
// when offline, a short notice is shown instead.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  if (e.request.mode !== 'navigate') return;
  e.respondWith(
    fetch(e.request).catch(
      () => new Response('<meta name="viewport" content="width=device-width"><p style="font-family:sans-serif;padding:24px">No internet connection. Reconnect and reload.</p>', { headers: { 'Content-Type': 'text/html' } }),
    ),
  );
});
