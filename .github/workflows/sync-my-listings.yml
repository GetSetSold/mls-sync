name: Sync My Listings to Sold

on:
  schedule:
    - cron: '*/30 * * * *'  # every 30 minutes
  workflow_dispatch:

jobs:
  sync:
    runs-on: ubuntu-latest
    environment: production

    steps:
      - name: Checkout repository
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Install dependencies
        run: npm install

      - name: Sync my office listings into sold
        run: node sync-my-listings.js
        env:
          SUPABASE_KEY: ${{ secrets.SUPABASE_SERVICE_ROLE_KEY }}
