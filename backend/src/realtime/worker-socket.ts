import type { Socket } from "socket.io";

import { WorkerPresenceService } from "../modules/workers/worker-presence.service";

import {
  addWorkerConnection,
  removeWorkerConnection,
} from "./worker-presence";

const presenceService =
  new WorkerPresenceService();

export function registerWorkerSocket(
  socket: Socket
) {
  const user = socket.data.user as {
    userId: number;
    role:
      | "customer"
      | "worker"
      | "admin";
  };

  if (user.role !== "worker") {
    return;
  }

  const workerId =
    user.userId;

  socket.join(
    `worker:${workerId}`
  );

  void addWorkerConnection(
    workerId,
    socket.id
  ).then(() => {
    return presenceService.setOnline(
      workerId
    );
  });

  socket.on(
    "worker:availability",
    async (
      availability:
        | "available"
        | "busy"
    ) => {
      if (
        availability === "available"
      ) {
        await presenceService.setAvailable(
          workerId
        );
        return;
      }

      await presenceService.setBusy(workerId);

    }
  );

  socket.on(
    "disconnect",
    async () => {
      const remaining =
        await removeWorkerConnection(
          workerId,
          socket.id
        );

      if (remaining === 0) {
        await presenceService.setOffline(
          workerId
        );
      }
    }
  );
}