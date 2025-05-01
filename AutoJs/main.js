"ui";

const websocket = require('./websocket.js')

// --- Configuration & State ---
const CONFIG_STORAGE_NAME = "remote_control_config";
const configStorage = storages.create(CONFIG_STORAGE_NAME);
let config = {
  serverHost: configStorage.get("serverHost", "ws://10.0.0.82:8080") // Default host
};

let wsClient = null;
let isServiceRunning = false; // Tracks if the main logic (like WS) should be active
let keepAliveIntervalId = null;
let statusUpdateIntervalId = null;

// --- UI Definition ---
ui.layout(
  <vertical padding="16">
    <text textSize="18sp" textColor="#1E88E5" marginBottom="10">通用控制端配置</text>

    <vertical>
      <text>服务端 Host (e.g., ws://192.168.1.100:8080)</text>
      <input id="serverHostInput" hint="WebSocket server address" />
      <button id="saveConfigBtn" text="保存配置" style="Widget.AppCompat.Button.Colored" />
    </vertical>

    <text textSize="16sp" textColor="#1E88E5" marginTop="15" marginBottom="5">权限状态 - 设置</text>
    <vertical>
      {buildPermissionLine("无障碍服务:", "accessibilityStatus", "goToAccessibilitySettings")}
      {buildPermissionLine("截图权限:", "captureStatus", "requestCapturePermission")}
      {buildPermissionLine("悬浮窗权限:", "overlayStatus", "goToOverlaySettings")}
      {buildPermissionLine("忽略电池优化:", "batteryOptimizationStatus", "requestIgnoreBattery")}
    </vertical>

    <text textSize="16sp" textColor="#1E88E5" marginTop="15" marginBottom="5">服务控制 - 状态</text>
    <vertical>
      <horizontal gravity="center_vertical">
        <text>WebSocket 状态:</text>
        <text id="wsStatus" text="未连接" textColor="#FF5722" marginLeft="10" />
      </horizontal>
      <button id="startStopBtn" text="启动服务" marginTop="10" style="Widget.AppCompat.Button.Colored" />
      <button id="refreshStatusBtn" text="刷新权限状态" marginTop="5" />
    </vertical>

    <text textSize="16sp" textColor="#1E88E5" marginTop="15" marginBottom="5">日志输出</text>
    <ScrollView h="200" borderWidth="1dp" borderColor="#E0E0E0">
      <text id="logText" textColor="#666666" padding="5" />
    </ScrollView>

  </vertical>
);

// Helper function to build permission rows in UI XML
function buildPermissionLine(label, statusId, buttonId) {
  return (
    <horizontal marginTop="5" gravity="center_vertical">
      <text text={label} layout_weight="1" />
      <text id={statusId} text="未知" textColor="#FFAB00" marginRight="10" />
      <button id={buttonId} text="设置/请求" style="Widget.AppCompat.Button.Small" padding="5dp 10dp" />
    </horizontal>
  );
}


// --- UI Event Listeners ---

ui.emitter.on("create", () => {
  // Load initial config into UI input
  ui.serverHostInput.setText(config.serverHost);
  // Initial status check
  refreshAllStatus();
  logToUI("界面已加载，请配置并启动服务。");
});

ui.saveConfigBtn.on("click", () => {
  const newHost = ui.serverHostInput.getText().toString().trim();
  if (newHost) {
    config.serverHost = newHost;
    configStorage.put("serverHost", newHost);
    toastLog("配置已保存: " + newHost);
    logToUI("配置已保存: " + newHost);
    // If service is running, maybe prompt to restart or just update the config for next start
    if (isServiceRunning) {
      logToUI("注意：服务正在运行，新配置将在下次启动时生效或需要手动重启服务。");
    }
  } else {
    toast("请输入有效的服务器地址");
  }
});

ui.startStopBtn.on("click", () => {
  if (!isServiceRunning) {
    startService();
  } else {
    stopService();
  }
});

ui.refreshStatusBtn.on("click", () => {
  toast("正在刷新权限状态...");
  refreshAllStatus();
});

// --- Permission Button Handlers ---

ui.goToAccessibilitySettings.on("click", () => {
  logToUI("正在尝试打开无障碍设置...");
  try {
    app.startActivity({
      action: "android.settings.ACCESSIBILITY_SETTINGS"
    });
    toast("请手动开启或关闭对应服务的无障碍权限");
  } catch (error) {
    logToUI("打开无障碍设置失败: " + error);
    toast("无法打开无障碍设置");
  }
  // Re-check status after a short delay
  setTimeout(checkAccessibilityStatus, 3000);
});

ui.requestCapturePermission.on("click", () => {
  logToUI("正在请求截图权限...");
  threads.start(function () {
    let granted = requestScreenCapture(true); // Request landscape if needed, true for sync request
    ui.run(() => {
      if (granted) {
        logToUI("截图权限已授予。");
        toastLog("截图权限已授予");
        // Release the capture immediately if just checking/requesting
        // if (capture) capture.recycle(); // Be careful with this if you need it later
      } else {
        logToUI("截图权限请求被拒绝或失败。");
        toast("截图权限请求被拒绝");
      }
      checkCaptureStatus(); // Update UI
    });
  });
});

ui.goToOverlaySettings.on("click", () => {
  logToUI("正在尝试打开悬浮窗权限设置...");
  try {
    // Standard intent, might not work on all devices/Android versions
    app.startActivity({
      action: "android.settings.action.MANAGE_OVERLAY_PERMISSION",
      packageName: context.getPackageName() // Try to target our app specifically
    });
    toast("请手动开启或关闭本应用的悬浮窗权限");
  } catch (error) {
    logToUI("打开悬浮窗权限设置失败 (尝试通用设置): " + error);
    try {
      // Fallback to general settings
      app.startActivity({
        action: "android.settings.SETTINGS"
      });
      toast("无法直接跳转，请在设置中查找 '显示在其他应用上层' 或类似选项，并设置本应用权限");
    } catch (e) {
      logToUI("打开设置失败: " + e);
      toast("无法打开系统设置");
    }
  }
  // Re-check status after a short delay
  setTimeout(checkOverlayStatus, 3000);
});

ui.requestIgnoreBattery.on("click", () => {
  logToUI("正在请求 '忽略电池优化'...");
  try {
    // Requires API 23 (Android 6.0)
    if (device.sdkInt >= 23) {
      importPackage(android.content);
      importPackage(android.provider);
      importClass(android.net.Uri);
      let intent = new Intent();
      intent.setAction(android.provider.Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
      intent.setData(Uri.parse("package:" + context.getPackageName()));
      intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK); // Important when starting from non-activity context
      context.startActivity(intent);
      toast("请在弹出的窗口或设置中允许忽略电池优化");
    } else {
      logToUI("此功能需要 Android 6.0 或更高版本。");
      toast("此功能需要 Android 6.0 或更高版本");
    }
  } catch (error) {
    logToUI("请求忽略电池优化失败: " + error);
    toast("请求忽略电池优化失败");
  }
  // Re-check status after a short delay
  setTimeout(checkBatteryOptimizationStatus, 3000);
});


// --- Core Service Logic ---

function startService() {
  if (isServiceRunning) {
    logToUI("服务已在运行中。");
    return;
  }
  logToUI("正在启动服务...");
  isServiceRunning = true;
  ui.run(() => {
    ui.startStopBtn.setText("停止服务");
  });

  // Check essential permissions first
  if (!auto.service) {
    logToUI("错误：无障碍服务未启动，部分功能可能受限。请先开启无障碍。");
    // Decide if you want to stop starting if accessibility isn't running
    // stopService(); // Uncomment this to enforce accessibility
    // return;
  }
  if (!floaty.checkPermission()) {
    logToUI("警告：悬浮窗权限未开启，悬浮窗相关功能将不可用。");
    // Decide if you want to stop starting if overlay isn't running
    // stopService();
    // return;
  }

  connectWebSocket();

  // Start periodic status updates (optional, adjust interval as needed)
  if (statusUpdateIntervalId) clearInterval(statusUpdateIntervalId);
  statusUpdateIntervalId = setInterval(() => {
    sendDeviceStatus();
  }, 60 * 1000); // Send status every 60 seconds

  logToUI("服务已启动。");
}

function stopService() {
  if (!isServiceRunning) {
    logToUI("服务未运行。");
    return;
  }
  logToUI("正在停止服务...");
  isServiceRunning = false;

  if (wsClient) {
    try {
      wsClient.close(1000, "Client stopped"); // Normal closure
    } catch (e) {
      logToUI("关闭 WebSocket 时出错: " + e);
    }
    wsClient = null; // Clear the reference
  }

  if (keepAliveIntervalId) {
    clearInterval(keepAliveIntervalId);
    keepAliveIntervalId = null;
  }
  if (statusUpdateIntervalId) {
    clearInterval(statusUpdateIntervalId);
    statusUpdateIntervalId = null;
  }

  ui.run(() => {
    ui.startStopBtn.setText("启动服务");
    updateWsStatus("未连接", "#FF5722"); // Orange/Red
  });
  logToUI("服务已停止。");
}

// --- WebSocket Logic ---

function connectWebSocket() {
  if (wsClient && wsClient.isOpen()) {
    logToUI("WebSocket 已连接。");
    return;
  }

  const wsHost = config.serverHost;
  if (!wsHost || (!wsHost.startsWith("ws://") && !wsHost.startsWith("wss://"))) {
    logToUI(`无效的服务端地址: ${wsHost}。请在配置中设置正确的地址 (ws:// or wss://)。`);
    updateWsStatus("配置错误", "#D32F2F"); // Red
    // Stop the service if WS config is bad
    stopService();
    return;
  }

  logToUI(`尝试连接到: ${wsHost}`);
  updateWsStatus("连接中...", "#FFAB00"); // Orange

  try {
    // Run WebSocket connection in a separate thread
    threads.start(function () {
      websocket.newWebSocket(wsHost, {
        // Optional: Add headers or timeouts if needed
        // headers: { 'User-Agent': 'AutoJS-Client' },
        // timeout: 10000, // Connection/Read/Write timeout in ms (10 seconds)
        timeout: 5000, // Connection timeout in ms
        pingInterval: 30000 // Send pings every 30 seconds
      }, function (ws) {
        // --- WebSocket Event Handlers (executed in WS thread) ---
        wsClient = ws; // Assign to global scope variable
        ws.on("open", (res) => {
          ui.run(() => {
            logToUI("WebSocket 已连接到 " + wsHost);
            updateWsStatus("已连接", "#4CAF50");
          });
          // 直接用 ws.send 发送注册消息，确保一定发出
          const regMsg = JSON.stringify({
            type: "info",
            payload: {
              device: {
                brand: device.brand,
                model: device.model,
                sdkInt: device.sdkInt,
                release: device.release,
                serial: device.serial,
              },
              appName: app.getAppName(context.getPackageName()),
              appVersion: app.versionName,
              timestamp: new Date().toISOString()
            }
          });
          ws.send(regMsg);
          logToUI("设备注册信息已发送(直接ws.send)");
          wsClient = ws; // 之后再赋值全局变量
          startKeepAlive();
        });

        ws.on("message", (text) => {
          ui.run(() => logToUI("收到消息: " + text));
          handleServerMessage(text); // Process message
        });

        ws.on("failure", (err, res) => {
          // Check if service should still be running before attempting reconnect
          if (!isServiceRunning) {
            ui.run(() => {
              logToUI("WebSocket 连接失败 (服务已停止): " + err);
              updateWsStatus("连接失败", "#D32F2F"); // Red
            });
            wsClient = null; // Clear client ref
            return;
          }

          ui.run(() => { // Update UI on main thread
            logToUI(`WebSocket 连接失败: ${err} (Code: ${res ? res.code() : 'N/A'})`);
            updateWsStatus("连接失败", "#D32F2F"); // Red
          });
          wsClient = null; // Clear client ref
          if (keepAliveIntervalId) clearInterval(keepAliveIntervalId);
          // Simple Reconnect Logic (optional)
          setTimeout(() => {
            if (isServiceRunning) { // Double check if service should still be running
              logToUI("尝试重新连接...");
              connectWebSocket();
            }
          }, 10000); // Try reconnecting after 10 seconds
        });

        ws.on("closing", (code, reason) => {
          ui.run(() => { // Update UI on main thread
            logToUI(`WebSocket 正在关闭: Code=${code}, Reason=${reason}`);
            updateWsStatus("正在关闭", "#FFAB00"); // Orange
          });
        });

        ws.on("closed", (code, reason) => {
          ui.run(() => { // Update UI on main thread
            logToUI(`WebSocket 已关闭: Code=${code}, Reason=${reason}`);
            updateWsStatus("已断开", "#FF5722"); // Orange/Red
          });
          wsClient = null; // Clear client ref
          if (keepAliveIntervalId) clearInterval(keepAliveIntervalId);
          // If the service is meant to be running, attempt reconnect
          if (isServiceRunning) {
            setTimeout(() => {
              if (isServiceRunning) { // Double check
                logToUI("连接已断开，尝试重新连接...");
                connectWebSocket();
              }
            }, 5000); // Reconnect after 5 seconds
          }
        });

        // Keep the WebSocket thread alive (important!)
        while (isServiceRunning && wsClient && wsClient.isOpen()) { // Check wsClient exists and is open
          sleep(1000); // Prevent busy-waiting
        }
        // console.log(isServiceRunning, wsClient, wsClient.isOpen())
        logToUI("WebSocket listener loop exited."); // Debug log
        // Ensure cleanup if loop exits unexpectedly
        if (wsClient && wsClient.isOpen()) {
          try { wsClient.close(1001, "Client thread ending"); } catch (e) { }
        }
        wsClient = null;
        ui.run(() => updateWsStatus("已断开", "#FF5722"));


      }); // End of web.newWebSocket callback
    }); // End of threads.start

  } catch (error) {
    ui.run(() => {
      logToUI("创建 WebSocket 失败: " + error);
      updateWsStatus("创建失败", "#D32F2F"); // Red
      stopService(); // Stop service if WS cannot be created
    });
  }
}

function sendToServer(data) {
  if (wsClient && wsClient.isOpen() && isServiceRunning) {
    try {
      const message = JSON.stringify(data);
      wsClient.send(message);
      // logToUI("Sent: " + message);
    } catch (error) {
      logToUI("发送消息失败: " + error);
    }
  } else {
    // logToUI("无法发送消息: WebSocket 未连接或服务未运行。");
  }
}

function sendInitialInfo() {
  logToUI("准备发送设备注册信息...");
  sendToServer({
    type: "info",
    payload: {
      device: {
        brand: device.brand,
        model: device.model,
        sdkInt: device.sdkInt,
        release: device.release,
        serial: device.serial,
      },
      appName: app.getAppName(context.getPackageName()),
      appVersion: app.versionName,
      timestamp: new Date().toISOString()
    }
  });
  logToUI("设备注册信息已发送");
}

function sendDeviceStatus() {
  // Gather status (run checks that don't require UI thread first)
  let battery = device.getBattery();
  let isCharging = device.isCharging();
  // Note: Permission checks should ideally be done async if complex,
  // but for status update, synchronous checks might be acceptable if fast.
  let accEnabled = auto.service != null;
  let overlayEnabled = floaty.checkPermission();
  let ignoringBattery = false;
  if (device.sdkInt >= 23) {
    try {
      let pm = context.getSystemService(context.POWER_SERVICE);
      ignoringBattery = pm.isIgnoringBatteryOptimizations(context.getPackageName());
    } catch (e) { logToUI("无法检查电池优化状态: " + e) }
  }

  sendToServer({
    type: "status",
    payload: {
      battery: battery,
      isCharging: isCharging,
      memory: { // Basic memory info
        total: device.getTotalMem(),
        available: device.getAvailMem(),
      },
      permissions: {
        accessibility: accEnabled,
        overlay: overlayEnabled,
        ignoreBatteryOptimization: ignoringBattery,
        // Capture status is harder to check passively, maybe send on request
      },
      timestamp: new Date().toISOString()
    }
  });
}

function sendLogToServer(level, message) {
  sendToServer({
    type: "log",
    payload: {
      level: level, // e.g., 'info', 'warn', 'error'
      message: message,
      timestamp: new Date().toISOString()
    }
  });
}

function handleServerMessage(messageText) {
  const workspace_path="/sdcard/autojs_remote_workspace/";
  // const workspace_path="/storage/emulated/10/脚本/autojs_remote_workspace/";
  try {
    const message = JSON.parse(messageText);
    logToUI(`处理指令: ${message.type}`);

    switch (message.type) {
      case "command": // Example: Execute a script
        if (message.payload && message.payload.script) {
          logToUI("收到执行脚本命令...");
          executeRemoteScript(message.payload.script);
        } else {
          logToUI("无效的 command 消息格式");
          sendLogToServer('warn', 'Received invalid command message format');
        }
        break;
      case "request_status":
        logToUI("收到状态请求，正在发送当前状态...");
        sendDeviceStatus();
        break;
      case "request_info":
        logToUI("收到设备信息请求，正在发送...");
        sendInitialInfo(); // Send basic device info again
        break;
      case "ping": // Server ping, respond with pong
        logToUI("收到 Ping, 回复 Pong");
        sendToServer({ type: "pong", timestamp: new Date().toISOString() });
        break;
      case "run_script":
        let entry = message.payload && message.payload.entry ? message.payload.entry : "main.js";
        logToUI("收到运行请求，正在执行 " + entry);
        try {
          engines.execScriptFile(workspace_path + entry);
        } catch (e) {
          logToUI("执行入口脚本失败: " + e);
        }
        break;
      case "file_update":
        let filename = message.payload && message.payload.filename;
        let content = message.payload && message.payload.content;
        if (filename && typeof content === 'string') {
          // 规范化 filename，去除前缀斜杠和点
          filename = filename.replace(/^\/?(\.?\/)?/, '');
          let baseDir = workspace_path;
          let fullPath = baseDir + filename;
          logToUI("准备保存文件: " + fullPath);
          // 自动创建多级目录
          files.ensureDir(fullPath);
          files.write(fullPath, content);
          logToUI("已保存文件: " + fullPath);
        }
        break;
      // Add more cases for other commands from the server
      default:
        logToUI(`未知的消息类型: ${message.type}`);
        sendLogToServer('warn', `Received unknown message type: ${message.type}`);
    }
  } catch (error) {
    logToUI("处理服务器消息时出错: " + error);
    sendLogToServer('error', `Error processing server message: ${error}`);
  }
}

function executeRemoteScript(scriptContent) {
  // SECURITY WARNING: Executing arbitrary code received from the network is
  // extremely dangerous. Only connect to trusted servers and implement
  // proper validation/sandboxing if needed.
  logToUI("开始执行远程脚本...");
  try {
    // Use engines.execScript to run the script in a new engine instance
    let executionResult = engines.execScript("Remote Script", scriptContent);
    logToUI("远程脚本执行完毕。");
    // Optionally send result back to server
    sendToServer({
      type: "script_result",
      payload: {
        status: "success",
        // result: executionResult // Be careful sending complex results
      }
    });
  } catch (error) {
    logToUI("执行远程脚本时出错: " + error);
    sendToServer({
      type: "script_result",
      payload: {
        status: "error",
        message: error.toString()
      }
    });
  }
}

function startKeepAlive() {
  if (keepAliveIntervalId) {
    clearInterval(keepAliveIntervalId);
  }
  logToUI("启动 WebSocket Keep-Alive (ping)");
  keepAliveIntervalId = setInterval(() => {
    // logToUI("Sending ping..."); // Can be noisy
    sendToServer({ type: "ping", timestamp: new Date().toISOString() });
  }, 30 * 1000); // Send ping every 30 seconds
}

// --- Status Check Functions ---

function setStatusLabel(id, text, color) {
  ui.run(() => { // Ensure UI updates happen on the main thread
    let label = ui[id];
    if (label) {
      label.setText(text);
      label.setTextColor(colors.parseColor(color));
    }
  });
}

function checkAccessibilityStatus() {
  const isEnabled = auto.service != null;
  setStatusLabel("accessibilityStatus", isEnabled ? "已启用" : "未启用", isEnabled ? "#4CAF50" : "#D32F2F");
  return isEnabled;
}

function checkCaptureStatus() {
  // Note: requestScreenCapture(false) doesn't reliably check without prompting again on some systems.
  // A common way is to try getting a capture. If it returns null AFTER a successful request,
  // it might mean permission was revoked or something else failed.
  // For UI purposes, we often just reflect the outcome of the *last request*.
  // A more reliable check might involve trying to take a 1x1 pixel capture.
  threads.start(function () {
    // let capture = getScreenCapture(); // Try to get existing grant
    let capture = captureScreen(); // Try to get existing grant
    let hasPermission = capture != null;
    if (capture) {
      // Important: If you get a capture object just to check,
      // you might need to release it if you don't use it immediately.
      // However, `getScreenCapture` might return a shared object.
      // Let's assume for status check, we don't need to recycle.
    }
    ui.run(() => {
      setStatusLabel("captureStatus", hasPermission ? "已授权" : "未授权", hasPermission ? "#4CAF50" : "#D32F2F");
    });
  });

}


function checkOverlayStatus() {
  const isEnabled = floaty.checkPermission();
  setStatusLabel("overlayStatus", isEnabled ? "已启用" : "未启用", isEnabled ? "#4CAF50" : "#D32F2F");
  if (!isEnabled) {
    // Sometimes checkPermission is false but it's actually enabled.
    // A more robust check might involve trying to show a small floaty window briefly.
    // toast("悬浮窗权限未开启，请在设置中手动开启。"); // Optional reminder
  }
  return isEnabled;
}

function checkBatteryOptimizationStatus() {
  // Requires API 23 (Android 6.0)
  if (device.sdkInt >= 23) {
    try {
      let pm = context.getSystemService(context.POWER_SERVICE);
      if (!pm) {
        setStatusLabel("batteryOptimizationStatus", "无法检查", "#FFAB00");
        return;
      }
      const isIgnoring = pm.isIgnoringBatteryOptimizations(context.getPackageName());
      setStatusLabel("batteryOptimizationStatus", isIgnoring ? "已忽略" : "未忽略", isIgnoring ? "#4CAF50" : "#D32F2F");
    } catch (e) {
      logToUI("检查电池优化状态失败: " + e);
      setStatusLabel("batteryOptimizationStatus", "检查失败", "#D32F2F");
    }
  } else {
    setStatusLabel("batteryOptimizationStatus", "N/A (SDK<23)", "#9E9E9E"); // Gray
  }
}


function refreshAllStatus() {
  logToUI("正在刷新所有状态...");
  checkAccessibilityStatus();
  checkCaptureStatus(); // Runs async, will update when done
  checkOverlayStatus();
  checkBatteryOptimizationStatus();
  logToUI("状态刷新完成。");
}

// --- Utility Functions ---

function logToUI(message) {
  console.log(message); // Also log to Auto.js console
  // Send log to server if connected
  if (isServiceRunning && wsClient && wsClient.isOpen()) {
    // Avoid infinite loop if logging is part of sending
    if (message.indexOf("Sent: ") === -1 && message.indexOf("Sending ping") === -1) {
      // Simple check to avoid logging sent messages or pings if too verbose
      sendLogToServer('info', message);
    }
  }

  ui.run(() => {
    let currentLog = ui.logText.getText().toString();
    let time = new java.text.SimpleDateFormat("HH:mm:ss").format(new java.util.Date());
    let newLog = time + ": " + message + "\n" + currentLog;
    // Limit log length to avoid memory issues
    if (newLog.length > 5000) {
      newLog = newLog.substring(0, 5000);
      // Find the last newline to avoid cutting mid-message
      let lastNewline = newLog.lastIndexOf("\n");
      if (lastNewline > 0) {
        newLog = newLog.substring(0, lastNewline);
      }
      newLog += "\n..."; // Indicate truncation
    }
    ui.logText.setText(newLog);
  });
}

function updateWsStatus(text, color) {
  ui.run(() => {
    ui.wsStatus.setText(text);
    ui.wsStatus.setTextColor(colors.parseColor(color));
  });
}

// --- Script Exit Handling ---
// Ensure service stops cleanly if the script UI is closed
events.on("exit", function () {
  logToUI("脚本即将退出，停止服务...");
  stopService();
  logToUI("服务已停止。再见！");
});

ui.serverHostInput.setText(config.serverHost);
// Initial status check
refreshAllStatus();
logToUI("界面已加载，请配置并启动服务。");

// Keep script alive while UI is open
// setInterval(() => {}, 1000); // Not usually needed when UI is active