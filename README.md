# Dovetail Digital website

A small static landing page for Dovetail Digital, deployed with Cloudflare Workers Static Assets.

## Develop locally

```sh
npx wrangler dev
```

## Deploy

```sh
npx wrangler deploy
```

The Worker is named `dovetail-digital-site` so it can be connected to GitHub without replacing the existing `dovetaildigital` Worker. Once `dovetaildigital.co.uk` is an active zone in the Cloudflare account, connect `dovetaildigital.co.uk` and `www.dovetaildigital.co.uk` as custom domains in the Worker settings (or declare custom domain routes in Wrangler).
