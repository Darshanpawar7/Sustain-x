# Putting the dashboard live on Netlify

The live site (`sustainflow.netlify.app`) only changes when Netlify builds it. It is not linked to GitHub yet,
so changes in this repository do not reach it on their own. Link it once (option A) and every merge to `main`
updates the site.

You need two values from Supabase (**Project Settings → API Keys**):

- the **Project URL**, like `https://<your-project>.supabase.co`
- the **anon** (public) key. Never use the `service_role` key: the build refuses it.

## Option A: link the GitHub repository (recommended)

1. Open [app.netlify.com](https://app.netlify.com) and the **sustainflow** site.
2. **Site configuration → Build & deploy → Continuous deployment → Link repository**. Choose GitHub, then `Darshanpawar7/Sustain-x`, branch `main`.
3. Leave the build settings to [`netlify.toml`](../netlify.toml): base directory `Web_Dashboard`, build command `node ../scripts/netlify-build.mjs`, publish directory `.`.
4. **Site configuration → Environment variables → Add a variable**:
   - `SUPABASE_URL` = the Project URL
   - `SUPABASE_ANON_KEY` = the anon key
5. Merge the pull request into `main` on GitHub. Netlify builds and publishes the site in about a minute.
6. Open the site: the status should read **Live** once the ESP32 is sending data.

Optional variables: `MQTT_URL` (default `wss://broker.hivemq.com:8884/mqtt`) and `MQTT_TOPIC_ROOT`
(default `flowstate/team10-d76014`; it must match `MQTT_TOPIC_ROOT` in the firmware).

## Option B: drag and drop (no GitHub link)

1. On a PC with Node.js, in the repository folder, run:

   ```text
   cd Web_Dashboard
   set SUPABASE_URL=https://<your-project>.supabase.co
   set SUPABASE_ANON_KEY=<the anon key>
   set OUTPUT_DIR=.
   node ../scripts/netlify-build.mjs
   ```

   (In PowerShell use `$env:SUPABASE_URL="…"` instead of `set`.) This writes `assets/env.js` and `_headers` into `Web_Dashboard`.
2. In Netlify, open the site, then **Deploys**, and drag the whole `Web_Dashboard` folder onto the page.
3. Do not commit the generated `assets/env.js`; restore it afterwards with `git checkout Web_Dashboard/assets/env.js`.

## Check it worked

- The page header shows **FlowState · Team 10**.
- *Settings* at the bottom says it is connected to the database it was deployed with.
- `?sample` at the end of the address shows the labelled sample-data preview.
