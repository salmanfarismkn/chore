import { env } from "../../config/env";
import { redis } from "../../config/redis";
import { IdentityMappingService } from "../auth-identities/identity-mapping.service";
import { IdentityRepository } from "../auth-identities/identity.repository";
import { UsersRepository } from "../users/users.repository";
import {
  Auth0AuthorizationCodeFlow,
  auth0AuthorizationCodeFlowConfigFromEnvironment,
} from "./auth0-authorization-code-flow";
import { createAuth0IdentityService } from "./auth0-identity.service";
import { RedisAuth0LoginTransactionStore } from "./auth0-login-transaction";

export const createAuth0AuthorizationCodeFlow = () =>
  new Auth0AuthorizationCodeFlow(
    auth0AuthorizationCodeFlowConfigFromEnvironment(env),
    new RedisAuth0LoginTransactionStore(redis),
    createAuth0IdentityService(
      new IdentityMappingService(new IdentityRepository()),
    ),
    new UsersRepository(),
  );
