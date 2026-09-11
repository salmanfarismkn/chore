import http from "k6/http";
import { check, sleep } from "k6";

export const options = {
  scenarios: {
    allocation_load: {
      executor: "constant-vus",
      vus: 10,
      duration: "30s",
    },
  },

  thresholds: {
    http_req_failed: ["rate<0.01"],
    http_req_duration: ["p(95)<1000"],
  },
};

const BASE_URL = "http://localhost:3000/v1";

export function setup() {
  const response = http.post(
    `${BASE_URL}/auth/test-token`,   // <-- now /v1/auth/test-token
    JSON.stringify({
      userId: 1,
      role: "customer",
    }),
    { headers: { "Content-Type": "application/json" } }
  );

  check(response, {
    "token request succeeded": (r) => r.status === 200,
  });

  return { token: response.json().token };
}

export default function (data) {
  const idempotencyKey = `load-${__VU}-${__ITER}-${Date.now()}`;

  const response = http.post(
    `${BASE_URL}/bookings`,          // <-- now /v1/bookings
    JSON.stringify({
      customerId: 1,
      serviceCategoryId: 1,
      pickupLatitude: 23.2599,
      pickupLongitude: 77.4126,
    }),
    {
      headers: {
        Authorization: `Bearer ${data.token}`,
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
    }
  );

  check(response, {
    "booking request succeeded": (r) => r.status === 200 || r.status === 201,
    "booking has id": (r) => {
      try {
        return Number.isInteger(r.json().id);
      } catch {
        return false;
      }
    },
  });

  sleep(1);
}
