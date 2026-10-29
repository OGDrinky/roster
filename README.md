# Instructor Perstat

A phone app for tracking daily duty status for a small team. Each person on the roster is marked
**PDY**, **School**, **Leave**, **Pass**, **Staff Duty**, **Recovery**, **FTX**, or **Other**, with an optional short note.
The shared "master roster" is a single `roster.json` file in a **private** GitHub repo.

It's an installable web app (PWA): no app store, and it works on iPhone and Android.

## How it works

- Every change saves on your phone right away and is sent to GitHub about a second later, with
  no button to press. A quick run of changes goes up together. If there's no signal, the app
  keeps retrying every 30 seconds and when you reopen it; the **Retry** button sends right away.
- The app pulls the master roster every 5 minutes while it's open, and whenever you reopen it.
  The refresh button pulls on demand.
- If two people save around the same time, nothing is overwritten. Changes merge per person, and
  the most recent status for each person wins. A rename and a status change to the same person
  both survive.
- Statuses carry over to the next day but show faded with "as of Tue 22 SEP" until someone
  re-confirms them. The **Needs update** chip lists everyone not updated today, and after 0700
  their names turn red.
- The roster is sorted by rank (senior first), then alphabetically. Names without a recognized
  Army rank (e.g. civilians) are listed last.
- Every save is a GitHub commit such as `SSG Frisbie: SPC Baker: Pass (Til Monday)`, so the repo
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
- Go back. The roster saves to GitHub on its own.

### 6. Invite the other three
Settings → **Copy setup code**, then send it over a channel you trust (it contains the token).
Each teammate installs the app (step 4), opens Settings, enters their name, pastes the code, and
taps **Apply**. The roster loads automatically.

### 7. Let personnel sign in with a team password
On an instructor phone: Settings → **Team password** → type the password → **Create team access
file** → **Copy file contents** → **Open GitHub** → paste → **Commit changes**. About a minute
later, anyone with the link can open the app, enter the password (not case-sensitive), then enter
their rank and name. That name is stamped on every update they make.

Phones that join this way can see the roster and update anyone's status. They can't add or
remove people, and they never see the token. To change the password, create the file again and
replace the contents of `access.json`. To lock everyone out, delete the token on GitHub; when you
make a new one, create a new team access file, and people re-enter the password.

## Daily use
1. Tap a person.
2. Type a note if needed (e.g. `ALC until 10 OCT`), then tap a status. That saves it.
3. That's it. It saves for everyone a second later ("Saved"). A person marked "not sent yet" is
   still waiting for signal.

Tap a summary chip to filter the list. Tap it again to show everyone.
**Share status report** creates a PERSTAT-style text summary you can paste into a group chat.

## Security notes
- Keep `pdy-roster` **private**. Test connection warns you if it's public.
- The token can only read and write that one repo. If a phone is lost, delete the token on
  GitHub, create a new one, and send a new setup code.
- Everyone shares one token, so GitHub shows every commit under the token owner's account. The
  app records who made each change (the name in Settings) in the data and in each commit message.
  Names are self-entered, so they show who *says* they made a change; they aren't verified.
- The team access file is public but encrypted with the team password. A common word as the password
  keeps out people who only have the link, not a determined attacker. Anyone with the password
  could, with some technical effort, pull the token out of the app and read or write the roster
  repo directly.
- Keep notes short and non-sensitive (no SSNs or medical details), and follow your unit's
  policy on storing personnel information in commercial cloud services.

## Files
| File | Purpose |
|---|---|
| `index.html` | Page layout: roster, status picker, settings, roster management |
| `app.js` | UI, local saving, auto-refresh, report |
| `sync.js` | Data model, merge logic, GitHub API |
| `access.js` | Team password: creates and opens the encrypted `access.json` |
| `styles.css` | Styling (follows the phone's light/dark mode) |
| `sw.js`, `manifest.webmanifest`, `icons/` | Makes it installable and able to open offline |
