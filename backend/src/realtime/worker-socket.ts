import type { Socket } from "socket.io";

import { WorkerPresenceService } from "../modules/workers/worker-presence.service";

import {
  addWorkerConnection,
  removeWorkerConnection,
} from "./worker-presence";
import { AllocationOfferService } from "../modules/allocation/allocation-offer.service";

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
  const offerService = new AllocationOfferService();

  socket.join(
    `worker:${workerId}`
  );

  const connectionReady = addWorkerConnection(
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
      await connectionReady;
      const remaining =
        await removeWorkerConnection(
          workerId,
          socket.id
        );

      if (remaining === 0) {
        await presenceService.setOffline(
          workerId
        );
        await offerService.revokeWorkerOffers(workerId);
      }
    }
  );
}