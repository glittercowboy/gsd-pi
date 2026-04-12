# UAT Guide: /api/shutdown Auth Protection

## Quick Test with curl

1. **Start the web server:**
   ```bash
   npm run gsd:web
   # Note the auth token in the URL that opens, e.g. http://127.0.0.1:3000/#token=abc123...
   ```

2. **Test 1: No auth (should return 401)**
   ```bash
   curl -X POST http://127.0.0.1:3000/api/shutdown
   # Expected: {"error":"Unauthorized"} with status 401
   ```

3. **Test 2: Wrong token (should return 401)**
   ```bash
   curl -X POST http://127.0.0.1:3000/api/shutdown \
     -H "Authorization: Bearer wrong-token"
   # Expected: {"error":"Unauthorized"} with status 401
   ```

4. **Test 3: Correct token via Bearer (should return 200)**
   ```bash
   # Use the actual token from step 1
   curl -X POST http://127.0.0.1:3000/api/shutdown \
     -H "Authorization: Bearer YOUR_ACTUAL_TOKEN"
   # Expected: {"ok":true} with status 200
   ```

5. **Test 4: Correct token via query param (should return 200)**
   ```bash
   curl -X POST "http://127.0.0.1:3000/api/shutdown?_token=YOUR_ACTUAL_TOKEN"
   # Expected: {"ok":true} with status 200
   ```

6. **Test 5: Bad origin (should return 403)**
   ```bash
   curl -X POST http://127.0.0.1:3000/api/shutdown \
     -H "Authorization: Bearer YOUR_ACTUAL_TOKEN" \
     -H "Origin: http://evil.com"
   # Expected: {"error":"Forbidden: origin mismatch"} with status 403
   ```

## What Success Looks Like

- ✅ Requests without auth return 401
- ✅ Requests with wrong token return 401
- ✅ Requests with valid token return 200
- ✅ Both Bearer header and _token param work
- ✅ Invalid origins return 403

## Before the Fix

Without `web/middleware.ts`, all these requests would return 200 regardless of auth.
