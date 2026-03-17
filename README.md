# Commute Speedrun Livesplit

A Livesplit-inspired commute tracker built with React + TypeScript, Vite, Tailwind v4, Framer Motion, and GSAP.

## Quick Start

```bash
npm install
npm run dev
```

## Firebase (Optional)

If you want cloud sync, add a `.env` file:

```bash
VITE_FIREBASE_CONFIG={"apiKey":"...","authDomain":"...","projectId":"...","storageBucket":"...","messagingSenderId":"...","appId":"..."}
VITE_FIREBASE_APP_ID=commute-speedrun
```

If `VITE_FIREBASE_CONFIG` is missing, the app runs in local-storage mode.

## Build

```bash
npm run build
npm run preview
```
