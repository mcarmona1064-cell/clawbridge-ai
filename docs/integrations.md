# Integrations

Agents use your business apps through the host. The apps' credentials stay in `~/.clawbridge/.env` on the host, and the agent's container never sees them. The agent asks the host to make a call (`integration_request`), the host adds the credentials, and the result comes back.

- **Reads** (listing issues, searching email, looking up a customer) run at once.
- **Changes** (sending email, creating or updating records, refunds, payments) are shown as an approval card first, with the exact request and its body. Nothing is sent until someone approves.
  - Where it is safe, the card offers **Always allow** for that kind of change, such as "create issues in acme/web".
  - Stripe and Shopify writes always ask.
- `/permissions` lists the rules. `/permissions deny github` turns an app off for an agent.
- Every change, and every approval decision, is in the audit log.

## Connecting an app

Add its credentials to `~/.clawbridge/.env`; it shows up within a second, with no restart needed. The agent's `list_integrations` tool shows what is connected.

| App | Settings | Where to get them |
|---|---|---|
| GitHub | `GITHUB_TOKEN` | github.com → Settings → Developer settings → Fine-grained token (pick repos and permissions) |
| Linear | `LINEAR_API_KEY` | Linear → Settings → API → Personal API keys |
| Jira | `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN` | id.atlassian.com → Security → API tokens; base URL like `https://acme.atlassian.net` |
| Notion | `NOTION_TOKEN` | notion.so/my-integrations → New integration; then share pages with it |
| HubSpot | `HUBSPOT_TOKEN` | HubSpot → Settings → Integrations → Private apps |
| Stripe | `STRIPE_SECRET_KEY` | Stripe → Developers → API keys. A restricted key is strongly recommended. |
| Shopify | `SHOPIFY_STORE_DOMAIN`, `SHOPIFY_ACCESS_TOKEN` | Shopify admin → Apps → Develop apps → Admin API access token |
| Gmail, Google Calendar, Drive, Sheets | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN` | A Google Cloud OAuth client (Desktop app) with the scopes you want, then a refresh token for your account |

**Your own REST APIs:**

```
CUSTOM_INTEGRATIONS=[{"name":"crm","baseUrl":"https://api.example.com","header":"Authorization","prefix":"Bearer ","env":"CRM_TOKEN"}]
CRM_TOKEN=...
```

## What the host enforces

- **Requests stay on the app's host.** `//other-host` and `..` in paths are refused.
- **Credential values are redacted** from anything the API echoes back.
- **Responses are capped** at 60 KB.
- **Reads and writes are classified per app.**
  - Linear GraphQL queries are reads; mutations are writes.
  - Notion `…/query` and `/search`, and HubSpot `…/search`, are reads.
