import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeFirestoreFields,
  handleRequest,
  isAuthorized,
  toPublicTrip,
} from "../src/index.js";

test("decodes Firestore REST values", () => {
  const decoded = decodeFirestoreFields({
    title: { stringValue: "Busan" },
    count: { integerValue: "3" },
    active: { booleanValue: true },
    tags: { arrayValue: { values: [{ stringValue: "summer" }] } },
    nested: { mapValue: { fields: { note: { stringValue: "hi" } } } },
  });
  assert.deepEqual(decoded, {
    title: "Busan",
    count: 3,
    active: true,
    tags: ["summer"],
    nested: { note: "hi" },
  });
});

test("accepts either query key or Bearer key", () => {
  assert.equal(isAuthorized(new Request("https://example.test/trip/x?key=secret"), "secret"), true);
  assert.equal(isAuthorized(new Request("https://example.test/trip/x", {
    headers: { authorization: "Bearer secret" },
  }), "secret"), true);
  assert.equal(isAuthorized(new Request("https://example.test/trip/x?key=wrong"), "secret"), false);
});

test("returns only the approved itinerary fields", () => {
  const output = toPublicTrip("busan2026aug", {
    name: "Busan",
    destination: "Busan",
    startDate: "2026-08-13",
    endDate: "2026-08-17",
    members: ["Traveler", "Dad", "Mom"],
    exp: { secretExpense: { amt: 999, payer: "Traveler" } },
    luggage: { privateBag: { name: "passport" } },
    pax: {
      p1: {
        name: "Traveler",
        order: 1,
        ob: { no: "CI000", from: "RMQ", to: "PUS", bookingRef: "SECRET" },
        goTrans: "private phone and booking number",
      },
    },
    days: {
      d1: { n: 1, date: "2026-08-13", title: "Arrival", spots: ["Haeundae"] },
    },
    sched: {
      s1: { dayId: "d1", time: "07:00", act: "Walk", place: "Beach" },
    },
    shopping: {
      q1: { order: 1, name: "Tea", note: "gift", done: false },
    },
  }, "2026-08-09T00:00:00Z");

  const serialized = JSON.stringify(output);
  assert.equal(serialized.includes("secretExpense"), false);
  assert.equal(serialized.includes("privateBag"), false);
  assert.equal(serialized.includes("bookingRef"), false);
  assert.equal(serialized.includes("private phone"), false);
  assert.equal(output.trip.flights[0].outbound.no, "CI000");
  assert.equal(output.trip.schedule[0].activity, "Walk");
  assert.equal(output.trip.shopping[0].name, "Tea");
});

test("health is public and trip data requires authorization", async () => {
  const env = { READ_KEY: "secret", ALLOWED_TRIP_IDS: "busan2026aug" };
  const health = await handleRequest(new Request("https://example.test/health"), env);
  assert.equal(health.status, 200);

  const denied = await handleRequest(new Request("https://example.test/trip/busan2026aug"), env);
  assert.equal(denied.status, 401);

  const hidden = await handleRequest(new Request("https://example.test/trip/not-allowed?key=secret"), env);
  assert.equal(hidden.status, 404);
});
