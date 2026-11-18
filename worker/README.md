# Travel Planner Read-only API

Cloudflare Worker that reads one allow-listed Firestore trip and returns a
machine-readable, read-only JSON view for trip discussions in chat.

## Public routes

- `GET /health` - deployment health check, no key required.
- `GET /trip/:tripId?key=READ_KEY` - sanitized itinerary JSON.
- `GET /trip/:tripId` with `Authorization: Bearer READ_KEY` - same response.

Only trip IDs listed in the `ALLOWED_TRIP_IDS` secret can be read. The response includes
trip dates, travelers, flight segments, days, schedule, route, and shopping.
It intentionally excludes expenses, luggage, payer/split data, Firebase
internals, and airport-transfer booking/contact details.

## Cloudflare secrets

- `READ_KEY`: random key required by the itinerary route.
- `FIREBASE_REFRESH_TOKEN`: refresh token for one Firebase anonymous reader.
- `ALLOWED_TRIP_IDS`: comma-separated trip document ids (secret, because ids are unguessable links).

Local secret files (`.dev.vars` and `.secrets.json`) are ignored by Git.

## Verify

```powershell
npm test
npx wrangler deploy
```
