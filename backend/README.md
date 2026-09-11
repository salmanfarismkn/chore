# Chore Backend

Production-oriented backend for a worker-based chore booking and allocation platform.

Chore models the problem of assigning nearby workers to customer bookings while handling
concurrency, worker availability, real-time offers, allocation failures, and booking lifecycle
transitions.

## Architecture

![System Architecture](../docs/Architecture.png)

```text
                         ┌─────────────────┐
                         │     Client      │
                         └────────┬────────┘
                                  │ HTTP / Socket.IO
                                  ▼
                         ┌─────────────────┐
                         │     Fastify     │
                         │   API Gateway   │
                         └───────┬─────────┘
                                 │
             ┌───────────────────┼───────────────────┐
             │                   │                   │
             ▼                   ▼                   ▼
       ┌───────────┐       ┌─────────────┐      ┌───────────┐
       │  Booking  │       │ Allocation  │      │   Auth    │
       │  Service  │       │   Engine    │      │   / JWT   │
       └─────┬─────┘       └──────┬──────┘      └───────────┘
             │                    │
             │             ┌──────┴──────┐
             │             │             │
             │             ▼             ▼
             │         PostgreSQL      Redis
             │             │             │
             └─────────────┴─────────────┘
                                  │
                                  ▼
                            Socket.IO
                                  │
                                  ▼
                              Workers