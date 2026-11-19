# Operator login

## Sub-features

Reject an incorrect code, issue a session for the disposable operator, and use it on a protected route.

## How to get to it (user POV)

Submit an access code through POST /api/auth, then send the returned bearer token with GET /api/mappings.

## Driving it with verify.py

Run `.agents/skills/verify-ai-implement/verify.py login` from the root after building. The invalid code returns 403. The accepted code returns 200 and the session retrieves the inventory. Inspect http.jsonl in the printed evidence directory.

## Gotchas

This journey covers access-code login. SSO requires a configured identity provider.
