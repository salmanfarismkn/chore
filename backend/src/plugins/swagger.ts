import fp from "fastify-plugin";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";

export default fp(async (app) => {
  await app.register(swagger, {
    openapi: {
      info: {
        title: "Pronto+ API",
        description: "Worker allocation and chore booking platform API",
        version: "1.0.0",
      },
      servers: [
        {
          url: "http://localhost:3000",
          description: "Local development",
        },
      ],
      tags: [
        {
          name: "Health",
          description: "Application health and readiness",
        },
        {
          name: "Auth",
          description: "Authentication endpoints",
        },
        {
          name: "Bookings",
          description: "Booking lifecycle and allocation",
        },
      ],
    },
  });

  await app.register(swaggerUi, {
    routePrefix: "/docs",
  });
});