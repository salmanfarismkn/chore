import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";

import { env } from "../config/env";
import { DependencyUnavailableError } from "../shared/core/errors/dependency-unavailable-error";

export const DATABASE_QUERY_TIMEOUT_MS = 8_000;

const DATABASE_CONNECTION_TIMEOUT_SECONDS = 3;
const DATABASE_STATEMENT_TIMEOUT_MS = 6_000;

const isDatabaseConnectionError = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  typeof error.code === "string" &&
  [
    "CONNECT_TIMEOUT",
    "CONNECTION_CLOSED",
    "CONNECTION_DESTROYED",
    "CONNECTION_ENDED",
    "ECONNREFUSED",
    "ECONNRESET",
    "EHOSTUNREACH",
    "ENETUNREACH",
    "ETIMEDOUT",
    "08000",
    "08001",
    "08003",
    "08006",
    "57P01",
    "57P02",
    "57P03",
  ].includes(error.code);

type PostgresSqlClient = ReturnType<typeof postgres>;
type PostgresPendingQuery = ReturnType<PostgresSqlClient["unsafe"]>;

const withQueryTimeout = (query: PostgresPendingQuery) => {
  let execution: Promise<unknown> | undefined;
  let proxy: PostgresPendingQuery;

  const start = () => {
    execution ??= new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new DependencyUnavailableError("database"));
        void Promise.resolve(query.cancel()).catch(() => {
          console.error("PostgreSQL query cancellation failed");
        });
      }, DATABASE_QUERY_TIMEOUT_MS);

      query.then(
        (result) => {
          clearTimeout(timeout);
          resolve(result);
        },
        (error: unknown) => {
          clearTimeout(timeout);
          reject(
            isDatabaseConnectionError(error)
              ? new DependencyUnavailableError("database")
              : error,
          );
        },
      );
    });

    return execution;
  };

  proxy = new Proxy(query, {
    get(target, property) {
      if (property === "then") {
        return (
          onFulfilled?: (value: unknown) => unknown,
          onRejected?: (reason: unknown) => unknown,
        ) => start().then(onFulfilled, onRejected);
      }
      if (property === "catch") {
        return (onRejected?: (reason: unknown) => unknown) =>
          start().catch(onRejected);
      }
      if (property === "finally") {
        return (onFinally?: () => void) => start().finally(onFinally);
      }

      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") {
        return value;
      }

      return (...args: unknown[]) => {
        const result = Reflect.apply(value, target, args);
        return result === target ? proxy : result;
      };
    },
  });

  return proxy;
};

const withBoundedQueries = <T extends object>(client: T): T =>
  new Proxy(client, {
    get(target, property) {
      if (property === "unsafe") {
        const unsafe = Reflect.get(target, property, target);
        if (typeof unsafe !== "function") {
          throw new Error("PostgreSQL query method is unavailable");
        }
        return (...args: unknown[]) =>
          withQueryTimeout(
            Reflect.apply(unsafe, target, args) as PostgresPendingQuery,
          );
      }

      if (property === "begin" || property === "savepoint") {
        const transactionMethod = Reflect.get(target, property, target);
        if (typeof transactionMethod !== "function") {
          throw new Error("PostgreSQL transaction method is unavailable");
        }
        return (...args: unknown[]) => {
          const callbackIndex = typeof args[0] === "string" ? 1 : 0;
          const callback = args[callbackIndex];
          if (typeof callback !== "function") {
            return Reflect.apply(transactionMethod, target, args);
          }

          const boundedArgs = [...args];
          boundedArgs[callbackIndex] = (transactionClient: object) =>
            callback(withBoundedQueries(transactionClient));
          return Reflect.apply(transactionMethod, target, boundedArgs);
        };
      }

      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

const rawClient = postgres(env.DATABASE_URL, {
  max: 10,
  idle_timeout: 20,
  connect_timeout: DATABASE_CONNECTION_TIMEOUT_SECONDS,
  keep_alive: 1,
  max_lifetime: 1_800,
  connection: {
    application_name: "pronto-backend",
    statement_timeout: DATABASE_STATEMENT_TIMEOUT_MS,
    lock_timeout: 2_000,
    idle_in_transaction_session_timeout: 10_000,
  },
});

export const dbClient = withBoundedQueries(rawClient);
export const db = drizzle(dbClient);

export async function closeDatabase() {
  await rawClient.end({ timeout: 5 });
}
