# WhatsApp Sender dashboard

Sends a service-wise WhatsApp message from your numbers to every **new** row added to your Google Sheets, once per person per service.

- Several WhatsApp numbers (scan QR in the dashboard) and several sheets
- Messages per service (1:1 Yoga, Therapy, …) edited in the dashboard
- Team: Admin / Manager / Viewer, each limited to chosen numbers
- SQLite database (`data/app.db`), daily backups in `data/backups/` (14 kept)

> Unofficial WhatsApp Web automation. Keep limits sensible; a normal number that messages many strangers fast can be banned.

## Roles

| | Admin | Manager | Viewer |
|---|---|---|---|
| See numbers, sheets, activity | All | Only their numbers | Only their numbers |
| Add / edit sheets and messages, "Check now", test message | ✓ | ✓ (their numbers) | – |
| Add / link / remove WhatsApp numbers, number settings | ✓ | – | – |
| Pause sending, check interval | ✓ | – | – |
| Team: add people, reset passwords, turn off access | ✓ | – | – |

New people get a temporary password and must set their own at first sign-in. Everyone can turn on 2-step sign-in under their name → My account.

## Install on EC2 (Ubuntu, Node 22.13+; t3.small runs 2–3 numbers)

```bash
pm2 delete wa-bot 2>/dev/null; pm2 delete wa-dashboard 2>/dev/null    # stop older versions

# run as a normal user, not root
sudo npm i -g pm2
sudo useradd -m -s /bin/bash wasender || true
sudo mkdir -p /opt/wa-dashboard && sudo chown wasender: /opt/wa-dashboard
sudo -iu wasender
unzip /path/to/wa-dashboard.zip -d /opt/wa-dashboard && cd /opt/wa-dashboard
cp .env.example .env && chmod 600 .env
npm install --omit=dev
npm run setup-admin            # admin username, password, 2-step code
pm2 start src/server.js --name wa-dashboard && pm2 save
exit
sudo env PATH=$PATH pm2 startup systemd -u wasender --hp /home/wasender   # start on reboot
```

Upgrading from the previous version: copy the old `data/` folder into `/opt/wa-dashboard/data` before starting.
`db.json` and the WhatsApp logins are imported automatically.

## Logo and colours (SuperMe branding)

`.env` already has SuperMe's logo and icon addresses. On the server run once:

```bash
npm run fetch-brand      # downloads the logo and browser-tab icon into public/brand/
```

Reload the page: the logo shows in the header and on the sign-in page, the tab shows the SuperMe icon,
and the colours are taken from the logo automatically. To use an exact brand colour instead, set
`BRAND_COLOR=#xxxxxx` in `.env` and `pm2 restart wa-dashboard`. For another brand, change `BRAND_NAME`,
`BRAND_LOGO_URL`, `BRAND_ICON_URL` and run `npm run fetch-brand` again.

## HTTPS (recommended)

Put nginx in front and only expose 443:

```nginx
server {
  server_name wa.example.com;
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```
Then `sudo certbot --nginx -d wa.example.com`, and in `.env`: `HOST=127.0.0.1`, `TRUST_PROXY=1`, `COOKIE_SECURE=true`.
Security group: 443 open, 3000 closed, 22 only from your IP.

Without a domain: keep port 3000 open **only to your office/home IP**.

## Security built in

- Passwords hashed with scrypt; strong passwords enforced; temporary passwords must be changed
- Optional 2-step sign-in (authenticator app), codes can't be reused
- Lock-out after 5 wrong attempts from one IP (15 min), plus a global limit
- HttpOnly + SameSite=Strict session cookie, idle and absolute timeouts, sign-out of other devices on password change
- CSRF token + same-origin check on every change
- Strict security headers (CSP, frame blocking, no-sniff, HSTS on HTTPS)
- Role checks on the server for every action; people only see their numbers
- Input length limits, request size limit, rate limits, no stack traces in responses
- Activity log records who did what; sign-in events visible to admins
- Data files readable only by the app user; phone numbers masked in server logs

## Sheet access

Three ways, best first:

1. **Connect Google account (recommended, free).** Click *Google accounts → Connect* once; after that any sheet
   that account can open just works by pasting its link. No sharing, no public link, and the status column is filled in.
   Needs the one-time setup below.
2. **Public link:** Share → General access → Anyone with the link → Viewer (status shown in the dashboard only).
3. **Service account:** see the end of this section.

### Connect Google account: one-time setup (about 10 minutes, no billing account needed)

Needs the dashboard on a domain with HTTPS (see HTTPS above), e.g. `https://wa.mysuperme.com`. Google does not allow plain IP addresses here.

1. Go to https://console.cloud.google.com → project picker → **New project** (e.g. "WhatsApp Sender").
2. **APIs & Services → Library** → search **Google Sheets API** → **Enable**.
3. **APIs & Services → OAuth consent screen** (Google Auth Platform):
   - User type: **Internal** if you use Google Workspace (no warning screen), otherwise **External**.
   - App name, support email, developer email → save.
   - **Data access / Scopes:** add `.../auth/spreadsheets`.
   - External only: **Audience → Publish app** (set to *In production*). In *Testing* mode Google signs you out every 7 days.
     Unverified apps show a "Google hasn't verified this app" screen: click **Advanced → Go to …**. That's fine for your own team.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**
   - Application type: **Web application**
   - Authorized redirect URI: `https://<your-domain>/auth/google/callback`
   - Create → copy the **Client ID** and **Client secret**.
5. In `/opt/.../.env`:
   ```
   PUBLIC_URL=https://wa.mysuperme.com
   GOOGLE_CLIENT_ID=xxxx.apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=xxxx
   ```
   then `pm2 restart wa-dashboard`.
6. Dashboard → **Google accounts → Connect Google account** → choose the account → Allow.

Admins can use every connected account. Managers can connect their own Google account and use only that.
Tokens are stored encrypted in the database (key in `data/secret.key`; back it up together with `data/app.db`).
Disconnecting also revokes the access at Google.

### Service account (alternative)

Google Cloud → service account → JSON key saved as `google-key.json`
   (`chmod 600`), enable the Google Sheets API, `pm2 restart wa-dashboard`, then share each sheet with the
   service account email shown in the dashboard as **Editor**.

## Locked out?

`npm run setup-admin` on the server resets (or creates) an admin with a new password.

## Files

- `data/app.db` database · `data/secret.key` encryption key · `data/backups/` daily copies · `data/wa-auth/` WhatsApp logins. Back up the whole `data/` folder.
