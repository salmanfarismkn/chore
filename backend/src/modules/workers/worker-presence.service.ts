import { WorkersRepository } from "./workers.repository";

export class WorkerPresenceService {
  constructor(
    private readonly workerRepository = new WorkersRepository()
  ) {}

  async setOnline(userId: number) {
    return this.workerRepository.updateStatus(
      userId,
      "available"
    );
  }

  async setOffline(userId: number) {
    return this.workerRepository.updateStatus(
      userId,
      "offline"
    );
  }

  async setBusy(userId: number) {
    return this.workerRepository.updateStatus(
      userId,
      "busy"
    );
  }

  async setAvailable(userId: number) {
    return this.workerRepository.updateStatus(
      userId,
      "available"
    );
  }
}
