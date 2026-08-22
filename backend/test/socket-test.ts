import { io } from "socket.io-client";

const socket = io(
  "http://localhost:3000",
  {
    auth: {
      token: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOjEsInJvbGUiOiJ3b3JrZXIiLCJpYXQiOjE3ODczODY0NzIsImV4cCI6MTc4NzM4NzM3Mn0.rhvcxFcEQj8rfI47_5q4qPJK-J4R7zwjG-g0_VEYLvs",
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