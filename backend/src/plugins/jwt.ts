import fp from "fastify-plugin";
import jwt from "@fastify/jwt";

import { env } from "../config/env";

export default fp(async (app) => {
  await app.register(jwt, {
    secret: env.JWT_SECRET,
    sign: {
      expiresIn: env.JWT_EXPIRES_IN,
    },
  });
});