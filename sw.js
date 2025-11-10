// PSS Network Service Worker
// Persistent FT-DFRP Node for Prayers, Saints & Saviors
// Version 1.0 with Full WebRTC P2P Implementation

const CACHE_NAME = 'prayers-network-v1';
const DB_NAME = 'PrayersNetworkDB';
const STORES = ['peers', 'prayers', 'parity', 'webrtc_signals', 'ice_candidates', 'connections'];

let db;
let peers = new Map();
let isOnline = false;
let startTime = Date.now();

// WebRTC P2P Implementation
let webrtcConnections = new Map(); // connectionKey -> connection metadata
let pendingSignals = new Map(); // peerId -> pending signaling data
let iceQueue = new Map(); // peerId -> queued ICE candidates
let connectionStates = new Map(); // peerId -> connection state
let signalingServer = null; // For fallback signaling

// WebRTC Configuration
const rtcConfig = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:stun3.l.google.com:19302' },
        { urls: 'stun:stun4.l.google.com:19302' },
        // Add TURN servers for production
        // { urls: 'turn:your-turn-server.com', username: 'user', credential: 'pass' }
    ],
    iceCandidatePoolSize: 10
};

console.log('🔧 SW: WebRTC P2P Service Worker starting...');

// Initialize IndexedDB for persistent storage
async function initDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, 2);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
            db = request.result;
            console.log('🔧 SW: IndexedDB initialized with WebRTC support');
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
                        store.createIndex('connectionState', 'connectionState', { unique: false });
                    }
                    if (storeName === 'webrtc_signals') {
                        store.createIndex('targetPeer', 'targetPeer', { unique: false });
                        store.createIndex('signalType', 'signalType', { unique: false });
                        store.createIndex('timestamp', 'timestamp', { unique: false });
                    }
                    if (storeName === 'ice_candidates') {
                        store.createIndex('peerId', 'peerId', { unique: false });
                        store.createIndex('timestamp', 'timestamp', { unique: false });
                    }
                    if (storeName === 'connections') {
                        store.createIndex('peerId', 'peerId', { unique: false });
                        store.createIndex('state', 'state', { unique: false });
                        store.createIndex('timestamp', 'timestamp', { unique: false });
                    }
                    console.log('🔧 SW: Created IndexedDB store:', storeName);
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
        
        console.log(`🔧 SW: Stored ${storeName} data:`, data.id);
        return true;
    } catch (error) {
        console.error(`🔧 SW: Failed to store ${storeName} data:`, error);
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
        console.error(`🔧 SW: Failed to get ${storeName} data:`, error);
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
        console.error(`🔧 SW: Failed to get all ${storeName} data:`, error);
        return [];
    }
}

// WebRTC Signaling Management
function getConnectionKey(peerA, peerB) {
    if (!peerA || !peerB) {
        return null;
    }
    return [peerA, peerB].sort().join('::');
}

async function storeWebRTCSignal(sourcePeer, targetPeer, signalType, signalData) {
    const signal = {
        id: `signal_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        sourcePeer: sourcePeer,
        targetPeer: targetPeer,
        signalType: signalType, // 'offer', 'answer', 'ice-candidate'
        signalData: signalData,
        timestamp: Date.now(),
        processed: false
    };
    
    await storeData('webrtc_signals', signal);
    console.log('🔧 SW: Stored WebRTC signal:', signalType, 'for peer:', targetPeer);
    
    // Notify main thread about new signal
    broadcastToClients('webrtc_signal_received', {
        sourcePeer: sourcePeer,
        targetPeer: targetPeer,
        signalType: signalType,
        signalData: signalData
    });

    return signal;
}

// ICE Candidate Management
async function storeICECandidate(sourcePeer, targetPeer, candidate) {
    const iceCandidate = {
        id: `ice_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        peerId: targetPeer,
        sourcePeer: sourcePeer,
        targetPeer: targetPeer,
        candidate: candidate,
        timestamp: Date.now(),
        processed: false
    };

    await storeData('ice_candidates', iceCandidate);
    console.log('🔧 SW: Stored ICE candidate from', sourcePeer, 'for peer:', targetPeer);

    // Queue for processing if connection isn't ready
    const queueKey = getConnectionKey(sourcePeer, targetPeer) || targetPeer;
    if (!iceQueue.has(queueKey)) {
        iceQueue.set(queueKey, []);
    }
    iceQueue.get(queueKey).push({ sourcePeer, targetPeer, candidate });

    // Notify main thread
    broadcastToClients('ice_candidate_received', {
        fromPeerId: sourcePeer,
        targetPeerId: targetPeer,
        candidate: candidate
    });

    return iceCandidate;
}

// Connection State Management
async function updateConnectionState(peerId, state, metadata = {}) {
    const connection = {
        id: getConnectionKey(metadata.sourcePeer, metadata.targetPeer) || peerId,
        peerId: peerId,
        state: state, // 'connecting', 'connected', 'disconnected', 'failed'
        metadata: metadata,
        timestamp: Date.now(),
        lastActivity: Date.now()
    };
    
    connectionStates.set(peerId, connection);
    await storeData('connections', connection);
    
    console.log('🔧 SW: Updated connection state for', peerId, 'to', state);
    
    // Update peer state
    if (peers.has(peerId)) {
        const peer = peers.get(peerId);
        peer.connectionState = state;
        peer.lastSeen = Date.now();
        peers.set(peerId, peer);
        await storeData('peers', { id: peerId, ...peer });
    }
    
    // Notify main thread
    broadcastToClients('connection_state_changed', {
        peerId: peerId,
        state: state,
        metadata: metadata
    });
}

// WebRTC Peer Discovery and Connection Initiation
async function initiateWebRTCConnection(sourcePeerId, targetPeerId, initiatorPeerId = sourcePeerId) {
    if (!sourcePeerId || !targetPeerId || sourcePeerId === targetPeerId) {
        return null;
    }

    console.log('🔧 SW: Initiating WebRTC connection between', sourcePeerId, 'and', targetPeerId, 'initiator:', initiatorPeerId);

    const connectionId = `conn_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const connectionKey = getConnectionKey(sourcePeerId, targetPeerId);

    const connectionMetadata = {
        id: connectionId,
        sourcePeer: sourcePeerId,
        targetPeer: targetPeerId,
        initiator: initiatorPeerId,
        state: 'initiating',
        rtcConfig: rtcConfig,
        timestamp: Date.now()
    };

    if (connectionKey) {
        webrtcConnections.set(connectionKey, connectionMetadata);
    }

    await updateConnectionState(targetPeerId, 'connecting', connectionMetadata);
    await updateConnectionState(sourcePeerId, 'connecting', connectionMetadata);

    // Notify initiator client
    broadcastToClients('create_webrtc_connection', {
        selfPeerId: sourcePeerId,
        targetPeerId: targetPeerId,
        connectionId: connectionId,
        isInitiator: initiatorPeerId === sourcePeerId,
        rtcConfig: rtcConfig
    });

    // Notify responder client
    broadcastToClients('create_webrtc_connection', {
        selfPeerId: targetPeerId,
        targetPeerId: sourcePeerId,
        connectionId: connectionId,
        isInitiator: initiatorPeerId === targetPeerId,
        rtcConfig: rtcConfig
    });

    return connectionMetadata;
}

// Handle WebRTC Offer/Answer Exchange
async function handleWebRTCOffer(fromPeerId, targetPeerId, offer) {
    console.log('🔧 SW: Received WebRTC offer from:', fromPeerId, 'for:', targetPeerId);

    if (!targetPeerId) {
        console.warn('🔧 SW: Offer missing target peer');
        return;
    }

    // Store the offer
    await storeWebRTCSignal(fromPeerId, targetPeerId, 'offer', offer);

    const connectionKey = getConnectionKey(fromPeerId, targetPeerId);
    if (connectionKey && !webrtcConnections.has(connectionKey)) {
        await initiateWebRTCConnection(fromPeerId, targetPeerId, fromPeerId);
    }

    // Notify main thread to handle offer
    broadcastToClients('webrtc_offer_received', {
        fromPeerId: fromPeerId,
        targetPeerId: targetPeerId,
        offer: offer
    });
}

async function handleWebRTCAnswer(fromPeerId, targetPeerId, answer) {
    console.log('🔧 SW: Received WebRTC answer from:', fromPeerId, 'for:', targetPeerId);

    if (!targetPeerId) {
        console.warn('🔧 SW: Answer missing target peer');
        return;
    }

    // Store the answer
    await storeWebRTCSignal(fromPeerId, targetPeerId, 'answer', answer);

    // Notify main thread to handle answer
    broadcastToClients('webrtc_answer_received', {
        fromPeerId: fromPeerId,
        targetPeerId: targetPeerId,
        answer: answer
    });
}

// Peer-to-Peer Message Routing
async function routeP2PMessage(targetPeerId, messageType, messageData) {
    console.log('🔧 SW: Routing P2P message to:', targetPeerId, 'type:', messageType);
    
    const message = {
        id: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        targetPeerId: targetPeerId,
        messageType: messageType,
        messageData: messageData,
        timestamp: Date.now(),
        fromServiceWorker: true
    };
    
    // Try to send via WebRTC if connected
    const connectionState = connectionStates.get(targetPeerId);
    if (connectionState && connectionState.state === 'connected') {
        // Notify main thread to send via WebRTC data channel
        broadcastToClients('send_webrtc_message', {
            targetPeerId: targetPeerId,
            message: message
        });
    } else {
        // Store for later delivery when connection is established
        await storeData('prayers', message);
        console.log('🔧 SW: Stored message for later delivery to:', targetPeerId);
    }
    
    return message;
}

// Network Discovery and Announcement
async function announceToNetwork(nodeData) {
    const peerId = nodeData.id || nodeData.nodeId;
    console.log('🔧 SW: Announcing to P2P network:', peerId);

    // Store our own peer data
    if (!peerId) {
        console.warn('🔧 SW: Cannot announce peer without identifier');
        return;
    }

    const normalizedNode = {
        ...nodeData,
        id: peerId,
        nodeId: nodeData.nodeId || peerId,
        timestamp: nodeData.timestamp || Date.now()
    };

    await storeData('peers', normalizedNode);
    peers.set(peerId, normalizedNode);

    // Broadcast to all connected clients
    broadcastToClients('peer_announcement', normalizedNode);

    // Try to connect to recently discovered peers
    const recentPeers = await getAllData('peers', 10);
    for (const peer of recentPeers) {
        if (peer.id !== nodeData.id && 
            !connectionStates.has(peer.id) && 
            Date.now() - peer.timestamp < 5 * 60 * 1000) { // 5 minutes
            
            // Initiate WebRTC connection
            setTimeout(() => {
                initiateWebRTCConnection(normalizedNode.nodeId, peer.id, normalizedNode.nodeId);
            }, Math.random() * 3000); // Random delay to prevent thundering herd
        }
    }
}

// Network Mesh Topology Management
async function optimizeNetworkTopology() {
    console.log('🔧 SW: Optimizing network topology...');
    
    const allPeers = await getAllData('peers', 50);
    const activePeers = allPeers.filter(peer => 
        Date.now() - peer.lastSeen < 2 * 60 * 1000 // 2 minutes
    );
    
    console.log('🔧 SW: Found', activePeers.length, 'active peers');
    
    // Calculate optimal connections (aim for 3-6 connections per node)
    const optimalConnections = Math.min(6, Math.max(3, Math.floor(Math.sqrt(activePeers.length))));
    
    const currentConnections = Array.from(connectionStates.values()).filter(conn => 
        conn.state === 'connected'
    );
    
    if (currentConnections.length < optimalConnections) {
        // Need more connections
        const unconnectedPeers = activePeers.filter(peer => 
            !connectionStates.has(peer.id)
        );
        
        const connectionsNeeded = optimalConnections - currentConnections.length;
        const peersToConnect = unconnectedPeers.slice(0, connectionsNeeded);
        
        for (const peer of peersToConnect) {
            const partner = activePeers.find(p => p.id !== peer.id);
            if (!partner) {
                continue;
            }

            console.log('🔧 SW: Initiating connection to optimize topology:', peer.id, '↔', partner.id);
            await initiateWebRTCConnection(partner.id, peer.id, partner.id);
        }
    }
}

// Delete old data to manage storage
async function cleanupOldData() {
    try {
        const maxAge = 7 * 24 * 60 * 60 * 1000; // 7 days
        const signalMaxAge = 60 * 60 * 1000; // 1 hour for signals
        const now = Date.now();
        
        // Clean up old prayers
        const oldPrayers = await getAllData('prayers', 1000);
        if (oldPrayers.length > 0) {
            const transaction = db.transaction(['prayers'], 'readwrite');
            const store = transaction.objectStore('prayers');
            
            oldPrayers.forEach(item => {
                if (item.timestamp && (now - item.timestamp) > maxAge) {
                    store.delete(item.id);
                }
            });
        }
        
        // Clean up old WebRTC signals
        const oldSignals = await getAllData('webrtc_signals', 1000);
        if (oldSignals.length > 0) {
            const transaction = db.transaction(['webrtc_signals'], 'readwrite');
            const store = transaction.objectStore('webrtc_signals');
            
            oldSignals.forEach(signal => {
                if (signal.timestamp && (now - signal.timestamp) > signalMaxAge) {
                    store.delete(signal.id);
                }
            });
        }
        
        // Clean up old ICE candidates
        const oldCandidates = await getAllData('ice_candidates', 1000);
        if (oldCandidates.length > 0) {
            const transaction = db.transaction(['ice_candidates'], 'readwrite');
            const store = transaction.objectStore('ice_candidates');
            
            oldCandidates.forEach(candidate => {
                if (candidate.timestamp && (now - candidate.timestamp) > signalMaxAge) {
                    store.delete(candidate.id);
                }
            });
        }
        
        // Clean up inactive peers
        for (const [peerId, peer] of peers.entries()) {
            if (now - (peer.lastSeen || 0) > maxAge) {
                peers.delete(peerId);
                connectionStates.delete(peerId);
                for (const key of Array.from(webrtcConnections.keys())) {
                    if (key && key.includes(peerId)) {
                        webrtcConnections.delete(key);
                    }
                }
            }
        }
        
        console.log('🔧 SW: Completed enhanced WebRTC data cleanup');
    } catch (error) {
        console.error('🔧 SW: Error during data cleanup:', error);
    }
}

// Background sync for peer discovery
self.addEventListener('sync', event => {
    console.log('🔧 SW: Sync event:', event.tag);
    
    if (event.tag === 'peer-discovery') {
        event.waitUntil(discoverPeers());
    } else if (event.tag === 'data-cleanup') {
        event.waitUntil(cleanupOldData());
    } else if (event.tag === 'optimize-topology') {
        event.waitUntil(optimizeNetworkTopology());
    }
});

// Message handling from main thread with WebRTC support
self.addEventListener('message', async event => {
    const rawType = event.data?.type;
    const data = event.data?.data;
    const type = typeof rawType === 'string' ? rawType.toUpperCase() : rawType;
    console.log('🔧 SW: Received message:', rawType);

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
                const peerId = data?.id || data?.nodeId;
                if (!peerId) {
                    console.warn('🔧 SW: REGISTER_PEER missing peer identifier');
                    break;
                }

                const peerData = {
                    ...data,
                    id: peerId,
                    nodeId: data.nodeId || peerId,
                    lastSeen: Date.now(),
                    connectionState: 'discovering'
                };

                peers.set(peerId, peerData);
                await storeData('peers', peerData);
                console.log('🔧 SW: Peer registered:', peerId);

                // Announce to network and try to establish connections
                await announceToNetwork(peerData);
                break;
                
            case 'WEBRTC_OFFER':
                await handleWebRTCOffer(data.fromPeerId, data.targetPeerId, data.offer);
                break;

            case 'WEBRTC_ANSWER':
                await handleWebRTCAnswer(data.fromPeerId, data.targetPeerId, data.answer);
                break;

            case 'WEBRTC_ICE_CANDIDATE':
                await storeICECandidate(data.fromPeerId, data.targetPeerId, data.candidate);
                break;

            case 'WEBRTC_CONNECTION_STATE':
                await updateConnectionState(data.peerId, data.state, data.metadata);
                break;
                
            case 'SEND_P2P_MESSAGE':
                await routeP2PMessage(data.targetPeerId, data.messageType, data.messageData);
                break;
                
            case 'INITIATE_WEBRTC_CONNECTION':
                await initiateWebRTCConnection(data.sourcePeerId, data.targetPeerId, data.initiatorPeerId || data.sourcePeerId);
                break;
                
            case 'GET_NETWORK_STATUS':
                if (event.ports && event.ports[0]) {
                    const activeConnections = Array.from(connectionStates.values()).filter(
                        conn => conn.state === 'connected'
                    );
                    
                    event.ports[0].postMessage({
                        peers: peers.size,
                        isOnline,
                        uptime: Date.now() - startTime,
                        dbReady: !!db,
                        webrtcConnections: activeConnections.length,
                        pendingSignals: pendingSignals.size,
                        queuedICE: Array.from(iceQueue.values()).reduce((sum, queue) => sum + queue.length, 0),
                        algorithm: 'WebRTC P2P Mesh v1.0'
                    });
                }
                break;
                
            case 'GET_WEBRTC_SIGNALS':
                const signals = await getAllData('webrtc_signals', data.limit || 50);
                if (event.ports && event.ports[0]) {
                    event.ports[0].postMessage({
                        type: 'WEBRTC_SIGNALS_DATA',
                        signals: signals.filter(s => !s.processed)
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

            case 'GET_ANNOUNCEMENTS':
                const announcements = await getAllData('peers', data?.limit || 20);
                if (event.ports && event.ports[0]) {
                    const response = announcements.map(peer => ({
                        nodeId: peer.nodeId || peer.id,
                        timestamp: peer.timestamp || peer.lastSeen,
                        vector: peer.vector || [],
                        features: peer.features || []
                    })).filter(item => item.nodeId);

                    event.ports[0].postMessage({
                        type: 'ANNOUNCEMENTS_DATA',
                        announcements: response
                    });
                }
                break;

            case 'CLEANUP':
                await cleanupOldData();
                break;
                
            case 'OPTIMIZE_TOPOLOGY':
                await optimizeNetworkTopology();
                break;
                
            default:
                console.log('🔧 SW: Unknown message type:', type);
        }
    } catch (error) {
        console.error('🔧 SW: Error handling message:', error);
    }
});

// Broadcast to connected peers via WebRTC (simulation for now)
function broadcastToPeers(type, data) {
    const activeConnections = Array.from(connectionStates.values()).filter(
        conn => conn.state === 'connected'
    );

    console.log(`🔧 SW: Broadcasting ${type} to ${activeConnections.length} WebRTC peers:`, data.id || data);

    // Route via WebRTC connections
    for (const connection of activeConnections) {
        routeP2PMessage(connection.peerId, type, data);
    }
}

// Enhanced cross-tab broadcasting with WebRTC coordination
function broadcastToClients(type, data) {
    self.clients.matchAll({ includeUncontrolled: true }).then(clients => {
        clients.forEach(client => {
            try {
                client.postMessage({
                    type: type,
                    data: data,
                    timestamp: Date.now(),
                    via: 'webrtc-service-worker'
                });
            } catch (e) {
                console.warn('🔧 SW: Client broadcast failed:', e);
            }
        });
    });
}

// Periodic peer discovery and maintenance with WebRTC support
async function discoverPeers() {
    try {
        console.log('🔧 SW: WebRTC peer discovery cycle...');
        
        // Clean up old peers (older than 10 minutes)
        const now = Date.now();
        const maxPeerAge = 10 * 60 * 1000; // 10 minutes
        
        const currentPeers = Array.from(peers.entries());
        currentPeers.forEach(([peerId, peerData]) => {
            if (now - (peerData.lastSeen || 0) > maxPeerAge) {
                peers.delete(peerId);
                connectionStates.delete(peerId);
                for (const key of Array.from(webrtcConnections.keys())) {
                    if (key && key.includes(peerId)) {
                        webrtcConnections.delete(key);
                    }
                }
                console.log('🔧 SW: Removed stale peer:', peerId);
            }
        });
        
        // Update online status using internal state only
        isOnline = peers.size > 0 || connectionStates.size > 0;
        
        // Schedule topology optimization
        if (Math.random() < 0.2) { // 20% chance each discovery cycle
            await optimizeNetworkTopology();
        }
        
        // Schedule data cleanup periodically
        if (Math.random() < 0.1) { // 10% chance each discovery cycle
            await cleanupOldData();
        }
        
        console.log(`🔧 SW: WebRTC discovery complete. Active peers: ${peers.size}, Connections: ${connectionStates.size}`);
    } catch (error) {
        console.error('🔧 SW: Error during WebRTC peer discovery:', error);
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
