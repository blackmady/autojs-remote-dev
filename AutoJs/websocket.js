// ==================================
// WebSocket Wrapper Implementation
// ==================================

var websocket = (function () {
  try {
    // Ensure OkHttp package is imported
    importPackage(Packages["okhttp3"]);
    importPackage(Packages["okio"]); // Needed for ByteString potentially
  } catch (e) {
    console.error("请确保 OkHttp 库已正确添加到 Auto.js 项目中！");
    console.error("错误: " + e);
    throw new Error("无法加载 OkHttp 库。");
  }

  /**
   * Simple Event Emitter class
   */
  function EventEmitter() {
    this._listeners = {};
  }

  EventEmitter.prototype.on = function (eventName, listener) {
    if (!this._listeners[eventName]) {
      this._listeners[eventName] = [];
    }
    this._listeners[eventName].push(listener);
    return this; // Allow chaining
  };

  EventEmitter.prototype.emit = function (eventName /*, ...args */) {
    var args = Array.prototype.slice.call(arguments, 1);
    var listeners = this._listeners[eventName];
    if (listeners) {
      listeners.forEach(function (listener) {
        try {
          listener.apply(null, args);
        } catch (e) {
          console.error("Error in WebSocket event listener for '" + eventName + "':", e);
        }
      });
    }
  };

  EventEmitter.prototype.off = function (eventName, listener) {
    var listeners = this._listeners[eventName];
    if (listeners) {
      if (listener) {
        var index = listeners.indexOf(listener);
        if (index !== -1) {
          listeners.splice(index, 1);
        }
      } else {
        // Remove all listeners for this event if no specific listener is provided
        delete this._listeners[eventName];
      }
    }
    return this; // Allow chaining
  };

  /**
   * Represents the WebSocket client connection with an event-based interface.
   * Inherits from EventEmitter.
   */
  function WebSocketClient() {
    EventEmitter.call(this); // Inherit EventEmitter properties
    this._okhttpWebSocket = null; // Reference to the actual OkHttp WebSocket
  }
  // Inherit EventEmitter prototype methods
  WebSocketClient.prototype = Object.create(EventEmitter.prototype);
  WebSocketClient.prototype.constructor = WebSocketClient;

  /**
     * Checks if the WebSocket connection is currently open.
     * @returns {boolean} True if the connection is open, false otherwise.
     */
  WebSocketClient.prototype.isOpen = function () {
    // The connection is considered open if the internal OkHttp WebSocket object exists.
    // It's set in onOpen and cleared in onClosing/onClosed/onFailure.
    return !!this._okhttpWebSocket; // Use !! for explicit boolean conversion
  };
  /**
   * Sends data over the WebSocket connection.
   * @param {string | object | okio.ByteString} data - Data to send. Objects are automatically stringified.
   * @returns {boolean} True if the send was attempted, false otherwise (e.g., not connected).
   */
  WebSocketClient.prototype.send = function (data) {
    if (this._okhttpWebSocket) {
      var dataToSend = data;
      if (typeof data === 'object' && !(data instanceof Packages.okio.ByteString)) {
        try {
          dataToSend = JSON.stringify(data);
        } catch (e) {
          console.error("Failed to stringify object for WebSocket send:", e);
          this.emit("error", new Error("Failed to stringify object: " + e.message));
          return false;
        }
      }
      // OkHttp's send method accepts String or okio.ByteString
      try {
        return this._okhttpWebSocket.send(dataToSend);
      } catch (e) {
        console.error("WebSocket send error:", e);
        this.emit("error", new Error("WebSocket send error: " + e.message));
        return false;
      }
    } else {
      console.warn("WebSocket send called but not connected.");
      return false;
    }
  };

  /**
   * Closes the WebSocket connection.
   * @param {number} [code=1000] - The closure code.
   * @param {string} [reason=null] - The closure reason.
   * @returns {boolean} True if the close was attempted, false otherwise.
   */
  WebSocketClient.prototype.close = function (code, reason) {
    if (this._okhttpWebSocket) {
      var closeCode = code || 1000; // Default to normal closure
      var closeReason = reason || null;
      try {
        return this._okhttpWebSocket.close(closeCode, closeReason);
      } catch (e) {
        console.error("WebSocket close error:", e);
        this.emit("error", new Error("WebSocket close error: " + e.message));
        return false;
      }
    } else {
      console.warn("WebSocket close called but not connected.");
      return false;
    }
  };

  /**
  * Immediately cancels the connection attempt or existing connection.
  * This differs from close() as it's more abrupt.
  */
  WebSocketClient.prototype.cancel = function () {
    if (this._okhttpWebSocket) {
      try {
        this._okhttpWebSocket.cancel();
      } catch (e) {
        console.error("WebSocket cancel error:", e);
        // No guarantee onFailure will be called after cancel, emit error defensively
        this.emit("error", new Error("WebSocket cancel error: " + e.message));
      }
    } else {
      console.warn("WebSocket cancel called but not connected.");
    }
  };


  // --- The main function ---

  function newWebSocket(url, options, callback) {
    if (typeof options === 'function') {
      // Shift arguments if options is omitted
      callback = options;
      options = {};
    }
    options = options || {};

    var wsClient = new WebSocketClient(); // Our wrapper object

    try {
      var clientBuilder = new OkHttpClient.Builder();

      // Configure retry
      clientBuilder.retryOnConnectionFailure(options.retryOnConnectionFailure !== false); // Default true

      // Configure timeouts (convert ms to OkHttp units if necessary)
      // Note: OkHttp uses long for time units, default is milliseconds unless specified otherwise
      if (options.timeout) {
        clientBuilder.connectTimeout(options.timeout, java.util.concurrent.TimeUnit.MILLISECONDS);
        clientBuilder.readTimeout(options.timeout, java.util.concurrent.TimeUnit.MILLISECONDS); // Often good to set both
        clientBuilder.writeTimeout(options.timeout, java.util.concurrent.TimeUnit.MILLISECONDS);
      }
      if (options.pingInterval) {
        clientBuilder.pingInterval(options.pingInterval, java.util.concurrent.TimeUnit.MILLISECONDS);
      }


      var client = clientBuilder.build();

      var requestBuilder = new Request.Builder().url(url);

      // Add headers
      if (options.headers) {
        for (var key in options.headers) {
          if (options.headers.hasOwnProperty(key)) {
            requestBuilder.addHeader(key, options.headers[key]);
          }
        }
      }

      var request = requestBuilder.build();

      // Define the OkHttp Listener that bridges to our EventEmitter
      var listener = new WebSocketListener({
        onOpen: function (webSocket, response) {
          // Store the actual OkHttp WebSocket object
          wsClient._okhttpWebSocket = webSocket;
          // Emit the 'open' event on our wrapper
          wsClient.emit("open", response);
        },
        onMessage: function (webSocket, message) {
          // message can be String or okio.ByteString
          // Emit 'message' event with the received message
          wsClient.emit("message", message);
        },
        onClosing: function (webSocket, code, reason) {
          // Emit 'closing' event
          wsClient.emit("closing", code, reason);
        },
        onClosed: function (webSocket, code, reason) {
          // Clean up reference
          wsClient._okhttpWebSocket = null;
          // Emit 'closed' event
          wsClient.emit("closed", code, reason);
        },
        onFailure: function (webSocket, t, response) {
          // Clean up reference
          wsClient._okhttpWebSocket = null;
          // Emit 'error' event (using 'error' convention)
          // 't' is the Throwable (Java exception)
          wsClient.emit("error", t, response);
        }
      });

      // Initiate the connection
      // Note: client.newWebSocket itself doesn't block, the listener handles events
      client.newWebSocket(request, listener);

      // Immediately call the user's callback function, passing the wrapper
      if (typeof callback === 'function') {
        try {
          callback(wsClient);
        } catch (e) {
          console.error("Error in user callback for newWebSocket:", e);
          // Attempt to close if connection started but callback failed
          if (wsClient._okhttpWebSocket) {
            wsClient.close(1011, "Callback setup error"); // Internal Error
          }
        }
      } else {
        console.warn("web.newWebSocket called without a callback function.");
      }


    } catch (e) {
      console.error("Failed to create WebSocket connection:", e);
      // Emit error on the wrapper object even if connection failed early
      wsClient.emit("error", e, null);
      // Ensure callback doesn't receive a non-functional wsClient if it expects one
      if (typeof callback === 'function') {
        try {
          // Call callback but indicate failure, maybe pass null or the error?
          // Passing the wsClient allows attaching error handlers even for setup failures.
          callback(wsClient);
        } catch (e) {
          console.error("Error in user callback during initial WebSocket failure:", e);
        }
      }
    }

    // Return the wrapper client immediately. User interacts via event listeners.
    return wsClient;
  }

  // Expose the public function
  return {
    newWebSocket: newWebSocket
  };

})(); // IIFE to create the 'web' object


module.exports = websocket;

// ==================================
// Usage Example
// ==================================

// var wsHost = "ws://192.168.31.164:9317"; // Your WebSocket server address
// var wsClient = null; // Variable to hold the WebSocket client instance

// console.log("Attempting to connect to:", wsHost);

// web.newWebSocket(wsHost, {
//   // Optional: Add headers or timeouts if needed
//   // headers: { 'User-Agent': 'AutoJS-WebSocket-Client' },
//   timeout: 10000, // Connection/Read/Write timeout in ms (10 seconds)
//   pingInterval: 30000 // Send pings every 30 seconds
// }, function (ws) {
//   // --- WebSocket Event Handlers (executed in WS background thread) ---
//   console.log("WebSocket client object created.");
//   wsClient = ws; // Assign to global scope variable for potential later use

//   ws.on("open", function (response) {
//     // Note: UI operations from here need runOnUiThread
//     // activity.runOnUiThread(function() {
//     //     toastLog("WebSocket Opened!");
//     // });
//     console.log("WebSocket Opened!");
//     console.log("Server response headers:", response ? response.headers() : "N/A");

//     // Send the initial 'hello' message
//     var helloMsg = {
//       type: "hello",
//       data: {
//         device_name: "模拟设备",
//         client_version: 123,
//         app_version: 123,
//         app_version_code: "233"
//       }
//     };
//     console.log("Sending hello message:", JSON.stringify(helloMsg));
//     var sent = ws.send(helloMsg); // send will stringify the object
//     if (!sent) {
//       console.error("Failed to send hello message immediately after open.");
//     }
//   });

//   ws.on("message", function (message) {
//     // message could be a Java String or okio.ByteString
//     var messageContent;
//     // Check if it's ByteString and try to decode as UTF-8, otherwise assume String
//     if (message instanceof Packages.okio.ByteString) {
//       try {
//         messageContent = message.utf8(); // Decode ByteString as UTF-8
//         console.log("Received binary message (decoded as UTF-8):", messageContent);
//       } catch (e) {
//         messageContent = message.hex(); // Fallback to hex if not valid UTF-8
//         console.log("Received binary message (hex):", messageContent);
//       }
//     } else {
//       messageContent = message; // It's already a string
//       console.log("Received text message:", messageContent);
//     }

//     // Example: Process the message (e.g., parse JSON)
//     try {
//       var parsed = JSON.parse(messageContent);
//       console.log("Parsed message data:", parsed);
//       // Do something with the parsed data...
//     } catch (e) {
//       console.warn("Received message is not valid JSON:", e);
//     }
//   });

//   ws.on("closing", function (code, reason) {
//     console.log("WebSocket Closing - Code:", code, "Reason:", reason);
//   });

//   ws.on("closed", function (code, reason) {
//     console.log("WebSocket Closed - Code:", code, "Reason:", reason);
//     wsClient = null; // Clear the reference
//     // Maybe attempt to reconnect here after a delay?
//   });

//   ws.on("error", function (error, response) {
//     console.error("WebSocket Error:", error);
//     // 'error' is typically a Java Throwable
//     if (error && typeof error.printStackTrace === 'function') {
//       // error.printStackTrace(); // Uncomment for full Java stack trace
//     }
//     if (response) {
//       console.error("Associated Response Status:", response.code(), response.message());
//       console.error("Associated Response Headers:", response.headers());
//     }
//     wsClient = null; // Clear the reference on error too
//   });

// });

// console.log("WebSocket connection initiated. Waiting for events...");

// // Keep the script running to allow WebSocket background threads to operate
// // This is essential if the main script would otherwise exit immediately.
// setInterval(() => {
//   // This loop prevents the script from exiting.
//   // You could add periodic checks or tasks here if needed.
//   if (wsClient) {
//     // Optional: console.log("Still connected...");
//   } else {
//     // Optional: console.log("Waiting for connection or reconnect...");
//   }
// }, 5000); // Check every 5 seconds, adjust as needed

// // To manually close the connection later (e.g., in response to a UI button):
// // if (wsClient) {
// //     console.log("Manually closing WebSocket...");
// //     wsClient.close(1000, "User requested closure");
// // }

// // To manually send a message later:
// // if (wsClient) {
// //     wsClient.send("Another message from Auto.js");
// // }