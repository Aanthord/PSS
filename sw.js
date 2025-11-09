// PSS Network Service Worker
// Persistent FT-DFRP Node for Prayers, Saints & Saviors
// Version 1.0

const CACHE_NAME = 'prayers-network-v1';
const DB_NAME = 'PrayersNetworkDB';
const STORES = ['peers', 'prayers', 'parity'];

let db;
let peers = new Map();
let isOnline = false;
let startTime = Date.now();

// Initialize IndexedDB for persistent storage
async function initDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, 1);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
            db = request.result;
            resolve(db);
        };
        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            STORES.forEach(storeName => {
                if (!db.objectStoreNames.contains(storeName)) {
                    const store = db.createObjectStore(storeName, { keyPath: 'id' });
                    // Add indexes for efficient querying
                    if (storeName === 'prayers') {
                        store.createIndex('timestamp', 'timestamp', { unique: false });
                        store.createIndex('category', 'category', { unique: false });
                        store.createIndex('urgency', 'urgency', { unique: false });
                    }
                    if (storeName === 'peers') {
                        store.createIndex('timestamp', 'timestamp', { unique: false });
                        store.createIndex('lastSeen', 'lastSeen', { unique: false });
                    }
                }
            });
        };
    });
}

// Store data persistently with error handling
async function storeData(storeName, data) {
    try {
        if (!db) await initDB();
        const transaction = db.transaction([storeName], 'readwrite');
        const store = transaction.objectStore(storeName);
        
        // Add timestamp if not present
        if (!data.timestamp) {
            data.timestamp = Date.now();
        }
        
        await new Promise((resolve, reject) => {
            const request = store.put(data);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
        
        console.log(`Stored ${storeName} data:`, data.id);
        return true;
    } catch (error) {
        console.error(`Failed to store ${storeName} data:`, error);
        return false;
    }
}

// Retrieve data with error handling
async function getData(storeName, id) {
    try {
        if (!db) await initDB();
        const transaction = db.transaction([storeName], 'readonly');
        const store = transaction.objectStore(storeName);
        
        return new Promise((resolve, reject) => {
            const request = store.get(id);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    } catch (error) {
        console.error(`Failed to get ${storeName} data:`, error);
        return null;
    }
}

// Get all data from a store
async function getAllData(storeName, limit = 100) {
    try {
        if (!db) await initDB();
        const transaction = db.transaction([storeName], 'readonly');
        const store = transaction.objectStore(storeName);
        
        return new Promise((resolve, reject) => {
            const request = store.getAll();
            request.onsuccess = () => {
                let results = request.result || [];
                // Sort by timestamp, newest first, and limit results
                results.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
                if (results.length > limit) {
                    results = results.slice(0, limit);
                }
                resolve(results);
            };
            request.onerror = () => reject(request.error);
        });
    } catch (error) {
        console.error(`Failed to get all ${storeName} data:`, error);
        return [];
    }
}

// Delete old data to manage storage
async function cleanupOldData() {
    try {
        const maxAge = 7 * 24 * 60 * 60 * 1000; // 7 days
        const now = Date.now();
        
        for (const storeName of STORES) {
            const allData = await getAllData(storeName, 1000);
            const transaction = db.transaction([storeName], 'readwrite');
            const store = transaction.objectStore(storeName);
            
            allData.forEach(item => {
                if (item.timestamp && (now - item.timestamp) > maxAge) {
                    store.delete(item.id);
                }
            });
        }
        
        console.log('Completed data cleanup');
    } catch (error) {
        console.error('Error during data cleanup:', error);
    }
}

// Background sync for peer discovery
self.addEventListener('sync', event => {
    console.log('Service Worker sync event:', event.tag);
    
    if (event.tag === 'peer-discovery') {
        event.waitUntil(discoverPeers());
    } else if (event.tag === 'data-cleanup') {
        event.waitUntil(cleanupOldData());
    }
});

// Message handling from main thread
self.addEventListener('message', async event => {
    const { type, data } = event.data;
    console.log('Service Worker received message:', type);
    
    try {
        switch (type) {
            case 'STORE_PRAYER':
                const stored = await storeData('prayers', data);
                if (stored) {
                    broadcastToPeers('NEW_PRAYER', data);
                }
                break;
                
            case 'STORE_PARITY':
                await storeData('parity', data);
                break;
                
            case 'REGISTER_PEER':
                peers.set(data.id, { ...data, lastSeen: Date.now() });
                await storeData('peers', data);
                console.log('Peer registered:', data.id);
                break;
                
            case 'GET_NETWORK_STATUS':
                if (event.ports && event.ports[0]) {
                    event.ports[0].postMessage({
                        peers: peers.size,
                        isOnline,
                        uptime: Date.now() - startTime,
                        dbReady: !!db
                    });
                }
                break;
                
            case 'GET_PRAYERS':
                const prayers = await getAllData('prayers', data.limit || 50);
                if (event.ports && event.ports[0]) {
                    event.ports[0].postMessage({
                        type: 'PRAYERS_DATA',
                        prayers: prayers
                    });
                }
                break;
                
            case 'GET_PEERS':
                const peersList = await getAllData('peers', 20);
                if (event.ports && event.ports[0]) {
                    event.ports[0].postMessage({
                        type: 'PEERS_DATA',
                        peers: peersList
                    });
                }
                break;
                
            case 'CLEANUP':
                await cleanupOldData();
                break;
                
            default:
                console.log('Unknown message type:', type);
        }
    } catch (error) {
        console.error('Error handling message:', error);
    }
});

// Broadcast to connected peers (simulation - in full implementation use WebRTC)
function broadcastToPeers(type, data) {
    const peerCount = peers.size;
    console.log(`Broadcasting ${type} to ${peerCount} peers:`, data.id || data);
    
    // In a full P2P implementation, this would send via WebRTC data channels
    // For now, we simulate by updating localStorage for other tabs to detect
    try {
        const broadcast = {
            id: 'broadcast_' + Math.random().toString(36).substr(2, 9),
            type: type,
            data: data,
            timestamp: Date.now(),
            sender: 'service-worker'
        };
        
        // Use localStorage for cross-tab communication simulation
        const broadcasts = JSON.parse(localStorage.getItem('network_broadcasts') || '[]');
        broadcasts.push(broadcast);
        
        // Keep only recent broadcasts
        if (broadcasts.length > 50) {
            broadcasts.splice(0, broadcasts.length - 50);
        }
        
        localStorage.setItem('network_broadcasts', JSON.stringify(broadcasts));
    } catch (error) {
        console.error('Error broadcasting to peers:', error);
    }
}

// Periodic peer discovery and maintenance
async function discoverPeers() {
    try {
        console.log('Discovering peers in background...');
        
        // Clean up old peers (older than 10 minutes)
        const now = Date.now();
        const maxPeerAge = 10 * 60 * 1000; // 10 minutes
        
        const currentPeers = Array.from(peers.entries());
        currentPeers.forEach(([peerId, peerData]) => {
            if (now - (peerData.lastSeen || 0) > maxPeerAge) {
                peers.delete(peerId);
                console.log('Removed stale peer:', peerId);
            }
        });
        
        // Update online status
        isOnline = peers.size > 0 || navigator.onLine;
        
        // Schedule data cleanup periodically
        if (Math.random() < 0.1) { // 10% chance each discovery cycle
            await cleanupOldData();
        }
        
        console.log(`Peer discovery complete. Active peers: ${peers.size}`);
    } catch (error) {
        console.error('Error during peer discovery:', error);
    }
}

// Installation event
self.addEventListener('install', event => {
    console.log('PSS Service Worker installing...');
    
    event.waitUntil(
        Promise.all([
            initDB(),
            self.skipWaiting()
        ])
    );
});

// Activation event
self.addEventListener('activate', event => {
    console.log('PSS Service Worker activating...');
    
    event.waitUntil(
        Promise.all([
            clients.claim(),
            discoverPeers()
        ])
    );
});

// Periodic maintenance (every 2 minutes)
setInterval(() => {
    discoverPeers();
}, 120000);

// Initialize when service worker starts
Promise.all([
    initDB(),
    discoverPeers()
]).then(() => {
    console.log('FT-DFRP Service Worker: Network node active');
    isOnline = true;
}).catch(error => {
    console.error('Service Worker initialization failed:', error);
});

// Handle fetch events for offline functionality (optional caching)
self.addEventListener('fetch', event => {
    // Only cache GET requests for our own domain
    if (event.request.method === 'GET' && 
        event.request.url.startsWith(self.location.origin)) {
        
        event.respondWith(
            caches.match(event.request)
                .then(response => {
                    // Return cached version or fetch from network
                    return response || fetch(event.request);
                })
                .catch(() => {
                    // Offline fallback if needed
                    return new Response('Offline - please check your connection');
                })
        );
    }
});

console.log('PSS Service Worker script loaded');
