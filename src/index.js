// Needs: npm install ws
const WebSocket = require('ws');
const { createServer } = require('http'); // Needed if differentiating by path later
const crypto = require('crypto'); // For more robust client IDs
const fs = require('fs');
const path = require('path');
const http = require('http');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const PORT = 8080; // Define port

// --- Data Storage ---
// Map<serial, { ws: WebSocket, info: object, status: object, online: boolean, lastSeen: number }>
const deviceClients = new Map();
// Store connections for Admin UIs
// Set<WebSocket>
const adminClients = new Set();

// --- Helper Functions ---

// Generate a more unique ID than just timestamp
function generateClientId() {
  return Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
}

// Broadcast a message to all connected Admin UIs
function broadcastToAdmins(message) {
  const messageString = JSON.stringify(message);
  adminClients.forEach(adminWs => {
    if (adminWs.readyState === WebSocket.OPEN) {
      try {
        adminWs.send(messageString);
      } catch (err) {
        console.error("Failed to send message to admin client:", err);
      }
    }
  });
}

// Send a message to a specific Auto.js device client
function sendToDevice(clientId, message) {
  const client = deviceClients.get(clientId);
  if (client && client.ws && client.online) {
    try {
      client.ws.send(JSON.stringify(message));
      return true;
    } catch (err) {
      console.error(`Failed to send message to device ${clientId}:`, err);
      return false;
    }
  } else {
    console.warn(`Device ${clientId} not found or connection not open.`);
    return false;
  }
}

// Prepare the list of devices for the admin UI
function getInitialClientListPayload() {
  const clientList = [];
  deviceClients.forEach((clientData, clientId) => {
    clientList.push({
      clientId: clientId,
      online: clientData.online,
      lastSeen: clientData.lastSeen,
      ...(clientData.info || {}),
      ...(clientData.status || {}),
      device: { ...((clientData.info && clientData.info.device) || {}), serial: clientId }
    });
  });
  return { type: 'initial_client_list', payload: { clients: clientList } };
}

// --- WebSocket Server Setup ---

// 创建 HTTP 服务器，提供静态文件服务
const server = http.createServer((req, res) => {
  let filePath = req.url;
  if (filePath === '/' || filePath === '/index.html') {
    filePath = path.join(__dirname, 'index.html');
  } else {
    // 只允许访问 server 目录下的静态资源
    filePath = path.join(__dirname, filePath);
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 Not Found');
    } else {
      // 简单类型判断
      let contentType = 'text/html';
      if (filePath.endsWith('.js')) contentType = 'application/javascript';
      if (filePath.endsWith('.css')) contentType = 'text/css';
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(data);
    }
  });
});

server.listen(PORT, () => {
  console.log(`HTTP server started on http://localhost:${PORT}/`);
});

// WebSocket 服务挂载到同一个 HTTP 服务器
const wss = new WebSocket.Server({ server });

console.log(`WebSocket server started on port ${PORT}`);

wss.on('connection', (ws, req) => {
  // Don't assign ID or store yet. Wait for identification.
  console.log(`Incoming connection from ${req.socket.remoteAddress}...`);

  let currentClientId = null; // Will be set for device clients
  let isIdentified = false;
  let isDeviceClient = false;
  let isAdminClient = false;

  // Timeout for identification
  const identificationTimeout = setTimeout(() => {
    if (!isIdentified) {
      console.log("Client did not identify in time. Closing connection.");
      ws.close(1008, "Identification timeout");
    }
  }, 5000); // 5 seconds to identify

  ws.on('message', (message) => {
    let data;
    try {
      data = JSON.parse(message);
    } catch (e) {
      console.error('Received invalid JSON:', message);
      ws.close(1003, "Invalid JSON format"); // 1003 = Unsupported data
      return;
    }

    if (!isIdentified) {
      // --- First Message Identification ---
      clearTimeout(identificationTimeout); // Identified, clear timeout

      if (data.type === 'info' && data.payload && data.payload.device) {
        // Identified as an Auto.js Device Client
        isDeviceClient = true;
        isIdentified = true;
        // 用 serial 作为 clientId
        const serial = data.payload.device.serial;
        let fallbackId = serial;
        if (!serial || serial === 'unknown' || serial === '') {
          // 若serial无效，尝试用brand+model+release组合
          const d = data.payload.device;
          fallbackId = [d.brand, d.model, d.release].filter(Boolean).join('-') || generateClientId();
        }
        currentClientId = fallbackId;
        let clientData = deviceClients.get(currentClientId);
        if (clientData) {
          // 已存在，更新 ws、状态
          clientData.ws = ws;
          clientData.info = data.payload;
          clientData.online = true;
          clientData.lastSeen = Date.now();
        } else {
          // 新设备
          clientData = {
            ws: ws,
            info: data.payload,
            status: {},
            online: true,
            lastSeen: Date.now(),
          };
        }
        deviceClients.set(currentClientId, clientData);
        console.log(`Device client identified: ${currentClientId} (${clientData.info?.device?.model || 'Unknown Model'})`);
        broadcastToAdmins({
          type: 'client_connected',
          payload: {
            clientId: currentClientId,
            info: { ...clientData.info, device: { ...clientData.info.device, serial: currentClientId } },
            online: true,
            lastSeen: clientData.lastSeen
          }
        });
        sendToDevice(currentClientId, { type: 'request_status' });
        upsertDevice(currentClientId, data.payload, true);

      } else if (data.type === 'admin_request_clients') {
        // Identified as an Admin UI Client
        isAdminClient = true;
        isIdentified = true;
        adminClients.add(ws);
        console.log(`Admin UI client connected from ${req.socket.remoteAddress}`);

        // Send the current list of devices to *this* admin
        try {
          ws.send(JSON.stringify(getInitialClientListPayload()));
        } catch (err) {
          console.error("Failed to send initial list to admin:", err);
        }

      } else {
        // Unknown first message type
        console.warn('Received unknown first message type:', data.type);
        ws.close(1002, "Unknown identification protocol"); // 1002 = Protocol error
      }

    } else {
      // --- Handle Subsequent Messages ---
      if (isDeviceClient && currentClientId) {
        handleDeviceMessage(currentClientId, data);
      } else if (isAdminClient) {
        handleAdminMessage(ws, data); // Pass ws for potential direct replies if needed
      }
    }
  });

  ws.on('close', (code, reason) => {
    clearTimeout(identificationTimeout); // Clear timeout if closed before identification
    console.log(`Connection closed: Code=${code}, Reason=${reason ? reason.toString() : 'N/A'}`);

    if (isDeviceClient && currentClientId && deviceClients.has(currentClientId)) {
      console.log(`Device client disconnected: ${currentClientId}`);
      let clientData = deviceClients.get(currentClientId);
      if (clientData) {
        clientData.online = false;
        clientData.ws = null;
        clientData.lastSeen = Date.now();
        deviceClients.set(currentClientId, clientData);
      }
      broadcastToAdmins({ type: 'client_disconnected', payload: { clientId: currentClientId } });
      upsertDevice(currentClientId, null, false);

    } else if (isAdminClient) {
      console.log(`Admin UI client disconnected.`);
      adminClients.delete(ws);
    }
    currentClientId = null; // Clean up reference
  });

  ws.on('error', (error) => {
    clearTimeout(identificationTimeout);
    console.error('WebSocket error:', error);
    // The 'close' event will usually follow an error, so cleanup happens there.
    // However, explicitly remove if needed, especially if 'close' doesn't fire reliably
    if (isDeviceClient && currentClientId && deviceClients.has(currentClientId)) {
      console.log(`Removing device client ${currentClientId} due to error.`);
      let clientData = deviceClients.get(currentClientId);
      if (clientData) {
        clientData.online = false;
        clientData.ws = null;
        clientData.lastSeen = Date.now();
        deviceClients.set(currentClientId, clientData);
      }
      broadcastToAdmins({ type: 'client_disconnected', payload: { clientId: currentClientId } });
      upsertDevice(currentClientId, null, false);
    } else if (isAdminClient) {
      console.log(`Removing admin client due to error.`);
      adminClients.delete(ws);
    }
    currentClientId = null; // Clean up reference
    try { ws.close(1011, "Server error"); } catch (e) { } // Attempt graceful close
  });
});

// --- Message Handling Logic ---

function handleDeviceMessage(clientId, data) {
  const clientData = deviceClients.get(clientId);
  if (!clientData) return; // Should not happen if logic is correct

  // Update last seen time
  clientData.lastSeen = Date.now();

  // console.log(`Received from ${clientId}: ${data.type}`); // Can be verbose

  switch (data.type) {
    case 'info': // Device might send updated info later
      clientData.info = { ...(clientData.info || {}), ...data.payload };
      broadcastToAdmins({ type: 'device_info', clientId: clientId, payload: clientData.info });

      // 在设备上线或收到 info 时调用
      upsertDevice(clientId, data.payload, true);

      break;
    case 'status':
      clientData.status = { ...(clientData.status || {}), ...data.payload };
      // Only broadcast necessary status updates to avoid flooding admins
      broadcastToAdmins({
        type: 'device_status',
        clientId: clientId,
        payload: { // Send only key status items or all? Choose based on need.
          battery: data.payload.battery,
          isCharging: data.payload.isCharging,
          permissions: data.payload.permissions, // Send permission status
          // Add other relevant status fields if needed
          lastSeen: clientData.lastSeen
        }
      });
      break;
    case 'log':
      // Relay log to admins, include clientId
      broadcastToAdmins({ type: 'log', clientId: clientId, payload: data.payload });
      break;
    case 'script_result':
      // Relay script result to admins
      broadcastToAdmins({ type: 'script_result', clientId: clientId, payload: data.payload });
      break;
    case 'ping':
      // Optional: Send pong back if device expects it
      // sendToDevice(clientId, { type: 'pong', timestamp: Date.now() });
      // console.log(`Ping received from ${clientId}`);
      break;
    case 'pong':
      // Server received pong (maybe in response to server's ping, if implemented)
      // console.log(`Pong received from ${clientId}`);
      break;
    default:
      console.log(`Received unhandled message type ${data.type} from device ${clientId}`);
  }
  // Update the map entry (important if info/status objects were modified)
  deviceClients.set(clientId, clientData);
}

function handleAdminMessage(adminWs, data) {
  console.log(`Received from Admin UI: ${data.type}`);

  switch (data.type) {
    case 'admin_command':
      const { script, target, clientId: singleClientId, clientIds: listClientIds } = data.payload;
      if (!script) {
        console.warn("Admin command received without script content.");
        return;
      }

      const commandPayload = { type: 'command', payload: { script: script } };
      let sentCount = 0;

      if (target === 'single' && singleClientId) {
        if (sendToDevice(singleClientId, commandPayload)) {
          sentCount = 1;
          console.log(`Sent command to single device: ${singleClientId}`);
        }
      } else if (target === 'list' && listClientIds && listClientIds.length > 0) {
        listClientIds.forEach(id => {
          if (sendToDevice(id, commandPayload)) {
            sentCount++;
          }
        });
        console.log(`Sent command to ${sentCount}/${listClientIds.length} devices from list.`);
      } else if (target === 'all') {
        deviceClients.forEach((clientData, id) => {
          if (clientData.online && sendToDevice(id, commandPayload)) {
            sentCount++;
          }
        });
        console.log(`Sent command to ${sentCount}/${deviceClients.size} online devices (broadcast).`);
      } else {
        console.warn("Admin command received with invalid target type or missing IDs:", data.payload);
      }
      // Optionally send feedback to the originating admin UI
      // adminWs.send(JSON.stringify({ type: 'command_sent_ack', payload: { target, sentCount } }));
      break;

    case 'run_script':
      if (data.payload && data.payload.clientId && data.payload.entry) {
        sendToDevice(data.payload.clientId, {
          type: 'run_script',
          payload: { entry: data.payload.entry }
        });
      }
      break;

    case 'admin_request_clients':
      // Admin might request refresh
      try {
        adminWs.send(JSON.stringify(getInitialClientListPayload()));
      } catch (err) { console.error("Failed send client list refresh to admin:", err); }
      break;

    case 'file_update':
      if (data.payload && data.payload.clientId && data.payload.filename && typeof data.payload.content === 'string') {
        sendToDevice(data.payload.clientId, {
          type: 'file_update',
          payload: {
            filename: data.payload.filename,
            content: data.payload.content
          }
        });
      }
      break;

    // Handle other admin-specific commands here if needed

    default:
      console.log(`Received unhandled message type ${data.type} from Admin UI`);
  }
}

// Optional: Periodically ping devices to check liveness
/*
setInterval(() => {
    deviceClients.forEach((clientData, clientId) => {
        if (!clientData.ws || clientData.ws.readyState !== WebSocket.OPEN) {
            // Should have been cleaned up by 'close' event, but double-check
            console.warn(`Found stale client entry for ${clientId}, cleaning up.`);
            deviceClients.delete(clientId);
            broadcastToAdmins({ type: 'client_disconnected', payload: { clientId: clientId } });
            return;
        }

        // Simple check: if lastSeen is too old, consider disconnected
        const timeout = 60 * 1000 * 2; // 2 minutes without message
        if (Date.now() - clientData.lastSeen > timeout) {
             console.log(`Device ${clientId} timed out. Closing connection.`);
             clientData.ws.close(1000, "Idle timeout"); // Triggers the 'close' handler for cleanup
        } else {
             // Optional: Send actual WebSocket ping frame
             // clientData.ws.ping((err) => {
             //     if (err) console.error(`Ping failed for ${clientId}:`, err);
             // });
        }
    });
}, 60 * 1000); // Check every minute
*/

// 在设备上线或收到 info 时调用
async function upsertDevice(clientId, info, online) {
  await prisma.device.upsert({
    where: { clientId },
    update: {
      ...info?.device,
      appName: info?.appName,
      appVersion: info?.appVersion,
      lastSeen: new Date(),
      online,
    },
    create: {
      clientId,
      ...info?.device,
      appName: info?.appName,
      appVersion: info?.appVersion,
      lastSeen: new Date(),
      online,
    }
  });
}

console.log("Server setup complete. Waiting for connections...");