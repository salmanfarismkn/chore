import { io } from "socket.io-client";

const socket = io(
  "http://localhost:3000",
  {
    auth: {
      token: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOjEsInJvbGUiOiJ3b3JrZXIiLCJpYXQiOjE3ODg0MzE1NDMsImV4cCI6MTc4ODQzMjQ0M30.pailVxTDZ8zehTSvtloiRgSbJdCwJfOKLHBPngY8pmM",
    },
  }
);

socket.on("connect", () => {
  console.log(
    "Connected:",
    socket.id
  );
  socket.emit("worker:availability", "available");
});

socket.on(
  "booking:offer",
  (offer) => {
    console.log(
      "BOOKING OFFER:",
      offer
    );
  }
);

socket.on("connect", () => {
  console.log(
    "Authenticated socket:",
    socket.id
  );
});

socket.on(
  "connect_error",
  (error) => {
    console.error(
      "Socket authentication failed:",
      error.message
    );
  }

);