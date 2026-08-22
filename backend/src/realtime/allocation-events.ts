import { getSocketIO } from "./socket";

export interface WorkerOfferEvent {
  bookingId: number;
  workerId: number;
  tier: string;
  expiresAt: number;
}

export function emitWorkerOffer(
  event: WorkerOfferEvent
) {
  const io = getSocketIO();

  io.to(`worker:${event.workerId}`).emit(
    "booking:offer",
    event
  );
}