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
    const repository = this.repository as IdempotencyRepository & {
      create: (userId: number, key: string, response: unknown) => unknown;
    };

    return repository.create(
      userId,
      key,
      response
    );
  }
}