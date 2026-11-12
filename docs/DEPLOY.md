# Putting the dashboard live on Netlify

The live site is **[iot-team10.netlify.app](https://iot-team10.netlify.app/)**. Netlify builds it from this
repository's `main` branch, so every merge into `main` updates the site in about a minute.

## Settings the site needs (Netlify, once)

1. **Project configuration → Environment variables → Add a variable**, with values from Supabase
   (**Project Settings → API Keys**):
   - `SUPABASE_URL` = the Project URL, like `https://<your-project>.supabase.co`
   - `SUPABASE_ANON_KEY` = the **anon** (public) key. Never the `service_role` key: the build refuses it.
2. **Deploys → Trigger deploy → Deploy project.** Variables are only read when the site is built.
3. **Project configuration → General → Visitor access → Project visibility → Edit visibility → Public.**
   New Netlify projects are private by default; until this is set, visitors see a Netlify login page.

The build settings come from [`netlify.toml`](../netlify.toml): base directory `Web_Dashboard`, build command
`node ../scripts/netlify-build.mjs`, publish directory `.`.

Optional variables: `MQTT_URL` (default `wss://broker.hivemq.com:8884/mqtt`) and `MQTT_TOPIC_ROOT`
(default `flowstate/team10-d76014`; it must match `MQTT_TOPIC_ROOT` in the firmware).

## Without GitHub: drag and drop

For a Netlify site that is not linked to GitHub:

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
- The status reads **Waiting for the ESP32** until the board sends data, then **Live**.
- `?sample` at the end of the address shows the labelled sample-data preview.
