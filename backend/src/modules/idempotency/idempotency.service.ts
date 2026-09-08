import { IdempotencyRepository } from "./idempotency.repository";

export class IdempotencyService {
  constructor(
    private readonly repository: IdempotencyRepository
  ) {}

  async getExisting(userId: number, key: string) {
    return this.repository.find(userId, key);
  }

  async save(
    userId: number,
    key: string,
    response: unknown
  ) {
    return this.repository.create(
      userId,
      key,
      response
    );
  }
}