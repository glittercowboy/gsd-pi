---
name: api-design
description: Design or review an HTTP/REST/GraphQL API for versioning, pagination, error shapes, idempotency, auth, and evolvability. Use when asked to "design an API", "shape the endpoints", "design the schema", "add a new endpoint", "review this API", or when building/modifying a public or internal HTTP surface. Complements `design-an-interface` (which is interface-agnostic) by covering HTTP-specific concerns like status codes, cache headers, and breaking-change management.
---

<objective>
Shape an HTTP or GraphQL API so callers get predictable, evolvable, and honest semantics. The deliverable is a concrete endpoint/schema sketch with: URL or operation names, method/verb, request shape, response shape, error shape, auth model, pagination strategy, and versioning stance. Optimize for "clients that exist in 2 years" over "client that's easy to write today".
</objective>

<context>
GSD-2 has `design-an-interface` for general module-interface design; this skill is the HTTP/GraphQL specialization. REST and GraphQL carry baggage — status codes, verbs, nullability, pagination — that a generic interface-design discussion glosses over.

Invocation points:
- Adding a new public API endpoint
- Redesigning an internal API boundary between services
- Code review of a PR that introduces HTTP handlers
- A slice whose acceptance criteria include "the API works"
- A GraphQL schema change
</context>

<core_principle>
**CALLERS OUTLIVE YOUR ASSUMPTIONS.** An API you ship today has to keep working when your internals change, when the mobile app version two is still in use, and when a third party integrates against it. Design for extension, not just for the current caller.

**HONEST STATUS CODES.** 200 OK with `{"error": "not found"}` is a lie. 404 says not found. Use the HTTP semantics the protocol offers — HTTP clients, caches, and intermediaries rely on them.

**PAGINATION IS NON-OPTIONAL.** Any list endpoint that doesn't paginate will eventually get a request for "all records" that kills your database.
</core_principle>

<process>

## Step 1: Gather the contract

Answer, or ask (one round, 1–3 questions):

1. **Who are the callers?** Internal service / mobile app / public third-party / same-repo frontend.
2. **What's the versioning stance?** None / URL-path (`/v1/`) / header-based / GraphQL schema evolution.
3. **Auth model?** Public / API key / OAuth / session cookie / mTLS / none-but-internal-only.
4. **Idempotency expectation?** Is a retry safe? Required?
5. **Consistency model?** Read-your-writes, eventual, serializable?

## Step 2: Resource and operation naming

### REST

- Nouns not verbs in URLs: `POST /users`, not `POST /createUser`.
- Plural resources: `/users/42`, not `/user/42`.
- Nested only when the relationship is hierarchical and the child has no independent identity: `/users/42/sessions/3`. Otherwise flat: `/sessions/3?userId=42`.
- Use subresources for actions that don't fit CRUD: `POST /users/42:deactivate` (colon syntax) or `POST /users/42/actions/deactivate`.

### GraphQL

- Queries are nouns; mutations are verbs: `user(id)`, `createUser(input)`, `deactivateUser(id)`.
- Group related mutations under an input type: `createUser(input: CreateUserInput!)`.
- Return the affected object plus any derived/computed fields from mutations — lets clients avoid a refetch.

## Step 3: Methods and status codes

### REST

| Method | Intent | Idempotent? | Default success |
|---|---|---|---|
| GET | Read | Yes | 200, or 304 if conditional |
| POST | Create or non-idempotent action | No | 201 with `Location` on create, 200 on action |
| PUT | Replace (full-object) | Yes | 200 with body, or 204 |
| PATCH | Partial update | No (usually) | 200 with body |
| DELETE | Remove | Yes | 204 |

Errors:
- 400: caller screwed up the request shape
- 401: no/invalid auth
- 403: authed but not allowed
- 404: resource doesn't exist
- 409: conflict (version mismatch, unique constraint)
- 410: gone (vs 404 when the resource previously existed and you want to signal that)
- 422: validation failed
- 429: rate-limited — include `Retry-After`
- 500: genuinely unexpected server error
- 503: service down or overloaded — include `Retry-After`

Never 200-with-error-body. Never 500 for a 4xx cause.

### GraphQL

- Top-level errors (`errors[]`) for transport-level failures. Domain errors (validation, not-found, forbidden) go in the typed return — use a union or result type.
- Partial results are expected; design the schema so `null` on a field is meaningful, not a signal of generic failure.

## Step 4: Pagination

- **Cursor-based by default.** Opaque cursor string, `limit`, return `nextCursor` when more exists. Scales, stable under writes.
- **Offset-based only when:** dataset is small, user needs jump-to-page semantics (admin tables), and you're willing to accept stability drift.
- **Never "return everything"** as default. Put a hard upper bound on `limit` (e.g., 200).
- GraphQL: use Relay-style connections (`edges`, `pageInfo`) if the ecosystem expects it; otherwise a simpler `{items, nextCursor}` is fine.

## Step 5: Error shape

Standardize one shape and use it everywhere. Example REST:

```json
{
  "error": {
    "code": "user_not_found",
    "message": "No user with id 42",
    "details": { "userId": 42 },
    "requestId": "req_abc123"
  }
}
```

- `code` is machine-readable; stable; documented.
- `message` is human-readable; can change.
- `details` carries structured context.
- `requestId` lets callers report bugs.

Errors don't leak stack traces, file paths, or internal queries.

## Step 6: Idempotency, caching, concurrency

- **Idempotency keys** for POST operations that mustn't double-execute on retry. Caller passes `Idempotency-Key: <uuid>`; server dedupes for a window.
- **ETags** for GET + conditional updates (`If-Match` on PUT/PATCH).
- **Cache-Control** on GETs that are safely cacheable.
- **Optimistic concurrency:** when multiple writers collide, 409 with the current state. Don't silently clobber.

## Step 7: Versioning and evolution

- **Additive changes are free:** new optional fields, new endpoints, new optional query params.
- **Breaking changes need a plan:** path-versioned (`/v2/`), sunset headers on `/v1/`, deprecation window communicated. Or, for GraphQL, `@deprecated` on fields with a migration note.
- **Document the contract:** OpenAPI/GraphQL SDL. Keep it in the repo. Make it part of the PR that introduces the change.

## Step 8: Review or write it up

If this is a review, produce findings in the same shape as `security-review` / `review` — file:line, category, recommendation.

If this is a new design, produce:

```markdown
## <API name>

### Scope
<what the API is for, who calls it>

### Endpoints / Operations
- `POST /users` — create user. Request: `{email, name}`. Response 201: `{id, email, name, createdAt}` + `Location: /users/<id>`. Errors: 409 email taken, 422 invalid.
- ...

### Auth
<model + where to put the credential>

### Pagination
<cursor shape, max limit>

### Error shape
<one canonical shape>

### Idempotency / concurrency
<rules>

### Versioning
<stance + how breaking changes will be handled>

### OpenAPI / SDL
<link or inline>
```

Append architectural decisions to `.gsd/DECISIONS.md`.

</process>

<anti_patterns>

- **200 OK with `{"error": "..."}`.** Lies to caches, proxies, retry libraries.
- **Unbounded list endpoints.** `GET /users` without a `limit` cap will bite you.
- **Offset pagination at scale.** Drifts under writes; slow at high offsets.
- **Free-form error messages with no code.** Machine callers can't branch on prose.
- **Breaking changes in-place.** Callers break; versioning exists for a reason.
- **Ignoring idempotency on retriable POSTs.** Double-charges, duplicate records.
- **Auth checks at the handler only, not the service layer.** Defense in depth.

</anti_patterns>

<success_criteria>

- [ ] Every endpoint/operation has named request, response, and error shapes.
- [ ] Status codes match HTTP semantics — no 200-with-error.
- [ ] List endpoints paginate; max limit is documented.
- [ ] A single error shape is used everywhere, with a machine-readable code.
- [ ] Versioning stance is stated — even if the answer is "additive only for now."
- [ ] OpenAPI/SDL reflects the design and lives in the repo.
- [ ] Decisions appear in `.gsd/DECISIONS.md`.

</success_criteria>
