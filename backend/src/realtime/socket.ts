import { Server as SocketIOServer } from "socket.io";
import type { Server as HTTPServer } from "node:http";
import type { FastifyInstance } from "fastify";

import { env } from "../config/env";
import {
  registerWorkerSocket,
} from "./worker-socket";


let io: SocketIOServer | null = null;

export function initializeSocket(
  server: HTTPServer,
  app: FastifyInstance
) {
  io = new SocketIOServer(server, {
    cors: {
      origin: env.CORS_ORIGIN,
      credentials: true,
    },
  });

  io.use(async (socket, next) => {
    try {
      const token =
        socket.handshake.auth?.token;

      if (
        typeof token !== "string" ||
        !token
      ) {
        return next(
          new Error("Authentication required")
        );
      }

      const payload =
        await app.jwt.verify(token);

      socket.data.user = payload;

      next();
    } catch {
      next(
        new Error(
          "Invalid authentication token"
        )
      );
    }
  });

  io.on("connection", (socket) => {
    console.log(
      `Authenticated socket connected: ${socket.id}`
    );

    registerWorkerSocket(socket);

    socket.on("disconnect", () => {
      console.log(
        `Socket disconnected: ${socket.id}`
      );
    });
  });

  return io;
}

export function getSocketIO(): SocketIOServer {
  if (!io) {
    throw new Error("Socket.IO not initialized. Call initializeSocket first.");
  }
  return io;
}