# Putting Stream Remote online with Firebase

Stream Remote (the phone website) runs on **Firebase**, free on the **Spark** plan, with no card needed:

| Part | Firebase service |
| --- | --- |
| Website files (`web/`) | Hosting, at `https://<project-id>.web.app` |
| Owner / client sign-in | Authentication (Email/Password) |
| PC sign-in (one per paired PC) | Authentication (Anonymous) |
| PC status, button presses, live screen | Realtime Database, protected by `database.rules.json` |
| Installer downloads | **GitHub Releases** (Firebase's free hosting allows only 360 MB of transfer a day) |

You do steps 1–4 once in the browser. Step 5 runs on this PC. Total time is about 15 minutes.

---

## 1. Create the project
1. Open **https://console.firebase.google.com** and sign in with the Google account that should own the website.
2. **Create a project**, for example `stream-remote-bk`. Google Analytics isn't needed; turn it off.

## 2. Turn on sign-in
**Build → Authentication → Get started → Sign-in method**, then enable two providers:
- **Email/Password**: turn on the first switch only (not "Email link").
- **Anonymous**: the desktop app uses this to sign in each paired PC.

## 3. Create the database and the setup code
1. **Build → Realtime Database → Create database**.
   - **Location:** the nearest one, e.g. *Singapore (asia-southeast1)* for India.
   - **Security rules:** **Start in locked mode**; step 5 uploads the real rules.
2. In the **Data** tab, hover the top line, click **+**, and add:
   - Key `secrets`, then click **+** on it to add a child:
   - Key `setupCode`, value: a long code only you know, at least 8 characters, e.g. `BK-Vastrapur-7391-Owner`.

   This code lets **one** person create the owner account. The website can never read it.

## 4. Copy the website settings into `web/config.json`
1. Click the **⚙ (Project settings) → General → Your apps → Web (`</>`)**.
2. Register an app called `Stream Remote`. Leave "Firebase Hosting" unticked.
3. Copy the values from the `firebaseConfig` that is shown into [`web/config.json`](web/config.json):
   ```json
   {
     "firebase": {
       "apiKey": "AIza…",
       "authDomain": "stream-remote-bk.firebaseapp.com",
       "databaseURL": "https://stream-remote-bk-default-rtdb.asia-southeast1.firebasedatabase.app",
       "projectId": "stream-remote-bk",
       "appId": "1:…:web:…"
     },
     "githubRepo": "Yashaswi-Anand/Stream_Remote_Brahmakumaris_vastrapur"
   }
   ```
   These values are **not secret**: Firebase is designed for them to be public, and `database.rules.json` is what protects the data. It's fine to commit them.

## 5. Deploy from this PC
In a terminal in the project folder:

```bash
npx --yes firebase-tools@15.34.2 login
```

```bash
npx --yes firebase-tools@15.34.2 use --add
```

(Choose your project and give it the alias `default`. This creates `.firebaserc`.)

```bash
npm run deploy
```

This uploads the website (`web/`) and the database rules. Run `npm run deploy` again after any change to `web/` or the rules.

## 6. First use
1. Open **https://<project-id>.web.app**. The first visit shows **Create the owner account**: enter the setup code from step 3, your email and a password (10+ characters).
2. **Admin → Add a PC**. In the desktop app (2.1.0 or later), go to the **Remote** tab and enter the website address `https://<project-id>.web.app` and the code.
3. **Admin → People → Invite by email** creates a one-time link (valid 7 days) for the client.
4. Lost password? Use **Forgot password?** on the sign-in page. Firebase emails a reset link.

## 7. Offer the installers on the Download page
On GitHub, open the repository → **Releases → Draft a new release**:
1. Tag `v2.1.0`, title `2.1.0`.
2. Attach `dist/Zoom-Stream-Automation-Setup-2.1.0.exe` and `dist/Zoom-Stream-Automation-Portable-2.1.0.exe`.
3. **Publish**. The website's **Download** page always shows the newest release.

## Optional: your own domain
Go to **Hosting → Add custom domain**, enter for example `remote.yourdomain.com`, and add the DNS records it shows in Hostinger's DNS editor. Firebase adds the https certificate itself. Then add the domain under **Authentication → Settings → Authorized domains**.

---

## Free plan limits (Spark)
- **Realtime Database:** 1 GB stored and **10 GB/month downloaded**, 100 connections at once.
  - The live screen is the big one: about **58 MB per hour of viewing**, so roughly 170 hours a month.
  - Everything else is tiny.
- **Hosting:** 10 GB stored, 360 MB/day of transfer. The website itself is about 100 KB.
- **If any limit is exceeded, Firebase turns the site off until the next month.** There is no bill. Usage is shown under **Usage and billing**.

## Testing on this PC without a Firebase project
```bash
npm run web:local
```
This starts the website at `http://localhost:5555`, and on your Wi-Fi at `http://<PC-IP>:5555`, using the Firebase emulators (Java needed). The setup code is `LOCAL-SETUP-CODE`. Test data is wiped when you stop it.

`npm run test:firebase` runs the security-rule tests and the desktop-connector test against the emulators.
