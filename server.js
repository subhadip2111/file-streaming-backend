// backend/server.js
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const rooms = {}; // { roomId: { sender: WebSocket, receiver: WebSocket } }

app.use(express.static(path.join(__dirname, './frontend')));

wss.on('connection', ws => {
    console.log('WebSocket client connected');

    ws.on('message', (message, isBinary) => {
        // If message is binary, relay to receiver if sender
        if (isBinary) {
            // Find the room and relay to receiver
            for (const roomId in rooms) {
                if (rooms[roomId].sender === ws && rooms[roomId].receiver && rooms[roomId].receiver.readyState === WebSocket.OPEN) {
                    rooms[roomId].receiver.send(message, { binary: true });
                    return;
                }
            }
            return;
        }

        // Only parse as JSON if not binary!
        let data;
        try {
            data = JSON.parse(message);
        } catch (e) {
            ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON message.' }));
            return;
        }

        const { type, roomId, role } = data;

        if (!roomId && type !== 'generate_room_id') {
            ws.send(JSON.stringify({ type: 'error', message: 'Room ID is required.' }));
            return;
        }

        if (type === 'join') {
            if (!rooms[roomId]) rooms[roomId] = {};

            if (role === 'receiver') {
                if (rooms[roomId].receiver) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Room already has a receiver.' }));
                    return;
                }
                rooms[roomId].receiver = ws;
                console.log(`Receiver joined room: ${roomId}`);
                ws.send(JSON.stringify({ type: 'status', message: `Joined room ${roomId} as receiver. Waiting for sender...` }));
                if (rooms[roomId].sender) {
                    rooms[roomId].sender.send(JSON.stringify({ type: 'room_ready', message: 'Receiver connected.' }));
                }
            } else if (role === 'sender') {
                if (rooms[roomId].sender) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Room already has a sender.' }));
                    return;
                }
                rooms[roomId].sender = ws;
                console.log(`Sender joined room: ${roomId}`);
                ws.send(JSON.stringify({ type: 'status', message: `Joined room ${roomId} as sender.` }));
                if (rooms[roomId].receiver) {
                    rooms[roomId].receiver.send(JSON.stringify({ type: 'status', message: 'Sender connected. Ready to receive files.' }));
                    rooms[roomId].sender.send(JSON.stringify({ type: 'room_ready', message: 'Receiver connected.' }));
                } else {
                    ws.send(JSON.stringify({ type: 'status', message: 'Waiting for receiver to connect...' }));
                }
            } else {
                ws.send(JSON.stringify({ type: 'error', message: 'Invalid role specified. Must be "sender" or "receiver".' }));
            }
        }
        // Relay file control messages from sender to receiver
        else if (
            type === 'file_start' ||
            type === 'file_end' ||
            type === 'folder_complete'
        ) {
            // Only relay if sender is sending and receiver is present
            if (
                rooms[roomId] &&
                rooms[roomId].sender === ws &&
                rooms[roomId].receiver &&
                rooms[roomId].receiver.readyState === WebSocket.OPEN
            ) {
                rooms[roomId].receiver.send(JSON.stringify(data));
            }
        }
        // Optionally, relay errors/status from receiver to sender if needed
    });

    ws.on('close', () => {
        console.log('WebSocket client disconnected');
        for (const roomId in rooms) {
            if (rooms[roomId].sender === ws) {
                console.log(`Sender disconnected from room: ${roomId}`);
                if (rooms[roomId].receiver) {
                    rooms[roomId].receiver.send(JSON.stringify({ type: 'error', message: 'Sender disconnected. Stream interrupted.' }));
                }
                delete rooms[roomId].sender;
                if (!rooms[roomId].receiver) delete rooms[roomId];
                break;
            } else if (rooms[roomId].receiver === ws) {
                console.log(`Receiver disconnected from room: ${roomId}`);
                if (rooms[roomId].sender) {
                    rooms[roomId].sender.send(JSON.stringify({ type: 'error', message: 'Receiver disconnected. Stream interrupted.' }));
                }
                delete rooms[roomId].receiver;
                if (!rooms[roomId].sender) delete rooms[roomId];
                break;
            }
        }
    });

    ws.on('error', error => {
        console.error('WebSocket error:', error);
    });
});

// Generate a new room ID
app.get('/generate-room-id', (req, res) => {
    const newRoomId = uuidv4().substring(0, 8);
    res.json({ roomId: newRoomId });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`WebSocket server running on ws://localhost:${PORT}`);
});

