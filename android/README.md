# Advance / Decline — Android app

A standalone Android version of the analyzer, built with [Capacitor](https://capacitorjs.com/).
It runs everything on the phone — no PC or backend needed:

- NSE pre-open fetch (scheduled + "Fetch NSE data now"), advance/decline, sector breadth and bias
- Master stock list upload (.xlsx/.csv), market cap, top 5 gainers/losers
- Circuit limits, tradeability flags, conviction score with adjustable factors
- Signals: results since the last close, results due today, ex-dates, relative volume, gap vs yesterday's range
- Kite Connect: login, account summary, positions, BUY/SELL and square-off, max-loss auto square-off

**Not included: TV research.** It drives a desktop browser through YouTube caption downloads and
calls the OpenAI API, so it stays on the PC version.

## Install

1. On your phone, open **https://github.com/Vishwanath793/advdec_nse/releases/tag/android-latest**
   and download the `.apk`. (Builds from other branches are under the repo's **Actions** tab → the
   run → *Artifacts*; that download needs a GitHub login and is zipped.)
2. Open the file. Android asks to allow installing apps from your browser — allow it once.
3. Allow notifications when the app asks, so the 09:10 reminder can appear.

New builds install over the old one and keep your settings and data. The build is signed with
`app/sideload.keystore`, a personal key committed to this repo so every build has the same
signature. It is not a Play Store key; anyone with the repo could sign an APK that installs over
this app, so only install APKs from this repo's releases.

## How the 09:10 fetch works on a phone

Android doesn't let apps run exactly-timed background jobs, so the app:

- shows a notification at the scheduled time (default 09:10 IST) on NSE trading days;
- fetches as soon as the app is open after that time — tap the notification, or just open the app;
- keeps checking every 20 seconds while it's open.

The schedule is set in **Settings → NSE pre-open data**. Holidays come from
`server/tv/holidays.json` (2026 only; add each year's NSE calendar).

## Kite Connect on the phone

The app is served from `https://localhost`, so set your Kite app's redirect URL to
**`https://localhost/kite/callback`**. A Kite Connect app has one redirect URL, so use a separate
Kite app for the phone if the desktop version also logs in. The API key, secret and session are
stored only in the app's private storage on the phone.

## Building

GitHub Actions (`.github/workflows/android.yml`) builds the APK on every push: tests → `npm run
build` → `npx cap sync android` → `./gradlew assembleRelease`. Builds from `main` replace the
`android-latest` release.

To build locally you need JDK 21 and the Android SDK (Android Studio), then:

```bash
npm run build && npx cap sync android && cd android && ./gradlew assembleRelease
```
