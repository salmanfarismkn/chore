import { eq, and } from "drizzle-orm";
import { db } from "../../db";
import { idempotencyKeys } from "../../db/schema";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export class IdempotencyRepository {
  async find(userId: number, key: string) {
    const [record] = await db
      .select()
      .from(idempotencyKeys)
      .where(
        and(
          eq(idempotencyKeys.userId, userId),
          eq(idempotencyKeys.key, key)
        )
      );

    return record ?? null;
  }

  async findWithTransaction(
    tx: Transaction,
    userId: number,
    key: string
  ) {
    const [record] = await tx
      .select()
      .from(idempotencyKeys)
      .where(
        and(
          eq(idempotencyKeys.userId, userId),
          eq(idempotencyKeys.key, key)
        )
      );

    return record ?? null;
  }

  async createWithTransaction(
    tx: Transaction,
    userId: number,
    key: string,
    response: unknown
  ) {
    const [record] = await tx
      .insert(idempotencyKeys)
      .values({
        userId,
        key,
        response,
      })
      .onConflictDoNothing({
        target: [
          idempotencyKeys.userId,
          idempotencyKeys.key,
        ],
      })
      .returning();

    return record ?? null;
  }
}