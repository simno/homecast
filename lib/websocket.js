const WebSocket = require('ws');

let wss = null;

function createWebSocketServer(server) {
    wss = new WebSocket.Server({ server });
    return wss;
}

function broadcast(msg) {
    if (!wss) return;
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(msg));
    });
}

function getWss() {
    return wss;
}

module.exports = { createWebSocketServer, broadcast, getWss };
