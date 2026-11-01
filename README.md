# Backend

Node + Express 5 + TypeScript. Zod-validated env, helmet, cors. Tests with Vitest + Supertest.

```
cp .env.example .env
pnpm install   # or npm install
pnpm dev       # http://localhost:3000, GET /api/health
pnpm test
pnpm build && pnpm start
```

`CORS_ORIGIN` is a comma-separated list of allowed browser origins (default `http://localhost:5173`). Every ACCS module site calls this one API with credentials, so list all seven site origins in deployed environments; see `.env.example`.

`tests/doc003-modules.test.ts` checks the DOC003 module inventory (`tests/fixtures/doc003-modules.json`, 58 modules): for each module, every owning role can sign in as its seeded account and reach at least one of the module's pages.

System concept not defined yet.

## Accounts and sign-in

| Endpoint | Body | Result |
|---|---|---|
| `POST /api/auth/register` | `{ fullName, email, identifier, role: 'student' \| 'professor' \| 'staff', program?, yearLevel?, section?, password }` | 201 + session cookie; 409 `CONFLICT` on a taken email or ID |
| `POST /api/auth/sign-in` | `{ emailOrId, password, remember? }` | 200 + session cookie; 401 `INVALID_CREDENTIALS`; 429 `TOO_MANY_ATTEMPTS` after 5 failures in 15 minutes |
| `POST /api/auth/forgot-password` | `{ emailOrId }` | Always 200; issues a 6-digit code (logged outside production only) |
| `POST /api/auth/reset-password` | `{ emailOrId, code, password }` | 200; 400 `INVALID_CODE` |
| `POST /api/auth/change-password` | `{ currentPassword, password }` (signed in) | 200; 400 `INVALID_CREDENTIALS` |
| `POST /api/auth/sign-out` | `{}` | Clears the cookie |

Passwords are hashed with `crypto.scryptSync` and need 10+ characters with upper and lower case, a number, and a symbol. Students must give program, year level, and section. Privileged roles are granted by an administrator, never self-registered.

Registered accounts and password hashes live in the auth store (`src/auth.ts`): an S3 object when `AUTH_STORE_BUCKET` is set (Lambda; `AUTH_STORE_KEY`, default `auth-store.json`), otherwise a JSON file at `AUTH_STORE_FILE` (default `/tmp/accs-auth-store.json`). Tests use an in-memory store. Seeded pilot accounts (`QCU-STU-IT-A`, `QCU-ADMIN`, …) sign in with their ID or email and `Accs@Qcu2026!` until changed; rotate or disable this shared password before real users join.
