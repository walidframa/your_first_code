# The phone app

Front Desk on an iPhone or an Android phone, installed from the home screen
rather than opened in a browser.

It is the **same app**, not a second one. The screens, the arithmetic, the
offline queue, the barcode decoder and the Arabic translation are one codebase;
what the phone adds is a shell around it, a shape built for a thumb, and the
things a browser tab cannot do — the camera as a scanner, a buzz you can feel,
a screen that does not lock itself mid-sale.

---

## Why Capacitor and not React Native

The app is around thirty thousand lines of working React: twenty-four back-office
screens, dual-currency money, a sale queue in IndexedDB for when the server is
away, a hand-written EAN/UPC/Code-128 decoder. Rewriting that in React Native
would mean maintaining two of everything, and the two would diverge within a
month — the second copy always lags, and the lag lands on whoever is standing at
the counter.

Capacitor puts the existing app inside a real native shell. It produces a genuine
`.apk`/`.aab` and `.ipa`, it goes in both stores, and it reaches the camera and
the vibrator through native APIs. One codebase, one set of bugs, one fix.

---

## The one thing that is genuinely different

On the web the app is *served by* the shop's own server, so `/api` is that
server by definition. There is nothing to configure and nothing to get wrong.

In the app the pages are bundled inside the app itself and the WebView serves
them from its own origin, so `/api` is the bundle — which contains no server.
**Somebody has to say where the shop is.** That is the first screen the app
shows, once, and the address is checked before it is accepted: the app asks the
shop to say its own name and shows it back, so a person can recognise it as
theirs before committing.

- `client/src/lib/server.js` — resolves and remembers the address
- `client/src/pages/Connect.jsx` — the screen that asks
- `client/src/components/ServerGate.jsx` — sits above every provider that
  fetches, so a fresh install cannot show four simultaneous failures

The server already sends permissive CORS, so nothing is needed on that side.

### It must be reachable from a phone

A phone on mobile data is not on the shop's wifi. The address must be one that
works from outside — `xtechpos.com`, not `192.168.1.20:4000` — and it should be
**https**, because iOS refuses plain http by default. Both are already true for
this installation.

---

## What the phone version does differently

| | Counter monitor | Phone |
|---|---|---|
| Menu | Rail down the left | Fixed tab bar at the bottom, five places |
| Everything else | Rail groups | **More** → a dense list, ~56px rows |
| The cart | Column on the right, always visible | A **sheet** that slides up, with a bar always showing the total |
| Open pages | A strip of tabs with close crosses | Hidden — a phone does not keep six pages open |
| Keyboard hints | `F2 charge · F3 hold …` | Hidden; there is no keyboard |
| A good scan | A line appears | A line appears **and the phone buzzes** |
| Screen sleeping | Not a problem | Held awake while the register is open, released on the way out |

The cart is the one worth spelling out. Before this, a narrow screen put the
cart *underneath* the product grid in one long scrolling page — so taking the
money meant scrolling past the entire shelf, with a customer waiting. Now it is
one thumb-press from a bar that always shows what the sale comes to, and the
Charge button sits at the bottom of the sheet where a thumb already is.

---

## Building it

```bash
npm --prefix client run app:sync      # build the web app and copy it into both projects
npm --prefix client run app:android   # ... and open Android Studio
npm --prefix client run app:ios       # ... and open Xcode  (macOS only)
```

`app:sync` is the one to remember. Everything else assumes it has run — the
native projects hold a *copy* of the built pages, so a change that has not been
synced is a change the app has never seen.

### The download link

One address, and it does not change:

```
https://github.com/walidframa/your_first_code/releases/download/app/front-desk.apk
```

Open it on an Android phone and it installs. No GitHub account, no Play Store
account, no signing key — the repository is public and a release asset is a
plain file. It is what to put on the shop's own phones, hand to somebody who
wants to try it, or print as a QR code beside the counter.

**It always holds the most recent build.** The link points at a release under
the fixed tag `app`, which every build replaces — so the same link keeps
working and keeps being current. Android will warn about installing outside the
Play Store, which is expected for a build handed out directly, and the app asks
for the shop's address the first time it opens.

### Making a new one

Actions → **Phone app** → **Run workflow**, and wait a couple of minutes. That
builds the APK, replaces the `app` release with it, and attaches a copy to the
run itself (`front-desk-<sha>-apk`) as the record of what was built.

Tagging a version (`v1.0.0`) does the same *and* keeps a copy under that tag,
so a released version still has the file it shipped with after `app` has moved
on to the next build.

**The phone app is not updated by deploying.** The server's deploy replaces the
web app; the phone app carries its own copy of the screens inside the APK. A
change the shop needs on the phones is a new APK, installed over the old one
(Android keeps the data and the shop address).

### If a build is only for you

The run's own artifact — `front-desk-<sha>-apk` under Artifacts — is a zip, it
expires after thirty days, and GitHub asks whoever clicks it to sign in. Fine
for checking a build; not something to send to a shopkeeper.

### Locally, if you would rather

```bash
npm --prefix client run app:apk
# client/android/app/build/outputs/apk/debug/app-debug.apk
```

Needs the Android SDK and a JDK 21. Android Studio installs both.

### iOS

iOS builds **require a Mac**. There is no way around it — the toolchain is
Apple's and runs only on macOS. What is in this repository is the complete Xcode
project; on a Mac:

```bash
npm --prefix client run app:ios      # opens Xcode
```

Then Signing & Capabilities → your team → Product → Archive.

An **Apple Developer account ($99/year)** is needed to put it on a phone that
is not plugged into that Mac, and to submit to the App Store. A free account
will run it on a device for seven days, which is enough to try it.

---

## Icons and the splash screen

Both are drawn from `client/resources/icon.svg` and `splash.svg`. To change
them, edit the SVG, re-render the PNG next to it, then:

```bash
npm --prefix client run app:icons
```

That regenerates all 113 sizes for both platforms.

It is a wrapper around `capacitor-assets` rather than a direct call, and the
wrapper exists for a reason: the tool also rewrites `public/manifest.webmanifest`
and what it writes there is wrong — it points the web manifest at
`../icons/*.webp`, a path that resolves outside the site root, and labels webp
files as `image/png`. That silently breaks the *browser* PWA's icons every time
somebody rebuilds the *phone* app's. The wrapper puts the manifest back.

---

## Releasing to the stores

### Google Play

Play wants a signed `.aab`, not an APK.

1. Make a keystore **once** and never lose it — Play ties your app's identity to
   it, and a lost keystore means the app can never be updated again, only
   republished under a new name:
   ```bash
   keytool -genkey -v -keystore front-desk.jks -keyalg RSA \
     -keysize 2048 -validity 10000 -alias front-desk
   ```
2. Keep it **out of the repository**. Back it up where the `ACCOUNT_SECRET`
   backup lives; the consequence of losing it is comparable.
3. Point `client/android/keystore.properties` at it (gitignored), then
   `npm --prefix client run app:aab`.

### App Store

Xcode → Archive → Distribute App. Needs the paid account. The camera usage
string is already in `Info.plist`; App Store review rejects a build without one,
so do not remove it.

### Both stores will ask for

- A privacy policy URL — the app collects nothing of its own; everything it
  shows comes from the shop's own server and stays there
- Screenshots at several sizes
- An age rating and a category (Business)

---

## Updating a shop that already has it

Two different things update, and they are worth keeping straight:

- **The web app inside it** — reaches the phone only through a store update,
  because the pages are bundled into the app. This is the opposite of the
  browser version, where a deploy reaches every till on the next reload.
- **The shop's data and server** — unchanged, immediately, as always.

So a phone app release is a store submission, and Apple's review takes a day or
two. Plan a change that both must have accordingly: deploy the server first, and
let the phones catch up.
