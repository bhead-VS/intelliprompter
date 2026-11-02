# Intelliprompter

A teleprompter for people who ad-lib. Instead of a word-for-word script, you enter the **topics** you want to hit. While you talk, Chrome turns your speech into text, and **TypeSafe Jev** (a fast yes/no model) checks about twice a second which topics you've covered. The cockpit ticks them off as you go. Jev matches ideas, not exact words, so you can say things however you like.

```
mic ──► Chrome speech-to-text ──► transcript (last 60 s) ──► local server ──► Jev ──► checklist
```

## Setup on your Mac (about 5 minutes, one time)

You'll need:
- **Google Chrome.** Speech recognition only works in Chrome (or Edge).
- **Access to this repo.** Ask Brian to add your GitHub account.
- **The TypeSafe (Jev) API key.** Ask Brian for it, and never commit it or paste it in a channel.

**1. Open Terminal** (⌘-Space, type "Terminal") and check that Python is installed:

```bash
python3 --version
```

If a box pops up offering to install developer tools, click **Install**, wait for it to finish, then run the command again. Any version 3.9 or newer is fine.

**2. Download the code** to your home folder:

```bash
git clone https://github.com/bhead-VS/intelliprompter.git ~/intelliprompter
```

If you're asked to sign in, use your GitHub username and a [personal access token](https://github.com/settings/tokens) as the password. Or skip git: on the repo page click **Code → Download ZIP**, unzip it, and move the folder to your home folder as `intelliprompter`.

**3. Install it:**

```bash
cd ~/intelliprompter && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt && cp .env.example .env
```

**4. Add the key.** Open the settings file:

```bash
open -e ~/intelliprompter/.env
```

Paste the key after `TYPESAFE_API_KEY=` with no spaces or quotes, so the line reads `TYPESAFE_API_KEY=apikey_…`. Save and close. (`.env` is ignored by git, so it never leaves your machine.)

## Running it (every time)

```bash
cd ~/intelliprompter && .venv/bin/uvicorn server:app --port 8765
```

Leave that Terminal window open, then open **http://localhost:8765 in Chrome**. Press Ctrl-C in Terminal when you're done.

## Using it

1. Type one topic per line. Add detail after `::` to make matching sharper:
   `Pricing :: per-sensor annual license, volume discounts`
   Spelling out names and jargon in plain words helps, since speech recognition can mishear product names.
2. Optionally save it as a named plan (saved in your browser).
3. Click **Go to cockpit**, then **● Start**, and allow the microphone when Chrome asks.
4. Talk. Each row shows its state:
   - **Blue edge, UP NEXT:** the first topic you haven't covered yet.
   - **Amber:** you're getting close.
   - **Green ✓:** covered.

   Click any row to check or uncheck it by hand.
5. The box at the bottom lets you type sentences instead of speaking, which is handy for a dry run.

**Settings** has the check-off threshold (default 0.70) and how many seconds of recent speech Jev looks at (default 60).

### If something's wrong

| You see | Fix |
|---|---|
| `Jev: no key on server` | The key isn't in `.env`. Add it and restart the server. |
| `Jev: Jev error 401` | The key is wrong or has extra characters. Paste it again. |
| `STT: mic blocked` | Click the mic icon in Chrome's address bar, allow it, and reload. |
| `STT: use Chrome for speech` | You're in Safari or Firefox. Open the page in Chrome. |
| Page won't load | The server isn't running. Start it again from Terminal. |

## Things to know

- **Privacy:** Chrome's speech recognition sends your audio to Google to transcribe. Jev receives the transcript text. Avoid using it for anything you wouldn't put through Google.
- **Cost:** Chrome's speech recognition is free. Jev costs about $0.042 per million input tokens, roughly $0.20 an hour of talking, and less as topics get checked off.
- **Gaps:** Chrome stops listening after a pause or about a minute. The app restarts it automatically, but a word or two can be lost at the seam.

## For developers

- `server.py`: FastAPI app. `/api/check` asks Jev (`POST https://api.typesafe.ai/v1/systemone`, `noul` questions, unchecked topics only). `/api/stt-token` mints OpenAI Realtime tokens and is optional.
- `static/`: the cockpit. `app.js` holds speech capture, the transcript window, the Jev polling loop and the checklist.
- `MOCK_JEV=1` in `.env` fakes Jev with word overlap so you can work on the UI without a key.
- **OpenAI speech-to-text (optional, untested):** set `OPENAI_API_KEY` and pick "OpenAI Realtime" in Settings. It uses `gpt-4o-mini-transcribe` (~$0.18/hour), works in any browser and is more accurate on jargon.
- **Hosting for the whole team:** the `Dockerfile` runs anywhere. Put it behind Google login restricted to vergesense.com (for example Cloud Run with IAP), or at least set `ACCESS_CODE`. Mic access needs HTTPS.
- Pin `JEV_MODEL` (for example `jev-1.14.0`) once you've tuned the threshold.
