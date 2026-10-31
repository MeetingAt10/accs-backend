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

`tests/doc003-modules.test.ts` checks the DOC003 module inventory (`tests/fixtures/doc003-modules.json`, 58 modules): for each module, every owning role can sign in as its demo account and reach at least one of the module's pages.

System concept not defined yet.
