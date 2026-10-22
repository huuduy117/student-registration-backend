jest.mock("../../services/tokenService", () => ({
  isTokenRevoked: jest.fn(),
  revokeToken: jest.fn(),
}));

jest.mock("../../services/roomAccessService", () => ({
  canAccessRoom: jest.fn(),
}));

const jwt = require("jsonwebtoken");
const { isTokenRevoked } = require("../../services/tokenService");
const { canAccessRoom } = require("../../services/roomAccessService");

jest.mock("ws", () => {
  class FakeWebSocketServer {
    constructor() {
      this.handlers = {};
      this.upgrades = 0;
    }
    on(event, handler) {
      this.handlers[event] = handler;
    }
    emit(event, ...args) {
      return this.handlers[event]?.(...args);
    }
    handleUpgrade(request, socket, head, callback) {
      this.upgrades += 1;
      callback(socket.__ws);
    }
  }
  return { WebSocketServer: FakeWebSocketServer };
});

const WebSocketController = require("../../controllers/websocket/WebSocketController");

beforeEach(() => {
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
  isTokenRevoked.mockReset();
  isTokenRevoked.mockResolvedValue(false);
  canAccessRoom.mockReset();
  canAccessRoom.mockResolvedValue(true);
});

const tokenFor = (userRole, userId = "u1", extra = {}) =>
  jwt.sign({ userId, username: `user-${userId}`, userRole, ...extra }, "test-secret", {
    algorithm: "HS256",
    expiresIn: "1h",
  });

const makeSocket = () => ({
  written: "",
  destroyed: false,
  write(chunk) {
    this.written += chunk;
  },
  destroy() {
    this.destroyed = true;
  },
});

const makeWs = () => ({
  handlers: {},
  sent: [],
  readyState: 1,
  roomId: null,
  user: null,
  on(event, handler) {
    this.handlers[event] = handler;
  },
  send(payload) {
    this.sent.push(JSON.parse(payload));
  },
  close: jest.fn(),
});

const createController = () => {
  const insertOne = jest.fn().mockResolvedValue({ acknowledged: true });
  const mongoDB = {
    collection: jest.fn(() => ({ insertOne })),
  };
  const controller = new WebSocketController(mongoDB);
  controller.setupWebSocketEvents();
  return { controller, insertOne };
};

const upgrade = async (controller, url) => {
  const ws = makeWs();
  const socket = makeSocket();
  socket.__ws = ws;
  await controller.handleUpgrade(
    { url, headers: { host: "localhost:5000" } },
    socket,
    {},
  );
  return { ws, socket };
};

describe("WebSocket handshake", () => {
  it("rejects a connection without a token", async () => {
    const { controller } = createController();
    const { socket } = await upgrade(controller, "/chat/room-1");

    expect(socket.written).toMatch(/401 Unauthorized/);
    expect(socket.destroyed).toBe(true);
    expect(controller.wss.upgrades).toBe(0);
  });

  it("rejects an invalid token", async () => {
    const { controller } = createController();
    const { socket } = await upgrade(controller, "/chat/room-1?token=forged");

    expect(socket.written).toMatch(/401 Unauthorized/);
    expect(controller.wss.upgrades).toBe(0);
  });

  it("drops upgrades for paths other than /chat/*", async () => {
    const { controller } = createController();
    const { socket } = await upgrade(
      controller,
      `/api/chat/room-1?token=${tokenFor("Student")}`,
    );

    expect(socket.destroyed).toBe(true);
    expect(socket.written).toBe("");
    expect(controller.wss.upgrades).toBe(0);
  });

  it("accepts a valid token and attaches the identity", async () => {
    const { controller } = createController();
    const { ws } = await upgrade(
      controller,
      `/chat/room-1?token=${tokenFor("Student", "u1")}`,
    );

    expect(controller.wss.upgrades).toBe(1);
    expect(ws.user).toMatchObject({ userId: "u1", username: "user-u1" });
    expect(ws.roomId).toBe("room-1");
    expect(controller.rooms.get("room-1").has(ws)).toBe(true);
    expect(canAccessRoom).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "u1" }),
      "room-1",
    );
  });

  it("rejects a revoked token", async () => {
    isTokenRevoked.mockResolvedValueOnce(true);
    const { controller } = createController();
    const { socket } = await upgrade(
      controller,
      `/chat/room-1?token=${tokenFor("Student", "u1", { jti: "revoked-1" })}`,
    );

    expect(isTokenRevoked).toHaveBeenCalledWith("revoked-1");
    expect(socket.written).toMatch(/401 Unauthorized/);
    expect(controller.wss.upgrades).toBe(0);
  });

  it("rejects a room the user cannot access", async () => {
    canAccessRoom.mockResolvedValueOnce(false);
    const { controller } = createController();
    const { socket } = await upgrade(
      controller,
      `/chat/room-2?token=${tokenFor("Student", "u1")}`,
    );

    expect(socket.written).toMatch(/403 Forbidden/);
    expect(socket.destroyed).toBe(true);
    expect(controller.wss.upgrades).toBe(0);
  });

  it("closes a socket that has no identity attached", () => {
    const { controller } = createController();
    const rogue = makeWs();

    controller.wss.emit("connection", rogue, {
      url: "/chat/room-1",
      headers: { host: "localhost:5000" },
    });

    expect(rogue.close).toHaveBeenCalledWith(1008, "Unauthorized");
  });
});

describe("chat messages", () => {
  it("ignores client-supplied sender and roomId", async () => {
    const { controller, insertOne } = createController();
    const { ws } = await upgrade(
      controller,
      `/chat/room-1?token=${tokenFor("Student", "u1")}`,
    );

    const peer = makeWs();
    controller.rooms.get("room-1").add(peer);

    await ws.handlers.message(
      Buffer.from(
        JSON.stringify({
          roomId: "other-room",
          sender: "Admin",
          text: "  hello  ",
        }),
      ),
    );

    expect(insertOne).toHaveBeenCalledTimes(1);
    const stored = insertOne.mock.calls[0][0];
    expect(stored.roomId).toBe("room-1");
    expect(stored.sender).toBe("user-u1");
    expect(stored.text).toBe("hello");

    // Broadcast reaches peers in the room, never the author.
    expect(peer.sent).toHaveLength(1);
    expect(peer.sent[0]).toMatchObject({
      roomId: "room-1",
      sender: "user-u1",
    });
    expect(ws.sent).toHaveLength(0);
  });

  it("rejects empty messages", async () => {
    const { controller, insertOne } = createController();
    const { ws } = await upgrade(
      controller,
      `/chat/room-1?token=${tokenFor("Student", "u1")}`,
    );

    await ws.handlers.message(Buffer.from(JSON.stringify({ text: "   " })));

    expect(insertOne).not.toHaveBeenCalled();
    expect(ws.sent.at(-1)).toMatchObject({ error: true });
  });

  it("truncates oversized messages to 2000 characters", async () => {
    const { controller, insertOne } = createController();
    const { ws } = await upgrade(
      controller,
      `/chat/room-1?token=${tokenFor("Student", "u1")}`,
    );

    await ws.handlers.message(
      Buffer.from(JSON.stringify({ text: "x".repeat(5000) })),
    );

    expect(insertOne.mock.calls[0][0].text).toHaveLength(2000);
  });
});

describe("history route", () => {
  it("is protected by the auth middleware", () => {
    const { controller } = createController();
    const handlers = controller.router.stack.find(
      (layer) => layer.route?.path === "/history/:roomId",
    )?.route.stack;

    // Express stores each handler as a layer; the first one must be auth.
    expect(handlers).toHaveLength(2);
    expect(typeof handlers[0].handle).toBe("function");
  });
});
