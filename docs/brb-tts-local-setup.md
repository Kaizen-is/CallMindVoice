# Running CallMind locally with BRB TTS

How to run CallMind on your own Windows PC with our BRB TTS voice working.

## What you need first

- Git, and Node.js 22 LTS (version 22.5 or newer).
- **GlobalProtect VPN, connected.** The BRB TTS server only answers inside the BRB network.
- The BRB TTS login and password. Ask for them privately; they are not in the repository.

## 1. Get the code

```bash
git clone -b develop https://gitlab.brb-tech.uz/Q.Raximov/callmind.git
```

```bash
cd callmind
```

```bash
npm ci
```

## 2. Create the `.env` file

Copy `.env.example` to `.env` in the same folder as `package.json`, then fill in at least these lines:

```
OVOZ_SESSION_SECRET=any-long-random-string
SEED_ADMIN_PASSWORD=pick-a-local-admin-password
BRB_SPEECH_URL=https://tts-stt-proxy-test.brb.uz
BRB_SPEECH_LOGIN=<the BRB login>
BRB_SPEECH_PASSWORD=<the BRB password>
```

To get AI answers in the Playground, also add `ANTHROPIC_API_KEY`. Without it the agent uses simple built-in answers, but BRB TTS still works.

Never commit `.env`.

## 3. Fix the office certificate problem (once per PC)

The office network re-signs HTTPS traffic with its own certificate, and Node does not trust it by default. Without this step every outside call fails silently and you hear the browser's robot voice instead of BRB. In PowerShell:

```bash
setx NODE_USE_SYSTEM_CA 1
```

Then close the terminal and open a new one; `setx` only applies to new windows.

## 4. Start the site and create the admin account

```bash
npm run dev
```

Open http://localhost:3000/login and try logging in once with any email and password. It will fail, but that first attempt creates the database. Then, in a second terminal in the same folder:

```bash
npm run seed
```

Now log in as `admintest@callmind.uz` with the `SEED_ADMIN_PASSWORD` you set.

## 5. Check that BRB TTS works

- **TTS lab:** go to http://localhost:3000/app/dev/tts, choose **BRB**, type an Uzbek sentence and play it. If you hear the BRB voice, the setup is done.
- **Playground:** open the voice menu, pick **BRB TTS** (the last option) and make a call.

## If it doesn't work

| What you see | What to do |
|---|---|
| A robot/browser voice, or a "voice model did not answer" warning | Check the VPN is connected and that the terminal was opened after `setx NODE_USE_SYSTEM_CA 1`. |
| `getaddrinfo` or `ENOTFOUND` in the terminal (the server name doesn't resolve) | The VPN isn't routing it. As administrator, add `172.22.202.1  tts-stt-proxy-test.brb.uz` to `C:\Windows\System32\drivers\etc\hosts`. |
| `brb_limit` error | The BRB account has a request limit. Every sentence already spoken is cached in `data/tts-cache` and never requested again, so avoid generating lots of new text just for testing. |
| The same BRB voice still plays with the VPN off | That's audio cached earlier, not a new request. |

## Good to know

- BRB TTS only works where the VPN is connected. The production server can't use it yet: it waits for the network admins to open a route to `172.22.202.1:443`.
- BRB TTS has a single voice and is treated as Uzbek-only. Russian and English lines fall back to the browser voice in the Playground.
- More on how CallMind runs and how the move to the Python backend is going: `docs/handoff.md`.
