# Regional Flight Optimizer

A browser-based travel planner for comparing nearby departure airports, exact travel dates, flexible vacation windows, ground transportation, and domestic/international destination ideas.

## Run Locally

On Windows, double-click:

```text
start-flight-optimizer.bat
```

Or open this file directly in your browser:

```text
index.html
```

The normal app does not require localhost.

## Make It Public

There are two supported public options:

### Static Public Site

GitHub Pages can publish `index.html` directly. This is the easiest sharing option. The optimizer, deal repository, local assistant fallback, fare links, saved fares, and browser feedback still work. The private AI proxy will not run on GitHub Pages.

### Full Public App With AI Proxy

Use Vercel for the full public app. This repo includes `api/assistant.js`, `api/feedback.js`, and `vercel.json`, so Vercel can serve the static app and keep API calls server-side.

1. Push this repo to GitHub.
2. Import the repo into Vercel.
3. In Vercel project settings, add environment variable `OPENAI_API_KEY`.
4. Optional: add `OPENAI_MODEL` if you want to override the default.
5. Deploy and share the Vercel URL.

Do not put API keys in `index.html` or GitHub Pages settings.

## Optional AI Assistant

The browser never stores or exposes an OpenAI API key. The static app uses the local assistant fallback. To enable the hosted AI assistant in a public deployment, set the key on the host that runs the `/api/assistant` route.

Optional:

```bash
set OPENAI_MODEL=gpt-5.4-mini
```

If no key is configured, the app falls back to the local assistant logic and still works.

ChatGPT Pro and the OpenAI API are separate products. Having ChatGPT Pro does not automatically give this app an API key; the proxy needs `OPENAI_API_KEY` set in the server or Vercel environment.

## Security Notes

- Do not put real API keys in `index.html`, `README.md`, committed files, or browser local storage.
- Keep secrets in server environment variables such as `OPENAI_API_KEY`.
- Server/API files are optional deployment support, not required for normal local use.
- The assistant endpoint is same-origin only, rate-limited, body-limited, and returns generic upstream errors.
- Browser-saved fares and feedback are stored locally on the user's device.

## Verified Fare Workflow

Search results include live fare links for Google Flights, Expedia, Kayak, Skyscanner, and deal searches. When you find the lowest live fare, click **Save lowest fare** on that row and enter the price/source. The app will then:

- show the saved provider under **Best Fare Location**
- sort optimizer results using the verified fare
- preserve the fare in browser local storage

The **Saved Deals** tab stores only fares you save after checking a live source. Unsaved model candidates stay in the search results and vacation optimizer, but they do not persist there.

## Feedback Loop

Feedback is saved in browser local storage. When the local server is running, **Export Feedback** also writes a private `feedback-inbox.jsonl` file in the project folder. That file is ignored by Git and is not served publicly. On serverless public deployments, feedback remains browser-local unless a durable database is added later.
