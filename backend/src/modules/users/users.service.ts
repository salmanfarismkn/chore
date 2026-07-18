import { UsersRepository } from "./users.repository";

export class UsersService {
  constructor(
    private readonly usersRepository = new UsersRepository()
  ) {}

  async createUser() {
    throw new Error("Not implemented");
  }
}