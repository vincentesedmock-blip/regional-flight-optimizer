# Regional Flight Optimizer

A browser-based travel planner for comparing nearby departure airports, exact travel dates, flexible vacation windows, ground transportation, and domestic/international destination ideas.

## Run Locally

You can still open `index.html` directly, but the AI assistant proxy only works through the local server:

```bash
npm start
```

Then open:

```text
http://localhost:3000
```

## Optional AI Assistant

The browser never stores or exposes an OpenAI API key. To enable the AI assistant, set the key on the machine or hosting provider that runs `server.js`:

```bash
set OPENAI_API_KEY=your_key_here
npm start
```

Optional:

```bash
set OPENAI_MODEL=gpt-5.4-mini
```

If no key is configured, the app falls back to the local assistant logic and still works.

## Security Notes

- Do not put real API keys in `index.html`, `README.md`, committed files, or browser local storage.
- Keep secrets in server environment variables such as `OPENAI_API_KEY`.
- `server.js` only serves the public `index.html` file and blocks hidden files, logs, package metadata, and server source from web access.
- The assistant endpoint is same-origin only, rate-limited, body-limited, and returns generic upstream errors.
- Browser-saved fares and feedback are stored locally on the user's device.

## Verified Fare Workflow

Search results include live fare links for Google Flights, Expedia, Kayak, Skyscanner, and deal searches. When you find the lowest live fare, click **Save lowest fare** on that row and enter the price/source. The app will then:

- show the saved provider under **Best Fare Location**
- sort optimizer results using the verified fare
- preserve the fare in browser local storage
