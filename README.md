# Advance / Decline

Install with `npm install`, then run `npm run server` and `npm run dev` in separate terminals. Open http://127.0.0.1:5173.

## Daily NSE pre-open import

Settings → NSE pre-open data controls the backend cron job. It defaults to enabled at 09:10 every day in Asia/Kolkata (IST), independent of the computer's timezone. Save NSE schedule applies changes immediately; Fetch now imports on demand.

The backend and computer must be running and awake at the scheduled time. Closing the browser is fine. This is an application cron job, not a Windows service; missed runs while stopped are not replayed. Restart `npm run server` to resume the saved schedule.

The schedule, last attempt/error, and latest successful snapshot persist in `.data/nse-preopen.json`. Only NSE settings/data are stored there. The browser opens one server-sent event connection, receives cached data once, and receives subsequent updates only when the data or schedule changes. It does not poll. Small keep-alive comments maintain the connection, and a dropped connection reconnects automatically without fetching from NSE. Data is analyzed with the bundled master stock list using the same filtering and sector calculations as CSV uploads. A manually uploaded CSV stays displayed until a newer NSE snapshot arrives (or the page is reloaded).

NSE's source timestamp and the fetch time are shown separately, because weekends/holidays may return a previous trading session. Failed, empty, or invalid responses retain the last successful snapshot. Requests time out after 25 seconds; overlapping scheduled/manual requests share one fetch. No Kite orders are submitted by the import.

Validation: `npm test` and `npm run build`.

## TV research: Zee Business + CNBC Awaaz

Open **TV research** in the navigation. This is a Node.js scheduler plus React dashboard integrated into the existing application. It uses the **OpenAI API**, which is billed separately from a ChatGPT subscription; results appear here and in local files, not in ChatGPT website history.

### Setup

1. Use Node.js 22 or later and run `npm install`.
2. Copy `.env.example` to `.env`. Set `OPENAI_API_KEY` locally. Do not paste the key into chat or commit it. `OPENAI_MODEL` defaults to `gpt-4.1` for its large context window. Choose a model with enough context for both complete Hindi transcripts and at least 32,000 output tokens.
3. Run `npm run tv:browser` to install Chromium, or set `TV_BROWSER_CHANNEL=chrome` to use an installed Google Chrome. A separate browser profile is kept in `.data/tv/browser-profile`; your personal Chrome profile is not used. This workspace is configured for installed Chrome.
4. Run `npm run build`, then `npm start`. Open http://127.0.0.1:3001/#/tv-research. For development, run `npm run server` and `npm run dev` in separate terminals.
5. Optional persistent Windows startup: run `powershell -NoProfile -File scripts/install-startup.ps1`. This registers `AdvanceDecline-Backend` for your user at login and before the evening run, starts it hidden, and logs to `.data/backend.log`. The user must be logged in and the PC awake. It does not wake a sleeping PC. Do not run a second backend instance on the same port. After editing `.env`, restart this task (or the terminal backend).

The backend serves the built UI and binds to loopback. TV routes additionally reject non-local hosts/origins. Do not expose the application with a public tunnel; authentication for a shared deployment is not included.

### Daily workflow

- The scheduler is enabled by default at **19:00 Asia/Kolkata**. It calculates the broadcast date in IST and builds both URLs in the supplied formats: `11th september` for Zee, `11th Sept 2026` for CNBC. It selects the first qualifying video in YouTube's current result order: at least seven hours, completed, expected channel/show, and exact broadcast date including year in the title. Up to six batches of search results are checked. A still-live stream, stale broadcast, ambiguous date, or missing duration is rejected.
- It opens `https://downsub.com/?url=` with the encoded canonical watch URL and downloads the **Hindi (auto-generated) TXT** track. Playlist parameters are deliberately omitted so another playlist item cannot replace the selected broadcast. Each source URL, duration, file size and SHA-256 digest is saved.
- Both entire UTF-8 caption texts are submitted inline to the Responses API in one first request, with the user's first prompt verbatim. No file-search sampling or local truncation is used. The second request includes both transcripts, the completed first response, and the user's second prompt verbatim. Additional instructions distinguish source text from instructions and count distinct named analysts, not repeated mentions. Ties, uncertainty and insufficient evidence must be disclosed.
- Context truncation is disabled. Oversized input, incomplete output, blocked downloads, absent captions, CAPTCHA or login challenges cause a visible failure. No partial result is labeled complete. The code cannot guarantee the model found every recommendation or that the source captions cover every word of a broadcast.
- Runs persist under `.data/tv/runs/YYYY-MM-DD/`: `zee.txt`, `cnbc.txt`, `extraction.md`, `consensus.md`, and `run.json`. Browser failures also save `browser-error.png`. The dashboard has source/download links and run history. Stored data and `.env` are gitignored.
- Overlapping jobs share the active run; completed dates are reused. Failed runs retry after 30 minutes, up to four attempts total, through 23:00 IST. Restarting the server catches up only the current evening. Saved transcripts and a completed extraction are reused on retry. A crash can still cause an API call to repeat if its result was not yet saved. Manual runs can retry beyond the automatic limit and select earlier market dates.

### Calendar maintenance

`server/tv/holidays.json` contains NSE **capital market (equity)** holidays for 2026 from [NSE circular CMTR/71775](https://nsearchives.nseindia.com/content/circulars/CMTR71775.pdf). It is not the currency or settlement calendar. Every Saturday and Sunday is excluded, including special weekend sessions, as requested. Add exchange-announced changes and each new year's official calendar to this file. Unknown years fail closed. This does not automatically detect later exchange holiday revisions.

For the current date, Saturday 12 September 2026, the next eligible run is **Tuesday 15 September 2026 at 19:00 IST**: Monday 14 September is Ganesh Chaturthi.

### Verification and troubleshooting

- `npm test`: holiday/date boundaries, URLs, duration parsing, correct video selection, complete transcript submission, prompt sequencing, retry limits, overlap and saved-file reuse, plus existing pre-open tests.
- `npm run build`: React production build.
- `npm run tv:check -- 2026-09-11`: live browser/download check without any paid API call. Saves files separately in `.data/tv/download-checks/2026-09-11/`.
- `npm run tv:run -- 2026-09-11`: full real run for a market date (uses the configured paid API).
- `npm run tv:setup-browser`: opens the separate automation profile for you to complete Downsub verification yourself. Close the browser before retrying a run. A future challenge may still interrupt unattended execution.
- Downsub and YouTube can change their UI or block automation. Inspect the saved screenshot and failure message. Set `TV_BROWSER_HEADLESS=false` for local troubleshooting; solve login or CAPTCHA challenges yourself. The automation does not bypass challenges. Restart the backend after changing environment settings.
- Stop Windows auto-start with `Disable-ScheduledTask -TaskName AdvanceDecline-Backend`; `Stop-ScheduledTask -TaskName AdvanceDecline-Backend` stops its running process. Pausing research from the UI keeps the existing pre-open service available.

Implementation references: [OpenAI conversation state](https://developers.openai.com/api/docs/guides/conversation-state), [GPT-4.1 model](https://developers.openai.com/api/docs/models/gpt-4.1), [Playwright downloads](https://playwright.dev/docs/downloads). Prompt constants are in `server/tv/prompts.js`.
