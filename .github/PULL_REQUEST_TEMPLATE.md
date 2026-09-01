## What this changes

<!-- And why. The why is the part that is hard to recover later. -->

## What you decided not to do

<!-- Optional, but the most useful section in this repo's history. If you tried
     an approach and rejected it, say so — it saves the next person the trip. -->

## Checklist

- [ ] `npm run check` passes
- [ ] `npm test` passes
- [ ] New behaviour has a test
- [ ] If I added a file to `public/lib/` or `public/views/`, I added it to
      `ASSETS` in `public/service-worker.js` (`test/pwa.test.mjs` enforces this)
- [ ] No secret, token, tailnet name or real login appears in the diff

## Security impact

<!-- Delete whichever does not apply. -->

- [ ] This does not touch the identity gate, same-origin check, REST allowlist,
      static file root, or the WebSocket upgrade path.
- [ ] This DOES touch one of the above. It comes with a test that fails without
      the change, and I have described below what an attacker could newly reach.
