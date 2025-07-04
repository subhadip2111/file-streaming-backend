// backend/server.js
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const Busboy = require('busboy');
const path = require('path');
const { v4: uuidv4 } = require('uuid'); // For generating unique room IDs

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Store active rooms and their participants
// Each room can have one sender and one receiver
const rooms = {}; // { roomId: { sender: WebSocket, receiver: WebSocket } }

// Serve static frontend files
// This will serve index.html, sender.html, and receiver.html
app.use(express.static(path.join(__dirname, './frontend')));

// WebSocket connection handling
wss.on('connection', ws => {
    console.log('WebSocket client connected');

    ws.on('message', message => {
        try {
            const data = JSON.parse(message);
            const { type, roomId, role } = data;

            if (!roomId) {
                ws.send(JSON.stringify({ type: 'error', message: 'Room ID is required.' }));
                return;
            }

            if (type === 'join') {
                if (!rooms[roomId]) {
                    rooms[roomId] = {};
                }

                if (role === 'receiver') {
                    if (rooms[roomId].receiver) {
                        ws.send(JSON.stringify({ type: 'error', message: 'Room already has a receiver.' }));
                        return;
                    }
                    rooms[roomId].receiver = ws;
                    console.log(`Receiver joined room: ${roomId}`);
                    ws.send(JSON.stringify({ type: 'status', message: `Joined room ${roomId} as receiver. Waiting for sender...` }));
                    // Notify sender if already connected
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
                    // Notify sender if receiver is ready
                    if (rooms[roomId].receiver) {
                        rooms[roomId].receiver.send(JSON.stringify({ type: 'status', message: 'Sender connected. Ready to receive files.' }));
                        rooms[roomId].sender.send(JSON.stringify({ type: 'room_ready', message: 'Receiver connected.' })); // Notify sender again for clarity
                    } else {
                        ws.send(JSON.stringify({ type: 'status', message: 'Waiting for receiver to connect...' }));
                    }
                } else {
                    ws.send(JSON.stringify({ type: 'error', message: 'Invalid role specified. Must be "sender" or "receiver".' }));
                }
            } else {
                ws.send(JSON.stringify({ type: 'error', message: 'Unknown WebSocket message type.' }));
            }
        } catch (e) {
            console.error('Failed to parse WebSocket message:', e);
            ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON message.' }));
        }
    });

    ws.on('close', () => {
        console.log('WebSocket client disconnected');
        // Clean up room when a participant disconnects
        for (const roomId in rooms) {
            if (rooms[roomId].sender === ws) {
                console.log(`Sender disconnected from room: ${roomId}`);
                if (rooms[roomId].receiver) {
                    rooms[roomId].receiver.send(JSON.stringify({ type: 'error', message: 'Sender disconnected. Stream interrupted.' }));
                }
                delete rooms[roomId].sender;
                if (!rooms[roomId].receiver) { // If no one left, delete room
                    delete rooms[roomId];
                }
                break;
            } else if (rooms[roomId].receiver === ws) {
                console.log(`Receiver disconnected from room: ${roomId}`);
                if (rooms[roomId].sender) {
                    rooms[roomId].sender.send(JSON.stringify({ type: 'error', message: 'Receiver disconnected. Stream interrupted.' }));
                }
                delete rooms[roomId].receiver;
                if (!rooms[roomId].sender) { // If no one left, delete room
                    delete rooms[roomId];
                }
                break;
            }
        }
    });

    ws.on('error', error => {
        console.error('WebSocket error:', error);
    });
});

// File upload endpoint using Busboy
app.post('/upload/:roomId', (req, res) => {
    const roomId = req.params.roomId;
    const room = rooms[roomId];

    // Check if the room exists and has both an active sender and an active receiver
    if (!room || !room.sender || room.sender.readyState !== WebSocket.OPEN || !room.receiver || room.receiver.readyState !== WebSocket.OPEN) {
        console.log(`Upload attempt for room ${roomId} failed: sender or receiver not active.`);
        let errorMessage = 'Streaming not possible. ';
        if (!room) {
            errorMessage += 'Room does not exist.';
        } else {
            if (!room.sender || room.sender.readyState !== WebSocket.OPEN) {
                errorMessage += 'Sender not connected or not active in this room.';
            }
            if (!room.receiver || room.receiver.readyState !== WebSocket.OPEN) {
                errorMessage += 'Receiver not connected or not active in this room.';
            }
        }
        return res.status(400).send(errorMessage);
    }

    const receiverWs = room.receiver;

    const busboy = Busboy({ headers: req.headers });
    let fileCount = 0;
    let totalBytesStreamed = 0;

    busboy.on('file', (fieldname, file, filename, encoding, mimetype) => {
        fileCount++;
        const relativePath = fieldname; // Assuming fieldname contains webkitRelativePath from frontend
        const originalFilename = filename.filename; // Busboy v1.x uses filename.filename for original name

        console.log(`Streaming file: ${originalFilename} (Path: ${relativePath}) in room ${roomId}`);

        // Notify receiver about the start of a new file
        if (receiverWs.readyState === WebSocket.OPEN) {
            receiverWs.send(JSON.stringify({
                type: 'file_start',
                filename: originalFilename,
                relativePath: relativePath,
                mimetype: mimetype
            }));
        } else {
            console.warn(`Receiver disconnected before starting file ${originalFilename}. Aborting stream.`);
            file.resume(); // Consume the rest of the stream to prevent process hanging
            busboy.emit('error', new Error('Receiver disconnected before file stream started.'));
            return; // Stop processing this file
        }


        file.on('data', data => {
            // Stream file data chunks directly to the receiver's WebSocket
            if (receiverWs.readyState === WebSocket.OPEN) {
                receiverWs.send(data, { binary: true });
                totalBytesStreamed += data.length;
            } else {
                console.warn(`Receiver disconnected while streaming file ${originalFilename}. Aborting stream.`);
                file.resume(); // Consume the rest of the stream to prevent process hanging
                busboy.emit('error', new Error('Receiver disconnected during file stream.'));
            }
        });

        file.on('end', () => {
            console.log(`Finished streaming file: ${originalFilename} in room ${roomId}`);
            // Notify receiver about the end of the current file
            if (receiverWs.readyState === WebSocket.OPEN) {
                receiverWs.send(JSON.stringify({
                    type: 'file_end',
                    filename: originalFilename,
                    relativePath: relativePath
                }));
            }
        });

        file.on('error', err => {
            console.error(`Error streaming file ${originalFilename}:`, err);
            if (receiverWs.readyState === WebSocket.OPEN) {
                receiverWs.send(JSON.stringify({ type: 'error', message: `Error streaming file ${originalFilename}: ${err.message}` }));
            }
        });
    });

    busboy.on('finish', () => {
        console.log(`All files processed for room ${roomId}. Total files: ${fileCount}, Total bytes: ${totalBytesStreamed}`);
        if (receiverWs && receiverWs.readyState === WebSocket.OPEN) {
            receiverWs.send(JSON.stringify({ type: 'folder_complete', message: `All ${fileCount} files streamed successfully.` }));
        }
        res.status(200).send('Files upload process initiated.');
    });

    busboy.on('error', err => {
        console.error('Busboy error:', err);
        res.status(500).send(`File upload failed: ${err.message}`);
        if (receiverWs && receiverWs.readyState === WebSocket.OPEN) {
            receiverWs.send(JSON.stringify({ type: 'error', message: `Server error during upload: ${err.message}` }));
        }
    });

    req.pipe(busboy);
});

// Generate a new room ID
app.get('/generate-room-id', (req, res) => {
    const newRoomId = uuidv4().substring(0, 8); // Shorten for readability
    res.json({ roomId: newRoomId });
});

const PORT = process.env.PORT || 7070;
server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`WebSocket server running on ws://localhost:${PORT}`);
    console.log(`Ensure this server is accessible from your frontend at http://${server.address().address}:${server.address().port}`);
});

