# Putting the live page online

The live page is a static site, so any static host works. These steps use **Vercel** (free plan). Do it early (*Hackathon 101*, chapter 14) and keep it online until at least Nov 25, 2026.

1. Push the repository to GitHub.
2. Go to https://vercel.com/new, sign in with GitHub and **Import** the repository.
3. Leave the settings as detected. `vercel.json` in the repo already sets:
   - Install: `npm install`
   - Build: `npm run build`
   - Output: `apps/web/dist`
4. No environment variables are needed: the page holds no secrets.
5. Click **Deploy**. Use the short main address (`https://<project>.vercel.app`), not the long preview links, which are locked to your account.
6. Test it like a stranger: open it on your phone using mobile data, and in a private window on your computer.
7. Share a link that opens your testnet rounds directly: `https://<project>.vercel.app/?contract=market.hivebuy.testnet`

Every push to `main` redeploys automatically.
