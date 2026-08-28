# Setting up Broadcast Desk

Everything you need to get from a fresh install to posting for clients, in the
order that wastes the least of your time.

---

## 1. Run it

```sh
cd broadcast-desk
npm install
npm start
```

To build an installer for yourself:

```sh
npm run dist:win     # NSIS installer
npm run dist:mac     # dmg
npm run dist:linux   # AppImage
```

Unsigned builds will warn on first launch (SmartScreen on Windows, Gatekeeper on
macOS). Signing certificates cost money and are worth it only when you start
handing the app to someone else.

---

## 2. The first hour, with no accounts at all

The desk opens in **dry run**: everything works, nothing publishes. Do this
before you touch a single API key, because it is the part that decides whether
the tool earns its keep.

1. **Profiles** — one per identity. Delete the seeded examples. Client profiles
   carry the engagement details and their own timezone.
2. **Library** — bulk-add the words and phrases each profile posts about, and
   tag them. The generator can only be as varied as this is. A thin library
   makes thin campaigns.
3. **Compose** — write a template with `{alternatives|like this}` and
   `[phrase:tag]` tokens, watch the variation count, check the per-network
   previews.
4. **Rules** — build one, read the sentence underneath, press **Test it**.

Nothing above needs a network, a key, or a penny.

---

## 3. The relay (optional, but you asked for unattended posting)

The relay is a small Cloudflare Worker. It does exactly three things the app on
your desk cannot:

- takes the OAuth callback for networks that refuse a `127.0.0.1` redirect
  (Meta, TikTok, Pinterest, LinkedIn),
- hosts media at a public URL for networks that fetch the file themselves
  rather than accepting an upload (Instagram; Reddit link posts),
- **sends scheduled posts while this machine is off.**

```sh
cd broadcast-desk/worker

npx wrangler kv namespace create HUB          # put the id into wrangler.toml
npx wrangler r2 bucket create broadcast-desk-media

# Set PUBLIC_URL in wrangler.toml to the Worker's own URL, then:
npx wrangler deploy

npx wrangler secret put DESK_KEY     # what the app sends as its bearer token
npx wrangler secret put TOKEN_KEY    # encrypts tokens at rest in KV

# One pair per OAuth network you intend to use:
npx wrangler secret put X_CLIENT_ID
npx wrangler secret put X_CLIENT_SECRET
# …FACEBOOK_, INSTAGRAM_, TIKTOK_, PINTEREST_, REDDIT_, TUMBLR_, VIMEO_, LINKEDIN_

npx wrangler deploy
```

Generate both keys with something like:

```sh
node -e "console.log(crypto.randomUUID()+crypto.randomUUID())"
```

Then in the app: **Settings → Relay**, paste the URL and the `DESK_KEY`, press
**Test**. The sidebar badge changes from `live` to `live + relay`.

### What "unattended" actually means

An account only posts with the machine off if you switch **Unattended** on for
it in Connections. That copies its token to the relay — which is the only way a
cron can use it, and is why it is a per-account decision rather than a global
one. Leave it off and that account posts only while Broadcast Desk is running
(the tray keeps it running after you close the window).

Media-heavy accounts are usually better left off: their files are on your disk,
not in the cloud.

---

## 4. Networks, in the order I would do them

### Straight away — no review, no cost

| Network | What you need | Where |
| --- | --- | --- |
| **WordPress** | The client's site URL, their WordPress username, and an **Application Password** | Their site → Users → Profile → Application Passwords |
| **Telegram** | A bot token, and the bot made an admin of the channel | `@BotFather` |
| **Discord** | A channel webhook URL | Channel → Integrations → Webhooks |
| **Reddit** | A free "web app" at reddit.com/prefs/apps; redirect `http://127.0.0.1` | reddit.com/prefs/apps |
| **Tumblr** | A free app; redirect `http://127.0.0.1` | tumblr.com/oauth/apps |
| **Vimeo** | A free app with the `upload` scope; redirect `http://127.0.0.1` | developer.vimeo.com/apps |
| **Pinterest** | A trial app; redirect `<relay>/oauth/callback` | developers.pinterest.com |

WordPress is the easiest client onboarding of the lot: one Application Password,
no OAuth app, no approval, and they can revoke it without changing their login.

### Costs money — X

X ended its free tier in February 2026. New developers are on pay-per-use:

- **$0.015** per post
- **$0.20** per post containing a link
- Basic ($200/mo) and Pro are closed to new signups

The desk is set up for this. **Settings → Spending** refuses link-bearing posts
to X by default and enforces a monthly cap that a runaway rule cannot cross. The
composer shows the cost before you send, and you can allow the charge on an
individual post when a link is genuinely worth twenty cents.

Register the app at developer.x.com, redirect `http://127.0.0.1`.

### Takes weeks — Meta and TikTok

**Facebook and Instagram.** Pages and Business/Creator accounts only; personal
timelines are not postable by any third-party app. To act on accounts you do not
own — which is every client — you need Meta app review and business
verification. Start it early; it is the longest pole here.

- Register at developers.facebook.com, redirect `<relay>/oauth/callback`
- Instagram needs the account linked to a Facebook Page
- Instagram posts must carry media, and Meta *fetches* it from a URL, which is
  what the relay's R2 bucket is for

**TikTok.** Until your app passes TikTok's Content Posting audit, every upload
is `SELF_ONLY` — visible to nobody but the account owner — and you are capped at
5 users per 24 hours. The adapter honours that: it marks a post private and says
so in the result rather than reporting a public post that isn't one. Apply for
the audit at developers.tiktok.com; expect weeks and a specific consent UX.

---

## 5. Onboarding a client

What to ask for, per network. Note that none of these is a password.

- **Any OAuth network** — send them the authorisation link the app opens; they
  approve on the network's own page. That is it. It survives their password
  changes and 2FA, and they can revoke it themselves.
- **WordPress** — an Application Password for a user with publish rights.
- **Telegram** — ask them to add your bot as an admin of the channel.
- **Discord** — a webhook URL for the channel they want posts in.
- **Facebook / Instagram** — they add you as a Page or asset user in Meta
  Business Suite, then authorise.

If a client offers you their password, decline. It breaks the moment they turn
on 2FA, it violates the terms both of you agreed to, and it makes their account
your liability.

---

## 6. Where things live

| | |
| --- | --- |
| Tokens | This machine, encrypted by the OS keyring (DPAPI / Keychain / libsecret) |
| Your workspace | This machine, in the app's data folder — **File → Reveal data folder** |
| Relay copies | Only for accounts you switched to Unattended |
| Media | Your disk. Only Instagram and Reddit link posts need a hosted copy |

**Export from Settings → Data before you move machines.** Clearing the app's
data folder clears the desk.

---

## 7. When something does not work

**"This system will not provide secure storage."** The OS keyring is missing.
On Linux install `gnome-keyring` or `pass` and restart. Credentials are not
saved in the clear as a fallback.

**A connection fails immediately.** Nine times in ten the redirect URI does not
match exactly. Loopback networks want `http://127.0.0.1` registered; relay
networks want `<PUBLIC_URL>/oauth/callback`, character for character.

**"Reachable, but the desk key is wrong."** The relay is up; the `DESK_KEY` in
Settings does not match the Worker's secret.

**Scheduled posts did not go out.** Check whether those accounts are marked
Unattended. If they are not, the app has to be running — it stays in the tray
after you close the window, but not after you quit or reboot.

**An X post was refused.** Almost certainly the link rule or the monthly cap.
Both are in Settings → Spending, and both are doing their job.
