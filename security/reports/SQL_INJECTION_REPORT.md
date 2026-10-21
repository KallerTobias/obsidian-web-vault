# SQL Injection Security Report

## Status: N/A

No SQL anywhere (no database driver in `package.json`, no query strings in `server/`). Search is in-memory (MiniSearch, `server/index/search.ts`); user queries are passed as data, not compiled into code. Settings/JSON input is validated by Ajv schemas with `additionalProperties: false` and no type coercion (`server/http/app.ts:118`); Fastify's JSON parser rejects `__proto__`/`constructor` keys by default, so `Object.assign` in `PUT /api/settings` cannot pollute prototypes.
