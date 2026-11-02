# Intelliprompter

A teleprompter for people who ad-lib. Instead of a word-for-word script, you enter the **topics** you want to hit. While you talk, live speech-to-text feeds a rolling transcript to **TypeSafe Jev** (a fast "System One" yes/no model) about twice a second, and the cockpit checks off each topic as you cover it. You can phrase things however you like because Jev matches ideas, not exact words.

```
mic ──► OpenAI Realtime STT ──► transcript (last 60 s) ──► /api/check ──► Jev noul questions ──► checklist
          (browser, ephemeral token)                         (server holds keys)
```

## Using it

1. Open the app and type one topic per line. Add detail after `::` to make matching sharper:
   `Pricing :: per-sensor annual license, volume discounts`
2. Optionally save it as a named plan (kept in your browser).
3. Click **Go to cockpit**, then **● Start** and talk.
   - Gray = not yet covered; blue edge = **UP NEXT**; amber = you're getting close; green ✓ = covered.
   - Click any row to check or uncheck it by hand.
   - The box at the bottom lets you type sentences to simulate speech, which is handy for testing.
4. In **Settings** you can change the speech-to-text source, the check-off threshold (default 0.70), and how many seconds of speech Jev sees.

## Models and cost

| Piece | Choice | Approx. cost |
|---|---|---|
| Speech-to-text | OpenAI Realtime API, `gpt-4o-mini-transcribe` (default) | ~$0.003/min ≈ $0.18/hour |
| Free fallback | Browser built-in Web Speech (Chrome/Edge) | $0, lower accuracy, audio goes to Google |
| Topic matching | TypeSafe Jev `jev-latest`, `POST /v1/systemone`, `noul` questions | $0.042 / 1M input tokens ≈ well under $1/hour |

ElevenLabs Scribe v2 Realtime (~$0.39/hour) or Deepgram Nova-3 (~$0.46/hour) are drop-in alternatives if accuracy needs to go up.

Jev only receives the **unchecked** topics and only when the transcript has changed, so cost falls as you work through the list. Pin `JEV_MODEL` to a specific version (for example `jev-1.14.0`) once you've tuned the threshold.

## Running locally

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
cp .env.example .env        # then fill in TYPESAFE_API_KEY and OPENAI_API_KEY
.venv/bin/uvicorn server:app --port 8765
```

Open http://localhost:8765. With `MOCK_JEV=1` the server fakes Jev with simple word overlap, so you can work on the UI without a key.

## Sharing with the team

API keys stay on the server. The browser only gets a short-lived OpenAI token for its own mic stream. To host it for VergeSense:

- Build the `Dockerfile` and deploy to any container host (Cloud Run, Render, Fly, etc.) with the env vars from `.env.example`.
- Set `ACCESS_CODE` so only people with the passcode can spend the corp keys; teammates enter it once under Settings.
- For proper SSO, put it behind Google Identity-Aware Proxy (or similar) restricted to `vergesense.com`.

Mic access needs HTTPS (or `localhost`).

## Files

- `server.py`: FastAPI app with `/api/check` (Jev) and `/api/stt-token` (OpenAI ephemeral token)
- `static/index.html`, `static/app.js`, `static/styles.css`: the cockpit
- `static/pcm-worklet.js`: mic to 24 kHz PCM16 for the Realtime API
