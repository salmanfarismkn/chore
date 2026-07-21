import { ConflictError } from "../../shared/core/errors/conflict-error";

import { UsersRepository } from "./users.repository";

import type {
  CreateUserInput,
  UserResponse,
} from "./users.types";

export class UsersService {
  constructor(
    private readonly usersRepository: UsersRepository
  ) {}

  async createUser(
    data: CreateUserInput
  ): Promise<UserResponse> {
    const existing =
      await this.usersRepository.findUserByPhoneNumber(
        data.phoneNumber
      );

    if (existing) {
      throw new ConflictError(
        "Phone number already exists"
      );
    }

    return this.usersRepository.createUser(data);
  }

  async getAllUsers() {
    return this.usersRepository.findAllUsers();
  }

  async getUserById(id: number) {
    return this.usersRepository.findUserById(id);
  }
}