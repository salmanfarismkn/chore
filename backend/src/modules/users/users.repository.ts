import { eq } from "drizzle-orm";

import { db } from "../../db";
import { users } from "../../db/schema";

import type {
  CreateUserInput,
  UserResponse,
} from "./users.types";

export class UsersRepository {
  async createUser(data: CreateUserInput): Promise<UserResponse> {
    const [user] = await db
      .insert(users)
      .values({
        phoneNumber: data.phoneNumber,
        fullName: data.fullName,
        role: data.role,
      })
      .returning({
        id: users.id,
        phoneNumber: users.phoneNumber,
        fullName: users.fullName,
        role: users.role,
      });

    return user;
  }

  async findUserByPhoneNumber(phoneNumber: string) {
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.phoneNumber, phoneNumber));

    return user ?? null;
  }

  async findUserById(id: number) {
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.id, id));

    return user ?? null;
  }

  async findAllUsers() {
    return db.select().from(users);
  }
}