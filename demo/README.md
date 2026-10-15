# pii-gate demo

Live at [pii-gate.vercel.app](https://pii-gate.vercel.app).

A single page that runs a fictional insurance note through pii-gate and shows every step: what was detected, what the model received, what it replied, what the app gets back, and the audit row.

## How the data stays fake

- The built-in samples use only values reserved for examples (555-01xx phone numbers, `example.*` domains, the voided SSN 078-05-1120, the Visa test card, a published example VIN). The page lists where each one comes from.
- **Simulated model (default):** everything runs in the browser, using the same `wrapAnthropic` code as the server. Nothing is sent anywhere. This is the only mode available for text you write yourself.
- **Live Claude:** the browser sends only a sample id and the policy to `POST /api/run`. The server looks up the sample text itself, so arbitrary text never reaches the server or the model. Request and response bodies are not logged. Each IP gets 5 runs a minute (per server instance).

## Run locally

```bash
cd demo
npm install
npm run dev          # builds the library in .. first, then http://localhost:3000
```

Live mode turns on when `ANTHROPIC_API_KEY` is set. `DEMO_MODEL` overrides the model (default `claude-sonnet-5-5`; `claude-haiku-5-5` is cheaper, `claude-opus-5-5` is stronger). The page is prerendered, so set both before `npm run build`.

## Deploy (Vercel)

- Root directory: `demo`. Keep "Include files outside the root directory" on: the library is linked from `..` (`"pii-gate": "file:.."`), and `prebuild` installs and builds it.
- Environment: `ANTHROPIC_API_KEY` (optional), `DEMO_MODEL` (optional). Consider a spend limit on the key.
