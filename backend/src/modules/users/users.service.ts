import { UsersRepository } from "./users.repository";
import type {
  CreateUserInput,
  UserResponse,
} from "./users.types";

export class UsersService {
  constructor(
    private readonly usersRepository = new UsersRepository()
  ) {}

  async createUser(data: CreateUserInput): Promise<UserResponse> {
    const existing = await this.usersRepository.findUserByPhoneNumber(
      data.phoneNumber
    );

    if (existing) {
      throw new Error("USER_ALREADY_EXISTS");
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