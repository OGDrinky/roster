# PDY Tracker

A phone app for tracking daily duty status for a small team. Each person on the roster is marked
**PDY**, **School**, **Leave**, **Pass**, **Staff Duty**, or **Recovery**, with an optional short note.
The shared "master roster" is a single `roster.json` file in a **private** GitHub repo.

It's an installable web app (PWA): no app store, and it works on iPhone and Android.

## How it works

- Every tap saves on your phone right away. **Push** sends your changes to GitHub.
- The app pulls the master roster every 5 minutes while it's open, and whenever you reopen it.
  The refresh button pulls on demand.
- If two people push around the same time, nothing is overwritten. Changes merge per person, and
  the most recent status for each person wins. A rename and a status change to the same person
  both survive.
- Statuses carry over to the next day but show faded with "as of Tue 22 SEP" until someone
  re-confirms them. The **Needs update** chip lists everyone not updated today.
- Every push is a GitHub commit such as `SSG Frisbie: SPC Baker: Pass (Til Monday)`, so the repo
  history is a full audit log.

## One-time setup (one person does this)

### 1. Create the private data repo
On github.com, create a new repository, for example `pdy-roster`:
- Visibility: **Private**
- Check **Add a README file**

### 2. Create an access token for that repo only
GitHub → your avatar → **Settings** → **Developer settings** → **Personal access tokens** →
**Fine-grained tokens** → **Generate new token**
- Repository access: **Only select repositories**, then pick `pdy-roster`
- Permissions → Repository permissions → **Contents: Read and write**
- Pick an expiration. When it expires, generate a new token and send teammates a new setup code.

Copy the token (starts with `github_pat_`). GitHub only shows it once.

### 3. Host the app on GitHub Pages
Create a second repository, for example `pdy-tracker`. It must be **Public** for free GitHub Pages.
That's fine because it holds only app code, never roster data or the token.
- Upload everything in this folder (`index.html`, `app.js`, `sync.js`, `styles.css`, `sw.js`,
  `manifest.webmanifest`, `icons/`).
- Repo **Settings** → **Pages** → Source: **Deploy from a branch**, Branch: `main`, folder `/ (root)`.
- After a minute the app is live at `https://<your-username>.github.io/pdy-tracker/`

### 4. Install it on your phone
- **iPhone:** open the link in **Safari** → Share → **Add to Home Screen**.
- **Android:** open the link in **Chrome** → ⋮ menu → **Install app** (or **Add to Home screen**).

Open it from the home-screen icon for the rest of setup. On iPhone, the home-screen app keeps its
own storage, separate from Safari.

### 5. Connect and load the roster
In the app: ⚙ **Settings**
- **Your name**: shown next to every status you set
- **Repo**: `your-username/pdy-roster`
- **Access token**: paste the token → **Test connection** (should say ✓ Connected)
- **Add / rename / remove people**: paste all names, one per line → **Add**
- Go back and tap **Push**

### 6. Invite the other three
Settings → **Copy setup code**, then send it over a channel you trust (it contains the token).
Each teammate installs the app (step 4), opens Settings, enters their name, pastes the code, and
taps **Apply**. The roster loads automatically.

## Daily use
1. Tap a person.
2. Type a note if needed (e.g. `ALC until 10 OCT`), then tap a status. That saves it.
3. Tap **Push** when you're done. The button shows how many changes haven't been pushed yet.

Tap a summary chip to filter the list. Tap it again to show everyone.
**Share status report** creates a PERSTAT-style text summary you can paste into a group chat.

## Security notes
- Keep `pdy-roster` **private**. Test connection warns you if it's public.
- The token can only read and write that one repo. If a phone is lost, delete the token on
  GitHub, create a new one, and send a new setup code.
- Everyone shares one token, so GitHub shows every commit under the token owner's account. The
  app records who made each change (the name in Settings) in the data and in each commit message.
- Keep notes short and non-sensitive (no SSNs or medical details), and follow your unit's
  policy on storing personnel information in commercial cloud services.

## Files
| File | Purpose |
|---|---|
| `index.html` | Page layout: roster, status picker, settings, roster management |
| `app.js` | UI, local saving, auto-refresh, report |
| `sync.js` | Data model, merge logic, GitHub API |
| `styles.css` | Styling (follows the phone's light/dark mode) |
| `sw.js`, `manifest.webmanifest`, `icons/` | Makes it installable and able to open offline |
