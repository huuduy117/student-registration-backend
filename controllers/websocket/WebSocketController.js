const { WebSocketServer } = require("ws")
const express = require("express")
const { auth, verifyToken } = require("../../middleware/auth")
const { isTokenRevoked } = require("../../services/tokenService")
const { canAccessRoom } = require("../../services/roomAccessService")

class WebSocketController {
  constructor(mongoDB) {
    this.wss = new WebSocketServer({ noServer: true })
    this.mongoDB = mongoDB
    this.router = express.Router()
    this.setupRoutes()
    this.rooms = new Map() // Track clients by room
  }
  setupRoutes() {
    this.router.get("/history/:roomId", auth, async (req, res) => {
      try {
        const { roomId } = req.params

        // The handshake check is not enough for REST history: a signed-in
        // student could otherwise read another class channel.
        if (!(await canAccessRoom(req.user, roomId))) {
          return res.status(403).json({ error: "You cannot access this room" })
        }

        const messagesCollection = this.mongoDB.collection("messages")

        const messages = await messagesCollection
          .find({ roomId: String(roomId) })
          .sort({ timestamp: -1 })
          .limit(50)
          .toArray()

        const formattedMessages = messages.map((msg) => ({
          ...msg,
          timestamp: msg.timestamp.toISOString(),
        }))

        res.json(formattedMessages.reverse())
      } catch (error) {
        console.error("Error fetching chat history:", error)
        res.status(500).json({ error: "Failed to fetch chat history" })
      }
    })
  }

  async initialize() {
    try {
      await this.initializeMessageCollection()
      this.setupWebSocketEvents()
      return this.router
    } catch (error) {
      console.error("Failed to initialize WebSocket controller:", error)
      throw error
    }
  }

  async initializeMessageCollection() {
    try {
      const collections = await this.mongoDB.listCollections().toArray()
      const messagesExists = collections.some((col) => col.name === "messages")

      if (!messagesExists) {
        await this.mongoDB.createCollection("messages", {
          validator: {
            $jsonSchema: {
              bsonType: "object",
              required: ["roomId", "text", "sender", "timestamp"],
              properties: {
                roomId: {
                  bsonType: "string",
                  description: "must be a string and is required",
                },
                text: {
                  bsonType: "string",
                  description: "must be a string and is required",
                },
                sender: {
                  bsonType: "string",
                  description: "must be a string and is required",
                },
                timestamp: {
                  bsonType: "date",
                  description: "must be a date and is required",
                },
              },
            },
          },
        })
        console.log("Messages collection created successfully")
      } else {
        console.log("Messages collection already exists")
      }
    } catch (error) {
      console.error("Error initializing messages collection:", error)
      throw error
    }
  }

  setupWebSocketEvents() {
    this.wss.on("connection", (ws, req) => {
      const url = new URL(req.url, `http://${req.headers.host}`)
      const pathname = url.pathname
      const roomId = pathname.split("/").pop()

      // `ws.user` is set by handleUpgrade after the JWT is verified. Without it
      // the socket should never have been accepted.
      if (!ws.user) {
        ws.close(1008, "Unauthorized")
        return
      }

      console.log(`Client ${ws.user.username} connected to room: ${roomId}`)

      // Add client to room
      if (!this.rooms.has(roomId)) {
        this.rooms.set(roomId, new Set())
      }
      this.rooms.get(roomId).add(ws)

      // Store roomId on the websocket object for easy access
      ws.roomId = roomId

      ws.on("message", async (message) => {
        try {
          let messageData = message
          if (Buffer.isBuffer(message)) {
            messageData = message.toString()
          }

          const parsedMessage = JSON.parse(messageData)
          const messageObj = {
            // Ignore client-supplied roomId/sender: otherwise any authenticated
            // user could post into another room or impersonate someone else.
            roomId: String(ws.roomId),
            text: String(parsedMessage.text || "").trim().slice(0, 2000),
            sender: ws.user.username,
            timestamp: new Date(),
          }

          if (!messageObj.roomId || !messageObj.text) {
            throw new Error("Missing required fields")
          }

          const messagesCollection = this.mongoDB.collection("messages")
          await messagesCollection.insertOne(messageObj)
          const messageForClient = {
            ...messageObj,
            timestamp: messageObj.timestamp.toISOString(),
          }

          // Only broadcast to clients in the same room
          const roomClients = this.rooms.get(messageObj.roomId)
          if (roomClients) {
            roomClients.forEach((client) => {
              if (client !== ws && client.readyState === 1) {
                client.send(JSON.stringify(messageForClient))
              }
            })
          }
        } catch (error) {
          console.error("Error processing message:", error)
          ws.send(
            JSON.stringify({
              error: true,
              message: "Failed to process message",
            }),
          )
        }
      })

      ws.on("close", () => {
        console.log(`Client disconnected from room: ${ws.roomId}`)
        // Remove client from room
        if (this.rooms.has(ws.roomId)) {
          this.rooms.get(ws.roomId).delete(ws)
          // Clean up empty rooms
          if (this.rooms.get(ws.roomId).size === 0) {
            this.rooms.delete(ws.roomId)
          }
        }
      })
    })
  }

  async handleUpgrade(request, socket, head) {
    const url = new URL(request.url, `http://${request.headers.host}`)

    const reject = (status, reason) => {
      socket.write(
        `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`,
      )
      socket.destroy()
    }

    if (!url.pathname.startsWith("/chat/")) {
      socket.destroy()
      return
    }

    let user
    try {
      // Browsers cannot set headers on WebSocket handshakes, so the token is
      // passed as a query parameter (same token the REST API uses).
      user = verifyToken(url.searchParams.get("token"))
    } catch (error) {
      reject(401, "Unauthorized")
      return
    }

    try {
      if (user.jti && (await isTokenRevoked(user.jti))) {
        reject(401, "Unauthorized")
        return
      }

      const roomId = decodeURIComponent(url.pathname.split("/").pop() || "")
      if (!roomId) {
        reject(400, "Bad Request")
        return
      }

      // Only members of the matching class (or staff/teachers) may connect.
      if (!(await canAccessRoom(user, roomId))) {
        reject(403, "Forbidden")
        return
      }

      this.wss.handleUpgrade(request, socket, head, (ws) => {
        ws.user = user
        this.wss.emit("connection", ws, request)
      })
    } catch (error) {
      console.error("Error during WebSocket upgrade:", error)
      reject(500, "Internal Server Error")
    }
  }
}

module.exports = WebSocketController
